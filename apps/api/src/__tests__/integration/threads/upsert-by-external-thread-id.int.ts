import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { createMockGraphData } from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import { createTestModule, TEST_USER_ID } from '../setup';

/**
 * Integration spec: ThreadsDao.upsertByExternalThreadId
 *
 * Pins the ON CONFLICT clause's CASE semantics for the running-timer fields.
 * The handler always passes runningStartedAt=now and totalRunningMs=0; the
 * three behaviours below come from SQL alone, not from caller-side logic.
 *
 *   1. INSERT (no existing row): incoming runningStartedAt/totalRunningMs win.
 *   2. CONFLICT, existing was Running: idempotent — runningStartedAt preserved.
 *   3. CONFLICT, existing was non-Running: runningStartedAt = EXCLUDED (now),
 *      totalRunningMs preserved (accumulator survives).
 *
 * Also covers the conflict-merge contract for source/metadata (preserved) and
 * last_run_id (overwritten when provided, preserved when null via COALESCE).
 */
describe('ThreadsDao.upsertByExternalThreadId — ON CONFLICT semantics', () => {
  let app: INestApplication;
  let threadsDao: ThreadsDao;
  let graphsService: GraphsService;
  let orm: MikroORM;
  let testProjectId: string;
  let sharedGraphId: string;
  let ctx: AppContextStorage;

  const createdThreadIds: string[] = [];

  beforeAll(async () => {
    app = await createTestModule();
    threadsDao = app.get(ThreadsDao);
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
    status: ThreadStatus.Running,
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

      const inserted = await threadsDao.upsertByExternalThreadId(
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

      const inserted = await threadsDao.upsertByExternalThreadId(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: originalStartedAt,
          totalRunningMs: 5_000,
        }),
      );
      createdThreadIds.push(inserted.id);

      // Re-upsert while already Running with a fresh "now"
      const newNow = new Date('2026-04-01T10:05:00.000Z');
      const upserted = await threadsDao.upsertByExternalThreadId(
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
      const upserted = await threadsDao.upsertByExternalThreadId(
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

      const inserted = await threadsDao.upsertByExternalThreadId(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: firstNow,
          source: 'manual-trigger',
          metadata: { effectiveCostLimitUsd: 1.5, anotherField: 'keep' },
        }),
      );
      createdThreadIds.push(inserted.id);

      // Re-upsert WITHOUT source/metadata — must not clobber
      await threadsDao.upsertByExternalThreadId(
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
    'CONFLICT: lastRunId is overwritten when provided, preserved when omitted',
    { timeout: 15_000 },
    async () => {
      const externalThreadId = randomUUID();
      const firstRunId = '11111111-1111-4111-8aaa-111111111111';
      const secondRunId = '22222222-2222-4222-8aaa-222222222222';

      const inserted = await threadsDao.upsertByExternalThreadId(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: new Date('2026-04-01T10:00:00.000Z'),
          lastRunId: firstRunId,
        }),
      );
      createdThreadIds.push(inserted.id);

      // Provide a new lastRunId — must overwrite
      await threadsDao.upsertByExternalThreadId(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: new Date('2026-04-01T11:00:00.000Z'),
          lastRunId: secondRunId,
        }),
      );
      expect((await reload(inserted.id)).lastRunId).toBe(secondRunId);

      // Omit lastRunId — must preserve (COALESCE)
      await threadsDao.upsertByExternalThreadId(
        baseUpsertPayload({
          externalThreadId,
          runningStartedAt: new Date('2026-04-01T12:00:00.000Z'),
        }),
      );
      expect((await reload(inserted.id)).lastRunId).toBe(secondRunId);
    },
  );
});
