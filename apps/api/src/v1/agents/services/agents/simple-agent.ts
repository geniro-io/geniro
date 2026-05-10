import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  ChatMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { RunnableConfig } from '@langchain/core/runnables';
import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  CompiledStateGraph,
  END,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { Injectable, Scope } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import { v4 } from 'uuid';
import { ZodSchema } from 'zod';

import { BaseMcp } from '../../../agent-mcp/services/base-mcp';
import { zodToAjvSchema } from '../../../agent-tools/agent-tools.utils';
import type { BuiltAgentTool } from '../../../agent-tools/tools/base-tool';
import {
  DeferredToolEntry,
  ToolSearchTool,
} from '../../../agent-tools/tools/common/tool-search.tool';
import { FinishTool } from '../../../agent-tools/tools/core/finish.tool';
import { WaitForTool } from '../../../agent-tools/tools/core/wait-for.tool';
import { GraphExecutionMetadata } from '../../../graphs/graphs.types';
import type { RequestTokenUsage } from '../../../litellm/litellm.types';
import { LitellmService } from '../../../litellm/services/litellm.service';
import { LlmModelsService } from '../../../litellm/services/llm-models.service';
import { CostLimitExceededError } from '../../agents.errors';
import {
  BaseAgentConfigurable,
  BaseAgentState,
  BaseAgentStateChange,
  LLMRequestContext,
  NewMessageMode,
  ReasoningEffort,
} from '../../agents.types';
import {
  buildReasoningMessage,
  markMessageHideForLlm,
  type ReasoningMessageContext,
  updateMessagesListWithMetadata,
} from '../../agents.utils';
import { GraphThreadState } from '../graph-thread-state';
import { InjectPendingNode } from '../nodes/inject-pending-node';
import { InvokeLlmNode } from '../nodes/invoke-llm-node';
import { SummarizeNode } from '../nodes/summarize-node';
import { ToolExecutorNode } from '../nodes/tool-executor-node';
import { ToolUsageGuardNode } from '../nodes/tool-usage-guard-node';
import { PgCheckpointSaver } from '../pg-checkpoint-saver';
import { AgentOutput, AgentRunEvent, BaseAgent } from './base-agent';

export type SimpleAgentSchemaType = {
  name: string;
  description: string;
  instructions: string;
  invokeModelName: string;
  invokeModelReasoningEffort?: ReasoningEffort;
  summarizeMaxTokens?: number;
  summarizeKeepTokens?: number;
  maxIterations?: number;
  newMessageMode?: NewMessageMode;
};

type ActiveRunEntry = {
  abortController: AbortController;
  runnableConfig: RunnableConfig<BaseAgentConfigurable>;
  threadId: string;
  lastState: BaseAgentState;
  stopped?: boolean;
  stopReason?: string;
};

@Injectable({ scope: Scope.TRANSIENT })
export class SimpleAgent extends BaseAgent<SimpleAgentSchemaType> {
  private graph?: CompiledStateGraph<BaseAgentState, Record<string, unknown>>;
  private graphThreadState?: GraphThreadState;
  private graphThreadStateUnsubscribe?: () => void;
  private currentConfig?: SimpleAgentSchemaType;
  private activeRuns = new Map<string, ActiveRunEntry>();
  private mcpServices: BaseMcp[] = [];
  private deferredTools: Map<string, DeferredToolEntry> = new Map();
  private activeTools: DynamicStructuredTool[] = [];
  private initialDeferredSnapshot?: Map<string, DeferredToolEntry>;
  private initialToolsSnapshot?: Map<string, DynamicStructuredTool>;
  private seenThreads = new Set<string>();

  constructor(
    private readonly checkpointer: PgCheckpointSaver,
    private readonly litellmService: LitellmService,
    private readonly logger: DefaultLogger,
    private readonly llmModelsService: LlmModelsService,
  ) {
    super();
  }

  private getActiveRunByThread(threadId: string) {
    for (const run of this.activeRuns.values()) {
      if (run.threadId === threadId) {
        return run;
      }
    }
    return undefined;
  }

  public async initTools(_config: SimpleAgentSchemaType) {
    // ----- core tools (always loaded) -----
    this.addTool(new FinishTool().build({}));
    this.addTool(new WaitForTool().build({}));

    // ----- mcp -----
    for (const mcpService of this.mcpServices) {
      try {
        const mcpTools = await mcpService.discoverTools();

        for (const builtAgentTool of mcpTools) {
          this.addTool(builtAgentTool);
        }
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error : new Error(String(error)),
          `Failed to discover tools from MCP service`,
        );
      }
    }

    // ----- move non-core tools to deferred registry -----
    const coreToolNames = new Set<string>([
      FinishTool.TOOL_NAME,
      WaitForTool.TOOL_NAME,
    ]);
    for (const [name, tool] of this.tools.entries()) {
      if (!coreToolNames.has(name)) {
        this.deferredTools.set(name, {
          tool: tool as BuiltAgentTool,
          description: tool.description,
          instructions: (tool as BuiltAgentTool).__instructions,
        });
        this.tools.delete(name);
      }
    }

    // ----- tool_search (always loaded) -----
    const toolSearchTool = new ToolSearchTool().build({
      deferredTools: this.deferredTools,
      loadTool: this.loadTool.bind(this),
    });
    this.addTool(toolSearchTool);

    // ----- build shared mutable activeTools array -----
    this.activeTools = Array.from(this.tools.values());

    // ----- snapshot the post-init state for per-thread reset -----
    // SimpleAgent instances are shared across all threads for a graph. Without
    // a reset, a tool auto-loaded in one thread stays in activeTools forever,
    // but the <available-tools> block in the baked system prompt still lists
    // it as deferred — so subsequent threads redundantly call tool_search.
    this.initialDeferredSnapshot = new Map(this.deferredTools);
    this.initialToolsSnapshot = new Map(this.tools);
    this.seenThreads.clear();
  }

  /**
   * Restore deferredTools and activeTools to the post-initTools snapshot the
   * first time a given thread invokes the agent. Mutates activeTools in place
   * so the array reference held by InvokeLlmNode and ToolExecutorNode stays
   * valid.
   */
  private ensureInitialToolStateForThread(threadId: string): void {
    if (this.seenThreads.has(threadId)) {
      return;
    }
    this.seenThreads.add(threadId);

    if (!this.initialDeferredSnapshot || !this.initialToolsSnapshot) {
      return;
    }

    this.deferredTools.clear();
    for (const [name, entry] of this.initialDeferredSnapshot) {
      this.deferredTools.set(name, entry);
    }

    this.tools.clear();
    for (const [name, tool] of this.initialToolsSnapshot) {
      this.tools.set(name, tool);
    }

    this.activeTools.length = 0;
    for (const tool of this.tools.values()) {
      this.activeTools.push(tool);
    }
  }

  protected async buildGraph(config: SimpleAgentSchemaType) {
    if (!this.graph) {
      const graphThreadState = new GraphThreadState();
      this.graphThreadStateUnsubscribe?.();
      this.graphThreadStateUnsubscribe = graphThreadState.subscribe(
        this.handleThreadStateChange,
      );

      // ---- summarize ----
      const summarizeNode = new SummarizeNode(
        this.litellmService,
        (_currentContext?: number, llmRequestContext?: LLMRequestContext) =>
          this.buildLLM(
            this.llmModelsService.getSummarizeModel(
              llmRequestContext?.models?.llmMiniModel,
            ),
          ),
        {
          maxTokens: config.summarizeMaxTokens || 272000,
          keepTokens: config.summarizeKeepTokens || 30000,
          tokenCountModel: config.invokeModelName,
        },
        this.logger,
      );

      // ---- invoke ----
      const toolsArray = this.getTools();
      const [
        useResponsesApi,
        useReasoning,
        useParallelToolCall,
        supportsStreaming,
      ] = await Promise.all([
        this.litellmService.supportsResponsesApi(config.invokeModelName),
        this.litellmService.supportsReasoning(config.invokeModelName),
        this.litellmService.supportsParallelToolCall(config.invokeModelName),
        this.litellmService.supportsStreaming(config.invokeModelName),
      ]);

      const invokeLlmNode = new InvokeLlmNode(
        this.litellmService,
        this.buildLLM(config.invokeModelName, {
          useResponsesApi,
          reasoning:
            useReasoning &&
            config.invokeModelReasoningEffort !== ReasoningEffort.None
              ? {
                  effort: config.invokeModelReasoningEffort,
                }
              : undefined,
          streaming: supportsStreaming,
        }),
        toolsArray,
        {
          systemPrompt: config.instructions,
          toolChoice: 'auto',
          parallelToolCalls: useParallelToolCall,
          enforceCostLimit: true,
        },
        this.logger,
      );

      // ---- tool executor ----
      const toolExecutorNode = new ToolExecutorNode(
        toolsArray,
        this.litellmService,
        { enforceCostLimit: true },
        this.logger,
        (name: string) => this.loadTool(name),
      );

      // ---- message injection ----
      const injectPendingNode = new InjectPendingNode(
        graphThreadState,
        this.logger,
      );

      // ---- build ----
      const g = new StateGraph({
        state: this.buildState(),
      })
        .addNode('summarize', summarizeNode.invoke.bind(summarizeNode))
        .addNode('invoke_llm', invokeLlmNode.invoke.bind(invokeLlmNode))
        .addNode('tools', toolExecutorNode.invoke.bind(toolExecutorNode))
        .addNode(
          'inject_pending',
          injectPendingNode.invoke.bind(injectPendingNode),
        )
        // ---- routing ----
        .addEdge(START, 'summarize')
        .addEdge('summarize', 'invoke_llm');

      // ---- tool usage guard (always on) ----
      const toolUsageGuardNode = new ToolUsageGuardNode(
        {
          getRestrictOutput: () => true,
          getRestrictionMessage: () =>
            "You must call the 'finish' tool to end your response. If you have completed the task or have a final answer, call the 'finish' tool with needsMoreInfo=false. If you need more information from the user, call the 'finish' tool with needsMoreInfo=true and include your question in the message.",
          getRestrictionMaxInjections: () => 3,
        },
        this.logger,
      );

      g.addNode(
        'tool_usage_guard',
        toolUsageGuardNode.invoke.bind(toolUsageGuardNode),
      )
        .addConditionalEdges(
          'invoke_llm',
          (s) => {
            const lastMsg = s.messages.at(-1) as AIMessage;
            const hasAnyToolCall = (lastMsg?.tool_calls?.length ?? 0) > 0;
            // If ANY tool was called, execute them. Otherwise check with guard.
            return hasAnyToolCall ? 'tools' : 'tool_usage_guard';
          },
          { tools: 'tools', tool_usage_guard: 'tool_usage_guard' },
        )
        .addConditionalEdges(
          'tool_usage_guard',
          (s) => (s.toolUsageGuardActivated ? 'invoke_llm' : END),
          { invoke_llm: 'invoke_llm', [END]: END },
        )
        .addConditionalEdges(
          'tools',
          (s, cfg) => {
            const threadId = String(cfg.configurable?.thread_id ?? '');
            const { pendingMessages, newMessageMode } =
              graphThreadState.getByThread(threadId);

            const hasPending = pendingMessages.length > 0;
            const mode = newMessageMode ?? NewMessageMode.InjectAfterToolCall;
            const finishState = FinishTool.getStateFromToolsMetadata(
              s.toolsMetadata,
            );
            const waitForState = WaitForTool.getStateFromToolsMetadata(
              s.toolsMetadata,
            );
            const isComplete = Boolean(
              (finishState &&
                (finishState.done || finishState.needsMoreInfo)) ||
              (waitForState && waitForState.waiting),
            );

            if (!isComplete) {
              if (mode === NewMessageMode.InjectAfterToolCall && hasPending) {
                return 'inject_pending';
              }
              // Allow agent to continue working - route back to summarize
              return 'summarize';
            }

            if (hasPending) {
              return 'inject_pending';
            }

            return END;
          },
          {
            inject_pending: 'inject_pending',
            summarize: 'summarize',
            [END]: END,
          },
        )
        .addEdge('inject_pending', 'summarize');

      this.graph = g.compile({
        checkpointer: this.checkpointer,
      }) as CompiledStateGraph<BaseAgentState, Record<string, unknown>>;
      this.graphThreadState = graphThreadState;
    }

    return this.graph;
  }

  private async emitNewMessages(
    messages: BaseMessage[],
    rc: RunnableConfig<BaseAgentConfigurable> | undefined,
    threadId: string,
  ) {
    if (!rc?.configurable?.graph_id) {
      return;
    }
    const runId = rc.configurable.run_id;

    const fresh = messages.filter((m) => {
      const kw = m.additional_kwargs as unknown as Record<string, unknown>;
      // Skip messages already emitted in real-time by streaming tools
      if (kw.__streamedRealtime) {
        return false;
      }
      return kw.__runId === runId || kw.run_id === runId;
    });

    if (fresh.length > 0) {
      const model = this.currentConfig?.invokeModelName;
      if (typeof model === 'string' && model.length > 0) {
        for (const m of fresh) {
          m.additional_kwargs = {
            ...(m.additional_kwargs ?? {}),
            __model: model,
          };
        }
      }
      this.emit({
        type: 'message',
        data: {
          threadId,
          messages: fresh,
          config: rc,
        },
      });
    }
  }

  /**
   * Compute newly introduced messages for a replace-mode update.
   *
   * Replace-mode updates are used for history compaction (e.g. summarization) and may
   * shorten the message list. In that case, naive `slice(beforeLen)` deltas miss new
   * messages inserted during replacement.
   *
   * We treat messages as identical by object identity, which is stable for messages
   * already present in the state. Nodes should avoid cloning existing messages when
   * they only want to keep them.
   */
  private diffNewMessages(
    prev: BaseMessage[],
    next: BaseMessage[],
  ): BaseMessage[] {
    if (!next.length) {
      return [];
    }
    if (!prev.length) {
      return next;
    }

    const prevSet = new Set(prev);
    return next.filter((m) => !prevSet.has(m));
  }

  public getThreadTokenUsage(threadId: string): RequestTokenUsage | null {
    if (!this.graphThreadState) {
      return null;
    }

    const s = this.graphThreadState.getByThread(threadId);
    const hasAny =
      s.inputTokens !== 0 ||
      s.cachedInputTokens !== 0 ||
      s.outputTokens !== 0 ||
      s.reasoningTokens !== 0 ||
      s.totalTokens !== 0 ||
      s.totalPrice !== 0 ||
      s.currentContext !== 0;

    if (!hasAny) {
      return null;
    }

    return {
      inputTokens: s.inputTokens,
      ...(s.cachedInputTokens
        ? { cachedInputTokens: s.cachedInputTokens }
        : {}),
      outputTokens: s.outputTokens,
      ...(s.reasoningTokens ? { reasoningTokens: s.reasoningTokens } : {}),
      totalTokens: s.totalTokens,
      totalPrice: s.totalPrice,
      ...(s.currentContext ? { currentContext: s.currentContext } : {}),
    };
  }

  private syncThreadTotals(threadId: string, state: BaseAgentState) {
    if (!this.graphThreadState) {
      return;
    }
    const prev = this.graphThreadState.getByThread(threadId);
    if (
      prev.inputTokens === state.inputTokens &&
      prev.cachedInputTokens === state.cachedInputTokens &&
      prev.outputTokens === state.outputTokens &&
      prev.reasoningTokens === state.reasoningTokens &&
      prev.totalTokens === state.totalTokens &&
      prev.totalPrice === state.totalPrice &&
      prev.currentContext === state.currentContext
    ) {
      return;
    }
    this.graphThreadState.applyForThread(threadId, {
      inputTokens: state.inputTokens,
      cachedInputTokens: state.cachedInputTokens,
      outputTokens: state.outputTokens,
      reasoningTokens: state.reasoningTokens,
      totalTokens: state.totalTokens,
      totalPrice: state.totalPrice,
      currentContext: state.currentContext,
    });
  }

  private async emitStateUpdate(
    prevState: BaseAgentState,
    nextState: BaseAgentState,
    runnableConfig: RunnableConfig<BaseAgentConfigurable> | undefined,
    threadId: string,
  ) {
    if (!runnableConfig?.configurable?.graph_id) {
      return;
    }

    type StateChangePayload = Partial<BaseAgentState> & {
      effectiveCostLimitUsd?: number | null;
    };

    const stateChange: StateChangePayload = {};

    if (prevState.toolsMetadata !== nextState.toolsMetadata) {
      stateChange.toolsMetadata = nextState.toolsMetadata;
    }

    if (
      prevState.toolUsageGuardActivated !== nextState.toolUsageGuardActivated
    ) {
      stateChange.toolUsageGuardActivated = nextState.toolUsageGuardActivated;
    }

    if (
      prevState.toolUsageGuardActivatedCount !==
      nextState.toolUsageGuardActivatedCount
    ) {
      stateChange.toolUsageGuardActivatedCount =
        nextState.toolUsageGuardActivatedCount;
    }

    if (prevState.inputTokens !== nextState.inputTokens) {
      stateChange.inputTokens = nextState.inputTokens;
    }

    if (prevState.cachedInputTokens !== nextState.cachedInputTokens) {
      stateChange.cachedInputTokens = nextState.cachedInputTokens;
    }

    if (prevState.outputTokens !== nextState.outputTokens) {
      stateChange.outputTokens = nextState.outputTokens;
    }

    if (prevState.reasoningTokens !== nextState.reasoningTokens) {
      stateChange.reasoningTokens = nextState.reasoningTokens;
    }

    if (prevState.totalTokens !== nextState.totalTokens) {
      stateChange.totalTokens = nextState.totalTokens;
    }

    if (prevState.totalPrice !== nextState.totalPrice) {
      stateChange.totalPrice = nextState.totalPrice;
    }

    if (prevState.currentContext !== nextState.currentContext) {
      stateChange.currentContext = nextState.currentContext;
    }

    if (Object.keys(stateChange).length === 0) {
      return;
    }

    // Always include a full token/cost snapshot in every AgentStateUpdate emission.
    // Consumers should be able to treat this event as "current truth" and not have to
    // merge partial diffs while defaulting missing fields to zero.
    stateChange.inputTokens = nextState.inputTokens;
    stateChange.cachedInputTokens = nextState.cachedInputTokens;
    stateChange.outputTokens = nextState.outputTokens;
    stateChange.reasoningTokens = nextState.reasoningTokens;
    stateChange.totalTokens = nextState.totalTokens;
    stateChange.totalPrice = nextState.totalPrice;
    stateChange.currentContext = nextState.currentContext;

    // Read the effective limit from the runnable config — it was resolved once
    // upstream (GraphsService.executeTrigger) and persisted to thread metadata.
    // The agent must not re-resolve on every state update.
    const configuredLimit =
      runnableConfig.configurable?.effective_cost_limit_usd;
    stateChange.effectiveCostLimitUsd =
      typeof configuredLimit === 'number' ? configuredLimit : null;

    this.emit({
      type: 'stateUpdate',
      data: {
        threadId,
        stateChange,
        config: runnableConfig,
      },
    });
  }

  private async appendMessages(
    messages: BaseMessage[],
    activeRun: ActiveRunEntry,
  ): Promise<void> {
    if (!messages.length) {
      return;
    }
    const threadId = activeRun.threadId;

    const updatedMessages = updateMessagesListWithMetadata(
      messages,
      activeRun.runnableConfig,
    );

    if (this.graphThreadState) {
      this.graphThreadState.applyForThread(threadId, {
        pendingMessages: [
          ...this.graphThreadState.getByThread(threadId).pendingMessages,
          ...updatedMessages,
        ],
      });
    }
  }

  private emitNodeAdditionalMetadataUpdate(meta: GraphExecutionMetadata) {
    if (!meta.threadId) {
      return;
    }

    const additionalMetadata = this.getGraphNodeMetadata(meta);
    this.emit({
      type: 'nodeAdditionalMetadataUpdate',
      data: {
        metadata: meta,
        additionalMetadata,
      },
    });
  }

  private handleReasoningChunk(threadId: string, messageChunk: AIMessageChunk) {
    if (!this.graphThreadState) {
      return;
    }

    const reasoningEntries = this.extractReasoningFromChunk(messageChunk);

    if (!reasoningEntries) {
      return;
    }

    const { reasoningChunks: prevReasoningChunks } =
      this.graphThreadState.getByThread(threadId);

    // Read context at chunk-handle time from the active run's configurable.
    const activeRun = this.getActiveRunByThread(threadId);
    const activeRunConfigurable = activeRun?.runnableConfig?.configurable;
    const reasoningContext: ReasoningMessageContext = {};
    if (
      typeof activeRunConfigurable?.__toolCallId === 'string' &&
      activeRunConfigurable.__toolCallId
    ) {
      reasoningContext.toolCallId = activeRunConfigurable.__toolCallId;
    }
    if (activeRunConfigurable?.__subagentCommunication === true) {
      reasoningContext.subagentCommunication = true;
    }
    if (activeRunConfigurable?.__interAgentCommunication === true) {
      reasoningContext.interAgentCommunication = true;
    }
    if (
      typeof activeRunConfigurable?.__sourceAgentNodeId === 'string' &&
      activeRunConfigurable.__sourceAgentNodeId
    ) {
      reasoningContext.sourceAgentNodeId =
        activeRunConfigurable.__sourceAgentNodeId;
    }

    // Build up an updated chunks map by processing each per-block entry.
    // Use prevReasoningChunks as the starting point and mutate a working copy.
    let workingChunks = new Map<string, ChatMessage>(prevReasoningChunks);

    for (const { text, blockId } of reasoningEntries) {
      const reasoningId = `reasoning:${blockId}`;
      const currentEntry = workingChunks.get(reasoningId);

      // When the incoming block belongs to a different id from what is already
      // accumulated, flush the existing in-flight entries as their own persisted
      // ChatMessages before starting fresh for the new id. Each provider-assigned
      // block id represents a distinct reasoning block and must not be concatenated
      // across ids.
      if (!currentEntry && workingChunks.size > 0 && activeRun) {
        this.flushReasoningEntries(
          threadId,
          workingChunks,
          activeRun.runnableConfig,
        );
        workingChunks = new Map<string, ChatMessage>();
      }

      const currentContent =
        typeof currentEntry?.content === 'string' ? currentEntry.content : '';
      const nextContent = currentContent + text;

      workingChunks.set(
        reasoningId,
        buildReasoningMessage(nextContent, blockId, reasoningContext),
      );
    }

    this.graphThreadState.applyForThread(threadId, {
      reasoningChunks: workingChunks,
    });
  }

  /**
   * Emits each entry in the provided reasoningChunks map as its own persisted
   * ChatMessage. Does not clear the in-memory state — callers are responsible
   * for resetting reasoningChunks after calling this method.
   *
   * Each entry is already a fully-formed ChatMessage with the correct id
   * ("reasoning:<parentId>"), role, and additional_kwargs set by
   * buildReasoningMessage at accumulation time. We emit it directly to avoid
   * double-prefixing the id (which would produce "reasoning:reasoning:<parentId>").
   */
  private flushReasoningEntries(
    threadId: string,
    reasoningChunks: Map<string, ChatMessage>,
    config: RunnableConfig<BaseAgentConfigurable>,
  ) {
    for (const entry of reasoningChunks.values()) {
      const content = typeof entry.content === 'string' ? entry.content : '';
      if (content.length === 0) {
        continue;
      }
      // Shallow-clone to avoid mutating the in-memory state entry while
      // updateMessagesListWithMetadata attaches run metadata.
      const reasoningMsg = Object.assign(
        Object.create(Object.getPrototypeOf(entry) as object) as ChatMessage,
        entry,
      );
      const tagged = updateMessagesListWithMetadata([reasoningMsg], config);
      this.emit({
        type: 'message',
        data: {
          threadId,
          messages: tagged,
          config,
        },
      });
    }
  }

  /**
   * Clears the in-memory reasoning chunk state for a thread.
   *
   * @param threadId The external thread ID
   * @param options.persist When true, emits accumulated reasoning as a
   *   persisted message before clearing. Used during abort/stop so partial
   *   reasoning survives page reloads.
   * @param options.config RunnableConfig required when persist is true
   *   (provides run metadata for the emitted message).
   */
  private clearReasoningState(
    threadId: string,
    options?: {
      persist?: boolean;
      config?: RunnableConfig<BaseAgentConfigurable>;
    },
  ) {
    if (!this.graphThreadState) {
      return;
    }

    const { reasoningChunks } = this.graphThreadState.getByThread(threadId);

    if (!reasoningChunks.size) {
      return;
    }

    // Persist accumulated reasoning so it survives page reloads after stop.
    // Each entry in the map corresponds to a distinct provider-assigned reasoning
    // id and is emitted as its own ChatMessage rather than a single joined blob.
    if (options?.persist && options.config) {
      this.flushReasoningEntries(threadId, reasoningChunks, options.config);
    }

    this.graphThreadState.applyForThread(threadId, {
      reasoningChunks: new Map(),
    });
  }

  private formatStoppedReason(reason?: string): string {
    const base = reason ?? 'Graph execution was stopped';
    if (base !== 'Graph execution was stopped') {
      return base;
    }

    const agentName = this.currentConfig?.name;
    if (!agentName) {
      return base;
    }

    return `Graph execution was stopped for agent ${agentName}`;
  }

  private readonly handleThreadStateChange = (threadId: string) => {
    if (!threadId) {
      return;
    }

    const activeRun = this.getActiveRunByThread(threadId);
    const runId = activeRun?.runnableConfig.configurable?.run_id;

    this.emitNodeAdditionalMetadataUpdate({
      threadId,
      ...(runId ? { runId } : {}),
    });
  };

  public override getGraphNodeMetadata(
    meta: GraphExecutionMetadata,
  ): Record<string, unknown> | undefined {
    const instructions = this.currentConfig?.instructions;
    const instructionsMeta = instructions
      ? { instructions: instructions.trim() }
      : undefined;

    const allTools = [
      ...this.getTools(),
      ...Array.from(this.deferredTools.values()).map((e) => e.tool),
    ];

    const connectivityMeta = {
      connectedTools: allTools.map((t) => ({
        name: t.name,
        description: t.description,
        // Use the pre-computed JSON Schema from build() to avoid re-converting
        // Zod schemas at runtime (MCP tool schemas may contain transforms).
        schema:
          (t as BuiltAgentTool).__ajvSchema ??
          zodToAjvSchema(t.schema as ZodSchema),
      })),
    };

    if (!meta?.threadId || !this.graphThreadState) {
      return {
        ...(instructionsMeta ?? {}),
        ...connectivityMeta,
      };
    }

    const threadState = this.graphThreadState.getByThread(meta.threadId);

    return {
      pendingMessages: threadState.pendingMessages.map((msg) => ({
        content: msg.content,
        role: msg.type,
        additionalKwargs: msg.additional_kwargs,
      })),
      reasoningChunks: Array.from(threadState.reasoningChunks.entries()).reduce(
        (res, [id, msg]) => {
          const kwargs = msg.additional_kwargs as Record<string, unknown>;
          const entry: Record<string, unknown> = {
            content: msg.content,
            id: msg.id,
            role: msg.role,
          };
          if (typeof kwargs.__toolCallId === 'string' && kwargs.__toolCallId) {
            entry.toolCallId = kwargs.__toolCallId;
          }
          if (kwargs.__subagentCommunication === true) {
            entry.subagentCommunication = true;
          }
          if (kwargs.__interAgentCommunication === true) {
            entry.interAgentCommunication = true;
          }
          if (
            typeof kwargs.__sourceAgentNodeId === 'string' &&
            kwargs.__sourceAgentNodeId
          ) {
            entry.sourceAgentNodeId = kwargs.__sourceAgentNodeId;
          }
          res[id] = entry;
          return res;
        },
        {} as Record<string, unknown>,
      ),
      ...(instructionsMeta ?? {}),
      ...connectivityMeta,
    };
  }

  public async runOrAppend(
    threadId: string,
    messages: BaseMessage[],
    _config?: SimpleAgentSchemaType,
    runnableConfig?: RunnableConfig<BaseAgentConfigurable>,
  ): Promise<AgentOutput> {
    const config = _config || this.currentConfig;

    if (!config) {
      throw new Error('Agent configuration is required for execution');
    }

    const activeRun = this.getActiveRunByThread(threadId);

    if (!activeRun) {
      return this.run(threadId, messages, config, runnableConfig);
    }

    await this.appendMessages(messages, activeRun);

    return {
      messages: activeRun.lastState.messages,
      threadId,
      checkpointNs: activeRun.runnableConfig?.configurable?.checkpoint_ns,
      needsMoreInfo:
        FinishTool.getStateFromToolsMetadata(activeRun.lastState.toolsMetadata)
          ?.needsMoreInfo === true,
    };
  }

  public async run(
    threadId: string,
    messages: BaseMessage[],
    _config?: SimpleAgentSchemaType,
    runnableConfig?: RunnableConfig<BaseAgentConfigurable>,
  ): Promise<AgentOutput> {
    const runId = runnableConfig?.configurable?.run_id || v4();
    const config = _config || this.currentConfig;

    if (!config) {
      throw new Error('Agent configuration is required for execution');
    }

    const activeRun = this.getActiveRunByThread(threadId);

    if (activeRun) {
      throw new Error('Thread is currently running');
    }

    this.ensureInitialToolStateForThread(threadId);

    const configuredIterations = config.maxIterations ?? 25;
    const requestedRecursionLimit = runnableConfig?.recursionLimit;
    const recursionLimit =
      typeof requestedRecursionLimit === 'number'
        ? Math.min(requestedRecursionLimit, configuredIterations)
        : configuredIterations;

    const mergedConfig: RunnableConfig<BaseAgentConfigurable> = {
      ...(runnableConfig ?? {}),
      configurable: {
        ...(runnableConfig?.configurable ?? {}),
        thread_id: threadId,
        caller_agent: this,
        run_id: runId,
      },
      recursionLimit,
    };

    const updateMessages = updateMessagesListWithMetadata(
      messages,
      mergedConfig,
    );
    const inputMessageSet = new Set(updateMessages);

    const g = await this.buildGraph(config);

    this.graphThreadState?.applyForThread(threadId, {
      newMessageMode: config.newMessageMode,
    });

    const abortController = new AbortController();

    // Load checkpoint state BEFORE streaming to get accumulated token/cost values
    // LangGraph checkpointer stores the full state including our custom fields
    let initialState: BaseAgentState = {
      messages: updateMessages,
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

    // Try to load checkpoint state for accumulated values
    try {
      if (
        g.checkpointer &&
        typeof g.checkpointer === 'object' &&
        'getTuple' in g.checkpointer
      ) {
        const checkpointTuple = await g.checkpointer.getTuple(mergedConfig);
        if (
          checkpointTuple &&
          typeof checkpointTuple === 'object' &&
          'checkpoint' in checkpointTuple
        ) {
          const checkpoint = checkpointTuple.checkpoint;
          if (
            checkpoint &&
            typeof checkpoint === 'object' &&
            'channel_values' in checkpoint
          ) {
            const checkpointState =
              checkpoint.channel_values as unknown as BaseAgentState;
            // Use checkpoint's accumulated values, but keep new messages
            initialState = {
              ...initialState,
              inputTokens: checkpointState.inputTokens || 0,
              cachedInputTokens: checkpointState.cachedInputTokens || 0,
              outputTokens: checkpointState.outputTokens || 0,
              reasoningTokens: checkpointState.reasoningTokens || 0,
              totalTokens: checkpointState.totalTokens || 0,
              totalPrice: checkpointState.totalPrice || 0,
              currentContext: checkpointState.currentContext || 0,
            };
          }
        }
      }
    } catch (error) {
      // If we can't load checkpoint, just start with zeros (first run)
      this.logger.debug(
        'Could not load checkpoint, starting with zero counters',
        {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }

    let finalState: BaseAgentState = initialState;

    const runEntry: ActiveRunEntry = {
      abortController,
      runnableConfig: mergedConfig,
      threadId,
      lastState: finalState,
      stopped: false,
    };

    this.activeRuns.set(runId, runEntry);

    // Emit invoke AFTER `activeRuns.set` so consumers reacting to
    // status=Running (e.g. follow-up triggers calling `runOrAppend`) see the
    // active entry and route via `appendMessages` instead of starting a new
    // run. Otherwise: `executeTrigger`'s eager status flip beats the active
    // mark, and a follow-up trigger arriving in that window starts a parallel
    // `run()` for the same thread instead of appending to the in-flight one.
    this.emit({
      type: 'invoke',
      data: {
        threadId,
        messages: updateMessages,
        config: mergedConfig,
      },
    });

    const initialStateChange: BaseAgentStateChange = {
      messages: {
        mode: 'append',
        items: updateMessages,
      },
      toolsMetadata: {
        ...FinishTool.clearState(),
        ...WaitForTool.clearState(),
      },
      toolUsageGuardActivated: false,
      toolUsageGuardActivatedCount: 0,
    };

    const stream = await g.stream(
      initialStateChange as unknown as Record<string, unknown>,
      {
        ...mergedConfig,
        streamMode: ['updates', 'messages'],
        signal: abortController.signal,
      },
    );

    await this.emitNewMessages(updateMessages, mergedConfig, threadId);

    // Track the most recent updates-mode node. Leaked subagent invoke_llm chunks
    // arrive after the parent's updates/invoke_llm event fires, so we can
    // distinguish them from legitimate parent reasoning chunks.
    let lastUpdatesNode: string | null = null;

    try {
      for await (const event of stream) {
        const [mode, value] = event as ['updates' | 'messages', unknown];

        if (mode === 'updates') {
          const chunk = value as Record<string, BaseAgentStateChange>;

          for (const [_nodeName, nodeState] of Object.entries(chunk)) {
            lastUpdatesNode = _nodeName;
            if (!nodeState || typeof nodeState !== 'object') {
              continue;
            }
            const stateChange = nodeState;

            const beforeLen = finalState.messages.length;
            const prevMessages = finalState.messages;
            const prevState = { ...finalState };

            finalState = this.applyChange(finalState, stateChange);
            this.syncThreadTotals(threadId, finalState);

            // Persist latest state for potential stop handling
            const runRef = this.activeRuns.get(runId);
            if (runRef) {
              runRef.lastState = finalState;
            }

            // Emit notification for new messages.
            //
            // IMPORTANT:
            // Some nodes (e.g. summarize) use `messages.mode = replace` to shrink the history.
            // In that case, `slice(beforeLen)` can be empty even if the replacement introduced
            // new messages (like a summary system marker). We compute a minimal "new messages"
            // delta for replace-mode updates to avoid losing those messages and to avoid re-emitting
            // the entire tail.
            const newMessages =
              stateChange.messages?.mode === 'replace'
                ? this.diffNewMessages(prevMessages, finalState.messages)
                : finalState.messages.slice(beforeLen);
            await this.emitNewMessages(newMessages, mergedConfig, threadId);

            // Emit state update notification (only changed fields)
            await this.emitStateUpdate(
              prevState,
              finalState,
              mergedConfig,
              threadId,
            );

            if (_nodeName === 'invoke_llm') {
              this.clearReasoningState(threadId, {
                persist: true,
                config: mergedConfig,
              });
            }
          }
        } else if (mode === 'messages') {
          const [messageChunk, metadata] = value as [
            AIMessageChunk,
            Record<string, unknown>,
          ];

          // Guard: reject leaked chunks from nested subagent graphs (LangGraph JS
          // leaks messages-mode events from nested compiled.stream() calls into
          // the parent stream; they arrive after the parent's updates/invoke_llm).
          if (
            metadata.langgraph_node === 'invoke_llm' &&
            lastUpdatesNode !== 'invoke_llm'
          ) {
            this.handleReasoningChunk(threadId, messageChunk);
          }
        }
      }
    } catch (err) {
      if (err instanceof CostLimitExceededError) {
        runEntry.stopped = true;
        runEntry.stopReason = 'cost_limit';

        // LiteLLM has already billed the LLM call that tripped the threshold. Persist
        // the in-flight AIMessage (and any reasoning messages) so the per-thread cost
        // rollup includes that spend instead of silently leaking it.
        if (err.inFlightMessages && err.inFlightMessages.length > 0) {
          // Already passed through updateMessagesListWithMetadata at the throw site —
          // emit them as-is. Do NOT re-stamp.
          this.emit({
            type: 'message',
            data: {
              threadId,
              messages: err.inFlightMessages,
              config: mergedConfig,
            },
          });
        }

        // Emit a user-visible SystemMessage describing the cost-limit stop.
        const limitText = err.effectiveLimitUsd.toFixed(2);
        const stopMsg = markMessageHideForLlm(
          new SystemMessage(`Cost limit reached ($${limitText})`),
        );
        const stopMsgs = updateMessagesListWithMetadata(
          [stopMsg],
          mergedConfig,
        );
        this.emit({
          type: 'message',
          data: {
            threadId,
            messages: stopMsgs,
            config: mergedConfig,
          },
        });

        // Emit the stop event so GraphStateManager can deterministically transition
        // the thread to Stopped with stopReason='cost_limit'.
        this.emit({
          type: 'stop',
          data: {
            config: mergedConfig,
            threadId,
            stopReason: 'cost_limit',
            stopCostUsd: err.totalPriceUsd,
          },
        });
      } else {
        const name = (err as { name?: string })?.name;
        const msg = (err as { message?: string })?.message || '';
        const aborted = abortController.signal.aborted;
        if (
          !aborted ||
          (name !== 'AbortError' && !msg.toLowerCase().includes('abort'))
        ) {
          const error = err as Error;

          // Emit a user-visible error message into the thread history
          const errorText = error.message || 'Unknown error';
          const errorMsg = markMessageHideForLlm(
            new AIMessage(`Execution failed: ${errorText}`),
          );
          errorMsg.additional_kwargs = {
            ...(errorMsg.additional_kwargs ?? {}),
            __isErrorMessage: true,
          };
          const errorMsgs = updateMessagesListWithMetadata(
            [errorMsg],
            mergedConfig,
          );
          this.emit({
            type: 'message',
            data: {
              threadId,
              messages: errorMsgs,
              config: mergedConfig,
            },
          });

          // M2: do NOT call this.activeRuns.delete(runId) here — the finally
          // block always runs and handles cleanup to avoid a double-delete.
          this.emit({
            type: 'run',
            data: { threadId, messages, config: mergedConfig, error },
          });

          throw error;
        }
      }
    } finally {
      this.activeRuns.delete(runId);
      // Persist partial reasoning so it survives page reloads after stop/abort.
      // Normal completion already emits reasoning via invoke_llm state changes,
      // so persist=true only matters when the run was interrupted.
      this.clearReasoningState(threadId, {
        persist: true,
        config: mergedConfig,
      });
    }

    const waitForState = WaitForTool.getStateFromToolsMetadata(
      finalState.toolsMetadata,
    );
    const isWaiting = waitForState?.waiting === true;

    const result = {
      // Preserve historical behavior: the AgentOutput is the *new* messages produced by the run,
      // not the initial user input we already provided to the graph.
      messages: finalState.messages.filter((m) => !inputMessageSet.has(m)),
      threadId,
      checkpointNs: mergedConfig?.configurable?.checkpoint_ns,
      needsMoreInfo:
        FinishTool.getStateFromToolsMetadata(finalState.toolsMetadata)
          ?.needsMoreInfo === true,
      waiting: isWaiting,
      ...(isWaiting && waitForState
        ? {
            waitMetadata: {
              durationSeconds: waitForState.durationSeconds,
              checkPrompt: waitForState.checkPrompt,
              reason: waitForState.reason,
            },
          }
        : {}),
    };

    const wasDone =
      FinishTool.getStateFromToolsMetadata(finalState.toolsMetadata)?.done ===
        true ||
      WaitForTool.getStateFromToolsMetadata(finalState.toolsMetadata)
        ?.waiting === true;
    const wasStopped = Boolean(runEntry.stopped) && !wasDone;
    const stopError = wasStopped
      ? new Error(runEntry.stopReason ?? this.formatStoppedReason())
      : undefined;

    // M1: the cost_limit stop path already emitted a dedicated 'stop' event
    // (with stopReason/stopCostUsd) above; emitting a second 'run' event here
    // would overwrite the thread's Stopped status. Skip for cost_limit stops.
    if (runEntry.stopReason === 'cost_limit') {
      return result;
    }

    // Emit run event with result or stop error so thread status can be updated
    const runEvent: AgentRunEvent = {
      threadId,
      messages,
      config: mergedConfig,
    };

    if (stopError) {
      runEvent.error = stopError;
    } else {
      runEvent.result = result;
    }

    this.emit({
      type: 'run',
      data: runEvent,
    });

    return result;
  }

  public async stop(): Promise<void> {
    for (const [runId, run] of this.activeRuns.entries()) {
      const graphId = run.runnableConfig?.configurable?.graph_id;
      const isDone =
        FinishTool.getStateFromToolsMetadata(run.lastState.toolsMetadata)
          ?.done === true;
      if (graphId && !isDone) {
        const msg = markMessageHideForLlm(
          new SystemMessage(this.formatStoppedReason()),
        );
        const msgs = updateMessagesListWithMetadata([msg], run.runnableConfig);

        this.emit({
          type: 'message',
          data: {
            threadId: run.threadId,
            messages: msgs,
            config: run.runnableConfig,
          },
        });

        this.emit({
          type: 'stop',
          data: {
            config: run.runnableConfig,
            threadId: run.threadId,
            stopReason: null,
            stopCostUsd: null,
          },
        });
      }

      run.stopped = true;
      run.stopReason ??= this.formatStoppedReason(run.stopReason);

      run.abortController.abort();

      this.activeRuns.delete(runId);
    }

    this.graph = undefined;
    this.currentConfig = undefined;
    this.graphThreadStateUnsubscribe?.();
    this.graphThreadStateUnsubscribe = undefined;
    this.graphThreadState = undefined;

    // MCP cleanup is handled by GraphCompiler
  }

  /**
   * Stop execution for a specific thread (best effort).
   * This aborts any active runs whose thread_id or parent_thread_id matches the provided threadId.
   */
  public async stopThread(threadId: string, reason?: string): Promise<boolean> {
    let stopped = false;

    for (const [_runId, run] of this.activeRuns.entries()) {
      const cfg = run.runnableConfig?.configurable;
      const runThreadId = run.threadId;
      const parentThreadId = cfg?.parent_thread_id;

      const matches = runThreadId === threadId || parentThreadId === threadId;
      if (!matches) {
        continue;
      }

      stopped = true;

      const isDone =
        FinishTool.getStateFromToolsMetadata(run.lastState.toolsMetadata)
          ?.done === true;
      if (cfg?.graph_id && !isDone) {
        const msg = markMessageHideForLlm(
          new SystemMessage(this.formatStoppedReason(reason)),
        );
        const msgs = updateMessagesListWithMetadata([msg], run.runnableConfig);

        this.emit({
          type: 'message',
          data: {
            threadId: run.threadId,
            messages: msgs,
            config: run.runnableConfig,
          },
        });

        // Emit stop event so GraphStateManager can deterministically emit ThreadUpdate(Stopped)
        // even if the underlying LangGraph run is aborted before it reaches the final `run` event.
        // stopReason: null explicitly clears any previously-set cost_limit marker so a manual
        // stop after an auto-stop doesn't leave a stale stopReason in the thread metadata.
        this.emit({
          type: 'stop',
          data: {
            config: run.runnableConfig,
            threadId: run.threadId,
            stopReason: null,
            stopCostUsd: null,
          },
        });

        // Best-effort: if the agent already decided to call the shell tool but the run is being
        // stopped before the tool result is persisted, emit a deterministic aborted shell result.
        // This makes "stop while a shell command is in-flight" observable in thread history.
        const hasShellTool = this.hasTool('shell');

        if (hasShellTool) {
          const pendingShellCall = [...run.lastState.messages]
            .reverse()
            .filter((m) => m instanceof AIMessage)
            .flatMap((m) => (m as AIMessage).tool_calls ?? [])
            .find((tc) => tc?.name === 'shell');

          if (pendingShellCall) {
            const callId = pendingShellCall?.id ?? '';

            const abortedShell = new ToolMessage({
              tool_call_id: callId,
              name: 'shell',
              content: JSON.stringify({
                exitCode: 124,
                stdout: '',
                stderr: 'Aborted',
                fail: true,
              }),
            });

            this.emit({
              type: 'message',
              data: {
                threadId: run.threadId,
                messages: updateMessagesListWithMetadata(
                  [abortedShell],
                  run.runnableConfig,
                ),
                config: run.runnableConfig,
              },
            });
          }
        }
      }

      run.stopped = true;
      run.stopReason ??= this.formatStoppedReason(reason);

      run.abortController.abort();
    }

    return stopped;
  }

  /**
   * Update the agent's configuration without destroying the instance.
   * The graph will be rebuilt on the next run() call with the new config.
   */
  public setConfig(config: SimpleAgentSchemaType): void {
    // Clear the graph so it will be rebuilt with new config
    this.graph = undefined;
    this.currentConfig = config;
    this.graphThreadStateUnsubscribe?.();
    this.graphThreadStateUnsubscribe = undefined;
    this.graphThreadState = undefined;
  }

  public getConfig(): SimpleAgentSchemaType {
    if (!this.currentConfig) {
      throw new Error('Agent config not initialized');
    }
    return this.currentConfig;
  }

  /**
   * Set MCP services for this agent.
   * Called by the template during agent creation to inject MCP services from connected nodes.
   */
  public setMcpServices(mcpServices: BaseMcp<unknown>[]): void {
    this.mcpServices = mcpServices;
  }

  private hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all currently active tools (core + loaded deferred tools).
   */
  public getTools(): DynamicStructuredTool[] {
    return this.activeTools;
  }

  /**
   * Move a tool from the deferred registry to the active tools list.
   * Returns the tool and its instructions if the tool was deferred, or null if already active or not found.
   */
  public loadTool(
    name: string,
  ): { tool: BuiltAgentTool; instructions?: string } | null {
    // Dedup: already loaded
    if (this.tools.has(name)) {
      return null;
    }
    const entry = this.deferredTools.get(name);
    if (!entry) {
      return null;
    }
    this.deferredTools.delete(name);
    this.addTool(entry.tool);
    this.activeTools.push(entry.tool);
    return { tool: entry.tool, instructions: entry.instructions };
  }

  public getDeferredTool(name: string): DeferredToolEntry | undefined {
    return this.deferredTools.get(name);
  }

  public getDeferredTools(): Map<string, DeferredToolEntry> {
    return this.deferredTools;
  }

  public override resetTools(): void {
    super.resetTools();
    this.deferredTools.clear();
    this.activeTools = [];
    this.initialDeferredSnapshot = undefined;
    this.initialToolsSnapshot = undefined;
    this.seenThreads.clear();
    this.graph = undefined; // Force graph rebuild so nodes get fresh activeTools reference
  }
}
