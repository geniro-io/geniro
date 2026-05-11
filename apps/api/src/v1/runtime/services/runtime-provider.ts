import { Injectable, Optional } from '@nestjs/common';
import {
  BaseException,
  DefaultLogger,
  extractErrorMessage,
} from '@packages/common';
import isEqual from 'lodash/isEqual';
import {
  adjectives,
  nouns,
  uniqueUsernameGenerator,
} from 'unique-username-generator';

import { environment } from '../../../environments';
import { NotificationEvent } from '../../notifications/notifications.types';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { RuntimeInstanceDao } from '../dao/runtime-instance.dao';
import { RuntimeInstanceEntity } from '../entity/runtime-instance.entity';
import {
  ProvideRuntimeInstanceParams,
  RuntimeErrorCode,
  RuntimeInstanceStatus,
  RuntimeStartingPhase,
  RuntimeType,
} from '../runtime.types';
import { BaseRuntime } from './base-runtime';
import { DaytonaRuntime, DaytonaRuntimeConfig } from './daytona-runtime';
import { DockerRuntime } from './docker-runtime';
import { K8sRuntime } from './k8s-runtime';
import { K8sRuntimeConfig } from './k8s-runtime.types';
import { resolveK8sConfigFromEnv } from './k8s-runtime.utils';
import { K8sWarmPoolService } from './k8s-warm-pool.service';
import { classifyError } from './runtime-state-machine.utils';

export type ProvideRuntimeResult<T extends BaseRuntime> = {
  runtime: T;
  cached: boolean;
};

type EmitRuntimeStatusExtras = {
  message?: string;
  startingPhase?: RuntimeStartingPhase | null;
  errorCode?: RuntimeErrorCode | null;
  lastError?: string | null;
};

@Injectable()
export class RuntimeProvider {
  private readonly runtimeInstances = new Map<string, BaseRuntime>();

  constructor(
    private readonly runtimeInstanceDao: RuntimeInstanceDao,
    private readonly logger: DefaultLogger,
    private readonly notificationsService: NotificationsService,
    @Optional()
    private readonly k8sWarmPoolService: K8sWarmPoolService | null = null,
  ) {}

  private emitRuntimeStatus(
    graphId: string | null | undefined,
    threadId: string,
    nodeId: string,
    runtimeId: string,
    status: RuntimeInstanceStatus,
    runtimeType: string,
    extras: EmitRuntimeStatusExtras = {},
  ): void {
    // System operations (e.g. repo indexing) have no graph — skip notifications.
    if (!graphId) {
      return;
    }

    this.notificationsService
      .emit({
        type: NotificationEvent.RuntimeStatus,
        graphId,
        threadId,
        nodeId,
        data: {
          runtimeId,
          threadId,
          nodeId,
          status,
          runtimeType,
          message: extras.message,
          startingPhase: extras.startingPhase ?? null,
          errorCode: extras.errorCode ?? null,
          lastError: extras.lastError ?? null,
        },
      })
      .catch((error) => {
        this.logger.error(
          error as Error,
          'Failed to emit runtime status notification',
          { graphId, threadId, nodeId, runtimeId, status },
        );
      });
  }

  private subscribeRuntimePhaseEvents(
    runtime: BaseRuntime,
    record: RuntimeInstanceEntity,
  ): () => Promise<void> {
    const pending = new Set<Promise<unknown>>();
    const unsub = runtime.subscribe(async (event) => {
      if (event.type !== 'phase') {
        return;
      }
      const task = (async () => {
        try {
          await this.runtimeInstanceDao.transitionStatus(
            record.id,
            RuntimeInstanceStatus.Starting,
            { startingPhase: event.data.phase },
          );
          this.emitRuntimeStatus(
            record.graphId,
            record.threadId,
            record.nodeId,
            record.id,
            RuntimeInstanceStatus.Starting,
            record.type,
            { startingPhase: event.data.phase },
          );
        } catch (error) {
          this.logger.warn(
            `Failed to record runtime phase ${event.data.phase} for ${record.id}: ${extractErrorMessage(error)}`,
          );
        }
      })();
      pending.add(task);
      task.finally(() => pending.delete(task));
      await task;
    });
    return async () => {
      unsub();
      await Promise.allSettled([...pending]);
    };
  }

  protected resolveRuntimeConfigByType(
    type: RuntimeType,
  ): Record<string, unknown> | undefined {
    switch (type) {
      case RuntimeType.Docker:
        return { socketPath: environment.dockerSocket };
      case RuntimeType.Daytona:
        return {
          apiKey: environment.daytonaApiKey,
          apiUrl: environment.daytonaApiUrl,
          target: environment.daytonaTarget,
        };
      case RuntimeType.K8s:
        return undefined;
    }
  }

  private resolveDaytonaConfig(): DaytonaRuntimeConfig {
    return {
      apiKey: environment.daytonaApiKey as string,
      apiUrl: environment.daytonaApiUrl as string,
      target: environment.daytonaTarget as string,
    };
  }

  private resolveK8sConfig(): K8sRuntimeConfig {
    return resolveK8sConfigFromEnv(environment);
  }

  protected resolveRuntimeByType(type: RuntimeType): BaseRuntime | undefined {
    switch (type) {
      case RuntimeType.Docker:
        return new DockerRuntime(this.resolveRuntimeConfigByType(type), {
          logger: this.logger,
        });
      case RuntimeType.Daytona:
        return new DaytonaRuntime(this.resolveDaytonaConfig(), {
          logger: this.logger,
        });
      case RuntimeType.K8s:
        return new K8sRuntime(this.resolveK8sConfig(), {
          logger: this.logger,
          warmPool: this.k8sWarmPoolService ?? null,
        });
    }
  }

  public getDefaultRuntimeType(): RuntimeType {
    const configured = environment.defaultRuntimeType;
    if (
      Boolean(configured) &&
      Object.values(RuntimeType).includes(configured as RuntimeType)
    ) {
      return configured as RuntimeType;
    }
    return RuntimeType.Daytona;
  }

  async provide<T extends BaseRuntime>(
    params: ProvideRuntimeInstanceParams,
  ): Promise<ProvideRuntimeResult<T>> {
    const { graphId = null, runtimeNodeId, threadId, type } = params;

    const existing = await this.runtimeInstanceDao.getOne({
      graphId,
      nodeId: runtimeNodeId,
      threadId,
      type,
    });

    if (existing) {
      if (existing.status === RuntimeInstanceStatus.Failed) {
        this.logger.warn(
          `Runtime instance ${existing.id} is in Failed status — cleaning up and recreating`,
        );
        await this.stopRuntime(existing);
        await this.runtimeInstanceDao.hardDeleteById(existing.id);
      } else {
        const runtimeConfig = params.runtimeStartParams;
        const configChanged = !isEqual(existing.config, runtimeConfig);

        if (configChanged) {
          await this.stopRuntime(existing);
          await this.runtimeInstanceDao.hardDeleteById(existing.id);
        } else {
          await this.runtimeInstanceDao.updateById(existing.id, {
            lastUsedAt: new Date(),
            config: runtimeConfig,
            temporary: params.temporary ?? false,
          });

          try {
            this.emitRuntimeStatus(
              graphId,
              threadId,
              runtimeNodeId,
              existing.id,
              RuntimeInstanceStatus.Starting,
              type,
            );
            const runtime = await this.ensureRuntimeForRecord<T>(existing);
            if (existing.status !== RuntimeInstanceStatus.Running) {
              await this.runtimeInstanceDao.transitionStatus(
                existing.id,
                RuntimeInstanceStatus.Running,
              );
            }

            this.emitRuntimeStatus(
              graphId,
              threadId,
              runtimeNodeId,
              existing.id,
              RuntimeInstanceStatus.Running,
              type,
            );
            return { runtime, cached: true };
          } catch (error) {
            const errorCode = classifyError(error);
            const lastError = extractErrorMessage(error);
            await this.runtimeInstanceDao
              .transitionStatus(existing.id, RuntimeInstanceStatus.Failed, {
                errorCode,
                lastError,
              })
              .catch(() => undefined);
            this.emitRuntimeStatus(
              graphId,
              threadId,
              runtimeNodeId,
              existing.id,
              RuntimeInstanceStatus.Failed,
              type,
              { message: lastError, errorCode, lastError },
            );
            await this.cleanupFailedInstance(existing);
            throw error;
          }
        }
      }
    }

    const containerName = this.buildContainerName();

    const created = await this.runtimeInstanceDao.create({
      graphId,
      nodeId: runtimeNodeId,
      threadId,
      type,
      containerName,
      status: RuntimeInstanceStatus.Starting,
      config: params.runtimeStartParams,
      temporary: params.temporary ?? false,
      lastUsedAt: new Date(),
    });

    this.emitRuntimeStatus(
      graphId,
      threadId,
      runtimeNodeId,
      created.id,
      RuntimeInstanceStatus.Starting,
      type,
    );

    let runtime: T;
    try {
      runtime = await this.ensureRuntimeForRecord<T>(created);
    } catch (error) {
      const errorCode = classifyError(error);
      const lastError = extractErrorMessage(error);
      await this.runtimeInstanceDao
        .transitionStatus(created.id, RuntimeInstanceStatus.Failed, {
          errorCode,
          lastError,
        })
        .catch(() => undefined);
      this.emitRuntimeStatus(
        graphId,
        threadId,
        runtimeNodeId,
        created.id,
        RuntimeInstanceStatus.Failed,
        type,
        { message: lastError, errorCode, lastError },
      );
      await this.cleanupFailedInstance(created);
      throw error;
    }

    await this.runtimeInstanceDao.transitionStatus(
      created.id,
      RuntimeInstanceStatus.Running,
      { lastUsedAt: new Date() },
    );

    this.emitRuntimeStatus(
      graphId,
      threadId,
      runtimeNodeId,
      created.id,
      RuntimeInstanceStatus.Running,
      type,
    );
    return { runtime, cached: false };
  }

  async stopRuntime(instance: RuntimeInstanceEntity): Promise<void> {
    // Terminal states skip the status/emit churn but still attempt the backend
    // cleanup so idle-reaper passes leave no orphaned containers behind.
    if (
      instance.status === RuntimeInstanceStatus.Stopped ||
      instance.status === RuntimeInstanceStatus.Failed
    ) {
      await this.stopContainer(instance);
      return;
    }

    if (instance.status !== RuntimeInstanceStatus.Stopping) {
      await this.runtimeInstanceDao.transitionStatus(
        instance.id,
        RuntimeInstanceStatus.Stopping,
      );
    }

    this.emitRuntimeStatus(
      instance.graphId,
      instance.threadId,
      instance.nodeId,
      instance.id,
      RuntimeInstanceStatus.Stopping,
      instance.type,
    );

    await this.stopContainer(instance);

    await this.runtimeInstanceDao.transitionStatus(
      instance.id,
      RuntimeInstanceStatus.Stopped,
    );

    this.emitRuntimeStatus(
      instance.graphId,
      instance.threadId,
      instance.nodeId,
      instance.id,
      RuntimeInstanceStatus.Stopped,
      instance.type,
    );
  }

  private async stopContainer(instance: RuntimeInstanceEntity): Promise<void> {
    const runtime = this.runtimeInstances.get(instance.id);

    if (runtime) {
      await runtime.stop().catch(() => undefined);
      this.runtimeInstances.delete(instance.id);
      return;
    }

    const config = this.resolveRuntimeConfigByType(instance.type);

    switch (instance.type) {
      case RuntimeType.Docker:
        await DockerRuntime.stopByName(instance.containerName, config).catch(
          () => undefined,
        );
        break;
      case RuntimeType.Daytona:
        await DaytonaRuntime.stopByName(
          instance.containerName,
          this.resolveDaytonaConfig(),
        ).catch(() => undefined);
        break;
      case RuntimeType.K8s:
        await K8sRuntime.stopByName(
          instance.containerName,
          this.resolveK8sConfig(),
        ).catch(() => undefined);
        break;
    }
  }

  async cleanupIdleRuntimes(idleThresholdMs: number): Promise<number> {
    const lastUsedBefore = new Date(Date.now() - idleThresholdMs);
    const instances = await this.runtimeInstanceDao.getAll({
      lastUsedAt: { $lt: lastUsedBefore },
      status: {
        $in: [
          RuntimeInstanceStatus.Running,
          RuntimeInstanceStatus.Starting,
          RuntimeInstanceStatus.Failed,
        ],
      },
    });

    return this.stopAndDeleteInstances(instances);
  }

  async cleanupRuntimesByNodeId(
    nodeId: string,
    graphId?: string | null,
  ): Promise<number> {
    // Multiple graphs in the same DB can share a node id (e.g. tests reuse
    // `runtime-1`). Filter by graphId so destroying one graph doesn't nuke
    // sibling graphs' runtime instances.
    const instances = await this.runtimeInstanceDao.getAll({
      nodeId,
      ...(graphId !== undefined ? { graphId } : {}),
    });

    return this.stopAndDeleteInstances(instances);
  }

  async cleanupTemporaryRuntimes(): Promise<number> {
    // Only cleanup temporary containers that haven't been used in the last 10 minutes
    // This prevents cleanup of actively running temporary containers (e.g., repo indexing)
    const TEMPORARY_ACTIVE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    const lastUsedBefore = new Date(Date.now() - TEMPORARY_ACTIVE_THRESHOLD_MS);

    const instances = await this.runtimeInstanceDao.getAll({
      temporary: true,
      lastUsedAt: { $lt: lastUsedBefore },
    });

    return this.stopAndDeleteInstances(instances);
  }

  private async stopAndDeleteInstances(
    instances: RuntimeInstanceEntity[],
  ): Promise<number> {
    if (!instances.length) {
      return 0;
    }

    // Bulk-cleanup paths (idle reaper, node-id sweep, temp sweep, thread
    // teardown) can race against each other and against the periodic
    // RuntimeCleanupService. Two outcomes both surface as exceptions but
    // are benign for bulk cleanup (which is idempotent by design):
    //  - RUNTIME_INSTANCE_NOT_FOUND: concurrent path already hard-deleted.
    //  - INVALID_RUNTIME_STATUS_TRANSITION: concurrent path already moved
    //    the row to a terminal state (Stopped/Failed) between our snapshot
    //    read and our transitionStatus call; nothing left to stop.
    // Both mean "someone else finished the work" — skip and try the
    // best-effort hard-delete.
    await Promise.all(
      instances.map(async (instance) => {
        try {
          await this.stopRuntime(instance);
        } catch (error) {
          if (
            !(error instanceof BaseException) ||
            (error.errorCode !== 'RUNTIME_INSTANCE_NOT_FOUND' &&
              error.errorCode !== 'INVALID_RUNTIME_STATUS_TRANSITION')
          ) {
            throw error;
          }
        }
        await this.runtimeInstanceDao
          .hardDeleteById(instance.id)
          .catch(() => undefined);
      }),
    );

    return instances.length;
  }

  async cleanupRuntimeInstance(params: {
    graphId?: string | null;
    runtimeNodeId: string;
    threadId: string;
    type: RuntimeType;
  }): Promise<void> {
    const instance = await this.runtimeInstanceDao.getOne({
      graphId: params.graphId ?? null,
      nodeId: params.runtimeNodeId,
      threadId: params.threadId,
      type: params.type,
    });

    if (!instance) {
      return;
    }

    await this.stopRuntime(instance);
    await this.runtimeInstanceDao.hardDeleteById(instance.id);
  }

  private async cleanupFailedInstance(
    instance: RuntimeInstanceEntity,
  ): Promise<void> {
    try {
      // Entity is already marked Failed (terminal) — skip the DAO status
      // transitions in stopRuntime() and just stop the underlying container
      // before hard-deleting the record.
      await this.stopContainer(instance);
    } catch (error) {
      this.logger.warn(
        `Failed to stop errored runtime ${instance.id} (${instance.containerName}): ${extractErrorMessage(error)}`,
      );
    }
    await this.runtimeInstanceDao.hardDeleteById(instance.id);
  }

  private async ensureRuntimeForRecord<T extends BaseRuntime>(
    record: RuntimeInstanceEntity,
  ): Promise<T> {
    const cached = this.runtimeInstances.get(record.id);
    if (cached) {
      return <T>cached;
    }

    const runtime = this.resolveRuntimeByType(record.type);
    if (!runtime) {
      throw new Error(`Runtime ${record.type} is not supported`);
    }

    const registryMirrors = environment.dockerRegistryMirror
      ? [environment.dockerRegistryMirror as string]
      : undefined;
    const insecureRegistries = environment.dockerInsecureRegistry
      ? [environment.dockerInsecureRegistry as string]
      : undefined;
    const baseLabels = record.config.labels ?? {};
    const threadIdLabel = record.threadId.includes(':')
      ? record.threadId.split(':').slice(1).join(':')
      : record.threadId;
    const labels: Record<string, string> = {
      ...baseLabels,
      ...(record.graphId ? { 'geniro.io/graph-id': record.graphId } : {}),
      'geniro.io/node-id': record.nodeId,
      'geniro.io/thread-id': threadIdLabel,
      'geniro.io/instance-id': record.id,
      'geniro.io/type': 'runtime',
    };
    if (record.temporary) {
      labels['geniro.io/temporary'] = 'true';
    }

    const unsubscribe = this.subscribeRuntimePhaseEvents(runtime, record);

    try {
      await runtime.start({
        ...record.config,
        network: record.graphId ? `geniro-${record.graphId}` : undefined,
        registryMirrors,
        insecureRegistries,
        containerName: record.containerName,
        labels,
        recreate: false,
      });
    } finally {
      await unsubscribe();
    }

    this.runtimeInstances.set(record.id, runtime);
    return <T>runtime;
  }

  private buildContainerName(): string {
    return uniqueUsernameGenerator({
      dictionaries: [adjectives, nouns],
      template: '{adjective}-{noun}-{digits:3}',
      style: 'lowerCase',
      length: 30,
    });
  }
}
