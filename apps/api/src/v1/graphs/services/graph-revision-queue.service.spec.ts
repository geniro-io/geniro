import { MikroORM } from '@mikro-orm/postgresql';
import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GraphRevisionJobData,
  GraphRevisionQueueService,
} from './graph-revision-queue.service';

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
  getJobs: vi.fn().mockResolvedValue([]),
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

let capturedProcessor:
  | ((job: { data: GraphRevisionJobData }) => Promise<void>)
  | undefined;

vi.mock('bullmq', () => ({
  Queue: function Queue() {
    return mockQueue;
  },
  Worker: function Worker(
    _name: string,
    processor: (job: { data: GraphRevisionJobData }) => Promise<void>,
  ) {
    capturedProcessor = processor;
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

describe('GraphRevisionQueueService', () => {
  let service: GraphRevisionQueueService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new GraphRevisionQueueService(
      mockLogger as unknown as DefaultLogger,
      mockOrm,
    );
    await service.onModuleInit();
  });

  describe('addRevision', () => {
    it('adds a job with revision.id as jobId', async () => {
      await service.addRevision({ id: 'rev-abc', graphId: 'graph-123' });

      expect(mockQueue.add).toHaveBeenCalledWith(
        'apply-revision',
        { revisionId: 'rev-abc', graphId: 'graph-123' },
        { jobId: 'rev-abc' },
      );
    });
  });

  describe('processJob (via worker internals)', () => {
    it('throws when processor is not set', async () => {
      // capturedProcessor is set by the Worker mock constructor during onModuleInit
      expect(capturedProcessor).toBeDefined();

      await expect(
        capturedProcessor!({
          data: { revisionId: 'rev-1', graphId: 'graph-1' },
        }),
      ).rejects.toThrow('Graph revision processor not set');
    });

    it('calls the processor when set', async () => {
      const processor = vi.fn().mockResolvedValue(undefined);
      service.setProcessor(processor);

      expect(capturedProcessor).toBeDefined();

      const jobData: GraphRevisionJobData = {
        revisionId: 'rev-2',
        graphId: 'graph-2',
      };
      await capturedProcessor!({ data: jobData });

      expect(processor).toHaveBeenCalledWith(jobData);
    });
  });

  describe('handleJobFailure (via worker failed event)', () => {
    it('logs an error with job details when job is defined', () => {
      const failedHandler = mockWorker.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'failed',
      )?.[1] as (
        job: { id: string; data: GraphRevisionJobData } | undefined,
        err: Error,
      ) => void;

      expect(failedHandler).toBeDefined();

      const err = new Error('revision failed');
      failedHandler(
        { id: 'job-1', data: { revisionId: 'r1', graphId: 'g1' } },
        err,
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        err,
        'Graph revision job job-1 failed for graph g1',
      );
    });

    it('logs with undefined id and graphId when job is undefined', () => {
      const failedHandler = mockWorker.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'failed',
      )?.[1] as (
        job: { id: string; data: GraphRevisionJobData } | undefined,
        err: Error,
      ) => void;

      expect(failedHandler).toBeDefined();

      const err = new Error('unknown failure');
      failedHandler(undefined, err);

      expect(mockLogger.error).toHaveBeenCalledWith(
        err,
        'Graph revision job undefined failed for graph undefined',
      );
    });
  });

  describe('onModuleDestroy', () => {
    it('closes worker, queue, and both Redis connections', async () => {
      await service.onModuleDestroy();

      expect(mockWorker.close).toHaveBeenCalled();
      expect(mockQueue.close).toHaveBeenCalled();
      // quit is called twice: once for redisQueue, once for redisWorker
      expect(mockRedis.quit).toHaveBeenCalledTimes(2);
    });

    it('continues to close remaining resources when worker.close throws', async () => {
      mockWorker.close.mockRejectedValueOnce(new Error('worker close failed'));

      await service.onModuleDestroy();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to close BullMQ worker',
        {
          error: 'worker close failed',
        },
      );
      expect(mockQueue.close).toHaveBeenCalled();
      expect(mockRedis.quit).toHaveBeenCalledTimes(2);
    });

    it('continues to close Redis connections when queue.close throws', async () => {
      mockQueue.close.mockRejectedValueOnce(new Error('queue close failed'));

      await service.onModuleDestroy();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to close BullMQ queue',
        {
          error: 'queue close failed',
        },
      );
      expect(mockRedis.quit).toHaveBeenCalledTimes(2);
    });

    it('logs a warning for a Redis connection that fails to quit', async () => {
      mockRedis.quit
        .mockRejectedValueOnce(new Error('redis quit failed'))
        .mockResolvedValueOnce(undefined);

      await service.onModuleDestroy();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to close Redis'),
        { error: 'redis quit failed' },
      );
      // Second Redis connection is still attempted
      expect(mockRedis.quit).toHaveBeenCalledTimes(2);
    });
  });
});
