import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

vi.mock('../../../environments', () => ({
  environment: {
    dockerSocket: '/var/run/docker.sock',
    daytonaApiKey: 'test-daytona-key',
    daytonaApiUrl: 'http://daytona.local',
    daytonaTarget: 'local',
    k8sRuntimeNamespace: 'geniro-runtimes',
    dockerRuntimeImage: 'geniro/runtime:latest',
    k8sRuntimeClass: 'gvisor',
    k8sRuntimeServiceAccount: 'geniro-runtime',
    k8sRuntimeCpuRequest: '100m',
    k8sRuntimeCpuLimit: '1000m',
    k8sRuntimeMemoryRequest: '256Mi',
    k8sRuntimeMemoryLimit: '2Gi',
    k8sRuntimeReadyTimeoutMs: 60000,
    k8sInCluster: false,
  },
}));

vi.mock('./k8s-runtime', async () => {
  const K8sRuntime = vi.fn(function (
    this: unknown,
    config: unknown,
    options: unknown,
  ) {
    Object.assign(this as object, { _config: config, _options: options });
  });
  Object.assign(K8sRuntime, {
    stopByName: vi.fn().mockResolvedValue(undefined),
  });
  return { K8sRuntime };
});

import { DefaultLogger } from '@packages/common';

import { NotificationsService } from '../../notifications/services/notifications.service';
import { RuntimeInstanceDao } from '../dao/runtime-instance.dao';
import { RuntimeInstanceEntity } from '../entity/runtime-instance.entity';
import { RuntimeInstanceStatus, RuntimeType } from '../runtime.types';
import { BaseRuntime } from './base-runtime';
import { K8sRuntime } from './k8s-runtime';
import { K8sWarmPoolService } from './k8s-warm-pool.service';
import { RuntimeProvider } from './runtime-provider';

describe('RuntimeProvider', () => {
  let runtimeInstanceDao: ReturnType<typeof mock<RuntimeInstanceDao>>;
  let logger: ReturnType<typeof mock<DefaultLogger>>;
  let notificationsService: ReturnType<typeof mock<NotificationsService>>;

  beforeEach(() => {
    runtimeInstanceDao = mock<RuntimeInstanceDao>();
    logger = mock<DefaultLogger>();
    notificationsService = mock<NotificationsService>();
    vi.mocked(K8sRuntime.stopByName).mockResolvedValue(undefined);
  });

  function buildProvider(
    warmPoolService: K8sWarmPoolService | null = null,
  ): RuntimeProvider {
    return new RuntimeProvider(
      runtimeInstanceDao,
      logger,
      notificationsService,
      warmPoolService,
    );
  }

  describe('resolveRuntimeByType', () => {
    it('returns a K8sRuntime instance when K8sWarmPoolService is provided', () => {
      const warmPool = mock<K8sWarmPoolService>();
      const provider = buildProvider(warmPool);

      const runtime = provider['resolveRuntimeByType'](RuntimeType.K8s);

      expect(runtime).toBeInstanceOf(K8sRuntime);
    });

    it('returns a K8sRuntime instance when K8sWarmPoolService is null (absent from DI)', () => {
      const provider = buildProvider(null);

      const runtime = provider['resolveRuntimeByType'](RuntimeType.K8s);

      expect(runtime).toBeInstanceOf(K8sRuntime);
    });

    it('passes the warmPool to K8sRuntime when K8sWarmPoolService is provided', () => {
      const warmPool = mock<K8sWarmPoolService>();
      const provider = buildProvider(warmPool);

      provider['resolveRuntimeByType'](RuntimeType.K8s);

      expect(vi.mocked(K8sRuntime)).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: 'geniro-runtimes' }),
        expect.objectContaining({ warmPool }),
      );
    });

    it('passes null warmPool to K8sRuntime when K8sWarmPoolService is absent', () => {
      const provider = buildProvider(null);

      provider['resolveRuntimeByType'](RuntimeType.K8s);

      expect(vi.mocked(K8sRuntime)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ warmPool: null }),
      );
    });
  });

  describe('ensureRuntimeForRecord label building', () => {
    function buildProviderWithStubRuntime(startSpy: ReturnType<typeof vi.fn>) {
      const provider = buildProvider(null);
      const fakeRuntime = {
        start: startSpy,
        subscribe: vi.fn().mockReturnValue(() => undefined),
      } as unknown as BaseRuntime;
      vi.spyOn(
        provider as unknown as {
          resolveRuntimeByType: (type: RuntimeType) => BaseRuntime;
        },
        'resolveRuntimeByType',
      ).mockReturnValue(fakeRuntime);
      return provider;
    }

    function buildRecord(threadId: string): RuntimeInstanceEntity {
      return {
        id: 'inst-1',
        type: RuntimeType.K8s,
        containerName: 'pod-name',
        graphId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        threadId,
        nodeId: 'node-1',
        status: RuntimeInstanceStatus.Running,
        temporary: false,
        config: {},
      } as unknown as RuntimeInstanceEntity;
    }

    it('extracts the sub-id portion of an externalThreadId (after the colon) into geniro.io/thread-id', async () => {
      const startSpy = vi.fn().mockResolvedValue(undefined);
      const provider = buildProviderWithStubRuntime(startSpy);

      const record = buildRecord(
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      );

      await (
        provider as unknown as {
          ensureRuntimeForRecord: (
            r: RuntimeInstanceEntity,
          ) => Promise<unknown>;
        }
      ).ensureRuntimeForRecord(record);

      expect(startSpy).toHaveBeenCalledTimes(1);
      const startArg = startSpy.mock.calls[0]?.[0] as {
        labels: Record<string, string>;
      };
      expect(startArg.labels['geniro.io/thread-id']).toBe(
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      );
      expect(startArg.labels['geniro.io/graph-id']).toBe(
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      );
    });

    it('passes the threadId through unchanged when it does not contain a colon', async () => {
      const startSpy = vi.fn().mockResolvedValue(undefined);
      const provider = buildProviderWithStubRuntime(startSpy);

      const record = buildRecord('simple-id');

      await (
        provider as unknown as {
          ensureRuntimeForRecord: (
            r: RuntimeInstanceEntity,
          ) => Promise<unknown>;
        }
      ).ensureRuntimeForRecord(record);

      expect(startSpy).toHaveBeenCalledTimes(1);
      const startArg = startSpy.mock.calls[0]?.[0] as {
        labels: Record<string, string>;
      };
      expect(startArg.labels['geniro.io/thread-id']).toBe('simple-id');
    });
  });

  describe('cleanupRuntimesByNodeId', () => {
    it('filters by graphId when provided so sibling graphs are not collateral', async () => {
      const provider = buildProvider(null);
      runtimeInstanceDao.getAll.mockResolvedValue([]);

      await provider.cleanupRuntimesByNodeId('runtime-1', 'graph-A');

      expect(runtimeInstanceDao.getAll).toHaveBeenCalledWith({
        nodeId: 'runtime-1',
        graphId: 'graph-A',
      });
    });

    it('filters by null graphId for system runtimes (no parent graph)', async () => {
      const provider = buildProvider(null);
      runtimeInstanceDao.getAll.mockResolvedValue([]);

      await provider.cleanupRuntimesByNodeId('runtime-1', null);

      expect(runtimeInstanceDao.getAll).toHaveBeenCalledWith({
        nodeId: 'runtime-1',
        graphId: null,
      });
    });

    it('omits the graphId filter when graphId arg is undefined (legacy callers)', async () => {
      const provider = buildProvider(null);
      runtimeInstanceDao.getAll.mockResolvedValue([]);

      await provider.cleanupRuntimesByNodeId('runtime-1');

      expect(runtimeInstanceDao.getAll).toHaveBeenCalledWith({
        nodeId: 'runtime-1',
      });
    });
  });

  describe('stopRuntime (K8s branch)', () => {
    it('calls K8sRuntime.stopByName when no cached runtime is present', async () => {
      const provider = buildProvider(null);

      const instance = {
        id: 'inst-k8s-1',
        type: RuntimeType.K8s,
        containerName: 'my-k8s-pod',
        graphId: 'graph-1',
        threadId: 'thread-1',
        nodeId: 'node-1',
        status: RuntimeInstanceStatus.Running,
      } as RuntimeInstanceEntity;

      runtimeInstanceDao.updateById.mockResolvedValue(1);

      notificationsService.emit.mockResolvedValue(undefined);

      await provider.stopRuntime(instance);

      expect(vi.mocked(K8sRuntime.stopByName)).toHaveBeenCalledWith(
        'my-k8s-pod',
        expect.objectContaining({ namespace: 'geniro-runtimes' }),
      );
    });
  });
});
