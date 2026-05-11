import { MikroORM } from '@mikro-orm/postgresql';
import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ThreadResumeJobData,
  ThreadResumeQueueCallbacks,
  ThreadResumeQueueService,
} from './thread-resume-queue.service';

vi.mock('@mikro-orm/postgresql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mikro-orm/postgresql')>();
  return {
    ...actual,
    RequestContext: {
      create: (_em: unknown, cb: () => Promise<void>) => cb(),
    },
  };
});

const mockOrm = { em: {} } as unknown as MikroORM;

const mockQueue = {
  add: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getJob: vi.fn().mockResolvedValue(null),
  getDelayed: vi.fn().mockResolvedValue([]),
};

const mockWorker = {
  on: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockRedis = {
  quit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

const mockLogger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

vi.mock('bullmq', () => ({
  Queue: function Queue() {
    return mockQueue;
  },
  Worker: function Worker() {
    return mockWorker;
  },
}));

vi.mock('ioredis', () => {
  return {
    default: function IORedis() {
      return mockRedis;
    },
  };
});

const makeJobData = (
  overrides: Partial<ThreadResumeJobData> = {},
): ThreadResumeJobData => ({
  threadId: 'thread-1',
  graphId: 'graph-1',
  nodeId: 'node-1',
  externalThreadId: 'ext-thread-1',
  checkPrompt: 'Check if the deployment is complete',
  reason: 'Waiting for deployment',
  scheduledAt: '2024-01-01T00:05:00.000Z',
  createdBy: 'user-1',
  ...overrides,
});

describe('ThreadResumeQueueService', () => {
  let service: ThreadResumeQueueService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new ThreadResumeQueueService(
      mockLogger as unknown as DefaultLogger,
      mockOrm,
    );
    await service.onModuleInit();
  });

  describe('setCallbacks', () => {
    it('stores the callbacks and creates worker', () => {
      const callbacks: ThreadResumeQueueCallbacks = {
        onProcess: vi.fn(),
        onFailed: vi.fn(),
      };
      service.setCallbacks(callbacks);

      expect(callbacks.onProcess).not.toHaveBeenCalled();
      expect(mockWorker.on).toHaveBeenCalledWith(
        'failed',
        expect.any(Function),
      );
    });
  });

  describe('scheduleResume', () => {
    it('adds a delayed job with correct jobId and delay', async () => {
      const data = makeJobData();

      await service.scheduleResume(data, 60_000);

      expect(mockQueue.add).toHaveBeenCalledWith('thread-resume', data, {
        jobId: 'thread-resume-thread-1',
        delay: 60_000,
      });
    });

    it('removes existing job before scheduling a new one', async () => {
      const mockExistingJob = {
        remove: vi.fn().mockResolvedValue(undefined),
      };
      mockQueue.getJob.mockResolvedValueOnce(mockExistingJob);

      const data = makeJobData();
      await service.scheduleResume(data, 30_000);

      expect(mockExistingJob.remove).toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith(
        'thread-resume',
        data,
        expect.objectContaining({ delay: 30_000 }),
      );
    });

    it('proceeds with scheduling even if existing job removal fails', async () => {
      const mockExistingJob = {
        remove: vi.fn().mockRejectedValue(new Error('remove failed')),
      };
      mockQueue.getJob.mockResolvedValueOnce(mockExistingJob);

      const data = makeJobData();
      await service.scheduleResume(data, 10_000);

      expect(mockQueue.add).toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Could not remove existing resume job',
        expect.objectContaining({ threadId: 'thread-1' }),
      );
    });
  });

  describe('cancelResumeJob', () => {
    it('removes the job when it exists', async () => {
      const mockJob = {
        remove: vi.fn().mockResolvedValue(undefined),
      };
      mockQueue.getJob.mockResolvedValueOnce(mockJob);

      await service.cancelResumeJob('thread-1');

      expect(mockQueue.getJob).toHaveBeenCalledWith('thread-resume-thread-1');
      expect(mockJob.remove).toHaveBeenCalled();
    });

    it('returns silently when job does not exist', async () => {
      mockQueue.getJob.mockResolvedValueOnce(null);

      await service.cancelResumeJob('non-existent');

      expect(mockQueue.getJob).toHaveBeenCalledWith(
        'thread-resume-non-existent',
      );
    });

    it('logs and does not throw when removal fails', async () => {
      const mockJob = {
        remove: vi.fn().mockRejectedValue(new Error('locked')),
      };
      mockQueue.getJob.mockResolvedValueOnce(mockJob);

      await service.cancelResumeJob('thread-1');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Could not cancel resume job',
        expect.objectContaining({ threadId: 'thread-1' }),
      );
    });
  });

  describe('cancelAllForGraph', () => {
    it('removes only delayed jobs matching the graphId', async () => {
      const removeMatching = vi.fn().mockResolvedValue(undefined);
      const removeOther = vi.fn().mockResolvedValue(undefined);

      mockQueue.getDelayed.mockResolvedValueOnce([
        { id: 'job-1', data: { graphId: 'graph-1' }, remove: removeMatching },
        { id: 'job-2', data: { graphId: 'graph-2' }, remove: removeOther },
        { id: 'job-3', data: { graphId: 'graph-1' }, remove: removeMatching },
      ]);

      await service.cancelAllForGraph('graph-1');

      expect(removeMatching).toHaveBeenCalledTimes(2);
      expect(removeOther).not.toHaveBeenCalled();
    });

    it('does nothing when no delayed jobs match', async () => {
      mockQueue.getDelayed.mockResolvedValueOnce([
        { id: 'job-1', data: { graphId: 'graph-other' }, remove: vi.fn() },
      ]);

      await service.cancelAllForGraph('graph-1');

      expect(mockLogger.debug).not.toHaveBeenCalledWith(
        'Cancelled resume jobs for graph',
        expect.anything(),
      );
    });

    it('logs warning when getDelayed fails', async () => {
      mockQueue.getDelayed.mockRejectedValueOnce(new Error('Redis error'));

      await service.cancelAllForGraph('graph-1');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to cancel resume jobs for graph',
        expect.objectContaining({ graphId: 'graph-1' }),
      );
    });
  });

  describe('handleJobFailed', () => {
    it('calls onFailed for final failure when attemptsMade >= attempts', async () => {
      const callbacks: ThreadResumeQueueCallbacks = {
        onProcess: vi.fn(),
        onFailed: vi.fn(),
      };
      service.setCallbacks(callbacks);

      const failedHandler = mockWorker.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'failed',
      )?.[1] as (job: unknown, err: Error) => Promise<void>;

      expect(failedHandler).toBeDefined();

      const error = new Error('resume failed permanently');
      const data = makeJobData();
      const mockJob = {
        id: 'job-1',
        data,
        attemptsMade: 3,
        opts: { attempts: 3 },
      };

      await failedHandler(mockJob, error);

      expect(callbacks.onFailed).toHaveBeenCalledWith(data, error);
    });

    it('does not call onFailed when more attempts remain', async () => {
      const callbacks: ThreadResumeQueueCallbacks = {
        onProcess: vi.fn(),
        onFailed: vi.fn(),
      };
      service.setCallbacks(callbacks);

      const failedHandler = mockWorker.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'failed',
      )?.[1] as (job: unknown, err: Error) => Promise<void>;

      const error = new Error('transient failure');
      const mockJob = {
        id: 'job-2',
        data: makeJobData(),
        attemptsMade: 1,
        opts: { attempts: 3 },
      };

      await failedHandler(mockJob, error);

      expect(callbacks.onFailed).not.toHaveBeenCalled();
    });

    it('does nothing when job is undefined', async () => {
      const callbacks: ThreadResumeQueueCallbacks = {
        onProcess: vi.fn(),
        onFailed: vi.fn(),
      };
      service.setCallbacks(callbacks);

      const failedHandler = mockWorker.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'failed',
      )?.[1] as (job: unknown, err: Error) => Promise<void>;

      await failedHandler(undefined, new Error('no job'));

      expect(callbacks.onFailed).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('closes worker, queue, and redis connections', async () => {
      service.setCallbacks({
        onProcess: vi.fn(),
        onFailed: vi.fn(),
      });

      await service.onModuleDestroy();

      expect(mockWorker.close).toHaveBeenCalled();
      expect(mockQueue.close).toHaveBeenCalled();
      expect(mockRedis.quit).toHaveBeenCalled();
    });

    it('handles missing worker gracefully', async () => {
      await service.onModuleDestroy();

      expect(mockQueue.close).toHaveBeenCalled();
      expect(mockRedis.quit).toHaveBeenCalled();
    });
  });
});
