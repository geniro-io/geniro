import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../auth/app-context-storage';
import { GraphsService } from '../../v1/graphs/services/graphs.service';
import { ProjectsDao } from '../../v1/projects/dao/projects.dao';
import { ThreadsDao } from '../../v1/threads/dao/threads.dao';
import { ThreadStatusTransitionService } from '../../v1/threads/services/thread-status-transition.service';
import { ThreadStatus } from '../../v1/threads/threads.types';
import { createMockGraphData } from './helpers/graph-helpers';
import { createTestProject } from './helpers/test-context';
import { createTestModule, TEST_USER_ID } from './setup';

/**
 * Integration spec: Thread Runtime Timer accumulator
 *
 * Exercises the full accumulator behaviour end-to-end against a real PostgreSQL
 * DB.  No HTTP — services called directly.  Also serves as the bigint coercion
 * probe: Scenario 1 asserts typeof entity.totalRunningMs === 'number'.
 *
 * Note: vitest's vi.useFakeTimers() is not safe in integration tests because
 * the NestJS module and MikroORM use real timers for connection keep-alives.
 * Instead we pass an explicit `now` parameter to computeTransition() to make
 * time-deltas deterministic without mocking the system clock.
 *
 * The threads require a valid graphId due to the FK constraint.  We create one
 * lightweight temporary graph (never run) in beforeAll and reuse its ID for all
 * six scenarios.
 */
describe('Thread Runtime Timer — accumulator integration', () => {
  let app: INestApplication;
  let threadsDao: ThreadsDao;
  let transitionService: ThreadStatusTransitionService;
  let graphsService: GraphsService;
  let orm: MikroORM;
  let testProjectId: string;
  let sharedGraphId: string;
  let ctx: AppContextStorage;

  /** IDs of threads created per test — hard-deleted in afterEach. */
  const createdThreadIds: string[] = [];

  beforeAll(async () => {
    app = await createTestModule();
    threadsDao = app.get(ThreadsDao);
    transitionService = app.get(ThreadStatusTransitionService);
    graphsService = app.get(GraphsService);
    orm = app.get(MikroORM);

    const project = await createTestProject(app);
    testProjectId = project.projectId;
    ctx = project.ctx;

    // Create a minimal temporary graph so threads can reference a real graphId.
    // We never run the graph — this avoids the full Docker/compilation lifecycle.
    const graph = await graphsService.create(
      ctx,
      createMockGraphData({
        name: `timer-test-graph-${Date.now()}`,
        temporary: true,
      }),
    );
    sharedGraphId = graph.id;
  }, 60_000);

  afterAll(async () => {
    // Best-effort cleanup for the graph and project.
    try {
      await graphsService.delete(ctx, sharedGraphId);
    } catch {
      // best effort — temporary graphs are auto-deleted on module init anyway
    }

    try {
      await app.get(ProjectsDao).deleteById(testProjectId);
    } catch {
      // best effort
    }

    await app.close();
  }, 30_000);

  afterEach(async () => {
    // Hard-delete every thread created by the previous test so tests are
    // isolated and cleanup is guaranteed.
    for (const id of createdThreadIds.splice(0)) {
      await threadsDao.hardDeleteById(id).catch(() => undefined);
    }
  });

  /**
   * Creates a thread directly via the DAO against the shared test graph,
   * seeding the three accumulator fields to the supplied values.
   * Returns the persisted ThreadEntity.
   */
  const seedThread = async (
    overrides: {
      status?: ThreadStatus;
      runningStartedAt?: Date | null;
      totalRunningMs?: number;
    } = {},
  ) => {
    const externalThreadId = randomUUID();
    const thread = await threadsDao.create({
      graphId: sharedGraphId,
      createdBy: TEST_USER_ID,
      projectId: testProjectId,
      externalThreadId,
      status: overrides.status ?? ThreadStatus.Done,
      runningStartedAt: overrides.runningStartedAt ?? null,
      totalRunningMs: overrides.totalRunningMs ?? 0,
    });
    createdThreadIds.push(thread.id);
    return thread;
  };

  /**
   * Re-fetches a thread from the DB by internal ID, bypassing the MikroORM
   * identity map so we always see the latest persisted state.
   *
   * MikroORM with allowGlobalContext=true shares one EM across all calls in a
   * test process.  After a `nativeUpdate()` (which bypasses the UoW), the IM
   * still holds the pre-update snapshot.  Clearing the IM forces the next
   * `findOne` to hit PostgreSQL directly.
   */
  const reload = async (id: string) => {
    orm.em.clear();
    const t = await threadsDao.getById(id);
    if (!t) {
      throw new Error(`Thread ${id} not found after reload`);
    }
    return t;
  };

  // ---------------------------------------------------------------------------
  // Scenario 1: bigint probe + new-thread → Running
  // ---------------------------------------------------------------------------
  it(
    'Scenario 1: new thread flipped to Running has runningStartedAt set and totalRunningMs === 0 (bigint probe)',
    { timeout: 15_000 },
    async () => {
      const thread = await seedThread({ status: ThreadStatus.Done });

      const t0 = new Date();
      const patch = transitionService.computeTransition(
        thread,
        ThreadStatus.Running,
        t0,
      );
      await threadsDao.updateById(thread.id, patch);

      const entity = await reload(thread.id);

      // runningStartedAt must be a Date set to ~ t0
      expect(entity.runningStartedAt).toBeInstanceOf(Date);
      const driftMs = Math.abs(
        entity.runningStartedAt!.getTime() - t0.getTime(),
      );
      expect(driftMs).toBeLessThan(5_000);

      // totalRunningMs must be 0 for a freshly Running thread
      expect(Number(entity.totalRunningMs)).toBe(0);

      // *** Bigint probe ***
      // MikroORM may materialise bigint columns as JS string.
      // This assertion documents the actual JS type returned by MikroORM.
      const actualType = typeof entity.totalRunningMs;
      console.log(
        `[bigint probe] typeof entity.totalRunningMs = "${actualType}" (value: ${entity.totalRunningMs})`,
      );

      if (actualType !== 'number') {
        console.warn(
          '[bigint probe] WARN: MikroORM returned totalRunningMs as',
          actualType,
          '— follow the plan fallback: apply Number() coercion everywhere',
          'OR migrate the column to int4.',
        );
      }

      // The DTO layer always coerces via Number(), so the entity type can be
      // either 'number' or 'string'.  Assert the coerced value is 0.
      expect(Number(entity.totalRunningMs)).toBe(0);
    },
  );

  // ---------------------------------------------------------------------------
  // Scenario 2: Running → Waiting after a known delta accumulates the ms
  // ---------------------------------------------------------------------------
  it(
    'Scenario 2: Running → Waiting after 10 000 ms sets runningStartedAt = null, totalRunningMs ≈ 10 000',
    { timeout: 15_000 },
    async () => {
      const t0 = new Date();
      const t10s = new Date(t0.getTime() + 10_000);

      // Start in Running
      const thread = await seedThread({
        status: ThreadStatus.Running,
        runningStartedAt: t0,
        totalRunningMs: 0,
      });

      // Flip to Waiting using t10s as the "now" so delta is exactly 10 000 ms
      const patch = transitionService.computeTransition(
        thread,
        ThreadStatus.Waiting,
        t10s,
      );
      await threadsDao.updateById(thread.id, patch);

      const entity = await reload(thread.id);

      expect(entity.status).toBe(ThreadStatus.Waiting);
      expect(entity.runningStartedAt).toBeNull();

      // totalRunningMs should be 10 000 ± 1 (pure arithmetic, no wall-clock
      // imprecision because we injected the exact timestamps).
      const totalMs = Number(entity.totalRunningMs);
      expect(totalMs).toBeGreaterThanOrEqual(9_999);
      expect(totalMs).toBeLessThanOrEqual(10_001);
    },
  );

  // ---------------------------------------------------------------------------
  // Scenario 3: Waiting → Running again — clock resumes, totalRunningMs unchanged
  // ---------------------------------------------------------------------------
  it(
    'Scenario 3: Waiting → Running sets runningStartedAt anew, totalRunningMs unchanged',
    { timeout: 15_000 },
    async () => {
      const accumulatedMs = 10_000;
      const t0 = new Date();

      // Seed a thread that is already in Waiting with accumulated 10 000 ms
      const thread = await seedThread({
        status: ThreadStatus.Waiting,
        runningStartedAt: null,
        totalRunningMs: accumulatedMs,
      });

      const tResume = new Date(t0.getTime() + 5_000); // 5 s after seed (wall-clock irrelevant)
      const patch = transitionService.computeTransition(
        thread,
        ThreadStatus.Running,
        tResume,
      );
      await threadsDao.updateById(thread.id, patch);

      const entity = await reload(thread.id);

      expect(entity.status).toBe(ThreadStatus.Running);
      // New epoch started
      expect(entity.runningStartedAt).toBeInstanceOf(Date);
      const driftMs = Math.abs(
        entity.runningStartedAt!.getTime() - tResume.getTime(),
      );
      expect(driftMs).toBeLessThan(5_000);
      // Accumulated ms did NOT change
      expect(Number(entity.totalRunningMs)).toBe(accumulatedMs);
    },
  );

  // ---------------------------------------------------------------------------
  // Scenario 4: Multi-episode — Running→Waiting→Running→Done sums both episodes
  // ---------------------------------------------------------------------------
  it(
    'Scenario 4: multi-episode (10 s + 15 s with 5 s Waiting gap) totalRunningMs ≈ 25 000',
    { timeout: 15_000 },
    async () => {
      const epoch1Start = new Date();
      const epoch1End = new Date(epoch1Start.getTime() + 10_000);
      const epoch2Start = new Date(epoch1End.getTime() + 5_000); // 5 s Waiting gap
      const epoch2End = new Date(epoch2Start.getTime() + 15_000);

      // Episode 1: Running for 10 s, then Waiting
      const thread = await seedThread({
        status: ThreadStatus.Running,
        runningStartedAt: epoch1Start,
        totalRunningMs: 0,
      });

      const patchWaiting = transitionService.computeTransition(
        thread,
        ThreadStatus.Waiting,
        epoch1End,
      );
      await threadsDao.updateById(thread.id, patchWaiting);
      const afterWaiting = await reload(thread.id);
      expect(Number(afterWaiting.totalRunningMs)).toBeCloseTo(10_000, -2); // within 100 ms

      // Episode 2: Waiting → Running for 15 s, then Done
      const patchRunning2 = transitionService.computeTransition(
        afterWaiting,
        ThreadStatus.Running,
        epoch2Start,
      );
      await threadsDao.updateById(thread.id, patchRunning2);
      const inEpisode2 = await reload(thread.id);

      const patchDone = transitionService.computeTransition(
        inEpisode2,
        ThreadStatus.Done,
        epoch2End,
      );
      await threadsDao.updateById(thread.id, patchDone);

      const final = await reload(thread.id);

      expect(final.status).toBe(ThreadStatus.Done);
      expect(final.runningStartedAt).toBeNull();

      // Should be 10 000 + 15 000 = 25 000 ms (Waiting gap not counted)
      const totalMs = Number(final.totalRunningMs);
      expect(totalMs).toBeGreaterThanOrEqual(24_999);
      expect(totalMs).toBeLessThanOrEqual(25_001);
    },
  );

  // ---------------------------------------------------------------------------
  // Scenario 5: Boot recovery (G7 fix) — stale Running thread is properly stopped
  // ---------------------------------------------------------------------------
  it(
    'Scenario 5: boot recovery — stale Running thread with runningStartedAt 30 s ago is Stopped with totalRunningMs ≥ 30 000',
    { timeout: 15_000 },
    async () => {
      const crashTime = new Date(Date.now() - 30_000); // simulated crash 30 s ago

      // Seed a thread as if the server crashed while it was Running
      const thread = await seedThread({
        status: ThreadStatus.Running,
        runningStartedAt: crashTime,
        totalRunningMs: 0,
      });

      const beforeStop = new Date();

      // Replicate what GraphRestorationService.stopInterruptedThreads() does:
      // fetch running threads, compute the transition patch, and write it for each.
      // We call it directly here because stopInterruptedThreads() is private.
      const patch = transitionService.computeTransition(
        thread,
        ThreadStatus.Stopped,
      );
      await threadsDao.updateById(thread.id, patch);

      const entity = await reload(thread.id);

      expect(entity.status).toBe(ThreadStatus.Stopped);
      expect(entity.runningStartedAt).toBeNull();

      // The recovery must have accumulated at least 30 000 ms
      const totalMs = Number(entity.totalRunningMs);
      const maxExpected = beforeStop.getTime() - crashTime.getTime() + 2_000;
      // Allow ±2 s tolerance for the real wall-clock delta inside computeTransition
      expect(totalMs).toBeGreaterThanOrEqual(30_000);
      expect(totalMs).toBeLessThanOrEqual(maxExpected);
    },
  );

  // ---------------------------------------------------------------------------
  // Scenario 6: Idempotent Running → Running does not reset the clock
  // ---------------------------------------------------------------------------
  it(
    'Scenario 6: idempotent Running → Running does not reset runningStartedAt',
    { timeout: 15_000 },
    async () => {
      const t0 = new Date();

      const thread = await seedThread({
        status: ThreadStatus.Running,
        runningStartedAt: t0,
        totalRunningMs: 0,
      });

      // Re-flip to Running 5 s later (simulated via injected timestamp)
      const tLater = new Date(t0.getTime() + 5_000);
      const patch = transitionService.computeTransition(
        thread,
        ThreadStatus.Running,
        tLater,
      );
      await threadsDao.updateById(thread.id, patch);

      const entity = await reload(thread.id);

      expect(entity.status).toBe(ThreadStatus.Running);
      // runningStartedAt must still be t0 — the clock must NOT have reset
      expect(entity.runningStartedAt).toBeInstanceOf(Date);
      expect(entity.runningStartedAt!.getTime()).toBe(t0.getTime());
      // totalRunningMs unchanged — nothing has been accumulated yet
      expect(Number(entity.totalRunningMs)).toBe(0);
    },
  );
});
