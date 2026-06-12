import { AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import { RunnableConfig } from '@langchain/core/runnables';
import {
  SdkAssistantMessage,
  SdkContentBlock,
  SdkMessage,
  SdkResultMessage,
  SdkUsage,
  SdkUserMessage,
} from '@packages/claude-bridge';

import { RequestTokenUsage } from '../../../litellm/litellm.types';
import { BaseAgentConfigurable } from '../../agents.types';
import {
  buildReasoningMessage,
  updateMessagesListWithMetadata,
} from '../../agents.utils';
import { AgentEventType } from '../agents/base-agent';

const GENIRO_MCP_PREFIX = 'mcp__geniro__';

export type ClaudeMapperParams = {
  threadId: string;
  config: RunnableConfig<BaseAgentConfigurable>;
  /** Model alias from node config — fallback when an SDK message omits it. */
  model: string;
  emit: (event: AgentEventType) => void;
  /**
   * Per-message price from LiteLLM registered rates. Undefined prices coerce
   * to 0 at ingestion per the cost-accounting rules.
   */
  calculatePriceUsd?: (usage: RequestTokenUsage, model: string) => number;
};

/**
 * Translates the bridge's verbatim SDK message stream into BaseAgent events.
 *
 * Contract honored (agents.types.ts / agent-message-notification-handler):
 * - every persisted message is emitted exactly once, in final form
 *   (persistence is insert-only);
 * - assistant messages carry `__model` + `__requestUsage`;
 * - SDK-subagent traffic (parent_tool_use_id) is tagged
 *   `__subagentCommunication` + `__toolCallId` so persistence buckets it
 *   under the `${nodeId}::sub::${toolCallId}` surrogate node id;
 * - ToolMessages are synthesized from SDK `tool_result` blocks so UI tool
 *   blocks resolve, and the next assistant message is stamped
 *   `__answeredToolCallNames` (invoke-llm-node parity);
 * - `mcp__geniro__` tool-name prefixes are stripped;
 * - a token/cost snapshot `stateUpdate` follows every assistant message.
 *
 * Known M1 divergence: SDK `stream_event` partial deltas are not forwarded —
 * the UI updates per completed message block, not per token.
 */
export class ClaudeStreamMapper {
  sessionId?: string;
  sdkTotalCostUsd?: number;
  resultSubtype?: string;
  isError = false;

  private readonly collected: BaseMessage[] = [];
  private readonly pendingToolNames = new Map<string, string>();
  private answeredToolCallNames: string[] = [];
  private usageTotals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalPrice: 0,
  };
  private currentContext: number | undefined;
  /**
   * Lag-1 buffer: an assistant batch is emitted when the NEXT stream message
   * arrives. Through the LiteLLM Anthropic passthrough, per-assistant-message
   * `usage` is all zeros — the real turn totals and cost arrive only on the
   * `result` message. Buffering the last assistant message lets `onResult`
   * stamp the residual turn usage/price onto it BEFORE it is persisted
   * (persistence is insert-only), so `Σ messages.requestTokenUsage` always
   * equals the billed turn totals regardless of which path reports usage.
   */
  private pendingAssistant: {
    messages: BaseMessage[];
    aiMessage: AIMessage | null;
  } | null = null;

  constructor(private readonly params: ClaudeMapperParams) {}

  getMessages(): BaseMessage[] {
    return this.collected;
  }

  getTotalPriceUsd(): number {
    return this.usageTotals.totalPrice;
  }

  /** Emit any buffered assistant batch. Call after the stream ends. */
  flush(): void {
    if (!this.pendingAssistant) {
      return;
    }
    const { messages } = this.pendingAssistant;
    this.pendingAssistant = null;
    this.emitMessages(messages);
  }

  onSdkMessage(message: SdkMessage): void {
    // Frames cross a trust boundary (anything in the sandbox can write to the
    // bridge's stdout): assistant/user kinds without a `message` object would
    // throw below, uncaught in the stream 'data' handler.
    if (
      (message.type === 'assistant' || message.type === 'user') &&
      (typeof message.message !== 'object' || message.message === null)
    ) {
      return;
    }
    switch (message.type) {
      case 'system': {
        this.flush();
        if (typeof message.session_id === 'string' && message.session_id) {
          this.sessionId = message.session_id;
        }
        return;
      }
      case 'assistant': {
        this.flush();
        this.onAssistant(message as SdkAssistantMessage);
        return;
      }
      case 'user': {
        this.flush();
        this.onUser(message as SdkUserMessage);
        return;
      }
      case 'result': {
        this.onResult(message as SdkResultMessage);
        return;
      }
      default: {
        // stream_event partials and unknown message kinds: activity only.
        return;
      }
    }
  }

  private onAssistant(message: SdkAssistantMessage): void {
    this.sessionId = message.session_id || this.sessionId;
    // Same trust boundary as onSdkMessage: `content` may be missing, a
    // string, or carry non-object elements on a crafted frame.
    const rawBlocks = message.message.content;
    const blocks = Array.isArray(rawBlocks)
      ? rawBlocks.filter(
          (block): block is SdkContentBlock =>
            typeof block === 'object' && block !== null,
        )
      : [];
    const model = message.message.model ?? this.params.model;
    const built: BaseMessage[] = [];

    const thinkingText = blocks
      .filter((block) => block.type === 'thinking' && block.thinking)
      .map((block) => block.thinking as string)
      .join('\n\n');
    if (thinkingText) {
      const reasoning = buildReasoningMessage(thinkingText, message.message.id);
      reasoning.additional_kwargs = {
        ...(reasoning.additional_kwargs ?? {}),
        ...this.subagentKwargs(message.parent_tool_use_id),
        __model: model,
      };
      built.push(reasoning);
    }

    const text = blocks
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text as string)
      .join('');

    const toolCalls: ToolCall[] = blocks
      .filter((block) => block.type === 'tool_use' && block.id && block.name)
      .map((block) => {
        const name = this.normalizeToolName(block.name as string);
        this.pendingToolNames.set(block.id as string, name);
        return {
          id: block.id as string,
          name,
          args: (block.input ?? {}) as Record<string, unknown>,
          type: 'tool_call' as const,
        };
      });

    let aiMessage: AIMessage | null = null;
    if (text || toolCalls.length > 0) {
      const usage = this.toRequestTokenUsage(message.message.usage, model);
      aiMessage = new AIMessage({
        content: text,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      });
      if (message.message.id) {
        aiMessage.id = message.message.id;
      }
      aiMessage.additional_kwargs = {
        ...this.subagentKwargs(message.parent_tool_use_id),
        __model: model,
        ...(usage && { __requestUsage: usage }),
        ...(this.answeredToolCallNames.length > 0 && {
          __answeredToolCallNames: [...this.answeredToolCallNames],
        }),
      };
      this.answeredToolCallNames = [];
      built.push(aiMessage);

      if (usage) {
        this.accumulateUsage(usage);
      }
    }

    if (built.length > 0) {
      this.pendingAssistant = { messages: built, aiMessage };
    }
    this.emitStateSnapshot();
  }

  private onUser(message: SdkUserMessage): void {
    const content = message.message.content;
    if (typeof content === 'string' || !Array.isArray(content)) {
      // Plain user text echoes (e.g. injected input) are not re-persisted —
      // the host emitted the originating Human messages itself.
      return;
    }

    const built: BaseMessage[] = [];
    for (const block of content) {
      if (
        typeof block !== 'object' ||
        block === null ||
        block.type !== 'tool_result' ||
        !block.tool_use_id
      ) {
        continue;
      }
      const name = this.pendingToolNames.get(block.tool_use_id);
      this.pendingToolNames.delete(block.tool_use_id);
      if (name) {
        this.answeredToolCallNames.push(name);
      }

      const toolMessage = new ToolMessage({
        tool_call_id: block.tool_use_id,
        name: name ?? 'tool',
        content: this.stringifyToolResult(block),
      });
      toolMessage.additional_kwargs = {
        ...this.subagentKwargs(message.parent_tool_use_id),
        ...(block.is_error === true && { __toolError: true }),
      };
      built.push(toolMessage);
    }

    this.emitMessages(built);
  }

  private onResult(message: SdkResultMessage): void {
    this.sessionId = message.session_id || this.sessionId;
    this.resultSubtype = message.subtype;
    this.isError = message.is_error === true || message.subtype !== 'success';
    if (typeof message.total_cost_usd === 'number') {
      this.sdkTotalCostUsd = message.total_cost_usd;
    }

    const syntheticUsageMessage = this.reconcileTurnUsage(message);
    this.flush();
    if (syntheticUsageMessage) {
      this.emitMessages([syntheticUsageMessage]);
    }
    this.emitStateSnapshot();
  }

  /**
   * Stamps the residual turn usage/price (result totals minus what the
   * per-message path already accounted for) onto the still-buffered last
   * PARENT assistant message, keeping `Σ messages.requestTokenUsage` equal to
   * the turn's real totals. The SDK's `total_cost_usd` is preferred; when
   * absent, the residual tokens are priced via the LiteLLM-rate calculator.
   * A result without `usage` still settles `total_cost_usd` — billed cost must
   * never bypass the rollup the cost-limit guard reads.
   *
   * When there is no stampable parent message (turn ended on a tool_result or
   * an SDK-subagent message — stamping a whole-turn residual onto a
   * `::sub::` surrogate would misattribute parent spend), returns a synthetic
   * empty assistant message carrying the residual `__requestUsage`; the caller
   * emits it AFTER flushing the buffer so persistence (insert-only) still
   * captures the spend under the parent node id.
   */
  private reconcileTurnUsage(message: SdkResultMessage): AIMessage | null {
    const turnUsage = this.toRequestTokenUsage(
      message.usage,
      this.params.model,
    ) ?? {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalPrice: 0,
    };

    // Each field clamps to 0 independently, so a partially over-counted turn
    // can yield residual.totalTokens ≠ inputTokens + outputTokens — fine for
    // current consumers, which sum every field independently.
    const residual: RequestTokenUsage = {
      inputTokens: Math.max(
        turnUsage.inputTokens - this.usageTotals.inputTokens,
        0,
      ),
      cachedInputTokens: Math.max(
        (turnUsage.cachedInputTokens ?? 0) - this.usageTotals.cachedInputTokens,
        0,
      ),
      outputTokens: Math.max(
        turnUsage.outputTokens - this.usageTotals.outputTokens,
        0,
      ),
      totalTokens: Math.max(
        turnUsage.totalTokens - this.usageTotals.totalTokens,
        0,
      ),
    };
    const turnPrice =
      typeof message.total_cost_usd === 'number'
        ? message.total_cost_usd
        : (turnUsage.totalPrice ?? 0);
    residual.totalPrice = Math.max(turnPrice - this.usageTotals.totalPrice, 0);

    if (residual.totalTokens === 0 && (residual.totalPrice ?? 0) === 0) {
      return null;
    }

    const buffered = this.pendingAssistant?.aiMessage;
    const isParentMessage =
      buffered && !buffered.additional_kwargs.__subagentCommunication;
    if (!buffered || !isParentMessage) {
      this.addToTotals(residual);
      const synthetic = new AIMessage({ content: '' });
      synthetic.additional_kwargs = {
        __model: this.params.model,
        __requestUsage: residual,
      };
      return synthetic;
    }

    const existing = buffered.additional_kwargs.__requestUsage as
      | RequestTokenUsage
      | undefined;
    const merged: RequestTokenUsage = {
      inputTokens: (existing?.inputTokens ?? 0) + residual.inputTokens,
      cachedInputTokens:
        (existing?.cachedInputTokens ?? 0) + (residual.cachedInputTokens ?? 0),
      outputTokens: (existing?.outputTokens ?? 0) + residual.outputTokens,
      totalTokens: (existing?.totalTokens ?? 0) + residual.totalTokens,
      totalPrice: (existing?.totalPrice ?? 0) + (residual.totalPrice ?? 0),
    };
    buffered.additional_kwargs = {
      ...buffered.additional_kwargs,
      __requestUsage: merged,
    };
    this.addToTotals(residual);
    return null;
  }

  private emitMessages(messages: BaseMessage[]): void {
    if (messages.length === 0) {
      return;
    }
    const stamped = updateMessagesListWithMetadata(
      messages,
      this.params.config,
    );
    this.collected.push(...stamped);
    this.params.emit({
      type: 'message',
      data: {
        threadId: this.params.threadId,
        messages: stamped,
        config: this.params.config,
      },
    });
  }

  private emitStateSnapshot(): void {
    const configuredLimit =
      this.params.config.configurable?.effective_cost_limit_usd;
    this.params.emit({
      type: 'stateUpdate',
      data: {
        threadId: this.params.threadId,
        stateChange: {
          inputTokens: this.usageTotals.inputTokens,
          cachedInputTokens: this.usageTotals.cachedInputTokens,
          outputTokens: this.usageTotals.outputTokens,
          totalTokens: this.usageTotals.totalTokens,
          totalPrice: this.usageTotals.totalPrice,
          currentContext: this.currentContext,
          effectiveCostLimitUsd:
            typeof configuredLimit === 'number' ? configuredLimit : null,
        },
        config: this.params.config,
      },
    });
  }

  private toRequestTokenUsage(
    usage: SdkUsage | undefined,
    model: string,
  ): RequestTokenUsage | undefined {
    if (!usage) {
      return undefined;
    }
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const inputTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      cacheRead;
    const outputTokens = usage.output_tokens ?? 0;
    const tokenUsage: RequestTokenUsage = {
      inputTokens,
      cachedInputTokens: cacheRead,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
    tokenUsage.totalPrice =
      this.params.calculatePriceUsd?.(tokenUsage, model) ?? 0;
    return tokenUsage;
  }

  private accumulateUsage(usage: RequestTokenUsage): void {
    this.addToTotals(usage);
    if (usage.totalTokens > 0) {
      this.currentContext = usage.totalTokens;
    }
  }

  private addToTotals(usage: RequestTokenUsage): void {
    this.usageTotals.inputTokens += usage.inputTokens;
    this.usageTotals.cachedInputTokens += usage.cachedInputTokens ?? 0;
    this.usageTotals.outputTokens += usage.outputTokens;
    this.usageTotals.totalTokens += usage.totalTokens;
    this.usageTotals.totalPrice += usage.totalPrice ?? 0;
  }

  private subagentKwargs(
    parentToolUseId: string | null | undefined,
  ): Record<string, unknown> {
    if (!parentToolUseId) {
      return {};
    }
    return {
      __subagentCommunication: true,
      __toolCallId: parentToolUseId,
    };
  }

  private normalizeToolName(name: string): string {
    return name.startsWith(GENIRO_MCP_PREFIX)
      ? name.slice(GENIRO_MCP_PREFIX.length)
      : name;
  }

  private stringifyToolResult(block: SdkContentBlock): string {
    const content = block.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (part): part is { type: string; text: string } =>
            typeof part === 'object' &&
            part !== null &&
            (part as { type?: unknown }).type === 'text' &&
            typeof (part as { text?: unknown }).text === 'string',
        )
        .map((part) => part.text)
        .join('\n');
      if (text) {
        return text;
      }
    }
    return content === undefined ? '' : JSON.stringify(content);
  }
}
