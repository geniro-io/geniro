import type { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';

import { NotificationEvent } from '../../../notifications/notifications.types';
import type { NotificationsService } from '../../../notifications/services/notifications.service';
import type { RuntimeInstanceDao } from '../../../runtime/dao/runtime-instance.dao';
import { RuntimeInstanceStatus } from '../../../runtime/runtime.types';
import type { ThreadsDao } from '../../../threads/dao/threads.dao';
import type { ThreadEntity } from '../../../threads/entity/thread.entity';
import { ThreadStatusTransitionService } from '../../../threads/services/thread-status-transition.service';
import { ThreadStatus } from '../../../threads/threads.types';
import { ClaudeOrphanReaperService } from './claude-orphan-reaper.service';

/** Well past the 2-minute grace window for a thread that started at epoch 0. */
const NOW = 10_000_000;

const makeThread = (over: Partial<ThreadEntity>): ThreadEntity =>
  ({
    id: 'tid',
    graphId: 'g-1',
    externalThreadId: 'ext-1',
    status: ThreadStatus.Running,
    runningStartedAt: new Date(0),
    totalRunningMs: 0,
    metadata: { claudeSessions: { 'claude-1': 'sess-1' } },
    ...over,
  }) as unknown as ThreadEntity;

describe('ClaudeOrphanReaperService.sweep', () => {
  let threadsDao: {
    getAll: ReturnType<typeof vi.fn>;
    getOne: ReturnType<typeof vi.fn>;
    updateById: ReturnType<typeof vi.fn>;
  };
  let runtimeDao: { getAll: ReturnType<typeof vi.fn> };
  let notifications: { emit: ReturnType<typeof vi.fn> };
  let service: ClaudeOrphanReaperService;

  beforeEach(() => {
    threadsDao = {
      getAll: vi.fn().mockResolvedValue([]),
      // reapThread re-reads the row immediately before the write; default to a
      // still-Running row so the happy path reaps. TOCTOU tests override this.
      getOne: vi.fn(async (where: { id: string }) =>
        makeThread({ id: where.id }),
      ),
      updateById: vi.fn().mockResolvedValue(1),
    };
    runtimeDao = { getAll: vi.fn().mockResolvedValue([]) };
    notifications = { emit: vi.fn().mockResolvedValue(undefined) };
    service = new ClaudeOrphanReaperService(
      threadsDao as unknown as ThreadsDao,
      runtimeDao as unknown as RuntimeInstanceDao,
      new ThreadStatusTransitionService(),
      notifications as unknown as NotificationsService,
      mockDeep<DefaultLogger>(),
    );
  });

  it('reaps a Running Claude thread with no live runtime — Stopped + ThreadUpdate notification', async () => {
    threadsDao.getAll.mockResolvedValue([makeThread({})]);
    runtimeDao.getAll.mockResolvedValue([]); // no live runtime backs the session

    const reaped = await service.sweep(NOW);

    expect(reaped).toBe(1);
    // Liveness check keys on the thread's external id (= runtime instance threadId).
    expect(runtimeDao.getAll).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'ext-1',
        status: {
          $in: [RuntimeInstanceStatus.Running, RuntimeInstanceStatus.Starting],
        },
      }),
    );
    expect(threadsDao.updateById).toHaveBeenCalledWith(
      'tid',
      expect.objectContaining({
        status: ThreadStatus.Stopped,
        runningStartedAt: null,
      }),
    );
    expect(notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: NotificationEvent.ThreadUpdate,
        threadId: 'ext-1',
        data: expect.objectContaining({ status: ThreadStatus.Stopped }),
      }),
    );
  });

  it('skips a Running Claude thread that still has a live runtime (alive here or on another instance)', async () => {
    threadsDao.getAll.mockResolvedValue([makeThread({})]);
    runtimeDao.getAll.mockResolvedValue([
      { id: 'r-1', status: RuntimeInstanceStatus.Running },
    ]);

    const reaped = await service.sweep(NOW);

    expect(reaped).toBe(0);
    expect(threadsDao.updateById).not.toHaveBeenCalled();
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('skips a Running thread that is not Claude-backed (no claudeSessions) — never hits the runtime check', async () => {
    threadsDao.getAll.mockResolvedValue([makeThread({ metadata: {} })]);

    const reaped = await service.sweep(NOW);

    expect(reaped).toBe(0);
    expect(runtimeDao.getAll).not.toHaveBeenCalled();
  });

  it('skips a freshly-Running Claude thread inside the grace window (its runtime row may not exist yet)', async () => {
    threadsDao.getAll.mockResolvedValue([
      makeThread({ runningStartedAt: new Date(NOW - 1_000) }),
    ]);

    const reaped = await service.sweep(NOW);

    expect(reaped).toBe(0);
    expect(runtimeDao.getAll).not.toHaveBeenCalled();
  });

  it('returns 0 without throwing when the thread query fails (sweep is best-effort)', async () => {
    threadsDao.getAll.mockRejectedValue(new Error('db down'));

    await expect(service.sweep(NOW)).resolves.toBe(0);
    expect(threadsDao.updateById).not.toHaveBeenCalled();
  });

  it('isolates a per-thread failure — one bad thread does not abort the rest of the sweep', async () => {
    const t1 = makeThread({ id: 'tid-1', externalThreadId: 'ext-1' });
    const t2 = makeThread({ id: 'tid-2', externalThreadId: 'ext-2' });
    threadsDao.getAll.mockResolvedValue([t1, t2]);
    // The first thread's runtime-liveness query rejects; the second is reapable.
    runtimeDao.getAll.mockImplementation(
      async (where: { threadId: string }) => {
        if (where.threadId === 'ext-1') {
          throw new Error('runtime query failed');
        }
        return [];
      },
    );

    const reaped = await service.sweep(NOW);

    expect(reaped).toBe(1); // only the second thread
    expect(threadsDao.updateById).toHaveBeenCalledWith(
      'tid-2',
      expect.anything(),
    );
    expect(threadsDao.updateById).not.toHaveBeenCalledWith(
      'tid-1',
      expect.anything(),
    );
  });

  it('does not reap a thread that is no longer Running at re-read time (restarted/finished mid-sweep)', async () => {
    threadsDao.getAll.mockResolvedValue([makeThread({})]); // snapshot says Running
    runtimeDao.getAll.mockResolvedValue([]);
    // By the time reapThread re-reads, the thread has finished or been restarted.
    threadsDao.getOne.mockResolvedValue(
      makeThread({ status: ThreadStatus.Done }),
    );

    const reaped = await service.sweep(NOW);

    expect(reaped).toBe(0);
    expect(threadsDao.updateById).not.toHaveBeenCalled();
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('writes the freshly re-read metadata (not the stale snapshot) when reaping', async () => {
    threadsDao.getAll.mockResolvedValue([
      makeThread({ metadata: { claudeSessions: { 'claude-1': 'sess-old' } } }),
    ]);
    runtimeDao.getAll.mockResolvedValue([]);
    // A concurrent writer persisted a new session id between snapshot and reap.
    threadsDao.getOne.mockResolvedValue(
      makeThread({
        metadata: {
          claudeSessions: { 'claude-1': 'sess-old', 'claude-2': 'sess-new' },
        },
      }),
    );

    await service.sweep(NOW);

    expect(threadsDao.updateById).toHaveBeenCalledWith(
      'tid',
      expect.objectContaining({
        metadata: expect.objectContaining({
          claudeSessions: { 'claude-1': 'sess-old', 'claude-2': 'sess-new' },
        }),
      }),
    );
  });
});
