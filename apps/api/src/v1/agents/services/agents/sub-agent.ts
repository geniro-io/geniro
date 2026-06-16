import { randomUUID } from 'node:crypto';

import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  ChatMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { RunnableConfig } from '@langchain/core/runnables';
import {
  END,
  LangGraphRunnableConfig,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { Injectable, Scope } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import { isPlainObject } from 'lodash';

import { RequestTokenUsage } from '../../../litellm/litellm.types';
import { LitellmService } from '../../../litellm/services/litellm.service';
import { CostLimitExceededError } from '../../agents.errors';
import {
  BaseAgentConfigurable,
  BaseAgentState,
  BaseAgentStateChange,
  SUBAGENT_THREAD_PREFIX,
} from '../../agents.types';
import {
  buildReasoningMessage,
  extractExploredFilesFromMessages,
  extractTextFromResponseContent,
  type ReasoningMessageContext,
  updateMessagesListWithMetadata,
} from '../../agents.utils';
import { InvokeLlmNode } from '../nodes/invoke-llm-node';
import { ToolExecutorNode } from '../nodes/tool-executor-node';
import { AgentOutput, BaseAgent } from './base-agent';

/** Maximum number of empty-response nudges before force-ending the subagent. */
const MAX_EMPTY_RESPONSE_RETRIES = 2;

const EMPTY_RESPONSE_NUDGE =
  'Your previous response was empty — it contained no text and no tool calls. ' +
  'You must either provide a substantive answer to the task, or continue ' +
  'researching by calling the available tools. Do not respond with an empty message.';

export interface SubagentRunStatistics {
  totalIterations: number;
  toolCallsMade: number;
  usage: RequestTokenUsage | null;
}

export interface SubagentRunResult {
  result: string;
  statistics: SubagentRunStatistics;
  /** Deduplicated list of file paths the subagent read or searched during execution. */
  exploredFiles: string[];
  error?: string;
  /**
   * Set to 'cost_limit' when the sub-agent stopped because the thread cost limit
   * was exceeded during its own execution. The parent agent should propagate this
   * to its own stop path.
   */
  stopReason?: 'cost_limit';
  /**
   * Total spend (USD) when the cost limit was hit. Only present when
   * stopReason === 'cost_limit'.
   */
  stopCostUsd?: number;
}

export type SubAgentSchemaType = {
  instructions: string;
  invokeModelName: string;
  /** Maximum LLM iterations before the subagent is force-stopped. */
  maxIterations: number;
  /**
   * Maximum context window size (in tokens) before the subagent is force-stopped.
   * Uses `currentContext` (input tokens from the last LLM call) — the same metric
   * that SimpleAgent uses for summarization thresholds.  When the conversation
   * context exceeds this value the subagent stops with a partial result.
   */
  maxContextTokens?: number;
};

/**
 * Lightweight LangGraph-based subagent that runs a task autonomously.
 *
 * Uses an in-memory checkpointer with a unique thread ID per invocation so
 * that LangGraph properly accumulates state across the invoke_llm → tools
 * loop.  An in-memory saver is used instead of the database-backed one
 * because subagent state is fully ephemeral — it never needs to survive a
 * process restart, and writing to PostgreSQL on every graph step would add
 * unnecessary I/O overhead.
 *
 * Has no finish tool / summarization, but includes an empty-response guard
 * that nudges the LLM when it returns an empty message without tool calls.
 * Completes when the LLM responds with non-empty content and no tool calls.
 *
 * Reuses InvokeLlmNode and ToolExecutorNode for consistent LLM invocation
 * and tool execution with the main agent.
 */
@Injectable({ scope: Scope.TRANSIENT })
export class SubAgent extends BaseAgent<SubAgentSchemaType> {
  private currentConfig?: SubAgentSchemaType;

  constructor(
    private readonly litellmService: LitellmService,
    private readonly logger: DefaultLogger,
  ) {
    super();
  }

  /** No-op — SubAgent lifecycle is controlled by the parent's abort signal. */
  public async stop(): Promise<void> {}

  public setConfig(config: SubAgentSchemaType): void {
    this.currentConfig = config;
  }

  public getConfig(): SubAgentSchemaType {
    if (!this.currentConfig) {
      throw new Error('SubAgent config has not been set.');
    }
    return this.currentConfig;
  }

  public async run(
    threadId: string,
    messages: BaseMessage[],
    _config?: SubAgentSchemaType,
    runnableConfig?: RunnableConfig<BaseAgentConfigurable>,
  ): Promise<AgentOutput> {
    const { result } = await this.runSubagent(messages, runnableConfig);
    return { messages: [new AIMessage(result)], threadId };
  }

  /**
   * Run the subagent loop and return the typed SubagentRunResult.
   *
   * This is the primary entry point used by SubagentsRunTaskTool.
   * Tools must be set via addTool() and config via setConfig() before calling.
   */
  public async runSubagent(
    messages: BaseMessage[],
    runnableConfig?: RunnableConfig<BaseAgentConfigurable>,
  ): Promise<SubagentRunResult> {
    const abortSignal = runnableConfig?.signal;

    // Early abort check
    if (abortSignal?.aborted) {
      return this.abortedResult();
    }

    const config = this.getConfig();
    const toolsArray = Array.from(this.tools.values());
    // Each subagent invocation gets a fresh in-memory checkpointer and thread
    // ID.  The MemorySaver is scoped to this single run and will be GC'd when
    // the method returns — no stale checkpoint data accumulates.
    const checkpointer = new MemorySaver();
    const threadId = `${SUBAGENT_THREAD_PREFIX}${randomUUID()}`;

    const initialMessages = updateMessagesListWithMetadata(
      messages,
      runnableConfig ?? {},
    );

    let totalIterations = 0;
    let toolCallsMade = 0;
    let finalState: BaseAgentState = {
      messages: initialMessages,
      summary: '',
      toolsMetadata: {},
      toolUsageGuardActivated: false,
      toolUsageGuardActivatedCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      totalPrice: 0,
      currentContext: 0,
    };

    // Build subagent configurable: inherit parent config but strip inter-agent
    // communication flags so they don't propagate via updateMessageWithMetadata()
    // into the subagent's internal messages.  Subagent messages get their own
    // __subagentCommunication flag instead.
    const {
      __interAgentCommunication: _stripInterAgent,
      __sourceAgentNodeId: _stripSourceNode,
      ...parentConfigurable
    } = (runnableConfig?.configurable ?? {}) as Record<string, unknown>;

    // Capture parent-context values for reasoning emission.
    // __sourceAgentNodeId is stripped above so we preserve it here before loss.
    // __toolCallId is kept in parentConfigurable but captured separately for clarity.
    const reasoningSourceAgentNodeId =
      typeof _stripSourceNode === 'string' ? _stripSourceNode : undefined;
    const reasoningToolCallId =
      typeof parentConfigurable.__toolCallId === 'string'
        ? parentConfigurable.__toolCallId
        : undefined;
    const reasoningEntries = new Map<string, ChatMessage>();

    const emitContext = {
      threadId,
      toolCallId: reasoningToolCallId,
      sourceAgentNodeId: reasoningSourceAgentNodeId,
      modelName: config.invokeModelName,
      runnableConfig: (runnableConfig ??
        {}) as RunnableConfig<BaseAgentConfigurable>,
    };

    try {
      const [
        useParallelToolCall,
        useResponsesApi,
        useReasoning,
        supportsStreaming,
      ] = await Promise.all([
        toolsArray.length > 0
          ? this.litellmService.supportsParallelToolCall(config.invokeModelName)
          : Promise.resolve(false),
        this.litellmService.supportsResponsesApi(config.invokeModelName),
        this.litellmService.supportsReasoning(config.invokeModelName),
        this.litellmService.supportsStreaming(config.invokeModelName),
      ]);

      const llm = this.buildLLM(config.invokeModelName, {
        useResponsesApi,
        reasoning: useReasoning ? { effort: 'low' } : undefined,
        streaming: supportsStreaming,
      });

      // Cost limit is enforced at the parent's tool-executor, not here —
      // subagent runs unbounded once invoked; overshoot is capped at one
      // subagent-cost.
      const invokeLlmNode = new InvokeLlmNode(
        this.litellmService,
        llm,
        toolsArray,
        {
          systemPrompt: config.instructions,
          toolChoice: toolsArray.length > 0 ? 'auto' : undefined,
          parallelToolCalls: useParallelToolCall,
          enforceCostLimit: false,
        },
        this.logger,
      );

      const toolExecutorNode = new ToolExecutorNode(
        toolsArray,
        this.litellmService,
        undefined,
        this.logger,
      );

      // Guard node: detect empty LLM responses (no tool calls AND no text).
      // If empty and retries remain, inject a nudge message and loop back.
      const emptyResponseGuard = (
        s: BaseAgentState,
        cfg: LangGraphRunnableConfig<BaseAgentConfigurable>,
      ): BaseAgentStateChange => {
        const lastMsg = s.messages.at(-1) as AIMessage;
        const textContent = extractTextFromResponseContent(lastMsg?.content);
        const hasContent = !!textContent;

        if (hasContent) {
          return { toolUsageGuardActivated: false };
        }

        const retriesSoFar = s.toolUsageGuardActivatedCount ?? 0;
        if (retriesSoFar >= MAX_EMPTY_RESPONSE_RETRIES) {
          this.logger.warn(
            `SubAgent empty response guard exhausted (${retriesSoFar}/${MAX_EMPTY_RESPONSE_RETRIES}); ending.`,
          );
          return { toolUsageGuardActivated: false };
        }

        this.logger.warn(
          `SubAgent received empty response; injecting nudge (attempt ${retriesSoFar + 1}/${MAX_EMPTY_RESPONSE_RETRIES}).`,
        );

        const nudge = new SystemMessage({ content: EMPTY_RESPONSE_NUDGE });
        return {
          messages: {
            mode: 'append',
            items: updateMessagesListWithMetadata([nudge], cfg),
          },
          toolUsageGuardActivated: true,
          toolUsageGuardActivatedCount: retriesSoFar + 1,
        };
      };

      const g = new StateGraph({ state: this.buildState() })
        .addNode('invoke_llm', invokeLlmNode.invoke.bind(invokeLlmNode))
        .addNode('tools', toolExecutorNode.invoke.bind(toolExecutorNode))
        .addNode('empty_response_guard', emptyResponseGuard)
        .addEdge(START, 'invoke_llm')
        .addConditionalEdges(
          'invoke_llm',
          (s) => {
            const lastMsg = s.messages.at(-1) as AIMessage;
            const hasToolCalls = (lastMsg?.tool_calls?.length ?? 0) > 0;
            return hasToolCalls ? 'tools' : 'empty_response_guard';
          },
          {
            tools: 'tools',
            empty_response_guard: 'empty_response_guard',
          },
        )
        .addConditionalEdges(
          'empty_response_guard',
          (s) => (s.toolUsageGuardActivated ? 'invoke_llm' : END),
          { invoke_llm: 'invoke_llm', [END]: END },
        )
        .addEdge('tools', 'invoke_llm');

      const compiled = g.compile({
        checkpointer,
      });

      const initialState: BaseAgentStateChange = {
        messages: { mode: 'append', items: initialMessages },
      };

      const stream = await compiled.stream(
        initialState as unknown as Record<string, unknown>,
        {
          ...(runnableConfig ?? {}),
          configurable: {
            ...parentConfigurable,
            thread_id: threadId,
          },
          recursionLimit: config.maxIterations,
          streamMode: ['updates', 'messages'],
          signal: abortSignal,
        },
      );

      // Track the most recent updates-mode node. Same guard as SimpleAgent:
      // leaked messages-mode chunks from nested graphs arrive after the parent's
      // updates/invoke_llm event, so we reject them by checking lastUpdatesNode.
      let lastUpdatesNode: string | null = null;

      for await (const event of stream) {
        const [mode, value] = event as ['updates' | 'messages', unknown];

        if (mode === 'updates') {
          const chunk = value as Record<string, BaseAgentStateChange>;

          for (const [nodeName, nodeState] of Object.entries(chunk)) {
            lastUpdatesNode = nodeName;
            if (!nodeState || typeof nodeState !== 'object') {
              continue;
            }

            const prevMessages = finalState.messages;
            finalState = this.applyChange(finalState, nodeState);

            if (nodeName === 'invoke_llm') {
              totalIterations++;
              // Flush any in-flight reasoning accumulated for this LLM invocation
              // before the node boundary so each invoke_llm reasoning block is
              // emitted as its own persisted message (mirrors SimpleAgent's
              // clearReasoningState({ persist: true }) at the invoke_llm boundary).
              this.flushReasoningEntries(reasoningEntries, emitContext);

              // Emit live cost progress to the parent thread's subscriber so the
              // UI can update the in-flight subagent price header while this
              // subagent is still running.  Skipped for direct SubAgent runs
              // (no parent tool call).
              this.emitInFlightSubagentPrice(
                reasoningToolCallId,
                finalState.totalPrice,
                parentConfigurable.thread_id,
                emitContext.runnableConfig,
              );
            }

            if (nodeName === 'tools') {
              const lastMsg = prevMessages.at(-1) as AIMessage | undefined;
              toolCallsMade += lastMsg?.tool_calls?.length ?? 0;
            }

            // Emit cloned copies of new messages for streaming to parent.
            // cloneMessageForEmit handles reasoning-block stripping and returns
            // null for messages that should be skipped entirely (e.g. AIMessages
            // that contained only reasoning blocks and no text content).
            const newMessages = finalState.messages.slice(prevMessages.length);
            if (newMessages.length > 0) {
              this.emitClonedMessages(
                newMessages,
                threadId,
                (runnableConfig ?? {}) as RunnableConfig<BaseAgentConfigurable>,
              );
            }

            // Check context window size after each node completes.
            // Uses currentContext (input tokens from the last LLM call) — the
            // same metric SimpleAgent uses for its summarization threshold.
            if (
              config.maxContextTokens &&
              finalState.currentContext >= config.maxContextTokens
            ) {
              this.logger.warn(
                `SubAgent hit context limit: ${finalState.currentContext} >= ${config.maxContextTokens}`,
              );
              return this.contextLimitResult(
                finalState,
                totalIterations,
                toolCallsMade,
                config.maxContextTokens,
              );
            }
          }
        } else if (mode === 'messages') {
          const [messageChunk, metadata] = value as [
            AIMessageChunk,
            Record<string, unknown>,
          ];
          // Guard: reject leaked messages-mode chunks from nested graph invocations.
          if (
            metadata.langgraph_node === 'invoke_llm' &&
            lastUpdatesNode !== 'invoke_llm'
          ) {
            this.handleReasoningChunk(
              messageChunk,
              reasoningEntries,
              emitContext,
            );
          }
        }
      }

      // Extract result from last AI message.
      // Content may be a plain string or an array of content blocks
      // (e.g. [{type: "text", text: "..."}]) depending on the provider.
      const lastAiMessage = [...finalState.messages]
        .reverse()
        .find((m) => m instanceof AIMessage) as AIMessage | undefined;

      const resultContent =
        extractTextFromResponseContent(lastAiMessage?.content) ||
        'Task completed.';

      // Aggregate usage — subagent reports only its own spend
      const usage = this.extractUsageFromState(finalState);
      const exploredFiles = extractExploredFilesFromMessages(
        finalState.messages,
      );

      return {
        result: resultContent,
        statistics: {
          totalIterations,
          toolCallsMade,
          usage,
        },
        exploredFiles,
      };
    } catch (err) {
      if (this.isAbortError(err)) {
        return this.abortedResult();
      }
      if (err instanceof CostLimitExceededError) {
        this.logger.warn(
          `SubAgent hit cost limit: $${err.totalPriceUsd.toFixed(4)} (limit: $${err.effectiveLimitUsd.toFixed(4)})`,
        );
        return this.costLimitResult(
          err,
          finalState,
          totalIterations,
          toolCallsMade,
        );
      }
      if (this.isRecursionLimitError(err)) {
        this.logger.warn(
          `SubAgent hit max iterations (${config.maxIterations})`,
        );
        return {
          result: `Subagent reached the maximum iteration limit (${config.maxIterations}) without completing. Partial progress may have been made.`,
          statistics: {
            totalIterations,
            toolCallsMade,
            usage: this.extractUsageFromState(finalState),
          },
          exploredFiles: extractExploredFilesFromMessages(finalState.messages),
          error: 'Max iterations reached',
        };
      }
      // Catch all other errors (LLM auth failures, provider errors, etc.)
      // and convert to a graceful error result instead of crashing.
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        err instanceof Error ? err : new Error(errorMessage),
        `SubAgent failed with unexpected error: ${errorMessage}`,
      );

      return {
        result: `Subagent execution failed: ${errorMessage}`,
        statistics: {
          totalIterations,
          toolCallsMade,
          usage: this.extractUsageFromState(finalState),
        },
        exploredFiles: extractExploredFilesFromMessages(finalState.messages),
        error: errorMessage,
      };
    } finally {
      // Flush any remaining in-flight reasoning on every exit path (normal
      // completion, abort, cost-limit, recursion-limit, context-limit, generic
      // error).  No-op when reasoningEntries is empty.  Mirrors the
      // clearReasoningState({ persist: true }) guarantee in SimpleAgent.
      this.flushReasoningEntries(reasoningEntries, emitContext);
    }
  }

  /**
   * Accumulates reasoning text from a streaming chunk into the provided map,
   * keyed by "reasoning:<blockId>" where blockId is the stable per-block id
   * from the content block (not the chunk's own streaming id, which changes
   * across chunks for some providers like OpenAI via the Responses API).
   *
   * When a new blockId arrives and the map already holds a different in-flight
   * id, the existing entries are flushed first so each provider-assigned block
   * id produces its own persisted message.
   *
   * No-op when no reasoning blocks are found in the chunk.
   */
  private handleReasoningChunk(
    chunk: AIMessageChunk,
    entries: Map<string, ChatMessage>,
    emitContext: {
      threadId: string;
      toolCallId: string | undefined;
      sourceAgentNodeId: string | undefined;
      modelName: string;
      runnableConfig: RunnableConfig<BaseAgentConfigurable>;
    },
  ): void {
    const reasoningEntries = this.extractReasoningFromChunk(chunk);

    if (!reasoningEntries) {
      return;
    }

    const context: ReasoningMessageContext = {
      subagentCommunication: true,
    };
    if (emitContext.toolCallId) {
      context.toolCallId = emitContext.toolCallId;
    }
    if (emitContext.sourceAgentNodeId) {
      context.sourceAgentNodeId = emitContext.sourceAgentNodeId;
    }

    for (const { text, blockId } of reasoningEntries) {
      const reasoningId = `reasoning:${blockId}`;
      const currentEntry = entries.get(reasoningId);

      // When the incoming block belongs to a different id than the one already
      // accumulated, flush the existing entries before starting fresh so per-id
      // boundaries are preserved over the wire.
      if (!currentEntry && entries.size > 0) {
        this.flushReasoningEntries(entries, emitContext);
      }

      const currentContent =
        typeof currentEntry?.content === 'string' ? currentEntry.content : '';
      const nextContent = currentContent + text;

      entries.set(
        reasoningId,
        buildReasoningMessage(nextContent, blockId, context),
      );
    }
  }

  /**
   * Emits each entry in the reasoning map as its own persisted ChatMessage,
   * decorated with subagent-communication tags so the web groups them inside
   * the correct SubagentBlock.  Clears the map after emission.
   *
   * No-op when the map is empty (safe to call on every exit path).
   */
  private flushReasoningEntries(
    entries: Map<string, ChatMessage>,
    emitContext: {
      threadId: string;
      toolCallId: string | undefined;
      sourceAgentNodeId: string | undefined;
      modelName: string;
      runnableConfig: RunnableConfig<BaseAgentConfigurable>;
    },
  ): void {
    if (entries.size === 0) {
      return;
    }

    // Snapshot + clear BEFORE the emit loop so that if any subscriber throws
    // the map is already empty and a subsequent flush call (e.g. in the finally
    // block) won't re-emit the same entries.
    const snapshot = [...entries.values()];
    entries.clear();

    for (const entry of snapshot) {
      const content = typeof entry.content === 'string' ? entry.content : '';
      if (content.length === 0) {
        continue;
      }

      // Rebuild the message so additional_kwargs carries all required tags.
      // We do NOT use updateMessagesListWithMetadata here because the parent's
      // run metadata is already on the runnableConfig; we just need the tags.
      const msg = Object.assign(
        Object.create(Object.getPrototypeOf(entry) as object) as ChatMessage,
        entry,
        {
          additional_kwargs: {
            ...(entry.additional_kwargs ?? {}),
            __subagentCommunication: true,
            ...(emitContext.toolCallId
              ? { __toolCallId: emitContext.toolCallId }
              : {}),
            ...(emitContext.sourceAgentNodeId
              ? { __sourceAgentNodeId: emitContext.sourceAgentNodeId }
              : {}),
            ...(emitContext.modelName
              ? { __model: emitContext.modelName }
              : {}),
          },
        },
      );

      this.emit({
        type: 'message',
        data: {
          threadId: emitContext.threadId,
          messages: [msg],
          config: emitContext.runnableConfig,
        },
      });
    }
  }

  /**
   * Clones new messages (stripping reasoning blocks) and emits them to the
   * parent agent.  No-op when all clones are filtered out.
   */
  private emitClonedMessages(
    messages: BaseMessage[],
    threadId: string,
    config: RunnableConfig<BaseAgentConfigurable>,
  ): void {
    const cloned = messages
      .map((msg) => this.cloneMessageForEmit(msg))
      .filter((msg): msg is BaseMessage => msg !== null);

    if (cloned.length === 0) {
      return;
    }

    this.emit({
      type: 'message',
      data: { threadId, messages: cloned, config },
    });
  }

  /**
   * Clones a message for emission to the parent agent, stripping reasoning
   * content blocks (already emitted as per-id ChatMessages) and tagging with
   * __subagentCommunication.
   *
   * Returns null when the stripped content array is empty — i.e. the original
   * AIMessage contained ONLY reasoning blocks. Emitting an empty clone would
   * render as a blank subagent block on the web.
   */
  private cloneMessageForEmit(msg: BaseMessage): BaseMessage | null {
    // Standalone ChatMessage(role='reasoning') was already persisted via the
    // messages-mode flush path — skip it here to avoid double-persisting.
    const role = (msg as unknown as { role?: unknown }).role;
    if (role === 'reasoning') {
      return null;
    }

    const rawContent = msg.content as unknown;
    const strippedContent = Array.isArray(rawContent)
      ? rawContent.filter(
          (b) =>
            !(
              isPlainObject(b) && (b as { type?: unknown }).type === 'reasoning'
            ),
        )
      : rawContent;

    const reasoningWasRemoved =
      Array.isArray(rawContent) &&
      (strippedContent as unknown[]).length !==
        (rawContent as unknown[]).length;

    if (reasoningWasRemoved && (strippedContent as unknown[]).length === 0) {
      return null;
    }

    return Object.assign(
      Object.create(Object.getPrototypeOf(msg) as object) as BaseMessage,
      msg,
      {
        additional_kwargs: {
          ...(msg.additional_kwargs ?? {}),
          __subagentCommunication: true,
        },
        // Only override content when reasoning blocks were actually removed so
        // HumanMessage / ToolMessage content is untouched and tool_calls on
        // AIMessage are preserved unchanged.
        ...(reasoningWasRemoved ? { content: strippedContent } : {}),
      },
    );
  }

  private isAbortError(err: unknown): boolean {
    const name = (err as { name?: string })?.name;
    const msg = (err as { message?: string })?.message ?? '';
    return name === 'AbortError' || msg.toLowerCase().includes('abort');
  }

  private isRecursionLimitError(err: unknown): boolean {
    const name = (err as { name?: string })?.name;
    return name === 'GraphRecursionError';
  }

  private abortedResult(): SubagentRunResult {
    return {
      result: 'Subagent was aborted.',
      statistics: { totalIterations: 0, toolCallsMade: 0, usage: null },
      exploredFiles: [],
      error: 'Aborted',
    };
  }

  private costLimitResult(
    err: CostLimitExceededError,
    state: BaseAgentState,
    totalIterations: number,
    toolCallsMade: number,
  ): SubagentRunResult {
    return {
      result: `Subagent stopped: cost limit $${err.effectiveLimitUsd.toFixed(2)} reached (total: $${err.totalPriceUsd.toFixed(4)}).`,
      statistics: {
        totalIterations,
        toolCallsMade,
        usage: this.extractUsageFromState(state),
      },
      exploredFiles: extractExploredFilesFromMessages(state.messages),
      error: 'Cost limit reached',
      stopReason: 'cost_limit',
      stopCostUsd: err.totalPriceUsd,
    };
  }

  /**
   * Emits a stateUpdate event carrying the subagent's current cumulative price
   * keyed by the parent's toolCallId, so the parent's subscriber can show live
   * cost progress in the UI.
   *
   * No-op when `reasoningToolCallId` is undefined (direct SubAgent invocation
   * without a parent tool call, i.e. no UI entry to key into).
   * `this.emit()` delegates to Node.js EventEmitter which is a no-op when
   * there are zero listeners — safe to call unconditionally.
   */
  private emitInFlightSubagentPrice(
    reasoningToolCallId: string | undefined,
    totalPrice: number,
    parentThreadIdUnknown: unknown,
    config: RunnableConfig<BaseAgentConfigurable>,
  ): void {
    if (reasoningToolCallId === undefined) {
      return;
    }
    const parentThreadId =
      typeof parentThreadIdUnknown === 'string' ? parentThreadIdUnknown : '';
    this.emit({
      type: 'stateUpdate',
      data: {
        threadId: parentThreadId,
        stateChange: {
          inFlightSubagentPrice: {
            [reasoningToolCallId]: totalPrice,
          },
        },
        config,
      },
    });
  }

  private contextLimitResult(
    state: BaseAgentState,
    totalIterations: number,
    toolCallsMade: number,
    maxContextTokens: number,
  ): SubagentRunResult {
    const lastAiMessage = [...state.messages]
      .reverse()
      .find((m) => m instanceof AIMessage) as AIMessage | undefined;

    const partial =
      extractTextFromResponseContent(lastAiMessage?.content) || '';

    return {
      result:
        partial ||
        `Subagent stopped: context reached ${state.currentContext} tokens (limit: ${maxContextTokens}).`,
      statistics: {
        totalIterations,
        toolCallsMade,
        usage: this.extractUsageFromState(state),
      },
      exploredFiles: extractExploredFilesFromMessages(state.messages),
      error: `Context limit reached (${state.currentContext}/${maxContextTokens})`,
    };
  }
}
