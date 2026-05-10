import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @kubernetes/client-node
// Same structural shape as k8s-runtime.spec.ts — kc.makeApiClient() returns
// the shared mockCoreApi object; Watch is instantiated per startWatch() call.
// ---------------------------------------------------------------------------

const mockCoreApi = {
  createNamespacedPod: vi.fn(),
  deleteNamespacedPod: vi.fn(),
  listNamespacedPod: vi.fn(),
  patchNamespacedPod: vi.fn(),
};

const mockWatchInstance = { watch: vi.fn() };

vi.mock('@kubernetes/client-node', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kubernetes/client-node')>();
  return {
    ...actual,
    KubeConfig: vi.fn(function (this: unknown) {
      Object.assign(this as object, {
        loadFromDefault: vi.fn(),
        loadFromCluster: vi.fn(),
        makeApiClient: vi.fn(() => mockCoreApi),
      });
    }),
    CoreV1Api: vi.fn(),
    Watch: vi.fn(function (this: unknown) {
      Object.assign(this as object, mockWatchInstance);
    }),
  };
});

// ---------------------------------------------------------------------------
// Environment mock — the factory returns a plain mutable object so tests can
// mutate individual properties per-case (works because vi.mock is hoisted
// but the returned object reference stays stable across all imports).
// ---------------------------------------------------------------------------

vi.mock('../../../environments', () => {
  // This factory runs at hoist-time — no outer variables may be referenced.
  // The `environment` export is a plain object mutated by tests via the
  // shared reference obtained with `await import('../../../environments')`.
  return {
    environment: {
      env: 'test',
      redisUrl: 'redis://localhost:6379',
      k8sRuntimeNamespace: 'geniro-runtimes-test',
      dockerRuntimeImage: 'test-image',
      k8sRuntimeClass: '',
      k8sRuntimeServiceAccount: 'test-sa',
      k8sRuntimeCpuRequest: '100m',
      k8sRuntimeCpuLimit: '1',
      k8sRuntimeMemoryRequest: '256Mi',
      k8sRuntimeMemoryLimit: '2Gi',
      k8sRuntimeReadyTimeoutMs: 60000,
      k8sWarmPoolSize: 3,
      k8sWarmPoolTtlMs: 1800000,
      k8sInCluster: false,
    },
    getInstanceFingerprint: () => 'test',
  };
});

// ---------------------------------------------------------------------------
// Mock ioredis — must use `function` so `new IORedis(...)` works as a constructor.
// The constructor returns `mockRedisInstance` explicitly so the service holds a
// reference to the same shared object — tests can then mutate `.status` between
// calls and the service will observe the updated value.
// ---------------------------------------------------------------------------

const mockRedisInstance = {
  on: vi.fn(),
  quit: vi.fn().mockResolvedValue('OK'),
  status: 'ready',
};

vi.mock('ioredis', () => ({
  default: vi.fn(function () {
    return mockRedisInstance;
  }),
}));

// ---------------------------------------------------------------------------
// Mock bullmq — Queue and Worker must also be constructor-compatible
// ---------------------------------------------------------------------------

const mockQueueAdd = vi.fn().mockResolvedValue({});
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
const mockWorkerOn = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn(function (this: unknown) {
    Object.assign(this as object, { add: mockQueueAdd, close: mockQueueClose });
  }),
  Worker: vi.fn(function (this: unknown) {
    Object.assign(this as object, {
      close: mockWorkerClose,
      on: mockWorkerOn,
    });
  }),
}));

// ---------------------------------------------------------------------------
// Import under test — must come after all vi.mock() declarations
// ---------------------------------------------------------------------------

import type { DefaultLogger } from '@packages/common';

import { K8sWarmPoolService } from './k8s-warm-pool.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): DefaultLogger {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as DefaultLogger;
}

/** Retrieves the stable mocked environment object. */
async function getMockEnv() {
  const mod = await import('../../../environments/index.js');
  return mod.environment as Record<string, unknown>;
}

/** Creates a pod object with the given age in milliseconds (relative to now). */
function makePod(
  name: string,
  ageMs: number,
  opts: { claimed?: boolean } = {},
) {
  return {
    metadata: {
      name,
      creationTimestamp: new Date(Date.now() - ageMs),
      resourceVersion: `rv-${name}`,
      labels: {
        'geniro.io/warm-pool': 'true',
        'geniro.io/claimed': opts.claimed ? 'true' : 'false',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('K8sWarmPoolService', () => {
  let service: K8sWarmPoolService;
  let logger: DefaultLogger;
  let mockEnv: Record<string, unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Grab the stable mocked environment reference
    mockEnv = await getMockEnv();

    // Reset to default values
    mockEnv['k8sWarmPoolSize'] = 3;
    mockEnv['k8sWarmPoolTtlMs'] = 1800000;
    mockEnv['k8sRuntimeNamespace'] = 'geniro-runtimes-test';
    mockEnv['k8sInCluster'] = false;
    mockRedisInstance.status = 'ready';
    mockRedisInstance.quit = vi.fn().mockResolvedValue('OK');
    mockRedisInstance.on = vi.fn();

    // Default watch resolves without error
    mockWatchInstance.watch.mockResolvedValue({ abort: vi.fn() });

    logger = makeLogger();
    service = new K8sWarmPoolService(logger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // onModuleInit — disabled path
  // -------------------------------------------------------------------------

  describe('onModuleInit()', () => {
    it('is a noop when k8sWarmPoolSize === 0 — Redis/Queue/Worker are NOT instantiated', async () => {
      mockEnv['k8sWarmPoolSize'] = 0;

      await service.onModuleInit();

      const IORedis = (await import('ioredis')).default;
      const { Queue, Worker } = await import('bullmq');

      expect(IORedis).not.toHaveBeenCalled();
      expect(Queue).not.toHaveBeenCalled();
      expect(Worker).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('disabled'),
      );
    });

    it('initializes Redis, Queue, Worker and starts Watch when size > 0', async () => {
      await service.onModuleInit();

      const IORedis = (await import('ioredis')).default;
      const { Queue, Worker } = await import('bullmq');

      expect(IORedis).toHaveBeenCalledOnce();
      expect(Queue).toHaveBeenCalledOnce();
      expect(Worker).toHaveBeenCalledOnce();
      // The recurring reconcile job is registered
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'warmpool-reconcile',
        {},
        expect.objectContaining({
          repeat: expect.objectContaining({ every: 30000 }),
        }),
      );
      // Watch was started
      expect(mockWatchInstance.watch).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // processJob — reconcile logic (calls private method directly)
  // -------------------------------------------------------------------------

  describe('processJob (reconcile)', () => {
    /** Injects coreApi into the service (bypasses onModuleInit overhead). */
    function injectCoreApi() {
      (service as unknown as { coreApi: typeof mockCoreApi }).coreApi =
        mockCoreApi;
    }

    /** Calls the private processJob method directly. */
    async function triggerProcessJob() {
      await (
        service as unknown as { processJob: (job: unknown) => Promise<void> }
      ).processJob({});
    }

    it('creates (targetSize - currentCount) pods when pool is short', async () => {
      injectCoreApi();
      mockEnv['k8sWarmPoolSize'] = 3;

      // 1 unclaimed pod exists → need to create 2 more
      mockCoreApi.listNamespacedPod
        .mockResolvedValueOnce({ items: [makePod('wp-existing', 1000)] })
        .mockResolvedValueOnce({ items: [makePod('wp-existing', 1000)] });

      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      await triggerProcessJob();

      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalledTimes(2);
      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: 'geniro-runtimes-test' }),
      );
    });

    it('does not create pods when pool is already full', async () => {
      injectCoreApi();
      mockEnv['k8sWarmPoolSize'] = 2;

      const existingPods = [makePod('wp-1', 1000), makePod('wp-2', 2000)];
      mockCoreApi.listNamespacedPod
        .mockResolvedValueOnce({ items: existingPods })
        .mockResolvedValueOnce({ items: existingPods });

      await triggerProcessJob();

      expect(mockCoreApi.createNamespacedPod).not.toHaveBeenCalled();
    });

    it('deletes pods whose creationTimestamp + ttlMs < now', async () => {
      injectCoreApi();
      mockEnv['k8sWarmPoolSize'] = 3;
      mockEnv['k8sWarmPoolTtlMs'] = 1800000;

      const oldPod = makePod('wp-old', 1800001); // 1 ms over TTL
      const youngPod = makePod('wp-young', 500);

      mockCoreApi.listNamespacedPod
        .mockResolvedValueOnce({ items: [youngPod] }) // unclaimed (1)
        .mockResolvedValueOnce({ items: [oldPod, youngPod] }); // all warm for TTL pass

      mockCoreApi.createNamespacedPod.mockResolvedValue({});
      mockCoreApi.deleteNamespacedPod.mockResolvedValue({});

      await triggerProcessJob();

      expect(mockCoreApi.deleteNamespacedPod).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'wp-old',
          gracePeriodSeconds: 0,
        }),
      );
      const deletedNames = mockCoreApi.deleteNamespacedPod.mock.calls.map(
        (c) => (c[0] as { name: string }).name,
      );
      expect(deletedNames).not.toContain('wp-young');
    });

    it('does not delete fresh pods within TTL', async () => {
      injectCoreApi();
      mockEnv['k8sWarmPoolSize'] = 1;
      mockEnv['k8sWarmPoolTtlMs'] = 1800000;

      const freshPod = makePod('wp-fresh', 60000); // 1 minute old

      mockCoreApi.listNamespacedPod
        .mockResolvedValueOnce({ items: [freshPod] })
        .mockResolvedValueOnce({ items: [freshPod] });

      await triggerProcessJob();

      expect(mockCoreApi.deleteNamespacedPod).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // claimWarmPod
  // -------------------------------------------------------------------------

  describe('claimWarmPod()', () => {
    function injectCoreApi() {
      (service as unknown as { coreApi: typeof mockCoreApi }).coreApi =
        mockCoreApi;
    }

    function injectQueue() {
      (service as unknown as { queue: { add: typeof mockQueueAdd } }).queue = {
        add: mockQueueAdd,
      };
    }

    const claimParams = {
      graphId: 'graph-1',
      nodeId: 'node-1',
      threadId: 'thread-1',
    };

    it('returns null when k8sWarmPoolSize === 0 (pool disabled)', async () => {
      mockEnv['k8sWarmPoolSize'] = 0;
      // coreApi deliberately NOT injected — either guard returns null first

      const result = await service.claimWarmPod(claimParams);

      expect(result).toBeNull();
      expect(mockCoreApi.listNamespacedPod).not.toHaveBeenCalled();
    });

    it('returns null when no unclaimed pods exist (pool exhausted)', async () => {
      injectCoreApi();
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [] });

      const result = await service.claimWarmPod(claimParams);

      expect(result).toBeNull();
      expect(mockCoreApi.patchNamespacedPod).not.toHaveBeenCalled();
    });

    it('returns the pod name after a successful patchNamespacedPod', async () => {
      injectCoreApi();
      injectQueue();
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [makePod('wp-abc', 1000)],
      });
      mockCoreApi.patchNamespacedPod.mockResolvedValue({});

      const result = await service.claimWarmPod(claimParams);

      expect(result).toBe('wp-abc');
      expect(mockCoreApi.patchNamespacedPod).toHaveBeenCalledOnce();
      expect(mockCoreApi.patchNamespacedPod).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'wp-abc',
          namespace: 'geniro-runtimes-test',
        }),
      );
    });

    it('skips pods that respond with 409 (already claimed) and tries the next one', async () => {
      injectCoreApi();
      injectQueue();
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [makePod('wp-taken', 1000), makePod('wp-free', 2000)],
      });

      const conflict409 = Object.assign(new Error('Conflict'), { code: 409 });
      mockCoreApi.patchNamespacedPod
        .mockRejectedValueOnce(conflict409)
        .mockResolvedValueOnce({});

      const result = await service.claimWarmPod(claimParams);

      expect(result).toBe('wp-free');
      expect(mockCoreApi.patchNamespacedPod).toHaveBeenCalledTimes(2);
    });

    it('returns null when all candidates return 409 (race, pool exhausted)', async () => {
      injectCoreApi();
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [makePod('wp-1', 1000), makePod('wp-2', 2000)],
      });

      const conflict409 = Object.assign(new Error('Conflict'), { code: 409 });
      mockCoreApi.patchNamespacedPod.mockRejectedValue(conflict409);

      const result = await service.claimWarmPod(claimParams);

      expect(result).toBeNull();
      expect(mockCoreApi.patchNamespacedPod).toHaveBeenCalledTimes(2);
    });

    it('propagates non-409 errors from patchNamespacedPod', async () => {
      injectCoreApi();
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [makePod('wp-err', 1000)],
      });

      const serverError = Object.assign(new Error('Internal Server Error'), {
        code: 500,
      });
      mockCoreApi.patchNamespacedPod.mockRejectedValueOnce(serverError);

      await expect(service.claimWarmPod(claimParams)).rejects.toMatchObject({
        code: 500,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Watch events — exercise the private onWatchEvent callback
  // -------------------------------------------------------------------------

  describe('Watch events', () => {
    function injectQueue() {
      (service as unknown as { queue: { add: typeof mockQueueAdd } }).queue = {
        add: mockQueueAdd,
      };
    }

    /** Extracts the onEvent callback passed to watch.watch() after onModuleInit. */
    function getOnWatchEvent(): (phase: string, apiObj: unknown) => void {
      return mockWatchInstance.watch.mock.calls[0]![2] as (
        phase: string,
        apiObj: unknown,
      ) => void;
    }

    it('DELETED phase triggers reconcile enqueue', async () => {
      await service.onModuleInit();
      injectQueue();

      const onEvent = getOnWatchEvent();
      onEvent('DELETED', {
        metadata: { resourceVersion: 'rv-1', labels: {} },
      });

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'warmpool-reconcile',
        {},
        expect.objectContaining({
          jobId: expect.stringContaining('reconcile-'),
        }),
      );
    });

    it('updates lastResourceVersion from apiObj.metadata.resourceVersion', async () => {
      await service.onModuleInit();
      injectQueue();

      const onEvent = getOnWatchEvent();
      onEvent('MODIFIED', {
        metadata: { resourceVersion: 'rv-42', labels: {} },
      });

      const lastRV = (
        service as unknown as { lastResourceVersion: string | null }
      ).lastResourceVersion;
      expect(lastRV).toBe('rv-42');
    });

    it('claimed=true label flip also triggers reconcile enqueue', async () => {
      await service.onModuleInit();
      injectQueue();

      const onEvent = getOnWatchEvent();
      onEvent('MODIFIED', {
        metadata: {
          resourceVersion: 'rv-2',
          labels: { 'geniro.io/claimed': 'true' },
        },
      });

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'warmpool-reconcile',
        {},
        expect.objectContaining({
          jobId: expect.stringContaining('reconcile-'),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Watch reconnect with backoff (K-15)
  // -------------------------------------------------------------------------

  describe('Watch reconnect (K-15)', () => {
    it('restarts the watch after onWatchEnd fires, using a timer-gated backoff', async () => {
      vi.useFakeTimers();

      await service.onModuleInit();

      // watch should have been called once during init
      expect(mockWatchInstance.watch).toHaveBeenCalledTimes(1);

      // Extract the onWatchEnd callback (4th arg of the first watch.watch() call)
      const onWatchEnd = mockWatchInstance.watch.mock.calls[0]![3] as (
        err: unknown,
      ) => void;

      // Simulate stream ending
      onWatchEnd(null);

      // Before the timer fires, watch should NOT have been called again
      expect(mockWatchInstance.watch).toHaveBeenCalledTimes(1);

      // Advance timers past maximum backoff (30s + 1s jitter)
      await vi.advanceTimersByTimeAsync(32_000);

      // watch should have been called again
      expect(mockWatchInstance.watch).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // onModuleDestroy
  // -------------------------------------------------------------------------

  describe('onModuleDestroy()', () => {
    it('aborts watch, closes Worker, Queue, and Redis', async () => {
      const abortFn = vi.fn();
      mockWatchInstance.watch.mockResolvedValue({ abort: abortFn });

      await service.onModuleInit();
      await service.onModuleDestroy();

      expect(abortFn).toHaveBeenCalledOnce();
      expect(mockWorkerClose).toHaveBeenCalledOnce();
      expect(mockQueueClose).toHaveBeenCalledOnce();
      expect(mockRedisInstance.quit).toHaveBeenCalledOnce();
    });

    it('does not throw when called before onModuleInit completed (size=0 path)', async () => {
      mockEnv['k8sWarmPoolSize'] = 0;
      await service.onModuleInit(); // noop

      await expect(service.onModuleDestroy()).resolves.not.toThrow();
    });

    it('does not call Redis.quit() when Redis status is not ready', async () => {
      // Start normally so internal state is wired up
      await service.onModuleInit();

      // Simulate Redis already closed before destroy
      mockRedisInstance.status = 'end';

      await service.onModuleDestroy();

      expect(mockRedisInstance.quit).not.toHaveBeenCalled();
    });
  });
});
