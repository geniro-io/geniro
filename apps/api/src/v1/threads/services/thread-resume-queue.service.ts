import { MikroORM, RequestContext } from '@mikro-orm/postgresql';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

import { environment, getInstanceFingerprint } from '../../../environments';

export interface ThreadResumeJobData {
  threadId: string;
  graphId: string;
  nodeId: string;
  externalThreadId: string;
  checkPrompt: string;
  reason: string;
  scheduledAt: string;
  createdBy: string;
}

export interface ThreadResumeQueueCallbacks {
  /** Called to process the resume job */
  onProcess: (data: ThreadResumeJobData) => Promise<void>;
  /** Called when a resume job fails after all retries */
  onFailed: (data: ThreadResumeJobData, error: Error) => Promise<void>;
}

/**
 * BullMQ-based job queue for delayed thread resume jobs.
 *
 * Creates its own IORedis connections rather than sharing with CacheService.
 * BullMQ requires `maxRetriesPerRequest: null` for blocking BRPOPLPUSH commands,
 * and the Worker needs a dedicated connection to avoid head-of-line blocking.
 * This matches the pattern used by RepoIndexQueueService.
 */
@Injectable()
export class ThreadResumeQueueService implements OnModuleInit, OnModuleDestroy {
  private queue!: Queue<ThreadResumeJobData>;
  private worker!: Worker<ThreadResumeJobData>;
  private redisQueue!: IORedis;
  private redisWorker!: IORedis;
  private callbacks?: ThreadResumeQueueCallbacks;
  private closing = false;
  private readonly queueName = `thread-resume-${getInstanceFingerprint()}`;

  constructor(
    private readonly logger: DefaultLogger,
    private readonly orm: MikroORM,
  ) {}

  async onModuleInit(): Promise<void> {
    // Disable the two auto-issued startup commands ioredis fires on every
    // (re)connect: INFO (via `_readyCheck`) and CLIENT SETINFO (telemetry).
    // Both go through `Redis.sendCommand` which writes synchronously to the
    // underlying TCP stream — when `worker.close()` aborts the blocking
    // BRPOPLPUSH and the connection cycles, the destroyed socket throws
    // EPIPE synchronously inside the legacy callback wrapper of
    // `_readyCheck.info(cb)`, which escapes ioredis's promise chain and
    // surfaces as an uncaught exception.
    //
    // Production tradeoff for `enableReadyCheck: false`: if Redis is in
    // LOADING state (cold start from RDB/AOF, replica full sync), commands
    // sent immediately would normally wait for ready; without it they
    // return a `LOADING` error. This is fine HERE because BullMQ retries
    // failed jobs at its own layer (`attempts`/`backoff` in defaultJobOptions
    // below) — LOADING errors during a Redis restart are transparently
    // retried. We do NOT apply this option to `CacheService` or the
    // Socket.IO Redis adapter, which have no retry compensation.
    //
    // Options propagate through `connection.duplicate(...)` so BullMQ's
    // internal blocking-connection duplicate inherits the same config.
    this.redisQueue = new IORedis(environment.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      disableClientInfo: true,
    });
    this.redisWorker = new IORedis(environment.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      disableClientInfo: true,
    });

    this.redisQueue.on('error', (err) => {
      this.logChannelError(err, 'Thread resume queue Redis connection error');
    });
    this.redisWorker.on('error', (err) => {
      this.logChannelError(err, 'Thread resume worker Redis connection error');
    });

    this.queue = new Queue<ThreadResumeJobData>(this.queueName, {
      connection: this.redisQueue,
      // Skip BullMQ's startup `INFO` call. BullMQ uses it to read the Redis
      // version and pick a Lua script variant; on (re)connect during
      // teardown it races the destroyed socket and surfaces an EPIPE that
      // ioredis logs as `[ioredis] Unhandled error event`. We pin Redis 7+
      // in deps:up and CI, so version detection is not required.
      skipVersionCheck: true,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 5000 },
      },
    });
  }

  /**
   * Register callbacks for job lifecycle events and start the worker.
   * Must be called exactly once during module initialization.
   */
  setCallbacks(callbacks: ThreadResumeQueueCallbacks): void {
    this.callbacks = callbacks;

    this.worker = new Worker<ThreadResumeJobData>(
      this.queueName,
      this.processJob.bind(this),
      {
        connection: this.redisWorker,
        concurrency: 5,
        lockDuration: 300_000, // 5 minutes
        skipVersionCheck: true,
      },
    );

    this.worker.on('failed', this.handleJobFailed.bind(this));
    // BullMQ creates an internal blocking-connection duplicate that gets its
    // own ioredis instance. Without an `error` listener attached, ioredis
    // logs `[ioredis] Unhandled error event:` to stderr on transient socket
    // errors — harmless but noisy. Forwarding worker-level errors to our
    // logger silences the duplicate too because BullMQ relays its blocking
    // connection's errors through `worker.on('error')`.
    this.worker.on('error', (err) => {
      this.logger.warn('Thread resume worker error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Schedule a delayed resume job for a thread.
   * The job will be processed after the specified delay.
   */
  async scheduleResume(
    data: ThreadResumeJobData,
    delayMs: number,
  ): Promise<void> {
    const jobId = `thread-resume-${data.threadId}`;

    // Remove any existing job for this thread before scheduling a new one
    const existingJob = await this.queue.getJob(jobId);
    if (existingJob) {
      try {
        await existingJob.remove();
        this.logger.debug('Removed existing resume job before rescheduling', {
          threadId: data.threadId,
        });
      } catch (err) {
        this.logger.debug('Could not remove existing resume job', {
          threadId: data.threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await this.queue.add('thread-resume', data, {
      jobId,
      delay: delayMs,
    });

    this.logger.debug('Thread resume job scheduled', {
      threadId: data.threadId,
      graphId: data.graphId,
      delayMs,
    });
  }

  /**
   * Cancel a pending resume job for a specific thread.
   * Best-effort: if the job is already processing or gone, we log and continue.
   */
  async cancelResumeJob(threadId: string): Promise<void> {
    const jobId = `thread-resume-${threadId}`;
    try {
      const job = await this.queue.getJob(jobId);
      if (!job) {
        return;
      }
      await job.remove();
      this.logger.debug('Cancelled resume job', { threadId });
    } catch (err) {
      this.logger.debug('Could not cancel resume job', {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Cancel all pending resume jobs for a specific graph.
   * Iterates delayed jobs and removes those matching the graphId.
   */
  async cancelAllForGraph(graphId: string): Promise<void> {
    try {
      const delayedJobs = await this.queue.getDelayed();
      const matchingJobs = delayedJobs.filter(
        (job) => job.data.graphId === graphId,
      );

      if (matchingJobs.length === 0) {
        return;
      }

      await Promise.allSettled(
        matchingJobs.map(async (job) => {
          try {
            await job.remove();
          } catch (err) {
            this.logger.debug('Could not remove delayed resume job', {
              jobId: job.id,
              graphId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );

      this.logger.debug('Cancelled resume jobs for graph', {
        graphId,
        count: matchingJobs.length,
      });
    } catch (err) {
      this.logger.warn('Failed to cancel resume jobs for graph', {
        graphId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Check whether a resume job exists for the given thread (any state).
   */
  async hasJob(threadId: string): Promise<boolean> {
    const jobId = `thread-resume-${threadId}`;
    const job = await this.queue.getJob(jobId);
    return job !== undefined;
  }

  private async processJob(job: Job<ThreadResumeJobData>): Promise<void> {
    if (!this.callbacks) {
      throw new Error('Queue callbacks not configured');
    }
    // Fork the EM for the job so identity-map state doesn't leak between
    // jobs or into the global EM. See GraphRevisionQueueService for the
    // full rationale.
    await RequestContext.create(this.orm.em, async () => {
      await this.callbacks!.onProcess(job.data);
    });
  }

  private async handleJobFailed(
    job: Job<ThreadResumeJobData> | undefined,
    err: Error,
  ): Promise<void> {
    if (!job) {
      return;
    }

    this.logger.error(err, 'Thread resume job failed', {
      jobId: job.id,
      threadId: job.data.threadId,
      attemptsMade: job.attemptsMade,
    });

    if (!this.callbacks) {
      return;
    }

    const isFinalFailure = job.attemptsMade >= (job.opts.attempts ?? 1);

    if (isFinalFailure) {
      try {
        await this.callbacks.onFailed(job.data, err);
      } catch (callbackErr) {
        this.logger.error(
          callbackErr instanceof Error
            ? callbackErr
            : new Error(String(callbackErr)),
          'Failed to handle resume job failure callback',
          { jobId: job.id },
        );
      }
    }
  }

  /**
   * Route a Redis connection `error` event. During intentional shutdown
   * (`onModuleDestroy` closes the worker/queue and quits the connections) a
   * connection error is expected churn — most visibly an `EPIPE` from BullMQ's
   * periodic `moveStalledJobsToWait` Lua script racing the socket teardown.
   * Demote those to `debug` so they don't read as a real fault in logs/CI; a
   * connection error while the service is live still surfaces at `error`.
   */
  private logChannelError(err: unknown, message: string): void {
    if (this.closing) {
      this.logger.debug(`${message} during shutdown (expected)`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.logger.error(
      err instanceof Error ? err : new Error(String(err)),
      message,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (this.worker) {
      try {
        await this.worker.close();
      } catch (err) {
        this.logger.warn('Failed to close BullMQ resume worker', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      await this.queue?.close();
    } catch (err) {
      this.logger.warn('Failed to close BullMQ resume queue', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    for (const [name, conn] of [
      ['queue', this.redisQueue],
      ['worker', this.redisWorker],
    ] as const) {
      try {
        await conn?.quit();
      } catch (err) {
        this.logger.warn(`Failed to close Redis ${name} connection`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
