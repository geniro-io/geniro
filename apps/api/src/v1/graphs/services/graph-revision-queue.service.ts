import { MikroORM, RequestContext } from '@mikro-orm/postgresql';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

import { environment, getInstanceFingerprint } from '../../../environments';
import { GraphRevisionEntity } from '../entity/graph-revision.entity';

export interface GraphRevisionJobData {
  revisionId: string;
  graphId: string;
}

@Injectable()
export class GraphRevisionQueueService
  implements OnModuleInit, OnModuleDestroy
{
  private queue!: Queue<GraphRevisionJobData>;
  private worker!: Worker<GraphRevisionJobData>;
  private redisQueue!: IORedis;
  private redisWorker!: IORedis;
  private processor?: (job: GraphRevisionJobData) => Promise<void>;
  private closing = false;
  private readonly queueName = `graph-revisions-${getInstanceFingerprint()}`;

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
      this.logChannelError(err, 'Redis queue connection error');
    });
    this.redisWorker.on('error', (err) => {
      this.logChannelError(err, 'Redis worker connection error');
    });

    this.queue = new Queue<GraphRevisionJobData>(this.queueName, {
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
        backoff: { type: 'exponential' as const, delay: 2000 },
      },
    });

    this.worker = new Worker<GraphRevisionJobData>(
      this.queueName,
      this.processJob.bind(this),
      {
        connection: this.redisWorker,
        concurrency: 5,
        // Graph revision processing can take time for complex graphs
        // Set lock duration to 5 minutes to prevent premature stall detection
        lockDuration: 5 * 60 * 1000, // 5 minutes in milliseconds
        skipVersionCheck: true,
      },
    );

    this.worker.on('failed', this.handleJobFailure.bind(this));
    // BullMQ creates an internal blocking-connection duplicate that gets its
    // own ioredis instance. Without an `error` listener attached, ioredis
    // logs `[ioredis] Unhandled error event:` to stderr on transient socket
    // errors — harmless but noisy. Forwarding worker-level errors to our
    // logger silences the duplicate too because BullMQ relays its blocking
    // connection's errors through `worker.on('error')`.
    this.worker.on('error', (err) => {
      this.logger.warn('Graph revision worker error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Register the processor callback for revision jobs.
   * The Worker is already running by the time this is called (NestJS constructs
   * all providers before invoking onModuleInit hooks), so the processor must be
   * set before any job can be dequeued and handed off.
   * Must be called exactly once during module initialization.
   */
  setProcessor(processor: (job: GraphRevisionJobData) => Promise<void>): void {
    this.processor = processor;
  }

  async addRevision(
    revision: Pick<GraphRevisionEntity, 'id' | 'graphId'>,
  ): Promise<void> {
    await this.queue.add(
      'apply-revision',
      { revisionId: revision.id, graphId: revision.graphId },
      { jobId: revision.id },
    );
  }

  async getQueueStatus(graphId: string): Promise<{
    pending: number;
    active: number;
    completed: number;
    failed: number;
  }> {
    const jobs = await this.queue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
      'failed',
    ]);

    const graphJobs = jobs.filter((job) => job.data.graphId === graphId);

    const jobStates = await Promise.all(
      graphJobs.map(async (job) => ({
        state: await job.getState(),
      })),
    );

    const stateCounts = jobStates.reduce<Record<string, number>>((acc, job) => {
      acc[job.state] = (acc[job.state] ?? 0) + 1;
      return acc;
    }, {});

    const countStates = (...states: string[]) =>
      states.reduce((sum, state) => sum + (stateCounts[state] ?? 0), 0);

    return {
      pending: countStates('waiting', 'delayed'),
      active: countStates('active'),
      completed: countStates('completed'),
      failed: countStates('failed'),
    };
  }

  private async processJob(job: Job<GraphRevisionJobData>): Promise<void> {
    if (!this.processor) {
      throw new Error('Graph revision processor not set');
    }

    // Fork the EM for the lifetime of this job. Without this, the processor
    // and everything downstream resolve `this.em` to the global EM, whose
    // identity map accumulates stale entities across jobs. RequestContext
    // gives the job its own forked EM (with its own identity map), isolating
    // it from concurrent jobs and HTTP requests (which get their own forks
    // via @mikro-orm/nestjs HTTP middleware).
    await RequestContext.create(this.orm.em, async () => {
      await this.processor!(job.data);
    });
  }

  private handleJobFailure(
    job: Job<GraphRevisionJobData> | undefined,
    err: Error,
  ): void {
    this.logger.error(
      err,
      `Graph revision job ${job?.id} failed for graph ${job?.data.graphId}`,
    );
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
    try {
      await this.worker.close();
    } catch (err) {
      this.logger.warn('Failed to close BullMQ worker', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await this.queue.close();
    } catch (err) {
      this.logger.warn('Failed to close BullMQ queue', {
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
