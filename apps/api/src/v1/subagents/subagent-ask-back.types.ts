/**
 * Shared types and constants for the M4 in-session inter-agent ask-back path
 * (subagent channel). A subagent can ask its caller a question via the
 * `ask_caller` tool; the subagent durably suspends at the question, the caller
 * answers via `answer_callee`, and the subagent resumes from its pg-checkpoint.
 */

/** Tool name the subagent calls to ask its caller a question. */
export const ASK_CALLER_TOOL_NAME = 'ask_caller' as const;

/** Tool name the caller uses to answer a suspended callee. */
export const ANSWER_CALLEE_TOOL_NAME = 'answer_callee' as const;

/**
 * Maximum number of ask -> answer round-trips a single suspended callee may run
 * before the ask-back loop is force-closed (the callee is told to complete with
 * what it has). Bounds the ask -> answer -> ask ... cycle deterministically so a
 * subagent that keeps asking can never loop unbounded (M4 step-7 guard).
 */
export const MAX_ASK_BACK_DEPTH = 8;

/**
 * Durable record describing a subagent suspended awaiting its caller's answer.
 *
 * The callee's CONVERSATION state lives in the pg-checkpoint keyed by
 * `durableThreadId`; this record holds only the small metadata needed to
 * RECONSTRUCT the transient subagent (its definition id) and resume that
 * checkpoint when the caller answers. `suspendId` equals `durableThreadId` — it
 * is the opaque handle round-tripped through the caller LLM and passed back to
 * `answer_callee`.
 */
export interface CalleeSuspendRecord {
  /** Opaque resume handle the caller passes back to `answer_callee`. */
  suspendId: string;
  /** Discriminates the resume path. Only `subagent` exists today (M4); the peer channel adds more. */
  calleeType: 'subagent';
  /** Subagent definition id — used to rebuild the subagent's tools at resume. */
  agentId: string;
  /** LangGraph pg-checkpoint thread_id holding the suspended conversation. */
  durableThreadId: string;
  /** The question the callee asked its caller (surfaced to the caller LLM). */
  question: string;
  /** Number of ask -> answer round-trips completed for this suspended callee. */
  askBackCount: number;
  /** Parent graph node id, when known — kept for cost attribution / UI grouping. */
  parentNodeId?: string;
}
