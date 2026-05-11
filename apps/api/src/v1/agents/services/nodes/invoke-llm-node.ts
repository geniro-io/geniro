import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { BaseChatOpenAICallOptions, ChatOpenAI } from '@langchain/openai';
import { DefaultLogger } from '@packages/common';

import { FinishTool } from '../../../agent-tools/tools/core/finish.tool';
import { UsageMetadata } from '../../../litellm/litellm.types';
import type { LitellmService } from '../../../litellm/services/litellm.service';
import { CostLimitExceededError } from '../../agents.errors';
import {
  BaseAgentConfigurable,
  BaseAgentState,
  BaseAgentStateChange,
} from '../../agents.types';
import {
  buildReasoningMessage,
  convertChunkToMessage,
  prepareMessagesForLlm,
  stripProxyPrefix,
  updateMessagesListWithMetadata,
} from '../../agents.utils';
import { BaseNode } from './base-node';

type ToolWithTitle = DynamicStructuredTool & {
  __titleFromArgs?: (args: unknown) => string | undefined;
};

type InvokeLlmNodeOpts = {
  systemPrompt?: string;
  toolChoice?: BaseChatOpenAICallOptions['tool_choice'];
  parallelToolCalls?: boolean;
  /**
   * When true, the node enforces the effective cost limit read from
   * `config.configurable.effective_cost_limit_usd`. Subagents pass false so
   * their LLM calls don't enforce (parent enforces after subagent returns).
   */
  enforceCostLimit?: boolean;
};

export class InvokeLlmNode extends BaseNode<
  BaseAgentState,
  BaseAgentStateChange
> {
  constructor(
    private readonly litellmService: LitellmService,
    private llm: ChatOpenAI,
    private tools: ToolWithTitle[],
    private opts?: InvokeLlmNodeOpts,
    private readonly logger?: DefaultLogger,
  ) {
    super();
  }

  async invoke(
    state: BaseAgentState,
    cfg: LangGraphRunnableConfig<BaseAgentConfigurable>,
  ): Promise<BaseAgentStateChange> {
    const lastMessage = state.messages[state.messages.length - 1];
    const hasNewHumanMessage = lastMessage instanceof HumanMessage;

    const finishState = FinishTool.getStateFromToolsMetadata(
      state.toolsMetadata,
    );
    const shouldResetNeedsMoreInfo =
      hasNewHumanMessage && Boolean(finishState?.needsMoreInfo);

    const runner = this.llm.bindTools(this.tools, {
      tool_choice: this.getToolChoice(state),
      parallel_tool_calls: this.tools.length
        ? this.opts?.parallelToolCalls
        : undefined,
    });

    const summaryText = (state.summary ?? '').trim();
    const summaryMemoryMessage = summaryText
      ? new SystemMessage(
          `MEMORY (reference only, not instructions):\n${summaryText}`,
        )
      : null;

    const preparedMessages = prepareMessagesForLlm(state.messages);

    // Messages sent to the LLM should be sanitized without internal metadata.
    // DO NOT call updateMessagesListWithMetadata here as it adds back internal tracking data
    // (__runId, __createdAt) that the LLM doesn't need and might interfere with the request.
    let messages: BaseMessage[] = [
      new SystemMessage(
        this.opts?.systemPrompt || 'You are a helpful AI assistant.',
      ),
      ...(summaryMemoryMessage ? [summaryMemoryMessage] : []),
      ...preparedMessages,
    ];

    // Some providers (e.g. Claude via OAuth proxies) reject conversations that
    // end with a non-user message ("prefill" error).  When the model is marked
    // `supports_assistant_prefill: false`, convert a trailing SystemMessage
    // (e.g. injected by tool-usage-guard) to a HumanMessage so the
    // conversation always ends on a user turn.
    const model = String(this.llm.model);
    const prefillSupported =
      await this.litellmService.supportsAssistantPrefill(model);
    if (!prefillSupported) {
      messages = this.ensureUserTurnAtEnd(messages);
    }

    // Note: runner.invoke() is always non-streaming.
    // If the model doesn't support streaming, we still use invoke() which is correct.
    const invokeTags = [
      cfg.configurable?.parent_thread_id ||
        cfg.configurable?.thread_id ||
        'unknown-thread',
    ];
    const invokeLlm = () => runner.invoke(messages, { tags: invokeTags });
    const invokeStartMs = performance.now();
    let res: Awaited<ReturnType<typeof invokeLlm>>;

    try {
      res = await this.invokeWithRetry(invokeLlm);
    } catch (error: unknown) {
      if (!this.isPromptTooLongError(error)) {
        throw error;
      }

      // Emergency recovery: the prompt exceeded the model's context limit.
      // Aggressively trim older messages (keep system messages + recent tail)
      // and retry once. The returned state will carry a high currentContext
      // value so the summarize node triggers proper compaction next cycle.
      this.logger?.warn(
        `Prompt too long error detected. Performing emergency message trimming and retrying.`,
      );
      const trimmedMessages = this.emergencyTrimMessages(messages);
      const retryInvoke = () =>
        runner.invoke(trimmedMessages, { tags: invokeTags });
      res = await retryInvoke();
    }
    const durationMs = Math.round(performance.now() - invokeStartMs);

    const preparedRes = convertChunkToMessage(res);
    this.stripProxyToolNamePrefix(preparedRes);
    this.attachToolCallTitles(preparedRes);

    // If this invocation is happening right after tool execution, tag the AI response
    // with the tool-call batch it is responding to. This makes it possible to attribute
    // requestTokenUsage for this message to the preceding tool calls in analytics.
    const answeredToolNames = this.getAnsweredToolCallNames(state.messages);
    if (answeredToolNames && answeredToolNames.length > 0) {
      preparedRes.additional_kwargs = {
        ...(preparedRes.additional_kwargs ?? {}),
        __answeredToolCallNames: answeredToolNames,
      };
    }

    const rawUsage = res.response_metadata?.usage as
      | Record<string, unknown>
      | undefined;
    const normalisedTokens = res.usage_metadata?.total_tokens;
    const rawTokens =
      typeof rawUsage?.total_tokens === 'number'
        ? rawUsage.total_tokens
        : undefined;
    // LangChain@1.3.1 streaming aggregation yields the usage-bearing chunk twice;
    // AIMessageChunk.concat() sums response_metadata.usage.*, so raw cost/total_tokens
    // arrive 2× (or Nx) relative to LangChain's normalised usage_metadata. Divide by
    // the detected multiple to recover the real per-request figure.
    // Non-exact-multiple ratios intentionally pass through uncompensated (conservative fallback).
    const chunkMultiple =
      typeof normalisedTokens === 'number' &&
      typeof rawTokens === 'number' &&
      normalisedTokens > 0 &&
      rawTokens >= normalisedTokens &&
      rawTokens % normalisedTokens === 0
        ? rawTokens / normalisedTokens
        : 1;
    const providerCost =
      typeof rawUsage?.cost === 'number'
        ? rawUsage.cost / chunkMultiple
        : undefined;
    const usageMetadata = {
      ...(res.usage_metadata ?? rawUsage ?? {}),
      // Preserve provider-reported cost (e.g. OpenRouter `usage.cost`) which
      // LangChain's normalised usage_metadata may strip.
      ...(providerCost !== undefined ? { cost: providerCost } : {}),
    };
    const threadUsage = await this.litellmService.extractTokenUsageFromResponse(
      model,
      usageMetadata as UsageMetadata,
    );
    if (threadUsage) {
      threadUsage.durationMs = durationMs;
    }

    // Stamp metadata FIRST so the in-flight message can be persisted on cost-limit throw.
    preparedRes.additional_kwargs = {
      ...preparedRes.additional_kwargs,
      __model: model,
      __requestUsage: threadUsage,
    };

    const out: BaseMessage[] = updateMessagesListWithMetadata(
      [preparedRes],
      cfg,
    );

    // Extract reasoning from contentBlocks.
    // ReasoningAwareChatCompletions ensures providers like DeepSeek
    // produce native reasoning blocks via the ChatDeepSeekTranslator.
    // Reasoning messages carry the same identification kwargs (__model) as the
    // parent AI message so analytics can attribute them to the right model,
    // subagent, or inter-agent communication flow.
    const reasoningMessages = updateMessagesListWithMetadata(
      res.contentBlocks
        .filter((m) => m.type === 'reasoning' && m.reasoning !== '')
        .map((block) => {
          const msg = buildReasoningMessage(String(block.reasoning), res.id);
          msg.additional_kwargs = {
            ...(msg.additional_kwargs ?? {}),
            __model: model,
          };
          return msg;
        }),
      cfg,
    );

    // Enforcement runs against the agent's own accumulated spend combined
    // with the current LLM call's contribution. The parent-level tool-executor
    // is responsible for enforcement at sub-agent boundaries.
    if (this.opts?.enforceCostLimit) {
      const effectiveLimit =
        typeof cfg.configurable?.effective_cost_limit_usd === 'number'
          ? cfg.configurable.effective_cost_limit_usd
          : null;
      // Defense in depth against legacy checkpoints predating state.totalPrice.
      // LangGraph reducer default at base-agent.ts:212-215 is 0 for fresh threads,
      // but pre-fix checkpoints may not encode the field — guard against undefined.
      const projectedTotal =
        (state.totalPrice ?? 0) + (threadUsage?.totalPrice ?? 0);
      if (effectiveLimit !== null && projectedTotal >= effectiveLimit) {
        throw new CostLimitExceededError(effectiveLimit, projectedTotal, [
          ...out,
          ...reasoningMessages,
        ]);
      }
    }

    // Destructure durationMs out of threadUsage — it is per-message metadata
    // stored in __requestUsage on the AI message kwargs, not accumulated state.
    // Cumulative `state.totalPrice` is `number` (the reducer accumulates).
    // Unknown pricing (null) is preserved on the per-message `__requestUsage`
    // kwargs, but the accumulator skips it by coercing to 0 here.
    let stateUsage: Record<string, number> = {};
    if (threadUsage) {
      const { durationMs: _dur, ...rest } = threadUsage;
      stateUsage = {
        ...rest,
        totalPrice: typeof rest.totalPrice === 'number' ? rest.totalPrice : 0,
      };
    }

    return {
      messages: { mode: 'append', items: [...reasoningMessages, ...out] },
      ...stateUsage,
      ...(shouldResetNeedsMoreInfo
        ? {
            toolsMetadata: FinishTool.clearState(),
          }
        : {}),
    };
  }

  private async invokeWithRetry<T>(invoke: () => Promise<T>): Promise<T> {
    const maxRetryMs = 60_000;
    const authRetryDelayMs = 5_000;
    const maxAuthRetries = 2;
    const retryAfterRe = /Please try again in ([0-9.]+)s/i;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });

    const getMessage = (error: unknown): string | undefined => {
      if (typeof error === 'string') {
        return error;
      }
      if (error instanceof Error) {
        return error.message;
      }
      return typeof (error as { message?: unknown })?.message === 'string'
        ? (error as { message: string }).message
        : undefined;
    };

    const getHeaders = (
      error: unknown,
    ): Record<string, string | number | string[]> | undefined =>
      (error as { headers?: Record<string, string | number | string[]> })
        ?.headers ??
      (
        error as {
          response?: { headers?: Record<string, string | number | string[]> };
        }
      )?.response?.headers;

    const getHeader = (
      headers: Record<string, string | number | string[]> | undefined,
      name: string,
    ): string | undefined => {
      if (!headers) {
        return undefined;
      }
      const key = Object.keys(headers).find(
        (h) => h.toLowerCase() === name.toLowerCase(),
      );
      if (!key) {
        return undefined;
      }
      const value = headers[key];
      if (typeof value === 'string') {
        return value;
      }
      if (typeof value === 'number') {
        return String(value);
      }
      if (Array.isArray(value)) {
        return value[0];
      }
      return undefined;
    };

    const parseRetryAfterMs = (value?: string): number | null => {
      if (!value) {
        return null;
      }
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds)) {
        return Math.ceil(seconds * 1000);
      }
      const dateMs = Date.parse(value);
      if (Number.isNaN(dateMs)) {
        return null;
      }
      const diffMs = dateMs - Date.now();
      return diffMs > 0 ? Math.ceil(diffMs) : null;
    };

    const getErrorStatus = (error: unknown): number | undefined => {
      const status =
        (error as { status?: unknown })?.status ??
        (error as { response?: { status?: unknown } })?.response?.status ??
        (error as { statusCode?: unknown })?.statusCode;
      return typeof status === 'number' ? status : undefined;
    };

    const isAuthError = (error: unknown): boolean => {
      const status = getErrorStatus(error);
      if (status === 401 || status === 403) {
        return true;
      }
      const message = getMessage(error);
      return (
        typeof message === 'string' &&
        /AuthenticationError|Unauthorized/i.test(message)
      );
    };

    const getRetryDelayMs = (error: unknown): number | null => {
      const status = getErrorStatus(error);
      const code =
        (error as { code?: unknown })?.code ??
        (error as { error?: { code?: unknown } })?.error?.code;
      const name = (error as { name?: unknown })?.name;
      const message = getMessage(error);
      const isRateLimit =
        status === 429 ||
        code === 'rate_limit_exceeded' ||
        (typeof name === 'string' && name.includes('RateLimit')) ||
        (typeof message === 'string' &&
          message.toLowerCase().includes('rate limit'));
      if (!isRateLimit) {
        return null;
      }

      const headerDelay = parseRetryAfterMs(
        getHeader(getHeaders(error), 'retry-after'),
      );
      if (headerDelay !== null) {
        return headerDelay;
      }

      const match = message?.match(retryAfterRe);
      return match?.[1] ? parseRetryAfterMs(match[1]) : null;
    };

    let authRetries = 0;

    const attempt = async (): Promise<T> => {
      try {
        return await invoke();
      } catch (error: unknown) {
        // Retry transient auth errors (e.g. upstream provider returning 401
        // due to temporary issues like session expiry or provider restarts)
        if (isAuthError(error) && authRetries < maxAuthRetries) {
          authRetries++;
          this.logger?.warn(
            `Auth error (attempt ${authRetries}/${maxAuthRetries}). ` +
              `Retrying LLM call after ${authRetryDelayMs}ms. ` +
              `Error: ${getMessage(error)}`,
          );
          await sleep(authRetryDelayMs);
          return attempt();
        }

        const retryDelayMs = getRetryDelayMs(error);
        if (retryDelayMs === null) {
          throw error;
        }

        if (retryDelayMs > maxRetryMs) {
          const retrySeconds = Math.ceil(retryDelayMs / 1000);
          throw new Error(
            `Rate limit retry delay ${retrySeconds}s exceeds 60s.`,
            { cause: error },
          );
        }

        this.logger?.warn(
          `Rate limit hit. Retrying LLM call after ${retryDelayMs}ms.`,
        );
        await sleep(retryDelayMs);
        return invoke();
      }
    };

    return attempt();
  }

  /**
   * Strips "proxy_" prefixes injected by OAuth proxies (e.g. CLIProxyAPI)
   * from tool_calls and additional_kwargs.tool_calls so the stored AIMessage
   * (and therefore the UI) shows clean tool names.
   */
  private stripProxyToolNamePrefix(msg: AIMessage): void {
    const knownNames = new Set(this.tools.map((t) => t.name));

    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        tc.name = stripProxyPrefix(tc.name, knownNames);
      }
    }

    const kwToolCalls = (msg.additional_kwargs as { tool_calls?: unknown[] })
      ?.tool_calls;
    if (Array.isArray(kwToolCalls)) {
      for (const tc of kwToolCalls) {
        const obj = tc as { function?: { name?: string } };
        if (typeof obj?.function?.name === 'string') {
          obj.function.name = stripProxyPrefix(obj.function.name, knownNames);
        }
      }
    }
  }

  /**
   * If the last message is a SystemMessage, convert it to a HumanMessage.
   * This prevents "assistant message prefill" errors on providers that reject
   * conversations not ending with a user turn.
   */
  private ensureUserTurnAtEnd(messages: BaseMessage[]): BaseMessage[] {
    if (messages.length === 0) {
      return messages;
    }

    const last = messages[messages.length - 1];
    if (!(last instanceof SystemMessage)) {
      return messages;
    }

    const content =
      typeof last.content === 'string'
        ? `[System] ${last.content}`
        : last.content;

    const replacement = new HumanMessage({ content });
    replacement.additional_kwargs = { ...(last.additional_kwargs ?? {}) };

    return [...messages.slice(0, -1), replacement];
  }

  private attachToolCallTitles(msg: ReturnType<typeof convertChunkToMessage>) {
    const calls = msg.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) {
      return;
    }

    const toolMap = new Map(this.tools.map((t) => [t.name, t]));

    msg.tool_calls = calls.map((tc) => {
      // Preserve existing title if already attached upstream
      const existing = (tc as unknown as { __title?: unknown })?.__title;
      if (typeof existing === 'string' && existing.length > 0) {
        return tc;
      }

      const tool = toolMap.get(tc.name);
      const title = tool?.__titleFromArgs?.(tc.args);
      if (!title) {
        return tc;
      }

      return Object.assign({}, tc, { __title: title });
    });
  }

  private getAnsweredToolCallNames(messages: BaseMessage[]): string[] | null {
    // Find the most recent AI message that called tools, and ensure at least one
    // tool result message exists after it (before the next AI message).
    // We only persist tool NAMES for analytics (not call ids).
    // Skip __hideForLlm messages (subagent internals) so we attribute usage
    // to the correct parent-level tool call, not the subagent's internal calls.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!(msg instanceof AIMessage)) {
        continue;
      }
      if (msg.additional_kwargs?.__hideForLlm) {
        continue;
      }

      const toolNames = this.getToolCallNamesFromAiMessage(msg);
      if (toolNames.length === 0) {
        continue;
      }

      const stopAt = (() => {
        for (let j = i + 1; j < messages.length; j++) {
          const m = messages[j]!;
          if (m instanceof AIMessage && !m.additional_kwargs?.__hideForLlm) {
            return j;
          }
        }
        return messages.length;
      })();

      const hasAnyToolResult = messages
        .slice(i + 1, stopAt)
        .some((m) => m.type === 'tool' && !m.additional_kwargs?.__hideForLlm);
      if (!hasAnyToolResult) {
        return null;
      }

      return toolNames;
    }

    return null;
  }

  private getToolCallNamesFromAiMessage(msg: AIMessage): string[] {
    const names: string[] = [];

    const kwToolCalls = msg.tool_calls;
    if (Array.isArray(kwToolCalls)) {
      names.push(...kwToolCalls.map((t) => t.name));
    }

    return Array.from(new Set(names));
  }

  private getToolChoice(
    state: BaseAgentState,
  ): BaseChatOpenAICallOptions['tool_choice'] | undefined {
    if (this.tools.length === 0) {
      return undefined;
    }

    if (this.shouldForceFinishTool(state)) {
      return {
        type: 'function',
        function: { name: FinishTool.TOOL_NAME },
      };
    }

    return this.opts?.toolChoice;
  }

  private shouldForceFinishTool(state: BaseAgentState): boolean {
    const lastMessage = state.messages[state.messages.length - 1];
    if (!(lastMessage instanceof SystemMessage)) {
      return false;
    }

    const kw = lastMessage.additional_kwargs as
      | Record<string, unknown>
      | undefined;
    if (kw?.__requiresFinishTool !== true) {
      return false;
    }

    return this.tools.some((tool) => tool.name === FinishTool.TOOL_NAME);
  }

  /**
   * Detect "prompt is too long" errors from LLM providers.
   * These are typically 400 Bad Request responses with a message about
   * the prompt exceeding the model's context window.
   */
  private isPromptTooLongError(error: unknown): boolean {
    const message =
      error instanceof Error
        ? error.message
        : typeof (error as { message?: unknown })?.message === 'string'
          ? (error as { message: string }).message
          : '';
    const status =
      (error as { status?: unknown })?.status ??
      (error as { statusCode?: unknown })?.statusCode;

    const lower = message.toLowerCase();
    return (
      lower.includes('prompt is too long') ||
      lower.includes('maximum context length') ||
      lower.includes('context_length_exceeded') ||
      (lower.includes('too many tokens') && status === 400)
    );
  }

  /**
   * Emergency message trimming for prompt-too-long recovery.
   *
   * Keeps all system messages (instructions, memory) and approximately the
   * last third of non-system messages. This is a rough heuristic — the goal
   * is to get under the limit so the model can respond. The returned state
   * will carry a high currentContext value to trigger proper summarization
   * on the next cycle.
   *
   * Respects tool-call atomicity: if the trim point falls inside a
   * tool-call roundtrip (AIMessage with tool_calls + their ToolMessages),
   * the entire block is kept or dropped.
   */
  private emergencyTrimMessages(messages: BaseMessage[]): BaseMessage[] {
    const systemMessages = messages.filter((m) => m instanceof SystemMessage);
    const nonSystem = messages.filter((m) => !(m instanceof SystemMessage));

    if (nonSystem.length <= 2) {
      // Nothing meaningful to trim
      return messages;
    }

    // Keep approximately the last third of non-system messages.
    // Walk backwards to find a clean cut point (not inside a tool-roundtrip).
    const keepCount = Math.max(2, Math.ceil(nonSystem.length / 3));
    let cutIndex = nonSystem.length - keepCount;

    // Ensure we don't cut inside a tool-call roundtrip.
    // If the message at cutIndex is a ToolMessage, move forward until we
    // exit the tool block (i.e. reach a non-ToolMessage).
    while (
      cutIndex < nonSystem.length &&
      nonSystem[cutIndex] instanceof ToolMessage
    ) {
      cutIndex++;
    }

    const kept = nonSystem.slice(cutIndex);
    return [...systemMessages, ...kept];
  }
}
