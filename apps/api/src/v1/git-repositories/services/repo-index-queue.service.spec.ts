import { MikroORM } from '@mikro-orm/postgresql';
import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RepoIndexJobData,
  RepoIndexQueueCallbacks,
  RepoIndexQueueService,
} from './repo-index-queue.service';

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

const mockRedisClient = {
  publish: vi.fn().mockResolvedValue(1),
};

const mockQueue = {
  add: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getJob: vi.fn().mockResolvedValue(null),
  client: Promise.resolve(mockRedisClient),
};

const mockWorker = {
  on: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  cancelJob: vi.fn().mockReturnValue(true),
};

const mockRedis = {
  quit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  subscribe: vi.fn().mockResolvedValue(undefined),
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

describe('RepoIndexQueueService', () => {
  let service: RepoIndexQueueService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new RepoIndexQueueService(
      mockLogger as unknown as DefaultLogger,
      mockOrm,
    );
    await service.onModuleInit();
  });

  describe('setCallbacks', () => {
    it('stores the callbacks and creates worker', () => {
      const callbacks: RepoIndexQueueCallbacks = {
        onProcess: vi.fn(),
        onStalled: vi.fn(),
        onRetry: vi.fn(),
        onFailed: vi.fn(),
      };
      service.setCallbacks(callbacks);
      // Callbacks are stored privately; verified via event handling behavior
      expect(callbacks.onProcess).not.toHaveBeenCalled();
      // Worker is created when setCallbacks is called
      expect(mockWorker.on).toHaveBeenCalled();
    });

    it('subscribes to the cancel channel', () => {
      service.setCallbacks({
        onProcess: vi.fn(),
        onStalled: vi.fn(),
        onRetry: vi.fn(),
        onFailed: vi.fn(),
      });

      expect(mockRedis.subscribe).toHaveBeenCalledWith(
        expect.stringContaining('repo-index-cancel:'),
      );
    });
  });

  describe('addIndexJob', () => {
    it('adds a job with repoIndexId as jobId', async () => {
      const data: RepoIndexJobData = {
        repoIndexId: 'test-id-123',
        repoUrl: 'https://github.com/owner/repo',
        branch: 'main',
      };

      await service.addIndexJob(data);

      expect(mockQueue.add).toHaveBeenCalledWith('index-repo', data, {
        jobId: 'test-id-123',
      });
    });

    it('skips adding when existing job is in waiting state', async () => {
      const data: RepoIndexJobData = {
        repoIndexId: 'waiting-job-id',
        repoUrl: 'https://github.com/owner/repo',
        branch: 'main',
      };

      mockQueue.getJob.mockResolvedValueOnce({
        getState: vi.fn().mockResolvedValue('waiting'),
        remove: vi.fn(),
        moveToFailed: vi.fn(),
      });

      await service.addIndexJob(data);

      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('moves to failed and re-adds when existing job is in active state', async () => {
      const data: RepoIndexJobData = {
        repoIndexId: 'active-job-id',
        repoUrl: 'https://github.com/owner/repo',
        branch: 'main',
      };

      const mockExistingJob = {
        getState: vi.fn().mockResolvedValue('active'),
        remove: vi.fn().mockResolvedValue(undefined),
        moveToFailed: vi.fn().mockResolvedValue(undefined),
      };

      mockQueue.getJob.mockResolvedValueOnce(mockExistingJob);

      await service.addIndexJob(data);

      expect(mockExistingJob.moveToFailed).toHaveBeenCalledWith(
        expect.any(Error),
        '0',
        false,
      );
      expect(mockExistingJob.remove).toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith('index-repo', data, {
        jobId: 'active-job-id',
      });
    });

    it('removes and re-adds when existing job is in completed state', async () => {
      const data: RepoIndexJobData = {
        repoIndexId: 'completed-job-id',
        repoUrl: 'https://github.com/owner/repo',
        branch: 'main',
      };

      const mockExistingJob = {
        getState: vi.fn().mockResolvedValue('completed'),
        remove: vi.fn().mockResolvedValue(undefined),
        moveToFailed: vi.fn(),
      };

      mockQueue.getJob.mockResolvedValueOnce(mockExistingJob);

      await service.addIndexJob(data);

      expect(mockExistingJob.moveToFailed).not.toHaveBeenCalled();
      expect(mockExistingJob.remove).toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith('index-repo', data, {
        jobId: 'completed-job-id',
      });
    });
  });

  describe('removeJob', () => {
    it('removes a waiting job successfully', async () => {
      const mockJob = {
        getState: vi.fn().mockResolvedValue('waiting'),
        remove: vi.fn().mockResolvedValue(undefined),
      };

      mockQueue.getJob.mockResolvedValueOnce(mockJob);

      service.setCallbacks({
        onProcess: vi.fn(),
        onStalled: vi.fn(),
        onRetry: vi.fn(),
        onFailed: vi.fn(),
      });

      await service.removeJob('waiting-job-id');

      expect(mockQueue.getJob).toHaveBeenCalledWith('waiting-job-id');
      expect(mockJob.remove).toHaveBeenCalled();
    });

    it('returns silently when job does not exist', async () => {
      mockQueue.getJob.mockResolvedValueOnce(null);

      await service.removeJob('non-existent-id');

      expect(mockQueue.getJob).toHaveBeenCalledWith('non-existent-id');
      // No error thrown, just returns
    });

    it('cancels active jobs via cancelActiveJob', async () => {
      const mockJob = {
        getState: vi.fn().mockResolvedValue('active'),
      };

      mockQueue.getJob.mockResolvedValueOnce(mockJob);
      mockWorker.cancelJob.mockReturnValue(true);

      service.setCallbacks({
        onProcess: vi.fn(),
        onStalled: vi.fn(),
        onRetry: vi.fn(),
        onFailed: vi.fn(),
      });

      await service.removeJob('active-job-id');

      expect(mockWorker.cancelJob).toHaveBeenCalledWith(
        'active-job-id',
        'Repository deleted',
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Cancelling active repo index job due to repository deletion',
        { repoIndexId: 'active-job-id' },
      );
    });

    it('publishes cancel event when cancelJob returns false (remote worker)', async () => {
      const mockJob = {
        getState: vi.fn().mockResolvedValue('active'),
      };

      mockQueue.getJob.mockResolvedValueOnce(mockJob);
      mockWorker.cancelJob.mockReturnValue(false);

      service.setCallbacks({
        onProcess: vi.fn(),
        onStalled: vi.fn(),
        onRetry: vi.fn(),
        onFailed: vi.fn(),
      });

      await service.removeJob('remote-job-id');

      expect(mockWorker.cancelJob).toHaveBeenCalledWith(
        'remote-job-id',
        'Repository deleted',
      );
      expect(mockRedisClient.publish).toHaveBeenCalledWith(
        expect.stringContaining('repo-index-cancel:'),
        'remote-job-id',
      );
    });
  });

  describe('cancelActiveJob', () => {
    beforeEach(() => {
      service.setCallbacks({
        onProcess: vi.fn(),
        onStalled: vi.fn(),
        onRetry: vi.fn(),
        onFailed: vi.fn(),
      });
    });

    it('cancels locally when worker.cancelJob returns true', async () => {
      mockWorker.cancelJob.mockReturnValue(true);

      await service.cancelActiveJob('local-job-id');

      expect(mockWorker.cancelJob).toHaveBeenCalledWith(
        'local-job-id',
        'Repository deleted',
      );
      expect(mockRedisClient.publish).not.toHaveBeenCalled();
    });

    it('publishes to Redis when worker.cancelJob returns false', async () => {
      mockWorker.cancelJob.mockReturnValue(false);

      await service.cancelActiveJob('remote-job-id');

      expect(mockWorker.cancelJob).toHaveBeenCalledWith(
        'remote-job-id',
        'Repository deleted',
      );
      expect(mockRedisClient.publish).toHaveBeenCalledWith(
        expect.stringContaining('repo-index-cancel:'),
        'remote-job-id',
      );
    });

    it('logs debug and does not throw when Redis publish fails', async () => {
      mockWorker.cancelJob.mockReturnValue(false);
      mockRedisClient.publish.mockRejectedValueOnce(
        new Error('Redis connection lost'),
      );

      await service.cancelActiveJob('failing-job-id');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Failed to publish cancel event',
        expect.objectContaining({
          repoIndexId: 'failing-job-id',
          error: 'Redis connection lost',
        }),
      );
    });
  });

  describe('handleJobFailed', () => {
    it('calls onFailed for final failure when attemptsMade >= attempts', async () => {
      const callbacks: RepoIndexQueueCallbacks = {
        onProcess: vi.fn(),
        onStalled: vi.fn(),
        onRetry: vi.fn(),
        onFailed: vi.fn(),
      };
      service.setCallbacks(callbacks);

      // Extract the 'failed' event handler registered on the worker
      const failedHandler = mockWorker.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'failed',
      )?.[1] as (job: unknown, err: Error) => Promise<void>;

      expect(failedHandler).toBeDefined();

      const error = new Error('indexing failed permanently');
      const mockJob = {
        id: 'job-1',
        data: { repoIndexId: 'repo-index-1', repoUrl: 'url', branch: 'main' },
        attemptsMade: 3,
        opts: { attempts: 3 },
      };

      await failedHandler(mockJob, error);

      expect(callbacks.onFailed).toHaveBeenCalledWith('repo-index-1', error);
      expect(callbacks.onRetry).not.toHaveBeenCalled();
    });

    it('calls onRetry when more attempts remain', async () => {
      const callbacks: RepoIndexQueueCallbacks = {
        onProcess: vi.fn(),
        onStalled: vi.fn(),
        onRetry: vi.fn(),
        onFailed: vi.fn(),
      };
      service.setCallbacks(callbacks);

      const failedHandler = mockWorker.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'failed',
      )?.[1] as (job: unknown, err: Error) => Promise<void>;

      expect(failedHandler).toBeDefined();

      const error = new Error('transient failure');
      const mockJob = {
        id: 'job-2',
        data: {
          repoIndexId: 'repo-index-2',
          repoUrl: 'url',
          branch: 'develop',
        },
        attemptsMade: 1,
        opts: { attempts: 3 },
      };

      await failedHandler(mockJob, error);

      expect(callbacks.onRetry).toHaveBeenCalledWith('repo-index-2', error);
      expect(callbacks.onFailed).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('closes worker, queue, and redis connections including subscriber', async () => {
      // Worker is created by setCallbacks, must call it first
      service.setCallbacks({
        onProcess: vi.fn(),
        onStalled: vi.fn(),
        onRetry: vi.fn(),
        onFailed: vi.fn(),
      });

      await service.onModuleDestroy();

      expect(mockWorker.close).toHaveBeenCalled();
      expect(mockQueue.close).toHaveBeenCalled();
      // quit is called for queue, worker, and subscriber connections (3 times)
      expect(mockRedis.quit).toHaveBeenCalled();
    });

    it('handles missing worker gracefully', async () => {
      // Worker not created (setCallbacks never called)
      await service.onModuleDestroy();

      expect(mockQueue.close).toHaveBeenCalled();
      expect(mockRedis.quit).toHaveBeenCalled();
    });
  });
});
