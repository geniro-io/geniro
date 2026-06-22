import { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';

import type { GraphExecutionMetadata } from '../graphs/graphs.types';
import type {
  MessageTokenUsage,
  RequestTokenUsage,
} from '../litellm/litellm.types';
import type { ModelPreferences } from '../user-preferences/user-preferences.types';
import type {
  AgentEventType,
  AgentOutput,
  BaseAgent,
} from './services/agents/base-agent';

/**
 * Message metadata stored in `BaseMessage.additional_kwargs`.
 *
 * Conventions:
 * - Our internal/custom fields use `__` prefix.
 * - Our internal/custom fields use camelCase.
 * - Provider/tool transport fields may also be present (no enforced naming).
 */
export type MessageAdditionalKwargs = Record<string, unknown> & {
  __runId?: string;
  __threadId?: string;
  __createdAt?: string;
  __model?: string;
  __title?: string;
  /** Shell command execution duration in milliseconds. Set by ShellTool on the ToolMessage. */
  __durationMs?: number;
  /**
   * When present on an AI message, indicates this message was generated in response
   * to one or more preceding tool results (tool roundtrip).
   *
   * This is used for analytics: the requestTokenUsage for "tool usage" is recorded
   * on the AI message that processes tool results, not on the tool result messages.
   */
  __answeredToolCallNames?: string[];

  // Used by message transformer for reasoning + LLM visibility controls
  __reasoningId?: string;
  __hideForLlm?: boolean;
  __hideForSummary?: boolean;
  __hideForUi?: boolean;
  __requiresFinishTool?: boolean;
  __isAgentInstructionMessage?: boolean;
  __isErrorMessage?: boolean;

  // Inter-agent communication metadata
  __interAgentCommunication?: boolean;
  __sourceAgentNodeId?: string;

  // Subagent communication metadata
  __subagentCommunication?: boolean;

  __context?: unknown;

  // Per-message token usage (proportional share)
  __tokenUsage?: MessageTokenUsage;

  // Full request token usage (entire LLM request, not just this message).
  // For AI messages: the LLM request that produced this response.
  // For tool messages: the parent LLM request that decided to call this tool.
  __requestUsage?: RequestTokenUsage;

  /** Tool's own execution token cost (e.g. subagent aggregate tokens) */
  __toolTokenUsage?: RequestTokenUsage;

  /**
   * Marks a message that was already emitted in real-time via tool streaming.
   * SimpleAgent.emitNewMessages() skips these to prevent double-emission.
   */
  __streamedRealtime?: boolean;

  /**
   * Links a streamed message to the parent tool call that produced it.
   * Used by the UI to group subagent intermediate messages under the tool call.
   */
  __toolCallId?: string;

  /** Names of tools that were auto-loaded (deferred tool loading) when processing this tool call. */
  __loadedTools?: string[];
};

/**
 * Thread-ID prefix used by SubAgent. Checkpoints with this prefix
 * are excluded from token-usage aggregation because their usage is
 * already folded into the parent checkpoint by tool-executor-node.
 */
export const SUBAGENT_THREAD_PREFIX = 'subagent-';

export type BaseAgentStateMessagesUpdateValue = {
  mode: 'append' | 'replace';
  items: BaseMessage[];
};

export interface BaseAgentState {
  messages: BaseMessage[];
  /**
   * Running conversation summary (memory).
   * Important: this is state only; it must not be stored as a synthetic message in `messages`.
   */
  summary: string;
  /**
   * Per-tool metadata/state, keyed by tool name.
   * Tools can update only their own entry via ToolInvokeResult.stateChange.
   */
  toolsMetadata: Record<string, Record<string, unknown>>;
  toolUsageGuardActivated: boolean;
  toolUsageGuardActivatedCount: number;
  /**
   * Aggregated token usage for this thread/run.
   * These counters are part of the persisted graph checkpoint state so
   * ThreadsService can read them without re-summing messages.
   */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  totalPrice: number;
  /**
   * Current context size (tokens) for this thread/run snapshot.
   * Not additive; overwritten with latest measurement.
   */
  currentContext: number;
}

export interface BaseAgentStateChange extends Partial<
  Omit<BaseAgentState, 'messages'>
> {
  messages?: BaseAgentStateMessagesUpdateValue;
}

export enum NewMessageMode {
  InjectAfterToolCall = 'inject_after_tool_call',
  WaitForCompletion = 'wait_for_completion',
}

export enum ReasoningEffort {
  None = 'none',
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

export type LLMRequestContext = {
  models?: ModelPreferences;
};

export type BaseAgentConfigurable = {
  thread_id?: string;
  caller_agent?: BaseAgent<unknown>;
  graph_id?: string;
  node_id?: string;
  checkpoint_ns?: string;
  parent_thread_id?: string;
  source?: string;
  async?: boolean;
  run_id?: string;
  graph_created_by?: string;
  thread_created_by?: string;
  graph_project_id?: string;
  /**
   * Effective USD cost limit for the thread, resolved once by the caller
   * (GraphsService.executeTrigger) and propagated through the agent run.
   * InvokeLlmNode enforces against this value when `enforceCostLimit` is set.
   * `null` / `undefined` = no limit.
   */
  effective_cost_limit_usd?: number | null;
  /**
   * Optional conversation label for inter-agent communication. When set, the
   * callee runs in an INDEPENDENT sub-conversation scoped to this label — a new
   * label starts a fresh thread (no shared history); the same label resumes it.
   * Set by the communication tool and threaded into both the callee thread id
   * and the bridge agent's per-conversation SDK-session key. Absent = the
   * single rolling conversation per (root thread, node, agent) — the default.
   */
  __communicationSession?: string;
  llmRequestContext?: LLMRequestContext;
  // SECURITY: This index signature is required by LangGraph's RunnableConfig
  // constraint. Never spread HTTP request body fields into this type — always
  // construct the configurable explicitly with server-side values only.
  [key: string]: unknown;
};

/**
 * The runtime surface every graph-node agent kind exposes to the rest of the
 * platform (triggers, thread resume, stop fan-out, inter-agent communication,
 * graph-state listeners). Extracted from SimpleAgent's formerly duck-typed
 * surface so new agent kinds (e.g. ClaudeAgent) plug into the same call sites
 * without `instanceof` checks. Node kinds whose instances implement this live
 * in `AGENT_NODE_KINDS` (graphs.types.ts) — keep the two in sync.
 */
export interface RunnableAgent<TSchema = unknown> {
  run(
    threadId: string,
    messages: BaseMessage[],
    config?: TSchema,
    runnableConfig?: RunnableConfig<BaseAgentConfigurable>,
  ): Promise<AgentOutput>;
  runOrAppend(
    threadId: string,
    messages: BaseMessage[],
    config?: TSchema,
    runnableConfig?: RunnableConfig<BaseAgentConfigurable>,
  ): Promise<AgentOutput>;
  stopThread(threadId: string, reason?: string): Promise<boolean>;
  subscribe(callback: (event: AgentEventType) => Promise<void>): () => void;
  emit(event: AgentEventType): void;
  getGraphNodeMetadata(
    meta: GraphExecutionMetadata,
  ): Record<string, unknown> | undefined;
}
