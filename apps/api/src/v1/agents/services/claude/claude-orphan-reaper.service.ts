import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DefaultLogger } from '@packages/common';

import { environment } from '../../../../environments';
import { NotificationEvent } from '../../../notifications/notifications.types';
import { NotificationsService } from '../../../notifications/services/notifications.service';
import { RuntimeInstanceDao } from '../../../runtime/dao/runtime-instance.dao';
import { RuntimeInstanceStatus } from '../../../runtime/runtime.types';
import { ThreadsDao } from '../../../threads/dao/threads.dao';
import type { ThreadEntity } from '../../../threads/entity/thread.entity';
import { ThreadStatusTransitionService } from '../../../threads/services/thread-status-transition.service';
import { ThreadStatus } from '../../../threads/threads.types';
import type { ClaudeThreadMetadata } from './claude-session.types';

/** Wait this long after boot before the first sweep — let the app settle. */
const STARTUP_DELAY_MS = 30_000;
/** Cadence of the periodic sweep. */
const SWEEP_INTERVAL_MS = 5 * 60_000;
/**
 * A thread must have been Running at least this long before it is eligible for
 * reaping — guards against a session whose runtime-instance row is still being
 * created at the very start of a run being mistaken for an orphan.
 */
const ORPHAN_GRACE_MS = 2 * 60_000;

const ORPHAN_STOP_REASON =
  'Session lost — the Claude runtime is no longer available (the API restarted or the sandbox was reaped).';

/**
 * Reaps Claude Agent threads stranded in `Running` after a crash or restart.
 *
 * A Claude session lives inside ONE specific runtime container. If no live
 * runtime instance (`Running`/`Starting`) backs the thread, the session is dead
 * on EVERY instance — the container is gone — so transitioning the thread out
 * of `Running` is safe even in a multi-instance deployment (the runtime-row
 * check is the pod-independent liveness signal; a thread genuinely running
 * elsewhere keeps its instance row alive and is skipped). The reaper therefore
 * never races a live run: it acts only once the backing runtime is gone, which
 * for a crashed pod happens after the idle reaper removes the stale instance.
 *
 * Crash-orphaned virtual keys are deliberately NOT swept here: they self-expire
 * via the LiteLLM key TTL (see `LitellmVirtualKeyService`), and their aliases
 * carry a per-issue suffix so they are not addressable out-of-band anyway.
 */
@Injectable()
export class ClaudeOrphanReaperService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private startupHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly threadsDao: ThreadsDao,
    private readonly runtimeInstanceDao: RuntimeInstanceDao,
    private readonly transitionService: ThreadStatusTransitionService,
    private readonly notificationsService: NotificationsService,
    private readonly logger: DefaultLogger,
  ) {}

  onApplicationBootstrap(): void {
    // The periodic sweep races explicit teardown in integration tests (and the
    // ephemeral test DB holds no real orphans); skip the auto-schedule there.
    // `sweep()` is still covered by direct-call unit tests.
    if (environment.env === 'test') {
      return;
    }
    this.startupHandle = setTimeout(() => void this.sweep(), STARTUP_DELAY_MS);
    this.sweepHandle = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.startupHandle) {
      clearTimeout(this.startupHandle);
      this.startupHandle = null;
    }
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
  }

  /** Returns the number of stranded threads reaped this pass. */
  async sweep(now: number = Date.now()): Promise<number> {
    let running: ThreadEntity[];
    try {
      running = await this.threadsDao.getAll({ status: ThreadStatus.Running });
    } catch (err) {
      this.logger.warn(
        `Claude orphan sweep skipped — thread query failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }

    let reaped = 0;
    for (const thread of running) {
      // Per-thread isolation: a single thread's failed runtime-liveness query,
      // DB write, or notification must not abort the whole best-effort pass and
      // strand every remaining orphan until the next sweep (sweep() runs as a
      // fire-and-forget `void this.sweep()` on the interval, so a throw here
      // would surface only as an unhandled rejection).
      try {
        const sessions = (thread.metadata as ClaudeThreadMetadata | undefined)
          ?.claudeSessions;
        if (!sessions || Object.keys(sessions).length === 0) {
          continue; // not a Claude-backed thread — checkpointed agents recover differently
        }

        const startedAt = thread.runningStartedAt
          ? new Date(thread.runningStartedAt).getTime()
          : null;
        if (startedAt === null || now - startedAt < ORPHAN_GRACE_MS) {
          // Too fresh, or unknown age: a null runningStartedAt on a Running
          // thread is a known DB-invariant violation (threads.service logs it)
          // that plausibly sits in the same startup window the grace covers —
          // its runtime-instance row may not exist yet, so the empty-liveness
          // check below would wrongly reap it. Fail safe: skip, never reap a
          // thread whose age we cannot establish.
          continue;
        }

        const liveRuntimes = await this.runtimeInstanceDao.getAll({
          threadId: thread.externalThreadId,
          status: {
            $in: [
              RuntimeInstanceStatus.Running,
              RuntimeInstanceStatus.Starting,
            ],
          },
        });
        if (liveRuntimes.length > 0) {
          continue; // session still alive here or on another instance
        }

        if (await this.reapThread(thread, now)) {
          reaped += 1;
        }
      } catch (err) {
        this.logger.warn(
          `Claude orphan sweep: failed to evaluate thread ${
            thread.externalThreadId
          } — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (reaped > 0) {
      this.logger.warn(
        `Claude orphan sweep reaped ${reaped} stranded Running thread(s)`,
      );
    }
    return reaped;
  }

  /** Returns true if the thread was transitioned, false if it was no longer an orphan. */
  private async reapThread(
    thread: ThreadEntity,
    now: number,
  ): Promise<boolean> {
    // Re-read immediately before the write. The per-thread runtime-liveness
    // checks across a multi-thread sweep widen the window between the snapshot
    // (threadsDao.getAll at sweep start) and here, during which the thread may
    // have been restarted (→ Running with a fresh runtime instance) or finished
    // (→ Done). Acting on the stale snapshot would (a) clobber a freshly
    // restarted live run back to Stopped, and (b) spread a stale metadata blob
    // over any claudeSessions persisted since the snapshot (a lost update vs the
    // atomic mergeMetadataKey writer). The fresh row closes both gaps.
    const fresh = await this.threadsDao.getOne({ id: thread.id });
    if (!fresh || fresh.status !== ThreadStatus.Running) {
      return false; // no longer an orphan — leave it untouched
    }
    const transition = this.transitionService.computeTransition(
      fresh,
      ThreadStatus.Stopped,
      new Date(now),
    );
    await this.threadsDao.updateById(fresh.id, {
      status: transition.status,
      runningStartedAt: transition.runningStartedAt,
      totalRunningMs: transition.totalRunningMs,
      metadata: { ...fresh.metadata, stopReason: ORPHAN_STOP_REASON },
    });
    await this.notificationsService.emit({
      type: NotificationEvent.ThreadUpdate,
      graphId: fresh.graphId,
      threadId: fresh.externalThreadId,
      data: { status: ThreadStatus.Stopped, stopReason: ORPHAN_STOP_REASON },
    });
    return true;
  }
}
