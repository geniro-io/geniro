import { AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import { RunnableConfig } from '@langchain/core/runnables';
import {
  GENIRO_MCP_SERVER_KEY,
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

const GENIRO_MCP_PREFIX = `mcp__${GENIRO_MCP_SERVER_KEY}__`;

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
  /**
   * Name-keyed FIFO of SDK `tool_use_id`s for FORWARDED Geniro tool calls
   * awaiting host dispatch. The bridge's `tool_call_request` carries only the
   * bridge correlation id (`request.id`) — a different id space from the SDK
   * `tool_use_id` the parent AI message records (the same split documented on
   * `pendingToolUsage` below). The dispatcher drains this by tool name
   * (`resolveToolUseId`) to recover the `tool_use_id` and stamp it as
   * `__toolCallId`, so a delegated agent's inner messages carry the SAME id the
   * UI groups Communication blocks by. Only `mcp__geniro__`-prefixed tools are
   * queued — built-in SDK tools (run in-sandbox, never dispatched to the host)
   * are excluded so the queue stays balanced 1:1 with host dispatch.
   */
  private readonly pendingToolUseIds = new Map<string, string[]>();
  private answeredToolCallNames: string[] = [];
  /**
   * SDK assistant `message.id`s whose `usage` has already been stamped +
   * accumulated. A single assistant message can surface as multiple `assistant`
   * frames — e.g. a text block, then a tool_use block — that each carry the
   * SAME cumulative `usage`. Without this guard both frames are persisted as
   * separate AI rows BOTH carrying the full turn `__requestUsage`, so the
   * thread rollup (`Σ requestTokenUsage`) and `usageTotals` double-count the
   * turn. Counting a given id's usage once keeps the documented invariant
   * `Σ messages.requestTokenUsage == billed turn totals`; if the first frame
   * was only partial, the result-frame residual reconcile settles the gap.
   * For a text→tool_use split, `relocateSplitUsageToToolFrame` moves the count
   * onto the tool-call frame (the working block) so the cost renders where the
   * work happens, not on the preamble text.
   */
  private readonly usageStampedMessageIds = new Set<string>();
  private usageTotals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalPrice: 0,
  };
  /**
   * Usage incurred INSIDE proxied Geniro tools (embeddings, nested LLM calls),
   * reported by the host dispatcher. Tracked apart from `usageTotals`: the
   * SDK's result-message turn totals know nothing about host-side tool spend,
   * so folding it into `usageTotals` would corrupt the residual reconciliation
   * in `reconcileTurnUsage`. Rollup surfaces (snapshot, total price) sum both.
   */
  private toolUsageTotals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalPrice: 0,
  };
  /**
   * FIFO of dispatcher-reported usages per tool name, stamped as
   * `__toolTokenUsage` onto the next synthesized ToolMessage of that name.
   * The bridge correlation id and the SDK `tool_use_id` are different id
   * spaces, so name-FIFO is the only available join; concurrent same-name
   * calls can at worst swap attribution between sibling calls of the same
   * tool on the same node — every rollup above per-call granularity is
   * unaffected.
   */
  private readonly pendingToolUsage = new Map<string, RequestTokenUsage[]>();
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
    return this.usageTotals.totalPrice + this.toolUsageTotals.totalPrice;
  }

  /**
   * Run-scoped aggregate (LLM + proxied-tool spend) — the source for
   * `AgentOutput.statistics.usage`, which relays fold into a caller's state.
   */
  getTotalUsage(): RequestTokenUsage {
    return {
      inputTokens:
        this.usageTotals.inputTokens + this.toolUsageTotals.inputTokens,
      cachedInputTokens:
        this.usageTotals.cachedInputTokens +
        this.toolUsageTotals.cachedInputTokens,
      outputTokens:
        this.usageTotals.outputTokens + this.toolUsageTotals.outputTokens,
      totalTokens:
        this.usageTotals.totalTokens + this.toolUsageTotals.totalTokens,
      totalPrice: this.usageTotals.totalPrice + this.toolUsageTotals.totalPrice,
    };
  }

  /** Host-dispatcher hook: usage a proxied Geniro tool incurred while executing. */
  recordToolUsage(toolName: string, usage: RequestTokenUsage): void {
    const queue = this.pendingToolUsage.get(toolName) ?? [];
    queue.push(usage);
    this.pendingToolUsage.set(toolName, queue);
    this.toolUsageTotals.inputTokens += usage.inputTokens;
    this.toolUsageTotals.cachedInputTokens += usage.cachedInputTokens ?? 0;
    this.toolUsageTotals.outputTokens += usage.outputTokens;
    this.toolUsageTotals.totalTokens += usage.totalTokens;
    this.toolUsageTotals.totalPrice += usage.totalPrice ?? 0;
  }

  /**
   * Host-dispatcher hook: name-FIFO join from a dispatcher tool name to the SDK
   * `tool_use_id` of the next pending forwarded call, consuming it. The bridge
   * correlation id (`request.id`) and the SDK `tool_use_id` live in different id
   * spaces, so name-FIFO is the only host-side join available. The dispatcher
   * stamps the resolved id as `__toolCallId` so a delegated agent's inner
   * messages carry the SAME id the parent AI message recorded for the
   * `communication_exec` tool call — which is the id the UI groups Communication
   * blocks by. Returns `undefined` when no pending id matches (the dispatcher
   * falls back to its own `request.id`). Concurrent same-name calls can at worst
   * swap attribution between siblings; every rollup above per-call granularity
   * is unaffected (same caveat as the usage FIFO).
   */
  resolveToolUseId(toolName: string): string | undefined {
    const name = this.normalizeToolName(toolName);
    const ids = this.pendingToolUseIds.get(name);
    if (!ids?.length) {
      return undefined;
    }
    const id = ids.shift();
    if (ids.length === 0) {
      this.pendingToolUseIds.delete(name);
    }
    return id;
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
        const assistantMessage = message as SdkAssistantMessage;
        this.relocateSplitUsageToToolFrame(assistantMessage);
        this.flush();
        this.onAssistant(assistantMessage);
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
        const rawName = block.name as string;
        const name = this.normalizeToolName(rawName);
        this.pendingToolNames.set(block.id as string, name);
        // Built-in SDK tools (Bash/Read/Edit) run in-sandbox and never produce
        // a host `tool_call_request`, so only `mcp__geniro__`-forwarded tools
        // are queued (under the bare name) — queuing a built-in would drift the
        // FIFO vs host dispatch.
        if (rawName.startsWith(GENIRO_MCP_PREFIX)) {
          const ids = this.pendingToolUseIds.get(name) ?? [];
          ids.push(block.id as string);
          this.pendingToolUseIds.set(name, ids);
        }
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
      // Count a given SDK message id's usage exactly once — see
      // `usageStampedMessageIds`. A repeat frame of the same id (text→tool_use
      // split) must NOT re-stamp `__requestUsage` or re-accumulate, or the turn
      // is billed twice. Frames without an id can't be deduped — stamp as before.
      const messageId = message.message.id;
      const usageAlreadyCounted =
        !!messageId && this.usageStampedMessageIds.has(messageId);
      const usageToStamp = usage && !usageAlreadyCounted ? usage : undefined;

      aiMessage = new AIMessage({
        content: text,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      });
      if (messageId) {
        aiMessage.id = messageId;
      }
      aiMessage.additional_kwargs = {
        ...this.subagentKwargs(message.parent_tool_use_id),
        __model: model,
        ...(usageToStamp && { __requestUsage: usageToStamp }),
        ...(this.answeredToolCallNames.length > 0 && {
          __answeredToolCallNames: [...this.answeredToolCallNames],
        }),
      };
      this.answeredToolCallNames = [];
      built.push(aiMessage);

      if (usageToStamp) {
        this.accumulateUsage(usageToStamp);
        if (messageId) {
          this.usageStampedMessageIds.add(messageId);
        }
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
      const toolUsage = name ? this.takeToolUsage(name) : undefined;
      toolMessage.additional_kwargs = {
        ...this.subagentKwargs(message.parent_tool_use_id),
        ...(block.is_error === true && { __toolError: true }),
        ...(toolUsage && { __toolTokenUsage: toolUsage }),
      };
      built.push(toolMessage);
    }

    this.emitMessages(built);
  }

  private onResult(message: SdkResultMessage): void {
    this.sessionId = message.session_id || this.sessionId;
    // `subtype` crosses the sandbox trust boundary and is rendered verbatim into
    // a user-visible failure message (claude-agent.emitSessionFailureMessage), so
    // guard it structurally: a non-string (crafted/garbage frame) collapses to
    // undefined rather than reaching the conversation as `[object Object]`.
    this.resultSubtype =
      typeof message.subtype === 'string' ? message.subtype : undefined;
    this.isError =
      message.is_error === true || this.resultSubtype !== 'success';
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
   *
   * Multi-result sessions (a mid-run `user_message` injection can extend the
   * query past its first result): the math assumes the SDK reports
   * `usage`/`total_cost_usd` CUMULATIVELY per query() call, so subtracting
   * the running totals yields each result's increment. If a future SDK
   * reports per-turn numbers instead, residuals clamp to 0 and under-count —
   * verify empirically when the live-LLM harness is available (M3).
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

    // The turn's total input (regular + cache-create + cache-read) is the size
    // of the prompt sent this turn — the best available proxy for "current
    // context" on the bridge pipeline, where per-message passthrough usage is
    // all zeros and only the SDK result carries real numbers. It is point-in-
    // time (NOT additive): SET on the stamped message, and the thread rollup
    // takes the max across turns (ThreadsService.getThreadUsageStatistics), the
    // same shape SimpleAgent uses. Exact for a single LLM call; a cumulative
    // upper bound for multi-call agentic turns. Mirrors accumulateUsage's
    // `> 0` guard so a usage-less result never wipes a good value.
    const turnContext = turnUsage.inputTokens;
    if (turnContext > 0) {
      this.currentContext = turnContext;
    }

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
        __requestUsage: {
          ...residual,
          ...(turnContext > 0 && { currentContext: turnContext }),
        },
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
      // Point-in-time: take the latest turn's value, not a sum.
      ...(turnContext > 0 && { currentContext: turnContext }),
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

  private takeToolUsage(name: string): RequestTokenUsage | undefined {
    const queue = this.pendingToolUsage.get(name);
    if (!queue?.length) {
      return undefined;
    }
    const usage = queue.shift();
    if (queue.length === 0) {
      this.pendingToolUsage.delete(name);
    }
    return usage;
  }

  private emitStateSnapshot(): void {
    const configuredLimit =
      this.params.config.configurable?.effective_cost_limit_usd;
    this.params.emit({
      type: 'stateUpdate',
      data: {
        threadId: this.params.threadId,
        stateChange: {
          // LLM + proxied-tool usage combined — same fold ToolExecutorNode
          // applies when it spreads aggregated tool usage into agent state.
          inputTokens:
            this.usageTotals.inputTokens + this.toolUsageTotals.inputTokens,
          cachedInputTokens:
            this.usageTotals.cachedInputTokens +
            this.toolUsageTotals.cachedInputTokens,
          outputTokens:
            this.usageTotals.outputTokens + this.toolUsageTotals.outputTokens,
          totalTokens:
            this.usageTotals.totalTokens + this.toolUsageTotals.totalTokens,
          totalPrice:
            this.usageTotals.totalPrice + this.toolUsageTotals.totalPrice,
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

  private subtractFromTotals(usage: RequestTokenUsage): void {
    this.usageTotals.inputTokens -= usage.inputTokens;
    this.usageTotals.cachedInputTokens -= usage.cachedInputTokens ?? 0;
    this.usageTotals.outputTokens -= usage.outputTokens;
    this.usageTotals.totalTokens -= usage.totalTokens;
    this.usageTotals.totalPrice -= usage.totalPrice ?? 0;
  }

  /**
   * Text→tool_use split: the SDK can stream one assistant message as a text
   * frame followed by a same-id tool_use frame, both carrying the message's
   * usage. The `usageStampedMessageIds` guard keeps the count on the FIRST
   * frame (the text part), but the tool-call frame is what renders as the
   * working block — the natural home for the turn's cost. When the incoming
   * frame is the tool part of the still-buffered text frame, strip the usage
   * off the (about-to-flush) text frame so `onAssistant` re-stamps it on the
   * tool frame. Net effect: counted exactly once, attributed to the working
   * block. If the tool frame itself carries no per-frame usage, the result
   * reconcile lands the residual on it instead (it is the last buffered
   * message), so the cost still renders on the working block.
   */
  private relocateSplitUsageToToolFrame(incoming: SdkAssistantMessage): void {
    const buffered = this.pendingAssistant?.aiMessage;
    const incomingId = incoming.message.id;
    if (!buffered || !incomingId || buffered.id !== incomingId) {
      return;
    }
    // Only move FROM a text frame (no tool calls) TO a tool frame.
    if (Array.isArray(buffered.tool_calls) && buffered.tool_calls.length > 0) {
      return;
    }
    const rawBlocks = incoming.message.content;
    const incomingHasToolUse =
      Array.isArray(rawBlocks) &&
      rawBlocks.some(
        (block): block is SdkContentBlock =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'tool_use',
      );
    if (!incomingHasToolUse) {
      return;
    }
    const existing = buffered.additional_kwargs.__requestUsage as
      | RequestTokenUsage
      | undefined;
    if (!existing) {
      return;
    }
    this.subtractFromTotals(existing);
    this.usageStampedMessageIds.delete(incomingId);
    const kwargs = { ...buffered.additional_kwargs };
    delete kwargs.__requestUsage;
    buffered.additional_kwargs = kwargs;
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
