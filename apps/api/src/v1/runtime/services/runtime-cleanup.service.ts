import { MikroORM, RequestContext } from '@mikro-orm/postgresql';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

import { environment, getInstanceFingerprint } from '../../../environments';
import { RuntimeProvider } from './runtime-provider';

@Injectable()
export class RuntimeCleanupService implements OnModuleInit, OnModuleDestroy {
  private queue!: Queue;
  private worker!: Worker;
  private redis!: IORedis;
  private readonly queueName = `runtime-cleanup-${getInstanceFingerprint()}`;

  constructor(
    private readonly runtimeProvider: RuntimeProvider,
    private readonly logger: DefaultLogger,
    private readonly orm: MikroORM,
  ) {}

  async onModuleInit(): Promise<void> {
    this.redis = new IORedis(environment.redisUrl, {
      maxRetriesPerRequest: null,
      // BullMQ-managed connection — see thread-resume-queue.service.ts for
      // the full rationale. `enableReadyCheck: false` is safe here because
      // BullMQ retries jobs at its own layer when commands fail during a
      // Redis LOADING window. `disableClientInfo: true` is purely cosmetic
      // (skips the SETINFO telemetry roundtrip).
      enableReadyCheck: false,
      disableClientInfo: true,
    });

    this.redis.on('error', (err) => {
      this.logger.error(err, 'Redis connection error');
    });

    this.queue = new Queue(this.queueName, {
      connection: this.redis,
      // Skip BullMQ's startup INFO call — see queue services for full
      // rationale (race with teardown surfaces ioredis stderr noise).
      skipVersionCheck: true,
      defaultJobOptions: {
        removeOnComplete: 25,
        removeOnFail: 25,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    });

    this.worker = new Worker(this.queueName, this.processJob.bind(this), {
      connection: this.redis,
      concurrency: 1,
      skipVersionCheck: true,
    });
    // Forward BullMQ worker errors to our logger so the internal blocking-
    // connection duplicate's transient socket errors don't surface as
    // unhandled `[ioredis] Unhandled error event:` console noise.
    this.worker.on('error', (err) => {
      this.logger.warn('Runtime cleanup worker error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    await this.queue.add(
      'cleanup',
      {},
      {
        repeat: { every: environment.runtimeCleanupIntervalMs },
      },
    );

    await this.runtimeProvider.cleanupTemporaryRuntimes();
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();

    try {
      if (this.redis?.status === 'ready') {
        await this.redis.quit();
      }
    } catch {
      // Redis connection may already be closed by worker/queue teardown
    }
  }

  private async processJob(_job: Job): Promise<void> {
    // Fork the EM for the job so identity-map state doesn't leak between
    // jobs or into the global EM. See GraphRevisionQueueService for the
    // full rationale.
    await RequestContext.create(this.orm.em, async () => {
      const idleThresholdMs = environment.runtimeIdleThresholdMs;
      await this.runtimeProvider.cleanupIdleRuntimes(idleThresholdMs);
      await this.runtimeProvider.cleanupTemporaryRuntimes();
    });
  }
}
