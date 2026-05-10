import { AIMessageChunk, BaseMessage } from '@langchain/core/messages';
import { RunnableConfig } from '@langchain/core/runnables';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { Annotation, BaseChannel } from '@langchain/langgraph';
import {
  ChatOpenAI,
  ChatOpenAIFields,
  OpenAIChatModelId,
} from '@langchain/openai';
import { EventEmitter } from 'events';

import { environment } from '../../../../environments';
import { GraphExecutionMetadata } from '../../../graphs/graphs.types';
import { RequestTokenUsage } from '../../../litellm/litellm.types';
import {
  BaseAgentConfigurable,
  BaseAgentState,
  BaseAgentStateChange,
  BaseAgentStateMessagesUpdateValue,
} from '../../agents.types';
import { ReasoningAwareChatCompletions } from '../reasoning-chat-completions';

export type AgentOutput = {
  messages: BaseMessage[];
  threadId: string;
  checkpointNs?: string;
  needsMoreInfo?: boolean;
  waiting?: boolean;
  waitMetadata?: {
    durationSeconds: number;
    checkPrompt: string;
    reason: string;
  };
};

export type AgentRunEvent = {
  threadId: string;
  messages: BaseMessage[];
  config: RunnableConfig<BaseAgentConfigurable>;
  result?: AgentOutput;
  error?: unknown;
};

export type AgentStopEvent = {
  config: RunnableConfig<BaseAgentConfigurable>;
  error?: unknown;
  threadId: string;
  // null = explicit clear; undefined = no change; string = set
  stopReason?: string | null;
  // null = explicit clear; undefined = no change; number = set
  stopCostUsd?: number | null;
};

export type AgentInvokeEvent = {
  threadId: string;
  messages: BaseMessage[];
  config: RunnableConfig<BaseAgentConfigurable>;
};

export type AgentMessageEvent = {
  threadId: string;
  messages: BaseMessage[];
  config: RunnableConfig<BaseAgentConfigurable>;
};

export type AgentStateUpdateEvent = {
  threadId: string;
  stateChange: Record<string, unknown>;
  config: RunnableConfig<BaseAgentConfigurable>;
};

export type AgentNodeAdditionalMetadataUpdateEvent = {
  metadata: GraphExecutionMetadata;
  additionalMetadata?: Record<string, unknown>;
};

export type AgentEventType =
  | { type: 'run'; data: AgentRunEvent }
  | { type: 'stop'; data: AgentStopEvent }
  | { type: 'invoke'; data: AgentInvokeEvent }
  | { type: 'message'; data: AgentMessageEvent }
  | { type: 'stateUpdate'; data: AgentStateUpdateEvent }
  | {
      type: 'nodeAdditionalMetadataUpdate';
      data: AgentNodeAdditionalMetadataUpdateEvent;
    };

export abstract class BaseAgent<
  TSchema = unknown,
  TNodeMetadata = Record<string, unknown>,
> {
  protected tools: Map<string, DynamicStructuredTool> = new Map();
  protected eventEmitter = new EventEmitter();

  public addTool(tool: DynamicStructuredTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Reset (clear) the agent toolset.
   */
  public resetTools(): void {
    this.tools.clear();
  }

  /**
   * Subscribe to agent events
   * Returns an unsubscriber function
   */
  subscribe(callback: (event: AgentEventType) => Promise<void>): () => void {
    const handler = (event: AgentEventType) => callback(event);

    this.eventEmitter.on('event', handler);

    return () => {
      this.eventEmitter.off('event', handler);
    };
  }

  /**
   * Emit agent events.
   * Public so that subagent event forwarding can re-emit through the parent.
   */
  public emit(event: AgentEventType): void {
    this.eventEmitter.emit('event', event);
  }

  public buildLLM(
    model: OpenAIChatModelId,
    params?: ChatOpenAIFields,
  ): ChatOpenAI {
    const fields: ChatOpenAIFields = {
      model,
      apiKey: environment.litellmMasterKey,
      configuration: { baseURL: environment.llmBaseUrl },
      tags: ['geniro'],
      ...params,
    };
    return new ChatOpenAI({
      ...fields,
      completions: new ReasoningAwareChatCompletions(fields),
    });
  }

  public getGraphNodeMetadata(
    _meta: GraphExecutionMetadata,
  ): TNodeMetadata | undefined {
    return undefined;
  }

  public abstract run(
    threadId: string,
    messages: BaseMessage[],
    config?: TSchema,
    runnableConfig?: RunnableConfig<BaseAgentConfigurable>,
  ): Promise<AgentOutput>;

  /**
   * Build the LangGraph Annotation state schema for BaseAgentState.
   * Shared across SimpleAgent and SubAgent to avoid duplication.
   */
  protected buildState() {
    return Annotation.Root({
      messages: Annotation<BaseMessage[], BaseAgentStateMessagesUpdateValue>({
        reducer: (left, right) =>
          !right
            ? left
            : right.mode === 'append'
              ? [...left, ...right.items]
              : right.items,
        default: () => [],
      }),
      summary: Annotation<string, string>({
        reducer: (left, right) => (right !== undefined ? right : left),
        default: () => '',
      }),
      toolsMetadata: Annotation<
        Record<string, Record<string, unknown>>,
        Record<string, Record<string, unknown>>
      >({
        reducer: (left, right) => (right ? { ...left, ...right } : left),
        default: () => ({}),
      }),
      toolUsageGuardActivatedCount: Annotation<number, number>({
        reducer: (left, right) => right ?? left,
        default: () => 0,
      }),
      toolUsageGuardActivated: Annotation<boolean, boolean>({
        reducer: (left, right) => right ?? left,
        default: () => false,
      }),
      inputTokens: Annotation<number, number>({
        reducer: (left, right) => left + (right ?? 0),
        default: () => 0,
      }),
      cachedInputTokens: Annotation<number, number>({
        reducer: (left, right) => left + (right ?? 0),
        default: () => 0,
      }),
      outputTokens: Annotation<number, number>({
        reducer: (left, right) => left + (right ?? 0),
        default: () => 0,
      }),
      reasoningTokens: Annotation<number, number>({
        reducer: (left, right) => left + (right ?? 0),
        default: () => 0,
      }),
      totalTokens: Annotation<number, number>({
        reducer: (left, right) => left + (right ?? 0),
        default: () => 0,
      }),
      totalPrice: Annotation<number, number>({
        reducer: (left, right) => left + (right ?? 0),
        default: () => 0,
      }),
      currentContext: Annotation<number, number>({
        reducer: (left, right) => right ?? left,
        default: () => 0,
      }),
    } satisfies Record<
      keyof BaseAgentState,
      BaseChannel | (() => BaseChannel)
    >);
  }

  /**
   * Apply a partial state change to the current agent state, producing the next state.
   * Shared across SimpleAgent and SubAgent.
   */
  protected applyChange(
    prev: BaseAgentState,
    change: BaseAgentStateChange,
  ): BaseAgentState {
    const nextMessages = change.messages
      ? change.messages.mode === 'append'
        ? [...prev.messages, ...change.messages.items]
        : change.messages.items
      : prev.messages;

    return {
      messages: nextMessages,
      summary: change.summary ?? prev.summary,
      toolsMetadata: change.toolsMetadata
        ? { ...prev.toolsMetadata, ...change.toolsMetadata }
        : prev.toolsMetadata,
      toolUsageGuardActivated:
        change.toolUsageGuardActivated ?? prev.toolUsageGuardActivated,
      toolUsageGuardActivatedCount:
        change.toolUsageGuardActivatedCount ??
        prev.toolUsageGuardActivatedCount,
      inputTokens: prev.inputTokens + (change.inputTokens ?? 0),
      cachedInputTokens:
        prev.cachedInputTokens + (change.cachedInputTokens ?? 0),
      outputTokens: prev.outputTokens + (change.outputTokens ?? 0),
      reasoningTokens: prev.reasoningTokens + (change.reasoningTokens ?? 0),
      totalTokens: prev.totalTokens + (change.totalTokens ?? 0),
      totalPrice: prev.totalPrice + (change.totalPrice ?? 0),
      currentContext: change.currentContext ?? prev.currentContext,
    };
  }

  /**
   * Extract aggregated token usage from agent state.
   * Returns null when no tokens were consumed.
   */
  protected extractUsageFromState(
    state: BaseAgentState,
  ): RequestTokenUsage | null {
    const hasAny =
      state.inputTokens !== 0 ||
      state.cachedInputTokens !== 0 ||
      state.outputTokens !== 0 ||
      state.reasoningTokens !== 0 ||
      state.totalTokens !== 0 ||
      state.totalPrice !== 0 ||
      state.currentContext !== 0;

    if (!hasAny) {
      return null;
    }

    const totalPrice = state.totalPrice;

    return {
      inputTokens: state.inputTokens,
      cachedInputTokens: state.cachedInputTokens,
      outputTokens: state.outputTokens,
      reasoningTokens: state.reasoningTokens,
      totalTokens: state.totalTokens,
      totalPrice,
      currentContext: state.currentContext,
    };
  }

  /**
   * Extracts per-block reasoning entries from a streaming AIMessageChunk.
   * Returns one entry per reasoning content block found in the chunk, using
   * the block's own stable id (b.id) as the key for accumulation. Falls back
   * to chunk.id when the block carries no id of its own (older providers).
   */
  protected extractReasoningFromChunk(
    chunk: AIMessageChunk,
  ): { text: string; blockId: string }[] | null {
    const blocks =
      chunk?.contentBlocks ?? chunk?.response_metadata?.output ?? [];

    if (!Array.isArray(blocks)) {
      return null;
    }

    const entries: { text: string; blockId: string }[] = [];
    for (const b of blocks as {
      type?: unknown;
      reasoning?: unknown;
      id?: unknown;
    }[]) {
      if (!b || b.type !== 'reasoning') {
        continue;
      }
      if (typeof b.reasoning !== 'string' || b.reasoning.length === 0) {
        continue;
      }
      const blockId =
        typeof b.id === 'string' && b.id.length > 0 ? b.id : (chunk.id ?? '');
      if (!blockId) {
        continue;
      }
      entries.push({ text: b.reasoning, blockId });
    }

    return entries.length > 0 ? entries : null;
  }

  public abstract stop(): Promise<void>;

  /**
   * Update the agent's configuration without destroying the instance.
   * This allows tools that hold references to the agent to continue working with the updated config.
   */
  public abstract setConfig(config: TSchema): void;

  /**
   * Get the current agent configuration (including enhanced instructions)
   */
  public abstract getConfig(): TSchema;
}
