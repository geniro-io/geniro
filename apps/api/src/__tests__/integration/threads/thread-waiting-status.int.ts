import { INestApplication } from '@nestjs/common';
import {
  BadRequestException,
  BaseException,
  NotFoundException,
} from '@packages/common';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import {
  createMockGraphData,
  waitForCondition,
} from '../helpers/graph-helpers';
import { buildTestContext, createTestProject } from '../helpers/test-context';
import { createTestModule, TEST_USER_ID } from '../setup';

describe('Thread Waiting Status Integration Tests', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  let threadsDao: ThreadsDao;
  let ctx: AppContextStorage;
  let testProjectId: string;
  let graphId: string;
  const createdGraphIds: string[] = [];

  /** Internal thread ID of the thread created via executeTrigger. */
  let threadId: string;

  beforeAll(async () => {
    app = await createTestModule();

    graphsService = app.get<GraphsService>(GraphsService);
    threadsService = app.get<ThreadsService>(ThreadsService);
    threadsDao = app.get<ThreadsDao>(ThreadsDao);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    ctx = projectResult.ctx;

    // Create and run a graph so we can create a thread via executeTrigger.
    const graph = await graphsService.create(
      ctx,
      createMockGraphData({
        name: `Thread Waiting Status ${Date.now()}`,
      }),
    );
    graphId = graph.id;
    createdGraphIds.push(graphId);

    await graphsService.run(ctx, graphId);
    await waitForCondition(
      () => graphsService.findById(ctx, graphId),
      (g) => g.status === GraphStatus.Running,
      { timeout: 60_000, interval: 1_000 },
    );

    // Execute a trigger to create a real thread in the database.
    const triggerResult = await graphsService.executeTrigger(
      ctx,
      graphId,
      'trigger-1',
      { messages: [`Thread waiting test ${Date.now()}`] },
    );

    // Wait for the thread to reach a TERMINAL status. `Running` is transient
    // and an in-flight notification handler can still flip it after the
    // condition resolves — under load (parallel mode), the handler routinely
    // overwrites a `setThreadWaiting()` write done by the test body, which
    // causes `getThreads({ status: Waiting })` to return 0.
    const thread = await waitForCondition(
      () =>
        threadsService.getThreadByExternalId(
          ctx,
          triggerResult.externalThreadId,
        ),
      (t) =>
        t.status === ThreadStatus.Done ||
        t.status === ThreadStatus.NeedMoreInfo ||
        t.status === ThreadStatus.Stopped,
      { timeout: 60_000, interval: 500 },
    );
    threadId = thread.id;
  }, 180_000);

  afterAll(async () => {
    await Promise.all(
      createdGraphIds.map(async (gId) => {
        try {
          await graphsService.destroy(ctx, gId);
        } catch (error: unknown) {
          if (
            !(error instanceof BaseException) ||
            (error.errorCode !== 'GRAPH_NOT_RUNNING' &&
              error.errorCode !== 'GRAPH_NOT_FOUND')
          ) {
            throw error;
          }
        }

        try {
          await graphsService.delete(ctx, gId);
        } catch (error: unknown) {
          if (
            !(error instanceof BaseException) ||
            error.errorCode !== 'GRAPH_NOT_FOUND'
          ) {
            throw error;
          }
        }
      }),
    );

    if (testProjectId) {
      try {
        await app.get(ProjectsDao).deleteById(testProjectId);
      } catch {
        // best effort cleanup
      }
    }

    await app.close();
  }, 180_000);

  /**
   * Helper: set a thread to Waiting status with optional wait metadata.
   */
  const setThreadWaiting = async (
    id: string,
    metadata?: Record<string, unknown>,
  ) => {
    await threadsDao.updateById(id, {
      status: ThreadStatus.Waiting,
      ...(metadata !== undefined ? { metadata } : {}),
    });
  };

  /**
   * Helper: reset a thread back to Done so tests start from a clean slate.
   */
  const resetThreadStatus = async (
    id: string,
    status: ThreadStatus = ThreadStatus.Done,
  ) => {
    await threadsDao.updateById(id, { status, metadata: {} });
  };

  describe('Thread status filter includes waiting status', () => {
    it(
      'should return threads filtered by Waiting status',
      { timeout: 30_000 },
      async () => {
        await setThreadWaiting(threadId);

        const threads = await threadsService.getThreads(ctx, {
          graphId,
          statuses: [ThreadStatus.Waiting],
          limit: 100,
          offset: 0,
        });

        expect(threads.length).toBeGreaterThanOrEqual(1);
        const found = threads.find((t) => t.id === threadId);
        expect(found).toBeDefined();
        expect(found!.status).toBe(ThreadStatus.Waiting);

        await resetThreadStatus(threadId);
      },
    );
  });

  describe('Waiting threads appear in getThreads without status filter', () => {
    it(
      'should include waiting threads when no status filter is applied',
      { timeout: 30_000 },
      async () => {
        await setThreadWaiting(threadId);

        const threads = await threadsService.getThreads(ctx, {
          graphId,
          limit: 100,
          offset: 0,
        });

        const found = threads.find((t) => t.id === threadId);
        expect(found).toBeDefined();
        expect(found!.status).toBe(ThreadStatus.Waiting);

        await resetThreadStatus(threadId);
      },
    );
  });

  describe('cancelWait transitions thread from Waiting to Stopped', () => {
    it(
      'should transition to Stopped and clear wait metadata',
      { timeout: 30_000 },
      async () => {
        const waitMetadata = {
          scheduledResumeAt: new Date(Date.now() + 60_000).toISOString(),
          waitReason: 'Waiting for external input',
          waitNodeId: 'agent-1',
          waitCheckPrompt: 'Check if input arrived',
          customField: 'should-be-preserved',
        };
        await setThreadWaiting(threadId, waitMetadata);

        const result = await threadsService.cancelWait(ctx, threadId);

        expect(result.status).toBe(ThreadStatus.Stopped);

        // Verify the persisted state via DAO
        const dbThread = await threadsDao.getById(threadId);
        expect(dbThread).toBeDefined();
        expect(dbThread!.status).toBe(ThreadStatus.Stopped);

        // Wait metadata should be cleared, custom fields preserved
        const meta = dbThread!.metadata ?? {};
        expect(meta).not.toHaveProperty('scheduledResumeAt');
        expect(meta).not.toHaveProperty('waitReason');
        expect(meta).not.toHaveProperty('waitNodeId');
        expect(meta).not.toHaveProperty('waitCheckPrompt');
        expect(meta).toHaveProperty('customField', 'should-be-preserved');

        await resetThreadStatus(threadId);
      },
    );
  });

  describe('cancelWait throws for non-waiting thread', () => {
    it(
      'should throw BadRequestException with THREAD_NOT_WAITING',
      { timeout: 30_000 },
      async () => {
        await resetThreadStatus(threadId, ThreadStatus.Done);

        try {
          await threadsService.cancelWait(ctx, threadId);
          expect.unreachable('Should have thrown');
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(BadRequestException);
          expect((error as BadRequestException).errorCode).toBe(
            'THREAD_NOT_WAITING',
          );
        }
      },
    );
  });

  describe('resumeThread throws for non-waiting thread', () => {
    it(
      'should throw BadRequestException with THREAD_NOT_WAITING',
      { timeout: 30_000 },
      async () => {
        await resetThreadStatus(threadId, ThreadStatus.Done);

        try {
          await threadsService.resumeThread(ctx, threadId, {
            message: 'check',
          });
          expect.unreachable('Should have thrown');
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(BadRequestException);
          expect((error as BadRequestException).errorCode).toBe(
            'THREAD_NOT_WAITING',
          );
        }
      },
    );
  });

  describe('cancelWait/resumeThread throws for non-existent thread', () => {
    it(
      'cancelWait should throw NotFoundException with THREAD_NOT_FOUND',
      { timeout: 30_000 },
      async () => {
        const fakeId = randomUUID();

        try {
          await threadsService.cancelWait(ctx, fakeId);
          expect.unreachable('Should have thrown');
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(NotFoundException);
          expect((error as NotFoundException).errorCode).toBe(
            'THREAD_NOT_FOUND',
          );
        }
      },
    );

    it(
      'resumeThread should throw NotFoundException with THREAD_NOT_FOUND',
      { timeout: 30_000 },
      async () => {
        const fakeId = randomUUID();

        try {
          await threadsService.resumeThread(ctx, fakeId, { message: 'check' });
          expect.unreachable('Should have thrown');
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(NotFoundException);
          expect((error as NotFoundException).errorCode).toBe(
            'THREAD_NOT_FOUND',
          );
        }
      },
    );
  });

  describe('getOwnedWaitingThread validates ownership', () => {
    it(
      'should throw NotFoundException when a different user tries to cancelWait',
      { timeout: 30_000 },
      async () => {
        await setThreadWaiting(threadId);

        const otherUserId = randomUUID();
        const otherCtx = buildTestContext(otherUserId, testProjectId);

        try {
          await threadsService.cancelWait(otherCtx, threadId);
          expect.unreachable('Should have thrown');
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(NotFoundException);
          expect((error as NotFoundException).errorCode).toBe(
            'THREAD_NOT_FOUND',
          );
        }

        await resetThreadStatus(threadId);
      },
    );
  });

  describe('clearWaitMetadata preserves non-wait metadata', () => {
    it(
      'should keep custom metadata fields after cancelWait',
      { timeout: 30_000 },
      async () => {
        const metadata = {
          scheduledResumeAt: new Date(Date.now() + 120_000).toISOString(),
          waitReason: 'Periodic check',
          waitNodeId: 'agent-1',
          waitCheckPrompt: 'Is the task done?',
          userLabel: 'important-thread',
          retryCount: 3,
          tags: ['auto', 'monitoring'],
        };
        await setThreadWaiting(threadId, metadata);

        await threadsService.cancelWait(ctx, threadId);

        const dbThread = await threadsDao.getById(threadId);
        expect(dbThread).toBeDefined();

        const meta = dbThread!.metadata ?? {};
        // Wait fields cleared
        expect(meta).not.toHaveProperty('scheduledResumeAt');
        expect(meta).not.toHaveProperty('waitReason');
        expect(meta).not.toHaveProperty('waitNodeId');
        expect(meta).not.toHaveProperty('waitCheckPrompt');

        // Custom fields preserved
        expect(meta).toHaveProperty('userLabel', 'important-thread');
        expect(meta).toHaveProperty('retryCount', 3);
        expect(meta).toHaveProperty('tags', ['auto', 'monitoring']);

        await resetThreadStatus(threadId);
      },
    );
  });
});
