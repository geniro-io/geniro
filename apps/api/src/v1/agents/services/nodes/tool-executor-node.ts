import {
  AIMessage,
  BaseMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import {
  DynamicStructuredTool,
  ToolRunnableConfig,
} from '@langchain/core/tools';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { DefaultLogger } from '@packages/common';
import { isPlainObject, keyBy } from 'lodash';
import { stringify as stringifyYaml } from 'yaml';

import {
  BuiltAgentTool,
  ToolInvokeResult,
} from '../../../agent-tools/tools/base-tool';
import type { RequestTokenUsage } from '../../../litellm/litellm.types';
import type { LitellmService } from '../../../litellm/services/litellm.service';
import { CostLimitExceededError } from '../../agents.errors';
import {
  BaseAgentConfigurable,
  BaseAgentState,
  BaseAgentStateChange,
} from '../../agents.types';
import {
  stripProxyPrefix,
  updateMessagesListWithMetadata,
} from '../../agents.utils';
import { BaseNode } from './base-node';

/**
 * Number of consecutive all-error tool batches with the same error message
 * before the circuit breaker injects a stop message.
 */
const CIRCUIT_BREAKER_THRESHOLD = 3;

export class ToolExecutorNode extends BaseNode<
  BaseAgentState,
  BaseAgentStateChange
> {
  private maxOutputChars: number;
  private readonly enforceCostLimit: boolean;

  /** Tracks consecutive identical tool-error batches for circuit breaking. */
  private consecutiveErrorMessage: string | null = null;
  private consecutiveErrorCount = 0;

  constructor(
    private tools: DynamicStructuredTool[],
    private readonly litellmService: LitellmService,
    opts?: {
      maxOutputChars?: number;
      /**
       * When true, the node enforces the effective cost limit read from
       * `config.configurable.effective_cost_limit_usd` BEFORE invoking any
       * tools in a batch. Subagents pass false (parent ToolExecutorNode
       * enforces after the subagent-tool returns).
       */
      enforceCostLimit?: boolean;
    },
    private readonly logger?: DefaultLogger,
    private readonly deferredToolResolver?: (name: string) => {
      tool: DynamicStructuredTool;
      instructions?: string;
    } | null,
  ) {
    super();
    this.maxOutputChars = opts?.maxOutputChars ?? 500_000;
    this.enforceCostLimit = opts?.enforceCostLimit ?? false;
  }

  async invoke(
    state: BaseAgentState,
    cfg: LangGraphRunnableConfig<BaseAgentConfigurable>,
  ): Promise<BaseAgentStateChange> {
    const last = state.messages[state.messages.length - 1];
    const ai = last instanceof AIMessage ? last : undefined;
    const calls = ai?.tool_calls || [];

    if (!calls.length) {
      return {
        messages: { mode: 'append', items: [] },
      };
    }

    const toolsMap = keyBy(this.tools, 'name');
    const toolNameSet = new Set(Object.keys(toolsMap));

    // Normalise tool-call IDs: some providers (e.g. Gemini via LiteLLM) may
    // return tool_calls with undefined ids.  ToolMessages require a matching
    // tool_call_id, and filterMessagesForLlm uses strict ID matching to pair
    // AI ↔ ToolMessage.  By backpatching generated IDs onto the AIMessage we
    // guarantee the pair always matches.
    for (const tc of calls) {
      if (!tc.id) {
        tc.id = `generated_id_${Math.random().toString(36).slice(2)}`;
      }
    }

    // Pre-invocation cost-limit check. If the agent's cumulative spend has
    // already met or exceeded the configured budget, refuse to spawn more
    // tool invocations (which may in turn spawn more LLM calls). Mirrors
    // InvokeLlmNode's pre-LLM check — same state field, same comparison.
    // Parents enforce; subagents pass enforceCostLimit=false because the
    // parent's ToolExecutorNode enforces after the subagent-tool returns.
    if (this.enforceCostLimit) {
      const effectiveLimit =
        typeof cfg.configurable?.effective_cost_limit_usd === 'number'
          ? cfg.configurable.effective_cost_limit_usd
          : null;
      if (effectiveLimit !== null && state.totalPrice >= effectiveLimit) {
        // Pre-invocation: no in-flight messages exist yet (no LLM call has been made
        // in this node). The 2-arg ctor is intentional. Asymmetric with the
        // post-tool-aggregate throw further below which DOES carry interleavedMessages
        // — see Step 5 sister-site fix.
        throw new CostLimitExceededError(effectiveLimit, state.totalPrice);
      }
    }

    const results = await Promise.all(
      calls.map(async (tc) => {
        const callId = tc.id!;

        // Defence-in-depth: InvokeLlmNode.stripProxyToolNamePrefix() already
        // cleans "proxy_" prefixes from tool calls before they are stored.
        // This secondary check catches edge cases (e.g. loaded from older
        // checkpoints that were persisted before the upstream fix).
        tc.name = stripProxyPrefix(tc.name, toolNameSet);

        let tool = toolsMap[tc.name];

        const makeMsg = (
          content: string,
          messageMetadata?: ToolInvokeResult<unknown>['messageMetadata'],
        ) =>
          new ToolMessage({
            tool_call_id: callId,
            name: tc.name,
            content,
            ...(messageMetadata ? { additional_kwargs: messageMetadata } : {}),
          });

        const makeErrorMsg = (
          content: string,
          messageMetadata?: ToolInvokeResult<unknown>['messageMetadata'],
        ) =>
          new ToolMessage({
            tool_call_id: callId,
            name: tc.name,
            content: JSON.stringify({ error: content }),
            ...(messageMetadata ? { additional_kwargs: messageMetadata } : {}),
          });

        let autoLoadedToolName: string | undefined;

        // Deferred tool auto-load fallback
        if (!tool && this.deferredToolResolver) {
          const resolved = this.deferredToolResolver(tc.name);
          if (resolved) {
            tool = resolved.tool;
            toolsMap[tc.name] = resolved.tool;
            autoLoadedToolName = tc.name;
          }
        }

        if (!tool) {
          return {
            toolName: tc.name,
            toolMessage: makeErrorMsg(`Tool '${tc.name}' not found.`),
            stateChange: undefined as unknown,
            stateChangeKey: undefined,
            toolRequestUsage: undefined,
            additionalMessages: undefined,
            stopReason: undefined,
            stopCostUsd: undefined,
          };
        }

        const streamedMessages: BaseMessage[] = [];

        try {
          const toolMetadata = state.toolsMetadata?.[tc.name];
          const builtTool = tool as unknown as BuiltAgentTool;
          const runnableConfig: ToolRunnableConfig<BaseAgentConfigurable> = {
            configurable: {
              ...(cfg.configurable ?? {}),
              ...(toolMetadata !== undefined ? { toolMetadata } : {}),
              __toolCallId: callId,
            },
            signal: cfg.signal,
          };

          let toolInvokeResult: ToolInvokeResult<unknown>;

          if (builtTool.__streamingInvoke) {
            // Streaming path: call __streamingInvoke directly (bypasses LangChain wrapper)
            const gen = builtTool.__streamingInvoke(
              tc.args,
              runnableConfig,
              toolMetadata,
            );

            const callerAgent = cfg.configurable?.caller_agent;
            const threadId = String(cfg.configurable?.thread_id ?? '');

            let iterResult = await gen.next();
            while (!iterResult.done) {
              const messages = iterResult.value;
              if (messages.length > 0) {
                // Mark messages as:
                // - __streamedRealtime: already emitted in real-time (skip in emitNewMessages)
                // - __hideForLlm: don't include in LLM context (subagent internal messages)
                // - __toolCallId: link to the parent tool call for UI grouping
                for (const msg of messages) {
                  msg.additional_kwargs = {
                    ...(msg.additional_kwargs ?? {}),
                    __streamedRealtime: true,
                    __hideForLlm: true,
                    __toolCallId: callId,
                  };
                }
                streamedMessages.push(...messages);

                // Emit in real-time for WebSocket delivery
                if (callerAgent) {
                  callerAgent.emit({
                    type: 'message',
                    data: {
                      threadId,
                      messages: updateMessagesListWithMetadata(messages, cfg),
                      config: cfg,
                    },
                  });
                }
              }
              iterResult = await gen.next();
            }
            toolInvokeResult = iterResult.value;
          } else {
            const rawResult = (await tool.invoke<
              unknown,
              ToolRunnableConfig<BaseAgentConfigurable>
            >(tc.args, runnableConfig)) as unknown;
            toolInvokeResult = rawResult as ToolInvokeResult<unknown>;
          }

          const {
            output,
            messageMetadata,
            stateChange,
            stateChangeKey,
            toolRequestUsage,
            additionalMessages: toolAdditionalMessages,
            stopReason: toolStopReason,
            stopCostUsd: toolStopCostUsd,
          } = toolInvokeResult;

          // Merge streamed messages with any additional messages from the final result
          const additionalMessages = [
            ...streamedMessages,
            ...(toolAdditionalMessages ?? []),
          ];

          const finalMetadata = autoLoadedToolName
            ? {
                ...(messageMetadata ?? {}),
                __loadedTools: [autoLoadedToolName],
              }
            : messageMetadata;

          const content = this.formatToolOutputForLlm(output);

          if (content.length > this.maxOutputChars) {
            const trimmed = content.slice(0, this.maxOutputChars);
            const suffix = `\n\n[output trimmed to ${this.maxOutputChars} characters from ${content.length}]`;

            return {
              toolName: tc.name,
              toolMessage: makeMsg(`${trimmed}${suffix}`, finalMetadata),
              stateChange,
              stateChangeKey,
              toolRequestUsage,
              additionalMessages:
                additionalMessages.length > 0 ? additionalMessages : undefined,
              stopReason: toolStopReason,
              stopCostUsd: toolStopCostUsd,
            };
          }

          return {
            toolName: tc.name,
            toolMessage: makeMsg(content, finalMetadata),
            stateChange,
            stateChangeKey,
            toolRequestUsage,
            additionalMessages:
              additionalMessages.length > 0 ? additionalMessages : undefined,
            stopReason: toolStopReason,
            stopCostUsd: toolStopCostUsd,
          };
        } catch (e) {
          const err = e as Error;
          const isAbortError = err?.name === 'AbortError';

          if (!isAbortError) {
            this.logger?.error(err, `Error executing tool '${tc.name}'`, {
              toolName: tc.name,
              callId,
            });
          }
          return {
            toolName: tc.name,
            toolMessage: makeErrorMsg(
              `Error executing tool '${tc.name}': ${err?.message || String(err)}`,
            ),
            stateChange: undefined as unknown,
            stateChangeKey: undefined,
            toolRequestUsage: undefined,
            // Preserve messages already emitted in real-time before the error
            additionalMessages:
              streamedMessages.length > 0 ? streamedMessages : undefined,
            stopReason: undefined,
            stopCostUsd: undefined,
          };
        }
      }),
    );

    // Build interleaved message list: each tool message followed by its additionalMessages
    const interleavedMessages: BaseMessage[] = [];

    for (const result of results) {
      const toolMsg = result?.toolMessage;

      if (!toolMsg) {
        continue;
      }

      // Attach token usage to tool message:
      // - __requestUsage = parent LLM call (consistent with AI messages)
      // - __toolTokenUsage = tool's own execution cost (e.g. subagent aggregate)
      const parentRequestUsage = ai?.additional_kwargs?.__requestUsage as
        | RequestTokenUsage
        | undefined;
      if (parentRequestUsage || result.toolRequestUsage) {
        toolMsg.additional_kwargs = {
          ...(toolMsg.additional_kwargs ?? {}),
          ...(parentRequestUsage ? { __requestUsage: parentRequestUsage } : {}),
          ...(result.toolRequestUsage
            ? { __toolTokenUsage: result.toolRequestUsage }
            : {}),
        };
      }

      interleavedMessages.push(toolMsg);

      // Clear the inFlight slot for this subagent tool call on the frontend.
      // Sentinel 0 clears the inFlightSubagentPrice entry for this toolCallId on
      // the frontend reducer — value 0 signals DELETE, not "$0 spent". Using a
      // sentinel rather than omitting the key keeps the reducer commutative: the
      // clear arrives atomically alongside (or just after) the final in-flight
      // value emitted by the subagent, and the frontend merges them safely in
      // FIFO order without needing a tombstone protocol. Cannot signal "absent"
      // vs "zero" over plain JSON, so sentinel 0 is the cleanest contract.
      const isSubagentTool =
        result.toolName === 'subagents_run_task' ||
        result.toolMessage.additional_kwargs?.__subagentCommunication === true;

      if (isSubagentTool) {
        const callIdForClear = toolMsg.tool_call_id;
        const parentThreadId = String(cfg.configurable?.thread_id ?? '');
        cfg.configurable?.caller_agent?.emit({
          type: 'stateUpdate',
          data: {
            threadId: parentThreadId,
            stateChange: {
              inFlightSubagentPrice: { [callIdForClear]: 0 },
            },
            config: cfg,
          },
        });
      }

      // Append any additional messages immediately after the tool result
      if (result.additionalMessages && result.additionalMessages.length > 0) {
        interleavedMessages.push(...result.additionalMessages);
      }
    }

    // --- Circuit breaker: detect repeated identical tool errors ---
    this.updateCircuitBreaker(results);

    if (this.consecutiveErrorCount >= CIRCUIT_BREAKER_THRESHOLD) {
      const stopMessage = new SystemMessage({
        content:
          `CRITICAL: The same tool error has occurred ${this.consecutiveErrorCount} times consecutively: "${this.consecutiveErrorMessage}". ` +
          'This appears to be an infrastructure or configuration issue that cannot be resolved by retrying the same tool call. ' +
          'Stop attempting tool calls and report this error to the user using the finish tool.',
      });
      stopMessage.additional_kwargs = {
        ...(stopMessage.additional_kwargs ?? {}),
        __hideForUi: true,
        __hideForSummary: true,
      };
      interleavedMessages.push(stopMessage);
    }

    // --- Cost-limit propagation: if any tool carried a cost-limit stop signal,
    // re-throw CostLimitExceededError so the parent agent's stream catch path
    // fires exactly as it would for a direct invoke_llm cost-limit throw.
    // The effective limit comes from the runnable config (resolved once upstream
    // by GraphsService.executeTrigger and stored in configurable).
    // Aggregate all tool request usages before cost-limit check so we can fold
    // them into the parent-scope totalSpend on re-throw.
    const aggregatedToolUsage = this.litellmService.sumTokenUsages(
      results.map((r) => r.toolRequestUsage).filter(Boolean),
    );

    const costLimitResult = results.find((r) => r.stopReason === 'cost_limit');
    if (costLimitResult) {
      const effectiveLimit = cfg.configurable?.effective_cost_limit_usd ?? 0;
      const totalSpend = Math.max(
        costLimitResult.stopCostUsd ?? 0,
        // Cost-limit budget guard: unknown pricing on the tool-aggregate
        // (totalPrice?: number) is coerced to 0 so unpriced calls do not
        // consume the user's budget cap — a conservative default. The
        // user-facing cost report (via threads.service aggregation) still
        // surfaces null as $— so the unknown-pricing case is visible, not
        // masked. state.totalPrice is always a number (the state reducer
        // seeds it to 0 and accumulates in-place).
        state.totalPrice + (aggregatedToolUsage?.totalPrice ?? 0),
      );
      throw new CostLimitExceededError(
        effectiveLimit,
        totalSpend,
        updateMessagesListWithMetadata(interleavedMessages, cfg),
      );
    }

    const toolsMetadataUpdate = results.reduce(
      (acc, r) => {
        if (r.stateChange !== undefined) {
          const key = r.stateChangeKey || r.toolName;
          acc[key] = r.stateChange as Record<string, unknown>;
        }
        return acc;
      },
      {} as Record<string, Record<string, unknown>>,
    );

    const messagesWithMetadata = updateMessagesListWithMetadata(
      interleavedMessages,
      cfg,
    );

    // Cumulative state.totalPrice is number; unknown pricing (null) is coerced
    // to 0 when accumulating. See matching handling in invoke-llm-node.
    const aggregatedUsageForState = aggregatedToolUsage
      ? {
          ...aggregatedToolUsage,
          totalPrice:
            typeof aggregatedToolUsage.totalPrice === 'number'
              ? aggregatedToolUsage.totalPrice
              : 0,
        }
      : {};

    return {
      messages: {
        mode: 'append',
        items: messagesWithMetadata,
      },
      toolsMetadata: toolsMetadataUpdate,
      // Spread aggregated tool usage into state (will be added by reducers)
      ...aggregatedUsageForState,
    };
  }

  /**
   * Extracts the error string from a ToolMessage produced by `makeErrorMsg`.
   * Error messages are serialised as `{"error":"..."}`. Returns `null` if the
   * message does not represent an error.
   */
  private extractErrorFromToolMessage(msg: ToolMessage): string | null {
    const content = typeof msg.content === 'string' ? msg.content : null;
    if (!content) {
      return null;
    }

    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'error' in parsed &&
        typeof parsed.error === 'string'
      ) {
        return parsed.error;
      }
    } catch {
      // Not JSON — not an error message
    }
    return null;
  }

  /**
   * Updates the circuit breaker counters after a batch of tool results.
   *
   * If every tool result in the batch is an error AND all share the same
   * error message AND that message matches the previous batch, the counter
   * increments. Otherwise it resets.
   */
  private updateCircuitBreaker(results: { toolMessage?: ToolMessage }[]): void {
    const toolMessages = results
      .map((r) => r.toolMessage)
      .filter((m): m is ToolMessage => m instanceof ToolMessage);

    if (toolMessages.length === 0) {
      this.consecutiveErrorMessage = null;
      this.consecutiveErrorCount = 0;
      return;
    }

    const errorMessages = toolMessages.map((m) =>
      this.extractErrorFromToolMessage(m),
    );

    // Check if ALL results in this batch are errors with the same message
    const allErrors = errorMessages.every((e) => e !== null);
    const uniqueErrors = new Set(errorMessages);
    const sameError = allErrors && uniqueErrors.size === 1;

    if (!sameError) {
      this.consecutiveErrorMessage = null;
      this.consecutiveErrorCount = 0;
      return;
    }

    const batchErrorMessage = errorMessages[0]!;

    if (batchErrorMessage === this.consecutiveErrorMessage) {
      this.consecutiveErrorCount++;
    } else {
      this.consecutiveErrorMessage = batchErrorMessage;
      this.consecutiveErrorCount = 1;
    }
  }

  private formatToolOutputForLlm(output: unknown): string {
    if (typeof output === 'string') {
      const trimmed = output.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return output;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isPlainObject(parsed) && !Array.isArray(parsed)) {
          return output;
        }

        return stringifyYaml(parsed).trimEnd();
      } catch {
        return output;
      }
    }

    if (isPlainObject(output) || Array.isArray(output)) {
      return stringifyYaml(output).trimEnd();
    }

    return JSON.stringify(output);
  }
}
