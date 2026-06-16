import { Injectable } from '@nestjs/common';

import { CalleeSuspendRecord } from './subagent-ask-back.types';

/**
 * Process-local registry of subagent callees suspended awaiting a caller answer
 * (M4 ask-back). The callee's CONVERSATION state is durable — it lives in the
 * pg-checkpoint keyed by `durableThreadId`; this registry holds only the small
 * reconstruction metadata that maps a `suspendId` back to the subagent
 * definition + checkpoint to resume.
 *
 * Lifecycle (honest): a record is removed only when the caller resumes the
 * callee to completion via `answer_callee`. On the escalate-to-user branch (the
 * caller calls finish(needsMoreInfo) instead of answering) or an abandoned
 * thread, the record is NOT evicted — there is currently NO TTL/GC for either
 * this in-memory Map or the orphaned pg-checkpoint rows. Records are tiny, but
 * on a long-running pod this Map grows with each unanswered suspension; adding a
 * TTL/size-bounded sweep (and cascading the durable rows on parent-thread
 * delete) is a tracked follow-up. The record is NOT seeded from the parent's
 * state (isolated-leaf cost model — see .claude/rules/cost-accounting.md).
 */
@Injectable()
export class SubagentSuspendService {
  private readonly suspends = new Map<string, CalleeSuspendRecord>();

  public register(record: CalleeSuspendRecord): void {
    this.suspends.set(record.suspendId, record);
  }

  public get(suspendId: string): CalleeSuspendRecord | undefined {
    return this.suspends.get(suspendId);
  }

  public remove(suspendId: string): void {
    this.suspends.delete(suspendId);
  }
}
