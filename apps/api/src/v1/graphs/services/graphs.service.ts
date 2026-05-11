import { HumanMessage } from '@langchain/core/messages';
import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  BadRequestException,
  DefaultLogger,
  NotFoundException,
} from '@packages/common';
import { isEqual } from 'lodash';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { BaseTrigger } from '../../agent-triggers/services/base-trigger';
import { SimpleAgent } from '../../agents/services/agents/simple-agent';
import { CheckpointStateService } from '../../agents/services/checkpoint-state.service';
import { TemplateRegistry } from '../../graph-templates/services/template-registry';
import { NotificationEvent } from '../../notifications/notifications.types';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { ProjectsDao } from '../../projects/dao/projects.dao';
import { ThreadsDao } from '../../threads/dao/threads.dao';
import { ThreadResumeQueueService } from '../../threads/services/thread-resume-queue.service';
import { ThreadStatusTransitionService } from '../../threads/services/thread-status-transition.service';
import type { ThreadsService } from '../../threads/services/threads.service';
import { THREADS_SERVICE_TOKEN } from '../../threads/services/threads.tokens';
import { ThreadStatus } from '../../threads/threads.types';
import { clearWaitMetadata } from '../../threads/threads.utils';
import { GraphDao } from '../dao/graph.dao';
import {
  CreateGraphDto,
  ExecuteTriggerDto,
  ExecuteTriggerResponseDto,
  GetAllGraphsQueryDto,
  GetGraphsPreviewQueryDto,
  GraphDto,
  GraphNodesQueryDto,
  GraphNodeWithStatusDto,
  GraphPreviewDto,
  UpdateGraphDto,
  UpdateGraphResponseDto,
} from '../dto/graphs.dto';
import { GraphEntity } from '../entity/graph.entity';
import type { GraphRevisionConfig } from '../entity/graph-revision.entity';
import { GRAPH_DELETED_EVENT, GraphDeletedEvent } from '../graphs.events';
import { GraphStatus, NodeKind } from '../graphs.types';
import {
  extractAgentsFromSchema,
  extractNodeDisplayNamesFromMetadata,
  extractTriggerNodesFromSchema,
} from '../graphs.utils';
import { CostLimitResolverService } from './cost-limit-resolver.service';
import { GraphCompiler } from './graph-compiler';
import { GraphRegistry } from './graph-registry';
import { GraphRevisionService } from './graph-revision.service';

@Injectable()
export class GraphsService {
  constructor(
    private readonly graphDao: GraphDao,
    private readonly graphCompiler: GraphCompiler,
    private readonly graphRegistry: GraphRegistry,
    private readonly graphRevisionService: GraphRevisionService,
    private readonly em: EntityManager,
    private readonly notificationsService: NotificationsService,
    private readonly threadsDao: ThreadsDao,
    private readonly eventEmitter: EventEmitter2,
    private readonly projectsDao: ProjectsDao,
    private readonly templateRegistry: TemplateRegistry,
    private readonly threadResumeQueueService: ThreadResumeQueueService,
    private readonly costLimitResolver: CostLimitResolverService,
    private readonly checkpointStateService: CheckpointStateService,
    private readonly transitionService: ThreadStatusTransitionService,
    private readonly logger: DefaultLogger,
    @Inject(THREADS_SERVICE_TOKEN)
    private readonly threadsService: ThreadsService,
  ) {}

  private extractGraphCostLimitUsd(entity: GraphEntity): number | null {
    return entity.settings?.costLimitUsd ?? null;
  }

  private prepareResponse(
    entity: GraphEntity,
    threadCounts?: { total: number; running: number },
  ): GraphDto {
    return {
      ...entity,
      runningThreads: threadCounts?.running ?? 0,
      totalThreads: threadCounts?.total ?? 0,
      createdAt: new Date(entity.createdAt).toISOString(),
      updatedAt: new Date(entity.updatedAt).toISOString(),
      costLimitUsd: this.extractGraphCostLimitUsd(entity),
    };
  }

  async create(
    ctx: AppContextStorage,
    data: CreateGraphDto,
  ): Promise<GraphDto> {
    this.graphCompiler.validateSchema(data.schema);

    const userId = ctx.checkSub();
    const projectId = ctx.checkProjectId();

    const project = await this.projectsDao.getOne({
      id: projectId,
      createdBy: userId,
    });
    if (!project) {
      throw new NotFoundException('PROJECT_NOT_FOUND');
    }

    // `em.fork().transactional()` matches the pattern used in executeTrigger
    // (line 776) — root the transaction on a private fork so the upper em's
    // #transactionContext can never leak across concurrent calls. Graph
    // creation is invoked concurrently from multiple test files and from the
    // graph-templates seeder, both of which previously triggered the
    // "savepoint trx1 does not exist" heisenbug under high parallelism.
    return await this.em.fork().transactional(async (em: EntityManager) => {
      const initialVersion = '1.0.0';
      const agents = extractAgentsFromSchema(
        data.schema,
        this.templateRegistry,
      );
      const row = await this.graphDao.create(
        {
          name: data.name,
          description: data.description,
          schema: data.schema,
          metadata: data.metadata,
          projectId,
          status: GraphStatus.Created,
          createdBy: userId,
          temporary: data.temporary ?? false,
          version: initialVersion,
          targetVersion: initialVersion,
          agents,
        } as Partial<GraphEntity>,
        em,
      );

      return this.prepareResponse(row);
    });
  }

  async findById(ctx: AppContextStorage, id: string): Promise<GraphDto> {
    const userId = ctx.checkSub();
    const graph = await this.graphDao.getOne({
      id,
      createdBy: userId,
    });
    if (!graph) {
      throw new NotFoundException('GRAPH_NOT_FOUND');
    }

    const threadCounts = await this.threadsDao.countByGraphIds([id]);
    return this.prepareResponse(graph, threadCounts.get(id));
  }

  async getAll(
    ctx: AppContextStorage,
    query?: GetAllGraphsQueryDto,
  ): Promise<GraphDto[]> {
    const userId = ctx.checkSub();
    const rows = await this.graphDao.getAll(
      {
        createdBy: userId,
        ...(query?.ids ? { id: { $in: query.ids } } : {}),
        projectId: ctx.checkProjectId(),
      },
      { orderBy: { updatedAt: 'DESC' } },
    );

    const graphIds = rows.map((r) => r.id);
    const threadCounts = await this.threadsDao.countByGraphIds(graphIds);

    return rows.map((entity) =>
      this.prepareResponse(entity, threadCounts.get(entity.id)),
    );
  }

  async getGraphsPreview(
    ctx: AppContextStorage,
    query?: GetGraphsPreviewQueryDto,
  ): Promise<GraphPreviewDto[]> {
    const userId = ctx.checkSub();
    const rows = await this.graphDao.getPreview(
      {
        createdBy: userId,
        ...(query?.ids ? { id: { $in: query.ids } } : {}),
        projectId: ctx.checkProjectId(),
      },
      { orderBy: { updatedAt: 'DESC' } },
    );

    if (rows.length === 0) {
      return [];
    }

    const graphIds = rows.map((r) => r.id);
    const [schemaMetadataMap, threadCounts] = await Promise.all([
      this.graphDao.getSchemaAndMetadata(graphIds),
      this.threadsDao.countByGraphIds(graphIds),
    ]);

    return rows.map((entity) => {
      const schemaData = schemaMetadataMap.get(entity.id);
      const schema = schemaData?.schema ?? { nodes: [], edges: [] };
      const metadata = schemaData?.metadata ?? null;
      const agents = schemaData?.agents ?? [];
      const counts = threadCounts.get(entity.id);

      return {
        id: entity.id,
        name: entity.name,
        description: entity.description ?? null,
        error: entity.error ?? null,
        version: entity.version,
        targetVersion: entity.targetVersion,
        status: entity.status,
        runningThreads: counts?.running ?? 0,
        totalThreads: counts?.total ?? 0,
        nodeCount: schema.nodes.length,
        edgeCount: schema.edges?.length ?? 0,
        agents,
        triggerNodes: extractTriggerNodesFromSchema(
          schema,
          metadata,
          this.templateRegistry,
        ),
        nodeDisplayNames: extractNodeDisplayNamesFromMetadata(metadata),
        createdAt: new Date(entity.createdAt).toISOString(),
        updatedAt: new Date(entity.updatedAt).toISOString(),
        temporary: entity.temporary,
        projectId: entity.projectId,
        costLimitUsd: this.extractGraphCostLimitUsd(entity),
      };
    });
  }

  async getCompiledNodes(
    ctx: AppContextStorage,
    id: string,
    data: GraphNodesQueryDto,
  ): Promise<GraphNodeWithStatusDto[]> {
    const userId = ctx.checkSub();
    const graph = await this.graphDao.getOne({
      id,
      createdBy: userId,
    });

    if (!graph) {
      throw new NotFoundException('GRAPH_NOT_FOUND');
    }

    const compiledGraph = this.graphRegistry.get(id);
    if (!compiledGraph) {
      throw new BadRequestException(
        'GRAPH_NOT_RUNNING',
        'Graph must be running to inspect compiled nodes',
      );
    }

    return compiledGraph.state.getSnapshots(data.threadId, data.runId);
  }

  async update(
    ctx: AppContextStorage,
    id: string,
    data: UpdateGraphDto,
  ): Promise<UpdateGraphResponseDto> {
    const userId = ctx.checkSub();
    const {
      currentVersion,
      metadata,
      schema,
      name,
      description,
      temporary,
      costLimitUsd,
    } = data;

    // Use transaction with row-level locking to prevent simultaneous updates.
    // Post-transaction data (revision to enqueue, notification to emit) is returned
    // from the transaction callback so TypeScript can track it through control flow.
    // Fork the EM first so concurrent callers don't share a transactionContext
    // pointer (avoids spurious "SAVEPOINT can only be used in transaction blocks").
    const { response, postCommit } = await this.em
      .fork()
      .transactional(async (em: EntityManager) => {
        // Lock the graph row for update (prevents race conditions)
        const graph = await this.graphDao.getOne(
          {
            id,
            createdBy: userId,
          },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
          em,
        );

        if (!graph) {
          throw new NotFoundException('GRAPH_NOT_FOUND');
        }

        if (graph.version !== currentVersion) {
          throw new BadRequestException(
            'VERSION_CONFLICT',
            `Graph version mismatch. Expected ${currentVersion} but found ${graph.version}`,
          );
        }

        // Invariant repair: targetVersion must never be lower than version.
        // If this happened due to legacy bugs or manual DB edits, clamp it before
        // we compute the revision head (targetVersion) for new revisions.
        if (
          this.graphRevisionService.isVersionLess(
            graph.targetVersion,
            graph.version,
          )
        ) {
          await this.graphDao.updateById(
            id,
            { targetVersion: graph.version },
            em,
          );
          graph.targetVersion = graph.version;
        }

        // --- Synchronous (in-place) fields: metadata, name, description, temporary ---
        // These are simple scalar fields that don't affect the compiled graph and
        // can be applied immediately without going through the revision pipeline.
        const syncUpdates: Partial<GraphEntity> = {};

        if (metadata !== undefined && !isEqual(metadata, graph.metadata)) {
          syncUpdates.metadata = metadata;
        }
        if (name !== undefined && name !== graph.name) {
          syncUpdates.name = name;
        }
        if (
          description !== undefined &&
          (description ?? null) !== (graph.description ?? null)
        ) {
          syncUpdates.description = description ?? undefined;
        }
        if (
          temporary !== undefined &&
          temporary !== null &&
          temporary !== graph.temporary
        ) {
          syncUpdates.temporary = temporary;
        }

        if (costLimitUsd !== undefined) {
          syncUpdates.settings = {
            ...(graph.settings ?? {}),
            costLimitUsd,
          };
        }

        if (Object.keys(syncUpdates).length > 0) {
          await this.graphDao.updateById(id, syncUpdates, em);
          Object.assign(graph, syncUpdates);
        }

        // --- Revision-relevant field: schema ---
        // Schema changes require async processing (compilation, live-update, etc.)
        const schemaChanged =
          schema !== undefined && !isEqual(schema, graph.schema);

        if (schemaChanged) {
          const revisionConfig: GraphRevisionConfig = {
            schema: schema!,
            name: graph.name,
            description: graph.description ?? null,
            temporary: graph.temporary,
          };

          const revision = await this.graphRevisionService.queueRevision(
            ctx,
            graph,
            currentVersion,
            revisionConfig,
            em,
            { enqueueImmediately: false },
          );

          graph.targetVersion = revision.toVersion;
          return {
            response: {
              graph: this.prepareResponse(graph),
              revision,
            } as UpdateGraphResponseDto,
            postCommit: {
              revisionToEnqueue: { id: revision.id, graphId: revision.graphId },
              revisionEntity: revision.entity,
              graphId: graph.id,
            },
          };
        }

        return {
          response: {
            graph: this.prepareResponse(graph),
          } as UpdateGraphResponseDto,
          postCommit: null,
        };
      });

    // Post-transaction: emit notification and enqueue processing.
    // These run after the transaction commits so the enrichment handler
    // can read the committed revision data from the database.
    if (postCommit) {
      await this.notificationsService.emit({
        type: NotificationEvent.GraphRevisionCreate,
        graphId: postCommit.graphId,
        data: postCommit.revisionEntity,
      });

      await this.graphRevisionService.enqueueRevisionProcessing(
        postCommit.revisionToEnqueue,
      );
    }

    return response;
  }

  async delete(ctx: AppContextStorage, id: string): Promise<void> {
    const userId = ctx.checkSub();
    const graph = await this.graphDao.getOne({
      id,
      createdBy: userId,
    });
    if (!graph) {
      throw new NotFoundException('GRAPH_NOT_FOUND');
    }

    if (graph.status === GraphStatus.Running) {
      await this.destroy(ctx, id);
    }

    await this.eventEmitter.emitAsync(GRAPH_DELETED_EVENT, {
      graphId: id,
      userId,
    } satisfies GraphDeletedEvent);

    await this.graphDao.deleteById(id);
  }

  async run(ctx: AppContextStorage, id: string): Promise<GraphDto> {
    const userId = ctx.checkSub();
    const graph = await this.graphDao.getOne({
      id,
      createdBy: userId,
    });
    if (!graph) {
      throw new NotFoundException('GRAPH_NOT_FOUND');
    }

    const registryStatus = this.graphRegistry.getStatus(id);
    const isGraphActive =
      registryStatus === GraphStatus.Running ||
      registryStatus === GraphStatus.Compiling;

    if (isGraphActive) {
      throw new BadRequestException('GRAPH_ALREADY_RUNNING');
    }

    const schema = graph.schema;

    await this.graphDao.updateById(id, {
      status: GraphStatus.Compiling,
      error: undefined,
    });

    await this.notificationsService.emit({
      type: NotificationEvent.Graph,
      graphId: id,
      data: {
        status: GraphStatus.Compiling,
        schema,
      },
    });

    await this.emitGraphPreview(id, GraphStatus.Compiling, graph);

    try {
      // Compile the graph (it will be registered automatically during compilation)
      await this.graphCompiler.compile(graph, {
        graphId: graph.id,
        name: graph.name,
        version: graph.version,
      });

      await this.graphDao.updateById(id, {
        status: GraphStatus.Running,
        error: undefined,
      });

      const updated = await this.graphDao.getOne({ id, createdBy: userId });
      if (!updated) {
        // If database read fails, cleanup the registry
        await this.graphRegistry.destroy(id);
        throw new NotFoundException('GRAPH_NOT_FOUND');
      }

      await this.notificationsService.emit({
        type: NotificationEvent.Graph,
        graphId: id,
        data: {
          status: GraphStatus.Running,
          schema,
        },
      });

      await this.emitGraphPreview(id, GraphStatus.Running, graph);

      return this.prepareResponse(updated);
    } catch (error) {
      if (this.graphRegistry.get(id)) {
        await this.graphRegistry.destroy(id);
      }

      try {
        await this.stopRunningThreads(id);
      } catch {
        // Best effort: keep original error as the primary failure reason
      }

      try {
        await this.threadResumeQueueService.cancelAllForGraph(id);
      } catch {
        // Best effort: keep original error as the primary failure reason
      }

      await this.graphDao.updateById(id, {
        status: GraphStatus.Error,
        error: (error as Error).message,
      });

      await this.notificationsService.emit({
        type: NotificationEvent.Graph,
        graphId: id,
        data: {
          status: GraphStatus.Error,
          schema,
        },
      });

      await this.emitGraphPreview(id, GraphStatus.Error, graph);

      throw error;
    }
  }

  private async stopRunningThreads(graphId: string): Promise<void> {
    const runningThreads = await this.threadsDao.getAll({
      graphId,
      status: { $in: [ThreadStatus.Running, ThreadStatus.Waiting] },
    });

    if (!runningThreads.length) {
      return;
    }

    const results = await Promise.allSettled(
      runningThreads.map((thread) => {
        const patch = this.transitionService.computeTransition(
          thread,
          ThreadStatus.Stopped,
        );
        return this.threadsDao.updateById(thread.id, patch);
      }),
    );
    for (const [idx, result] of results.entries()) {
      if (result.status === 'rejected') {
        const thread = runningThreads[idx]!;
        const reason =
          result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason));
        this.logger.error(
          reason,
          'Failed to stop running thread during graph stop',
          {
            threadId: thread.id,
            externalThreadId: thread.externalThreadId,
            graphId,
          },
        );
      }
    }
  }

  private async emitGraphPreview(
    id: string,
    status: GraphStatus,
    graph: GraphEntity,
  ): Promise<void> {
    const schema = graph.schema;
    await this.notificationsService.emit({
      type: NotificationEvent.GraphPreview,
      graphId: id,
      data: {
        id,
        status,
        triggerNodes: extractTriggerNodesFromSchema(
          schema,
          graph.metadata,
          this.templateRegistry,
        ),
        nodeDisplayNames: extractNodeDisplayNamesFromMetadata(graph.metadata),
        nodeCount: schema.nodes.length,
        edgeCount: schema.edges?.length ?? 0,
        agents: graph.agents ?? [],
        version: graph.version,
        targetVersion: graph.targetVersion,
        error: graph.error ?? null,
      },
    });
  }

  /**
   * Best-effort stop of a single thread execution within a running graph.
   * Stops any active agent runs whose thread_id or parent_thread_id matches the provided externalThreadId.
   */
  async stopThreadExecution(
    graphId: string,
    externalThreadId: string,
    reason?: string,
  ): Promise<boolean> {
    const compiledGraph = this.graphRegistry.get(graphId);
    if (!compiledGraph) {
      return false;
    }

    const agentNodes = this.graphRegistry.getNodesByType<SimpleAgent>(
      graphId,
      NodeKind.SimpleAgent,
    );

    if (!agentNodes.length) {
      return false;
    }

    const results = await Promise.allSettled(
      agentNodes.map(async (node) => {
        return await node.instance.stopThread(externalThreadId, reason);
      }),
    );

    return results.some((r) => r.status === 'fulfilled' && r.value === true);
  }

  async destroy(ctx: AppContextStorage, id: string): Promise<GraphDto> {
    const userId = ctx.checkSub();
    const graph = await this.graphDao.getOne({
      id,
      createdBy: userId,
    });
    if (!graph) {
      throw new NotFoundException('GRAPH_NOT_FOUND');
    }

    if (this.graphRegistry.get(id)) {
      await this.graphRegistry.destroy(id);
    }

    // Safety net: stop any threads still marked as running/waiting in the database.
    try {
      await this.stopRunningThreads(id);
    } catch {
      // Best effort: keep destroy flowing even if thread cleanup fails
    }

    // Cancel any pending resume jobs for this graph
    try {
      await this.threadResumeQueueService.cancelAllForGraph(id);
    } catch {
      // Best effort: keep destroy flowing even if resume job cancellation fails
    }

    await this.graphDao.updateById(id, {
      status: GraphStatus.Stopped,
      error: undefined,
    });

    const updated = await this.graphDao.getOne({ id, createdBy: userId });
    if (!updated) {
      throw new NotFoundException('GRAPH_NOT_FOUND');
    }

    await this.notificationsService.emit({
      type: NotificationEvent.Graph,
      graphId: id,
      data: {
        status: GraphStatus.Stopped,
        schema: graph.schema,
      },
    });

    await this.emitGraphPreview(id, GraphStatus.Stopped, graph);

    return this.prepareResponse(updated);
  }

  async executeTrigger(
    ctx: AppContextStorage,
    graphId: string,
    triggerId: string,
    dto: ExecuteTriggerDto,
  ): Promise<ExecuteTriggerResponseDto> {
    const userId = ctx.checkSub();
    const graph = await this.graphDao.getOne({
      id: graphId,
      createdBy: userId,
    });

    if (!graph) {
      throw new NotFoundException('GRAPH_NOT_FOUND');
    }

    const compiledGraph = this.graphRegistry.get(graphId);
    if (!compiledGraph || compiledGraph.status !== GraphStatus.Running) {
      throw new BadRequestException(
        'GRAPH_NOT_RUNNING',
        'Graph must be running to execute triggers',
      );
    }

    const triggerNode = this.graphRegistry.getNode<BaseTrigger>(
      graphId,
      triggerId,
    );
    if (!triggerNode) {
      throw new NotFoundException('TRIGGER_NOT_FOUND');
    }

    if (triggerNode.type !== NodeKind.Trigger) {
      throw new BadRequestException(
        'INVALID_NODE_TYPE',
        'Node is not a trigger',
      );
    }

    const trigger = triggerNode.instance;

    if (!trigger.isStarted) {
      throw new BadRequestException(
        'TRIGGER_NOT_STARTED',
        'Trigger is not in listening state',
      );
    }

    const messages = dto.messages.map((msg) => {
      if (typeof msg === 'string') {
        return new HumanMessage(msg);
      }
      // Structured message with content blocks — LangChain HumanMessage
      // natively supports content block arrays in the OpenAI vision format.
      return new HumanMessage({ content: msg.content });
    });

    if (!trigger.invokeAgent) {
      throw new BadRequestException(
        'TRIGGER_NOT_CONFIGURED',
        'Agent invocation function not set on trigger',
      );
    }

    // Resolve the effective cost limit once at the trigger boundary so both
    // the running agent and the persisted thread metadata agree. This is also
    // the single "new user message" write point that refreshes the stored
    // limit when the user or admin changes the configured value between
    // messages.
    const effectiveCostLimitUsd = await this.costLimitResolver.resolveForThread(
      userId,
      graphId,
    );

    if (dto.threadSubId) {
      // Wrap the entire "existing thread" branch in a pessimistic-write
      // transaction to prevent TOCTOU races where two concurrent requests
      // read Stopped status simultaneously and both bypass the resume guard.
      //
      // Use `em.fork().transactional(...)` instead of `em.transactional(...)`
      // so the transaction is rooted on a private fork, never on the global em.
      // executeTrigger can be invoked concurrently (HTTP request + the BullMQ
      // resume worker, or two follow-up triggers landing during an in-flight
      // run); MikroORM's maintainer recommends the explicit-fork pattern for
      // concurrent transactions because `em.transactional()` on the global em
      // (a) merges entities back into the upper context on commit, and
      // (b) goes through TransactionManager's NESTED-by-default propagation
      //     which checks `em.getTransactionContext()` on the upper em — if a
      //     prior fork's `#transactionContext` ever leaks onto the upper em,
      //     the next call opens a SAVEPOINT on a connection that's already
      //     been returned to the pool, and rollback explodes with
      //     "ROLLBACK TO SAVEPOINT can only be used in transaction blocks".
      // See: https://github.com/mikro-orm/mikro-orm/discussions/5309
      await this.em.fork().transactional(async (em: EntityManager) => {
        const existingThread = await this.threadsDao.getOne(
          {
            externalThreadId: `${graphId}:${dto.threadSubId}`,
            graphId: graphId,
          },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
          em,
        );

        if (!existingThread) {
          return;
        }

        let nextMetadata = { ...(existingThread.metadata ?? {}) } as Record<
          string,
          unknown
        >;
        let nextStatus: ThreadStatus | undefined;

        if (existingThread.status === ThreadStatus.Waiting) {
          // Cancel the pending resume job so the user's message takes over.
          try {
            await this.threadResumeQueueService.cancelResumeJob(
              existingThread.id,
            );
            nextMetadata = clearWaitMetadata(existingThread.metadata) ?? {};
            nextStatus = ThreadStatus.Running;
          } catch {
            // Best effort — the user message will proceed regardless
          }
        } else if (
          existingThread.status === ThreadStatus.Stopped &&
          ((existingThread.metadata as { stopReason?: string } | undefined)
            ?.stopReason === 'cost_limit' ||
            (existingThread.metadata as { costLimitHit?: boolean } | undefined)
              ?.costLimitHit === true)
        ) {
          // Prefer the persisted stopCostUsd (captured at the moment the limit
          // was exceeded) over the checkpoint total. When CostLimitExceededError
          // fires, execution exits before the over-budget call's usage is written
          // to the checkpoint, so the checkpoint read here would otherwise be the
          // PRE-call total and would allow resume without the user raising the
          // limit.
          const metadataStopCost = (
            existingThread.metadata as { stopCostUsd?: number } | undefined
          )?.stopCostUsd;

          // if effectiveCostLimitUsd is null the user removed all limits —
          // allow resume unconditionally. Otherwise require a valid stopCostUsd
          // (drop the checkpoint fallback which could underestimate the cost).
          if (effectiveCostLimitUsd !== null) {
            if (typeof metadataStopCost !== 'number') {
              throw new BadRequestException(
                'THREAD_COST_LIMIT_REACHED',
                'Raise the configured cost limit to resume this thread.',
              );
            }
            if (metadataStopCost >= effectiveCostLimitUsd) {
              throw new BadRequestException(
                'THREAD_COST_LIMIT_REACHED',
                `Raise the limit above $${metadataStopCost.toFixed(2)} to resume.`,
              );
            }
          }

          // Limit has been raised (or removed) — clear all cost-limit markers.
          // Do NOT pre-set status: Running; the agent-run event flow sets status.
          delete (nextMetadata as { stopReason?: string }).stopReason;
          delete (nextMetadata as { stopCostUsd?: number }).stopCostUsd;
          delete (nextMetadata as { costLimitHit?: boolean }).costLimitHit;
        }

        // Always refresh the persisted effective limit for the new user message
        // so the stored value matches what the running agent is about to enforce.
        (
          nextMetadata as { effectiveCostLimitUsd?: number | null }
        ).effectiveCostLimitUsd = effectiveCostLimitUsd;

        if (nextStatus === ThreadStatus.Running) {
          // Compute the transition patch (sets runningStartedAt atomically alongside
          // status) and merge with metadata for a single DB round trip — avoids the
          // stale-drift window where status=Running but runningStartedAt=null.
          const patch = this.transitionService.computeTransition(
            existingThread,
            ThreadStatus.Running,
          );
          await this.threadsDao.updateById(
            existingThread.id,
            { ...patch, metadata: nextMetadata },
            em,
          );
        } else {
          // No status transition — only refresh metadata (e.g. cost-limit fields).
          await this.threadsDao.updateById(
            existingThread.id,
            { metadata: nextMetadata },
            em,
          );
        }
      });
    }

    // Why: capture eagerStartedAt before invokeAgent so the running timer
    // includes agent startup time (connection setup, queue drain, etc.) —
    // using new Date() after awaiting invokeAgent would undercount elapsed ms.
    const eagerStartedAt = new Date();
    const res = await trigger.invokeAgent(messages, {
      configurable: {
        thread_id: dto.threadSubId,
        async: dto.async,
        thread_metadata: dto.metadata,
        thread_created_by: userId,
        effective_cost_limit_usd: effectiveCostLimitUsd,
      },
    });

    const externalThreadId = res.threadId;

    // Strip reserved server-managed keys from client-supplied metadata so
    // clients cannot poison cost-limit state by sending these in dto.metadata.
    const {
      effectiveCostLimitUsd: _e,
      stopReason: _s,
      stopCostUsd: _c,
      costLimitHit: _h,
      ...clientMetadata
    } = dto.metadata ?? {};
    const initialMetadata: Record<string, unknown> = {
      ...clientMetadata,
      effectiveCostLimitUsd,
    };

    // Eagerly upsert the thread row so the frontend can immediately load it.
    // ThreadsService.upsertRunningThread merges only status/lastRunId/
    // updatedAt/runningStartedAt/totalRunningMs on conflict, so a concurrent
    // AgentInvokeNotificationHandler upsert and the upper transactional
    // metadata update both remain authoritative for their respective fields —
    // no PK race, no metadata stomp. eagerStartedAt seeds the runtime timer
    // so the running clock includes agent-startup time.
    await this.threadsService.upsertRunningThread({
      graphId,
      createdBy: userId,
      projectId: graph.projectId,
      externalThreadId,
      status: ThreadStatus.Running,
      runningStartedAt: eagerStartedAt,
      totalRunningMs: 0,
      metadata: initialMetadata,
    });

    return {
      externalThreadId,
      checkpointNs: res.checkpointNs,
    };
  }
}
