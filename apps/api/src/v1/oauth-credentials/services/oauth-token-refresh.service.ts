import { MikroORM, RequestContext } from '@mikro-orm/postgresql';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

import { environment, getInstanceFingerprint } from '../../../environments';
import { OAuthCredentialsService } from './oauth-credentials.service';

/**
 * Background watchdog that proactively refreshes OAuth credentials before their
 * access tokens expire. The interactive run gate (`refreshIfNeeded`) only
 * rotates a token when a run actually starts, so a short-lived token (Linear's
 * is ~24h) can expire overnight and the first background/trigger run then pauses
 * for re-auth. This keeps tokens fresh AHEAD of any run.
 *
 * Cross-pod safety: the queue name carries `getInstanceFingerprint()`, which in
 * dev/prod is the deployment env name (so ALL pods of an env share one queue and
 * the repeatable tick is processed by exactly ONE worker — never two pods
 * refreshing the same rotating token concurrently) and in tests is unique per
 * `createTestModule()` app (so test apps don't share the namespace). Mirrors
 * {@link RuntimeCleanupService}.
 */
@Injectable()
export class OAuthTokenRefreshService implements OnModuleInit, OnModuleDestroy {
  private queue!: Queue;
  private worker!: Worker;
  private redis!: IORedis;
  private readonly queueName = `oauth-token-refresh-${getInstanceFingerprint()}`;

  constructor(
    private readonly oauthCredentialsService: OAuthCredentialsService,
    private readonly logger: DefaultLogger,
    private readonly orm: MikroORM,
  ) {}

  async onModuleInit(): Promise<void> {
    this.redis = new IORedis(environment.redisUrl, {
      maxRetriesPerRequest: null,
      // BullMQ-managed connection — see thread-resume-queue.service.ts for the
      // full rationale (`enableReadyCheck: false` is safe; BullMQ retries at its
      // own layer, `disableClientInfo: true` skips the SETINFO roundtrip).
      enableReadyCheck: false,
      disableClientInfo: true,
    });

    this.redis.on('error', (err) => {
      this.logger.error(err, 'Redis connection error');
    });

    this.queue = new Queue(this.queueName, {
      connection: this.redis,
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
    this.worker.on('error', (err) => {
      this.logger.warn('OAuth token-refresh worker error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    await this.queue.add(
      'refresh',
      {},
      {
        repeat: { every: environment.oauthTokenRefreshIntervalMs },
      },
    );
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
    // Fork the EM for the job so identity-map state doesn't leak between jobs or
    // into the global EM. See GraphRevisionQueueService for the full rationale.
    await RequestContext.create(this.orm.em, async () => {
      const summary =
        await this.oauthCredentialsService.refreshExpiringCredentials(
          environment.oauthTokenRefreshThresholdMs,
        );
      if (summary.refreshed > 0 || summary.failed > 0) {
        this.logger.log('OAuth token-refresh watchdog tick', summary);
      } else {
        this.logger.debug('OAuth token-refresh watchdog tick (nothing due)', {
          scanned: summary.scanned,
        });
      }
    });
  }
}
