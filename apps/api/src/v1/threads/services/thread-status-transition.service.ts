import { Injectable } from '@nestjs/common';

import { ThreadEntity } from '../entity/thread.entity';
import { ThreadStatus } from '../threads.types';

@Injectable()
export class ThreadStatusTransitionService {
  computeTransition(
    current: Pick<
      ThreadEntity,
      'status' | 'runningStartedAt' | 'totalRunningMs'
    >,
    nextStatus: ThreadStatus,
    now: Date = new Date(),
  ): {
    status: ThreadStatus;
    runningStartedAt: Date | null;
    totalRunningMs: number;
  } {
    const currentTotalMs = Number(current.totalRunningMs ?? 0);

    if (nextStatus === ThreadStatus.Running) {
      if (current.status === ThreadStatus.Running) {
        // Idempotent — no clock reset, preserve existing runningStartedAt
        return {
          status: nextStatus,
          runningStartedAt: current.runningStartedAt,
          totalRunningMs: currentTotalMs,
        };
      }
      // Transition into Running from any non-Running status
      return {
        status: nextStatus,
        runningStartedAt: now,
        totalRunningMs: currentTotalMs,
      };
    }

    // Transitioning out of Running to any non-Running status
    if (current.status === ThreadStatus.Running) {
      const startedAt = current.runningStartedAt;
      const delta =
        startedAt != null
          ? Math.max(0, now.getTime() - startedAt.getTime())
          : 0;
      return {
        status: nextStatus,
        runningStartedAt: null,
        totalRunningMs: currentTotalMs + delta,
      };
    }

    // non-Running → non-Running: both fields unchanged
    return {
      status: nextStatus,
      runningStartedAt: current.runningStartedAt,
      totalRunningMs: currentTotalMs,
    };
  }
}
