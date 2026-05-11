import { randomBytes } from 'node:crypto';

import type { V1Pod } from '@kubernetes/client-node';
import { CoreV1Api, KubeConfig, Watch } from '@kubernetes/client-node';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

import { environment, getInstanceFingerprint } from '../../../environments';
import {
  GENIRO_CLAIMED_LABEL,
  GENIRO_GRAPH_LABEL,
  GENIRO_NODE_LABEL,
  GENIRO_THREAD_LABEL,
  GENIRO_WARMPOOL_LABEL,
  K8sRuntimeConfig,
  K8sWarmPoolClaimant,
  LabelPatch,
} from './k8s-runtime.types';
import {
  buildPodSpec,
  isNotFound,
  resolveK8sConfigFromEnv,
} from './k8s-runtime.utils';

@Injectable()
export class K8sWarmPoolService
  implements OnModuleInit, OnModuleDestroy, K8sWarmPoolClaimant
{
  private queue!: Queue;
  private worker!: Worker;
  private redis!: IORedis;
  private kc: KubeConfig | null = null;
  private coreApi: CoreV1Api | null = null;
  private watchReq: { abort: () => void } | null = null;
  private watchRestartTimer: NodeJS.Timeout | null = null;
  private watchRestartBackoffMs: number = 1000;
  private lastResourceVersion: string | null = null;
  private isShuttingDown: boolean = false;
  private readonly queueName = `k8s-warmpool-${getInstanceFingerprint()}`;

  constructor(private readonly logger: DefaultLogger) {}

  async onModuleInit(): Promise<void> {
    if (environment.k8sWarmPoolSize === 0) {
      this.logger.debug('K8s warm pool disabled (size=0)');
      return;
    }

    const kc = new KubeConfig();
    if (environment.k8sInCluster) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
    this.kc = kc;
    this.coreApi = kc.makeApiClient(CoreV1Api);

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
      this.logger.warn('K8s warm pool worker error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    await this.queue.add(
      'warmpool-reconcile',
      {},
      {
        repeat: { every: 30000 },
        jobId: 'warmpool-reconcile',
      },
    );

    await this.startWatch();
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    if (this.watchRestartTimer !== null) {
      clearTimeout(this.watchRestartTimer);
      this.watchRestartTimer = null;
    }
    try {
      this.watchReq?.abort();
    } catch {
      // Ignore abort errors during shutdown
    }
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

  /**
   * Claims an unclaimed warm pool pod by patching its labels atomically.
   * Returns the pod name on success, or null if the pool is exhausted.
   */
  async claimWarmPod(params: {
    graphId: string | null;
    nodeId: string;
    threadId: string;
  }): Promise<string | null> {
    if (!this.coreApi) {
      return null;
    }
    if (environment.k8sWarmPoolSize === 0) {
      return null;
    }

    const ns = environment.k8sRuntimeNamespace;
    const list = await this.coreApi.listNamespacedPod({
      namespace: ns,
      labelSelector: `${GENIRO_WARMPOOL_LABEL}=true,${GENIRO_CLAIMED_LABEL}=false`,
    });

    for (const pod of list.items ?? []) {
      const name = pod.metadata?.name;
      if (!name) {
        continue;
      }

      // resourceVersion makes the patch conditional: K8s rejects with 409 if the
      // pod was mutated between our list and this patch (TOCTOU protection).
      const resourceVersion = pod.metadata?.resourceVersion;
      if (!resourceVersion) {
        continue;
      }

      // Build the label patch: clear residual identity labels, remove warm-pool
      // membership, and assign the new owner's identity in a single atomic patch.
      const labels: LabelPatch = {
        [GENIRO_WARMPOOL_LABEL]: null,
        [GENIRO_CLAIMED_LABEL]: 'true',
        [GENIRO_THREAD_LABEL]: params.threadId,
        [GENIRO_NODE_LABEL]: params.nodeId,
        // graphId is set to the new owner's value if present, or cleared otherwise
        [GENIRO_GRAPH_LABEL]: params.graphId ?? null,
      };

      const patchBody = {
        metadata: {
          resourceVersion,
          labels,
        },
      };

      try {
        await this.coreApi.patchNamespacedPod({
          name,
          namespace: ns,
          body: patchBody,
        });
        // Kick a reconcile to replenish the pool
        this.queue
          ?.add('warmpool-reconcile', {}, { jobId: `reconcile-${Date.now()}` })
          .catch(() => {});
        return name;
      } catch (err) {
        // 409 = someone else claimed it first; 404 = pod was deleted between list and patch
        if ((err as { code?: number }).code === 409 || isNotFound(err)) {
          continue;
        }
        throw err;
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Private: watch stream management
  // ---------------------------------------------------------------------------

  private async startWatch(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    if (!this.kc) {
      return;
    }

    const watch = new Watch(this.kc);
    try {
      this.watchReq = await watch.watch(
        `/api/v1/namespaces/${environment.k8sRuntimeNamespace}/pods`,
        {
          labelSelector: `${GENIRO_WARMPOOL_LABEL}=true`,
          ...(this.lastResourceVersion
            ? { resourceVersion: this.lastResourceVersion }
            : {}),
        },
        this.onWatchEvent.bind(this),
        this.onWatchEnd.bind(this),
      );
      // Reset backoff on successful connect
      this.watchRestartBackoffMs = 1000;
    } catch (err) {
      this.logger.error(
        err as Error,
        'K8s warm pool watch init failed, scheduling retry',
      );
      this.scheduleWatchRestart();
    }
  }

  private onWatchEvent(phase: string, apiObj: V1Pod): void {
    // Update resourceVersion for incremental resume
    if (apiObj?.metadata?.resourceVersion) {
      this.lastResourceVersion = apiObj.metadata.resourceVersion;
    }
    // Enqueue reconcile on DELETED or label flip to claimed=true
    if (
      phase === 'DELETED' ||
      apiObj?.metadata?.labels?.[GENIRO_CLAIMED_LABEL] === 'true'
    ) {
      this.queue
        ?.add(
          'warmpool-reconcile',
          {},
          {
            jobId: `reconcile-${Date.now()}-${Math.random()}`,
          },
        )
        .catch(() => {});
    }
  }

  private onWatchEnd(_err: unknown): void {
    if (this.isShuttingDown) {
      return;
    }
    this.logger.warn('K8s warm pool watch stream ended, scheduling restart');
    this.scheduleWatchRestart();
  }

  private scheduleWatchRestart(): void {
    if (this.isShuttingDown) {
      return;
    }
    const jitter = Math.random() * 1000;
    const delay = Math.min(this.watchRestartBackoffMs + jitter, 30000);
    this.watchRestartBackoffMs = Math.min(
      this.watchRestartBackoffMs * 2,
      30000,
    );
    this.watchRestartTimer = setTimeout(() => {
      this.watchRestartTimer = null;
      void this.startWatch();
    }, delay).unref();
  }

  // ---------------------------------------------------------------------------
  // Private: reconcile job
  // ---------------------------------------------------------------------------

  private async processJob(_job: Job): Promise<void> {
    if (!this.coreApi) {
      return;
    }

    const ns = environment.k8sRuntimeNamespace;

    // 1. Fetch unclaimed warm pods
    const unclaimed = await this.coreApi.listNamespacedPod({
      namespace: ns,
      labelSelector: `${GENIRO_WARMPOOL_LABEL}=true,${GENIRO_CLAIMED_LABEL}=false`,
    });
    const targetSize = environment.k8sWarmPoolSize;
    const toCreate = Math.max(0, targetSize - (unclaimed.items?.length ?? 0));

    for (let i = 0; i < toCreate; i++) {
      const podName = `geniro-sb-wp-${randomBytes(4).toString('hex')}`;
      const spec = buildPodSpec(
        this.resolveConfig(),
        { image: environment.dockerRuntimeImage },
        podName,
        {
          [GENIRO_WARMPOOL_LABEL]: 'true',
          [GENIRO_CLAIMED_LABEL]: 'false',
        },
        false,
      );
      await this.coreApi
        .createNamespacedPod({ namespace: ns, body: spec })
        .catch((err) =>
          this.logger.warn(
            `Failed to create warm pool pod: ${(err as Error).message}`,
          ),
        );
    }

    // 2. TTL: delete old pods (creationTimestamp + ttlMs < now)
    const allWarm = await this.coreApi.listNamespacedPod({
      namespace: ns,
      labelSelector: `${GENIRO_WARMPOOL_LABEL}=true`,
    });
    const ttlMs = environment.k8sWarmPoolTtlMs;
    const nowMs = Date.now();

    for (const pod of allWarm.items ?? []) {
      const createdAt = pod.metadata?.creationTimestamp
        ? new Date(pod.metadata.creationTimestamp).getTime()
        : nowMs;
      if (nowMs - createdAt > ttlMs) {
        await this.coreApi
          .deleteNamespacedPod({
            name: pod.metadata!.name!,
            namespace: ns,
            gracePeriodSeconds: 0,
            propagationPolicy: 'Background',
          })
          .catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: config helper
  // ---------------------------------------------------------------------------

  private resolveConfig(): K8sRuntimeConfig {
    return resolveK8sConfigFromEnv(environment);
  }
}
