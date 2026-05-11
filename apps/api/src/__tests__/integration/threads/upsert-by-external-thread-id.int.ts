import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { createMockGraphData } from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import { createTestModule, TEST_USER_ID } from '../setup';

/**
 * Integration spec: ThreadsService.upsertRunningThread
 *
 * Pins the upsert-then-resume semantics for the running-timer fields. The
 * service composes a single INSERT...ON CONFLICT DO NOTHING (atomic) with a
 * conflict path that locks the existing row and applies
 * ThreadStatusTransitionService.computeTransition. The handler always passes
 * runningStartedAt=now and totalRunningMs=0; the three behaviours below come
 * from the service's compose, not from caller-side logic.
 *
 *   1. INSERT (no existing row): incoming runningStartedAt/totalRunningMs win.
 *   2. CONFLICT, existing was Running: idempotent — runningStartedAt preserved.
 *   3. CONFLICT, existing was non-Running: runningStartedAt reset to a fresh
 *      resume clock, totalRunningMs preserved (accumulator survives).
 *
 * Also covers the conflict-merge contract for source/metadata (preserved) and
 * last_run_id (overwritten when provided, preserved when null).
 */
describe('ThreadsService.upsertRunningThread — INSERT-or-resume semantics', () => {
  let app: INestApplication;
  let threadsDao: ThreadsDao;
  let threadsService: ThreadsService;
  let graphsService: GraphsService;
  let orm: MikroORM;
  let testProjectId: string;
  let sharedGraphId: string;
  let ctx: AppContextStorage;

  const createdThreadIds: string[] = [];

  beforeAll(async () => {
    app = await createTestModule();
    threadsDao = app.get(ThreadsDao);
    threadsService = app.get(ThreadsService);
    graphsService = app.get(GraphsService);
    orm = app.get(MikroORM);

    const project = await createTestProject(app);
    testProjectId = project.projectId;
    ctx = project.ctx;

    const graph = await graphsService.create(
      ctx,
      createMockGraphData({
        name: `upsert-thread-test-${Date.now()}`,
        temporary: true,
      }),
    );
    sharedGraphId = graph.id;
  }, 60_000);

  afterAll(async () => {
    try {
      await graphsService.delete(ctx, sharedGraphId);
    } catch {
      // best effort
    }

    try {
      await app.get(ProjectsDao).deleteById(testProjectId);
    } catch {
      // best effort
    }

    await app.close();
  }, 30_000);

  afterEach(async () => {
    for (const id of createdThreadIds.splice(0)) {
      await threadsDao.hardDeleteById(id).catch(() => undefined);
    }
  });

  /** Re-fetches a thread bypassing the MikroORM identity map. */
  const reload = async (id: string) => {
    orm.em.clear();
    const t = await threadsDao.getById(id);
    if (!t) {
      throw new Error(`Thread ${id} not found after reload`);
    }
    return t;
  };

  const baseUpsertPayload = (overrides: {
    externalThreadId: string;
    runningStartedAt: Date;
    totalRunningMs?: number;
    source?: string;
    lastRunId?: string;
    metadata?: Record<string, unknown>;
  }) => ({
    graphId: sharedGraphId,
    createdBy: TEST_USER_ID,
    projectId: testProjectId,
    externalThreadId: overrides.externalThreadId,
    status: ThreadStatus.Running as typeof ThreadStatus.Running,
    runningStartedAt: overrides.runningStartedAt,
    totalRunningMs: overrides.totalRunningMs ?? 0,
    ...(overrides.source !== undefined ? { source: overrides.source } : {}),
    ...(overrides.lastRunId !== undefined
      ? { lastRunId: overrides.lastRunId }
      : {}),
    ...(overrides.metadata !== undefined
      ? { metadata: overrides.metadata }
      : {}),
  });

  it(
    'INSERT: returns a fully-hydrated row with runningStartedAt=now and totalRunningMs=0',
    { timeout: 15_000 },
    async () => {
      const externalThreadId = randomUUID();
      const now = new Date();

      const inserted = await threadsService.upsertRunningThread(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: now,
        }),
      );
      createdThreadIds.push(inserted.id);

      expect(inserted.status).toBe(ThreadStatus.Running);
      expect(inserted.runningStartedAt).toBeInstanceOf(Date);
      expect(inserted.runningStartedAt!.getTime()).toBe(now.getTime());
      expect(Number(inserted.totalRunningMs)).toBe(0);
      // RETURNING * gives all columns
      expect(inserted.id).toBeDefined();
      expect(inserted.externalThreadId).toBe(externalThreadId);
      expect(inserted.graphId).toBe(sharedGraphId);
    },
  );

  it(
    'CONFLICT (existing Running): runningStartedAt preserved, totalRunningMs preserved',
    { timeout: 15_000 },
    async () => {
      const externalThreadId = randomUUID();
      const originalStartedAt = new Date('2026-04-01T10:00:00.000Z');

      const inserted = await threadsService.upsertRunningThread(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: originalStartedAt,
          totalRunningMs: 5_000,
        }),
      );
      createdThreadIds.push(inserted.id);

      // Clear the identity map so the second upsert goes to the DB (not cache),
      // mirroring production where each request uses an independent EM context.
      orm.em.clear();

      // Re-upsert while already Running with a fresh "now"
      const newNow = new Date('2026-04-01T10:05:00.000Z');
      const upserted = await threadsService.upsertRunningThread(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: newNow,
          totalRunningMs: 0,
        }),
      );

      // Idempotent — clock NOT reset, accumulator NOT zeroed
      expect(upserted.status).toBe(ThreadStatus.Running);
      expect(upserted.runningStartedAt!.getTime()).toBe(
        originalStartedAt.getTime(),
      );
      expect(Number(upserted.totalRunningMs)).toBe(5_000);

      const reloaded = await reload(inserted.id);
      expect(reloaded.runningStartedAt!.getTime()).toBe(
        originalStartedAt.getTime(),
      );
      expect(Number(reloaded.totalRunningMs)).toBe(5_000);
    },
  );

  it(
    'CONFLICT (existing non-Running, resume): runningStartedAt overwritten with EXCLUDED, totalRunningMs preserved',
    { timeout: 15_000 },
    async () => {
      const externalThreadId = randomUUID();
      const accumulated = 7_000;

      // Seed a Done thread directly via DAO.create so the accumulator is set
      const seeded = await threadsDao.create({
        graphId: sharedGraphId,
        createdBy: TEST_USER_ID,
        projectId: testProjectId,
        externalThreadId,
        status: ThreadStatus.Done,
        runningStartedAt: null,
        totalRunningMs: accumulated,
      });
      createdThreadIds.push(seeded.id);

      // Resume: upsert sets status=Running with a fresh now
      const resumeNow = new Date('2026-04-01T12:00:00.000Z');
      const upserted = await threadsService.upsertRunningThread(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: resumeNow,
          totalRunningMs: 0,
        }),
      );

      // Status flips, clock starts at resumeNow, accumulator survives
      expect(upserted.status).toBe(ThreadStatus.Running);
      expect(upserted.runningStartedAt!.getTime()).toBe(resumeNow.getTime());
      expect(Number(upserted.totalRunningMs)).toBe(accumulated);

      const reloaded = await reload(seeded.id);
      expect(reloaded.status).toBe(ThreadStatus.Running);
      expect(reloaded.runningStartedAt!.getTime()).toBe(resumeNow.getTime());
      expect(Number(reloaded.totalRunningMs)).toBe(accumulated);
    },
  );

  it(
    'CONFLICT: source and metadata are preserved (insert-only fields)',
    { timeout: 15_000 },
    async () => {
      const externalThreadId = randomUUID();
      const firstNow = new Date('2026-04-01T10:00:00.000Z');

      const inserted = await threadsService.upsertRunningThread(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: firstNow,
          source: 'manual-trigger',
          metadata: { effectiveCostLimitUsd: 1.5, anotherField: 'keep' },
        }),
      );
      createdThreadIds.push(inserted.id);

      // Re-upsert WITHOUT source/metadata — must not clobber
      await threadsService.upsertRunningThread(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: new Date('2026-04-01T11:00:00.000Z'),
        }),
      );

      const reloaded = await reload(inserted.id);
      expect(reloaded.source).toBe('manual-trigger');
      expect(reloaded.metadata).toEqual({
        effectiveCostLimitUsd: 1.5,
        anotherField: 'keep',
      });
    },
  );

  it(
    'CONFLICT (existing Running, incoming status=Done): preserves Running invariants — DAO should reject non-Running upserts',
    { timeout: 15_000 },
    async () => {
      // The DAO contract is implicitly "upsert into Running": all production
      // callers pass status=Running (agent-invoke handler + executeTrigger
      // eager upsert). The ON CONFLICT CASE only handles the
      // "existing=Running → incoming arbitrary" branch correctly for
      // status=Running; if a caller passes status=Done, the merged row ends
      // up with status=Done + non-null runningStartedAt (preserved from the
      // existing Running row) + UNACCUMULATED totalRunningMs (preserved
      // verbatim). That row violates the invariant that out-of-Running
      // statuses MUST have runningStartedAt=null AND the elapsed delta folded
      // into totalRunningMs (the contract that ThreadStatusTransitionService
      // upholds for the proper code path via computeTransition + updateById).
      //
      // Either the DAO must REJECT non-Running upserts at the type / runtime
      // boundary, OR the SQL CASE must be widened so a Running→Done upsert
      // accumulates and nulls correctly. Today neither defense exists; this
      // test asserts the type-level/runtime guard.
      const externalThreadId = randomUUID();
      const originalStartedAt = new Date('2026-04-01T10:00:00.000Z');

      const inserted = await threadsService.upsertRunningThread(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: originalStartedAt,
          totalRunningMs: 5_000,
        }),
      );
      createdThreadIds.push(inserted.id);

      // Re-upsert with status=Done. Today this silently produces a row with
      // status=Done + non-null runningStartedAt (the existing Running value)
      // — i.e. a row that the front-end's live-duration hook reads as
      // "running" (status flag says Done, but the timer field is populated)
      // OR that the prepareThreadsResponse stale-drift defense has to clean
      // up after the fact. The DAO should refuse to commit such a row.
      //
      // Acceptable resolutions:
      //   (a) DAO/runtime guard: throw on non-Running upsert.
      //   (b) Widen SQL CASE: when incoming status != Running, force
      //       running_started_at=null and accumulate the delta into
      //       total_running_ms.
      //
      // This test passes if EITHER (a) the call throws OR (b) the resulting
      // row has running_started_at=null AND totalRunningMs > 5_000 (the
      // accumulator was advanced). It fails today because the current
      // implementation does neither.
      let threwOnNonRunningUpsert = false;
      let upserted: Awaited<
        ReturnType<typeof threadsService.upsertRunningThread>
      > | null = null;
      try {
        upserted = await threadsService.upsertRunningThread({
          graphId: sharedGraphId,
          createdBy: TEST_USER_ID,
          projectId: testProjectId,
          externalThreadId,
          // Intentionally passing a non-Running status to verify the runtime guard.
          // The DAO type requires status=Running; cast to bypass compile-time check.
          status: ThreadStatus.Done as typeof ThreadStatus.Running,
          runningStartedAt: new Date('2026-04-01T10:05:00.000Z'),
          totalRunningMs: 0,
        });
      } catch {
        threwOnNonRunningUpsert = true;
      }

      if (threwOnNonRunningUpsert) {
        // Resolution (a) — DAO refused the bad upsert. Confirm the row was
        // not mutated.
        const reloaded = await reload(inserted.id);
        expect(reloaded.status).toBe(ThreadStatus.Running);
        expect(reloaded.runningStartedAt!.getTime()).toBe(
          originalStartedAt.getTime(),
        );
        expect(Number(reloaded.totalRunningMs)).toBe(5_000);
        return;
      }

      // Resolution (b) — DAO accepted but produced a semantically correct
      // out-of-Running row. Today the row is semantically WRONG (status=Done
      // but runningStartedAt=non-null and totalRunningMs unchanged), so the
      // assertions below fail on current code.
      expect(upserted).not.toBeNull();
      expect(upserted!.runningStartedAt).toBeNull();
      // The elapsed delta (≥5_000ms seeded) must be folded into totalRunningMs
      // so the accumulator is not lost when the row transitions out of Running.
      expect(Number(upserted!.totalRunningMs)).toBeGreaterThanOrEqual(5_000);
      const reloaded = await reload(inserted.id);
      expect(reloaded.runningStartedAt).toBeNull();
      expect(Number(reloaded.totalRunningMs)).toBeGreaterThanOrEqual(5_000);
    },
  );

  it(
    'CONFLICT: lastRunId is overwritten when provided, preserved when omitted',
    { timeout: 15_000 },
    async () => {
      const externalThreadId = randomUUID();
      const firstRunId = '11111111-1111-4111-8aaa-111111111111';
      const secondRunId = '22222222-2222-4222-8aaa-222222222222';

      const inserted = await threadsService.upsertRunningThread(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: new Date('2026-04-01T10:00:00.000Z'),
          lastRunId: firstRunId,
        }),
      );
      createdThreadIds.push(inserted.id);

      // Provide a new lastRunId — must overwrite
      await threadsService.upsertRunningThread(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: new Date('2026-04-01T11:00:00.000Z'),
          lastRunId: secondRunId,
        }),
      );
      expect((await reload(inserted.id)).lastRunId).toBe(secondRunId);

      // Omit lastRunId — must preserve (COALESCE)
      await threadsService.upsertRunningThread(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: new Date('2026-04-01T12:00:00.000Z'),
        }),
      );
      expect((await reload(inserted.id)).lastRunId).toBe(secondRunId);
    },
  );
});
