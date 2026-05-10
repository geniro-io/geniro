import { EntityManager, FilterQuery } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import {
  BadRequestException,
  DefaultLogger,
  NotFoundException,
} from '@packages/common';
import { UnrecoverableError } from 'bullmq';
import { compare, type Operation } from 'fast-json-patch';
import { isEqual } from 'lodash';
import { coerce, compare as compareSemver, inc } from 'semver';
import { setTimeout } from 'timers/promises';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { TemplateRegistry } from '../../graph-templates/services/template-registry';
import { LlmModelsService } from '../../litellm/services/llm-models.service';
import { NotificationEvent } from '../../notifications/notifications.types';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { ProjectsDao } from '../../projects/dao/projects.dao';
import { GraphDao } from '../dao/graph.dao';
import { GraphRevisionDao } from '../dao/graph-revision.dao';
import {
  GraphRevisionDto,
  GraphRevisionQueryDto,
} from '../dto/graph-revisions.dto';
import { GraphEntity } from '../entity/graph.entity';
import {
  type GraphRevisionConfig,
  GraphRevisionEntity,
} from '../entity/graph-revision.entity';
import {
  CompiledGraph,
  CompiledGraphNode,
  GraphEdgeSchemaType,
  GraphMetadataSchemaType,
  GraphNode,
  GraphNodeSchemaType,
  GraphRevisionStatus,
  GraphSchemaType,
  GraphStatus,
  NodeKind,
} from '../graphs.types';
import { extractAgentsFromSchema } from '../graphs.utils';
import { GraphCompiler } from './graph-compiler';
import { GraphMergeService } from './graph-merge.service';
import { GraphRegistry } from './graph-registry';
import {
  GraphRevisionJobData,
  GraphRevisionQueueService,
} from './graph-revision-queue.service';

@Injectable()
export class GraphRevisionService {
  private static readonly REVISION_RETENTION_LIMIT = 50;

  private readonly graphLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly logger: DefaultLogger,
    private readonly em: EntityManager,
    private readonly graphDao: GraphDao,
    private readonly graphRevisionDao: GraphRevisionDao,
    private readonly notificationsService: NotificationsService,
    private readonly graphCompiler: GraphCompiler,
    private readonly graphMergeService: GraphMergeService,
    private readonly graphRegistry: GraphRegistry,
    private readonly graphRevisionQueue: GraphRevisionQueueService,
    private readonly templateRegistry: TemplateRegistry,
    private readonly llmModelsService: LlmModelsService,
    private readonly projectsDao: ProjectsDao,
  ) {
    this.graphRevisionQueue.setProcessor(this.applyRevision.bind(this));
  }

  async queueRevision(
    ctx: AppContextStorage,
    graph: GraphEntity,
    baseVersion: string,
    clientConfig: GraphRevisionConfig,
    entityManager?: EntityManager,
    options?: { enqueueImmediately?: boolean },
  ): Promise<GraphRevisionDto & { entity: GraphRevisionEntity }> {
    const userId = ctx.checkSub();

    const txFn = async (em: EntityManager) => {
      const { headVersion, headSchema } = await this.resolveHeadSchema(
        graph,
        em,
      );
      const baseSchema = await this.resolveBaseSchema(graph, baseVersion, em);

      const { headConfig, baseConfig } = await this.resolveConfigs(
        graph,
        baseVersion,
        headVersion,
        em,
      );

      // Schema is always part of config; validate the incoming schema
      this.graphCompiler.validateSchema(clientConfig.schema);

      const mergedSchema = this.mergeAndValidateSchemas(
        baseSchema,
        headSchema,
        clientConfig.schema,
        baseVersion,
        headVersion,
      );

      this.graphCompiler.validateSchema(mergedSchema);

      const mergedConfig: GraphRevisionConfig = {
        ...this.mergeGraphFields(
          baseConfig,
          headConfig,
          clientConfig,
          baseVersion,
          headVersion,
        ),
        schema: mergedSchema,
      };

      const configDiff = compare(headConfig, mergedConfig);

      if (configDiff.length === 0) {
        throw new BadRequestException(
          'REVISION_WITHOUT_CHANGES',
          'Submitted update has no changes compared to current graph version',
          { baseVersion, headVersion },
        );
      }

      const newVersion = this.generateNextVersion(headVersion);

      const revision = await this.graphRevisionDao.create(
        {
          graphId: graph.id,
          baseVersion,
          toVersion: newVersion,
          configDiff,
          clientConfig,
          newConfig: mergedConfig,
          status: GraphRevisionStatus.Pending,
          createdBy: userId,
        },
        em,
      );

      await this.graphDao.updateById(
        graph.id,
        { targetVersion: newVersion },
        em,
      );

      return revision;
    };

    // If an outer entityManager is provided, run within it; otherwise create a new transaction
    const revision = entityManager
      ? await txFn(entityManager)
      : await this.em.transactional(txFn);

    // Emit notification only when queueRevision owns the transaction (no outer entityManager).
    // When called within an outer transaction, the caller is responsible for emitting
    // after their transaction commits — otherwise the enrichment handler may query
    // uncommitted data and fail silently.
    if (!entityManager) {
      await this.notificationsService.emit({
        type: NotificationEvent.GraphRevisionCreate,
        graphId: graph.id,
        data: revision,
      });
    }

    const response = { ...this.prepareResponse(revision), entity: revision };

    const shouldEnqueue = options?.enqueueImmediately ?? true;
    if (shouldEnqueue) {
      await this.graphRevisionQueue.addRevision({
        id: revision.id,
        graphId: revision.graphId,
      });
    }

    return response;
  }

  async enqueueRevisionProcessing(
    revision: Pick<GraphRevisionDto, 'id' | 'graphId'>,
  ): Promise<void> {
    await this.graphRevisionQueue.addRevision(revision);
  }

  private mergeAndValidateSchemas(
    baseSchema: GraphSchemaType,
    headSchema: GraphSchemaType,
    clientSchema: GraphSchemaType,
    baseVersion: string,
    headVersion: string,
  ): GraphSchemaType {
    const mergeResult = this.graphMergeService.mergeSchemas(
      baseSchema,
      headSchema,
      clientSchema,
    );

    if (!mergeResult.success) {
      throw new BadRequestException(
        'MERGE_CONFLICT',
        'Cannot merge changes due to conflicts',
        { conflicts: mergeResult.conflicts, headVersion },
      );
    }

    if (!mergeResult.mergedSchema) {
      throw new BadRequestException(
        'MERGE_FAILED',
        'Merge succeeded but produced no schema',
        { baseVersion, headVersion },
      );
    }

    return mergeResult.mergedSchema;
  }

  private async resolveHeadSchema(
    graph: GraphEntity,
    entityManager: EntityManager,
  ): Promise<{ headVersion: string; headSchema: GraphSchemaType }> {
    const headVersion = graph.targetVersion;

    if (headVersion === graph.version) {
      return { headVersion, headSchema: graph.schema };
    }

    const headRevision = await this.getSchemaAtVersion(
      graph.id,
      headVersion,
      entityManager,
    );

    if (!headRevision) {
      this.logger.warn(
        `Could not find revision at targetVersion ${headVersion}, falling back to current schema`,
      );
      return { headVersion, headSchema: graph.schema };
    }

    return { headVersion, headSchema: headRevision.newConfig.schema };
  }

  private async resolveBaseSchema(
    graph: GraphEntity,
    baseVersion: string,
    entityManager: EntityManager,
  ): Promise<GraphSchemaType> {
    if (baseVersion === graph.version) {
      return graph.schema;
    }

    const baseRevision = await this.getSchemaAtVersion(
      graph.id,
      baseVersion,
      entityManager,
    );

    if (!baseRevision) {
      throw new BadRequestException(
        'VERSION_NOT_FOUND',
        `Base version ${baseVersion} not found. Please refresh and retry.`,
      );
    }

    return baseRevision.newConfig.schema;
  }

  private async getSchemaAtVersion(
    graphId: string,
    version: string,
    txEm?: EntityManager,
  ): Promise<GraphRevisionEntity | null> {
    const revision = await this.graphRevisionDao.getOne(
      { graphId, toVersion: version },
      undefined,
      txEm,
    );

    return revision || null;
  }

  private getConfigFromGraph(graph: GraphEntity): GraphRevisionConfig {
    return {
      schema: graph.schema,
      name: graph.name,
      description: graph.description ?? null,
      temporary: graph.temporary,
    };
  }

  private getConfigFromRevision(
    revision: GraphRevisionEntity,
  ): GraphRevisionConfig {
    return revision.newConfig;
  }

  private async resolveConfigs(
    graph: GraphEntity,
    baseVersion: string,
    headVersion: string,
    entityManager: EntityManager,
  ): Promise<{
    headConfig: GraphRevisionConfig;
    baseConfig: GraphRevisionConfig;
  }> {
    let headConfig = this.getConfigFromGraph(graph);
    if (headVersion !== graph.version) {
      const headRevision = await this.getSchemaAtVersion(
        graph.id,
        headVersion,
        entityManager,
      );
      if (headRevision) {
        headConfig = this.getConfigFromRevision(headRevision);
      }
    }

    if (baseVersion === graph.version) {
      return { headConfig, baseConfig: this.getConfigFromGraph(graph) };
    }

    const baseRevision = await this.getSchemaAtVersion(
      graph.id,
      baseVersion,
      entityManager,
    );
    if (!baseRevision) {
      throw new BadRequestException(
        'VERSION_NOT_FOUND',
        `Base version ${baseVersion} not found. Please refresh and retry.`,
      );
    }

    return { headConfig, baseConfig: this.getConfigFromRevision(baseRevision) };
  }

  private mergeGraphFields(
    base: GraphRevisionConfig,
    head: GraphRevisionConfig,
    client: GraphRevisionConfig,
    baseVersion: string,
    headVersion: string,
  ): Omit<GraphRevisionConfig, 'schema'> {
    const merged: Omit<GraphRevisionConfig, 'schema'> = {
      name: head.name,
      description: head.description,
      temporary: head.temporary,
    };

    const conflicts: {
      field: keyof Omit<GraphRevisionConfig, 'schema'>;
      base: unknown;
      head: unknown;
      client: unknown;
    }[] = [];

    const fields: (keyof Omit<GraphRevisionConfig, 'schema'>)[] = [
      'name',
      'description',
      'temporary',
    ];

    for (const field of fields) {
      const baseVal = base[field];
      const headVal = head[field];
      const clientVal = client[field];

      if (isEqual(headVal, baseVal)) {
        merged[field] = clientVal as never;
        continue;
      }

      if (isEqual(clientVal, baseVal)) {
        merged[field] = headVal as never;
        continue;
      }

      if (isEqual(clientVal, headVal)) {
        merged[field] = headVal as never;
        continue;
      }

      conflicts.push({
        field,
        base: baseVal,
        head: headVal,
        client: clientVal,
      });
    }

    if (conflicts.length > 0) {
      throw new BadRequestException(
        'MERGE_CONFLICT',
        'Cannot merge graph updates due to conflicts',
        { conflicts, headVersion, baseVersion },
      );
    }

    return merged;
  }

  /**
   * Re-merges revision's client changes against current graph head if needed.
   * Updates revision entity in-place with the re-merged schema and diff.
   */
  private async reMergeRevisionIfNeeded(
    revision: GraphRevisionEntity,
    graph: GraphEntity,
    baseSchemaCache: GraphSchemaType | null,
    baseConfigCache: GraphRevisionConfig | null,
    entityManager: EntityManager,
  ): Promise<void> {
    const currentHead = graph.schema;
    const headHasChanged = graph.version !== revision.baseVersion;
    const currentHeadConfig = this.getConfigFromGraph(graph);

    // No re-merge needed if head hasn't changed since the revision was queued
    if (!headHasChanged) {
      const next = revision.newConfig;
      this.graphCompiler.validateSchema(next.schema);
      await this.updateRevisionConfig(
        revision,
        next,
        currentHeadConfig,
        entityManager,
      );

      return;
    }

    // Re-merge client changes against new head
    const nextBaseConfig = baseConfigCache;
    const baseSchema = baseSchemaCache ?? nextBaseConfig?.schema ?? null;

    if (!nextBaseConfig || !baseSchema) {
      throw new BadRequestException(
        'REVISION_BASE_UNAVAILABLE',
        `Cannot re-merge revision: base version ${revision.baseVersion} is no longer available. ` +
          `Please create a new revision from the current version.`,
      );
    }

    const reMergedSchema = this.mergeAndValidateSchemas(
      baseSchema,
      currentHead,
      revision.clientConfig.schema,
      revision.baseVersion,
      graph.version,
    );

    const reMergedFields = this.mergeGraphFields(
      nextBaseConfig,
      currentHeadConfig,
      revision.clientConfig,
      revision.baseVersion,
      graph.version,
    );

    const reMergedConfig: GraphRevisionConfig = {
      ...reMergedFields,
      schema: reMergedSchema,
    };

    this.graphCompiler.validateSchema(reMergedConfig.schema);
    await this.updateRevisionConfig(
      revision,
      reMergedConfig,
      currentHeadConfig,
      entityManager,
    );
  }

  private async updateRevisionConfig(
    revision: GraphRevisionEntity,
    newConfig: GraphRevisionConfig,
    currentHeadConfig: GraphRevisionConfig,
    entityManager: EntityManager,
  ): Promise<void> {
    const diff = compare(currentHeadConfig, newConfig);
    await this.graphRevisionDao.updateById(
      revision.id,
      { newConfig, configDiff: diff },
      entityManager,
    );

    revision.newConfig = newConfig;
    revision.configDiff = diff;
  }

  private async finalizeAppliedRevision(
    graph: GraphEntity,
    revision: GraphRevisionEntity,
    entityManager: EntityManager,
  ): Promise<void> {
    // Invariant repair: ensure targetVersion never falls behind version.
    // If targetVersion is corrupted (or legacy), bump it up to at least the applied version.
    const targetVersion = this.isVersionLess(
      graph.targetVersion,
      revision.toVersion,
    )
      ? revision.toVersion
      : graph.targetVersion;

    // Only update schema and version fields from the revision.
    // name, description, and temporary are managed synchronously (applied
    // immediately during the update call) and must not be overwritten here
    // with potentially stale revision-snapshot values.
    const graphUpdates: Partial<GraphEntity> = {
      schema: revision.newConfig.schema,
      version: revision.toVersion,
      targetVersion,
      agents: extractAgentsFromSchema(
        revision.newConfig.schema,
        this.templateRegistry,
      ),
    };

    await this.graphDao.updateById(
      revision.graphId,
      graphUpdates,
      entityManager,
    );

    await this.graphRevisionDao.updateById(
      revision.id,
      { status: GraphRevisionStatus.Applied },
      entityManager,
    );

    await this.pruneOldRevisions(graph.id, entityManager);
  }

  private async applyRevision(job: GraphRevisionJobData): Promise<void> {
    const graphId = job.graphId;
    const previousLock = this.graphLocks.get(graphId) ?? Promise.resolve();

    let releaseLock: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.graphLocks.set(graphId, currentLock);

    try {
      await previousLock;
      await this.processRevision(job);
    } finally {
      releaseLock!();
      if (this.graphLocks.get(graphId) === currentLock) {
        this.graphLocks.delete(graphId);
      }
    }
  }

  private async processRevision(job: GraphRevisionJobData): Promise<void> {
    const revision = await this.graphRevisionDao.getById(job.revisionId);
    if (!revision) {
      throw new NotFoundException('GRAPH_REVISION_NOT_FOUND');
    }

    // If revision is already "Applying", this is a retry after server crash/disconnect.
    // BullMQ automatically retries jobs that weren't acknowledged.
    // We just continue with the work - the transaction will be idempotent or handle the state.
    if (revision.status === GraphRevisionStatus.Pending) {
      // Mark as "Applying" OUTSIDE the transaction so observers can see it in real-time.
      // The UoW path keeps the in-memory `revision` in sync with the DB write,
      // so the notification (which requires `instanceof GraphRevisionEntity`)
      // can emit the same entity reference.
      await this.graphRevisionDao.updateById(revision.id, {
        status: GraphRevisionStatus.Applying,
      });

      await this.notificationsService.emit({
        type: NotificationEvent.GraphRevisionApplying,
        graphId: revision.graphId,
        data: revision,
      });
    }

    const baseRevisionCache = await this.fetchBaseRevisionCache(revision);
    const baseSchemaCache = baseRevisionCache?.newConfig.schema ?? null;
    const baseConfigCache = baseRevisionCache?.newConfig ?? null;

    try {
      await this.applyRevisionTransaction(
        revision,
        baseSchemaCache,
        baseConfigCache,
      );
    } catch (error) {
      await this.handleRevisionFailure(revision, error as Error);
      this.rethrowIfUnrecoverable(error as Error, revision.id);
      throw error;
    }
  }

  private async fetchBaseRevisionCache(
    revision: GraphRevisionEntity,
  ): Promise<GraphRevisionEntity | null> {
    return this.getSchemaAtVersion(revision.graphId, revision.baseVersion);
  }

  private async applyRevisionTransaction(
    revision: GraphRevisionEntity,
    baseSchemaCache: GraphSchemaType | null,
    baseConfigCache: GraphRevisionConfig | null,
  ): Promise<void> {
    // The revision worker runs concurrently with HTTP requests and other
    // BullMQ workers. MikroORM v7's `em.transactional` does NOT fork the EM
    // by default — it binds an async context to the global EM, so concurrent
    // hydrations leak into each other's identity maps. Without `clear: true`,
    // entities loaded by an HTTP request mid-flight can appear as "new" to
    // the worker's flush and trigger PK conflicts. Each phase clears.
    // Phase 1: Short DB transaction -- re-merge and validate only
    await this.em.transactional(
      async (em) => {
        const graph = await this.graphDao.getOne(
          { id: revision.graphId },
          undefined,
          em,
        );

        if (!graph) {
          throw new NotFoundException('GRAPH_NOT_FOUND');
        }

        await this.reMergeRevisionIfNeeded(
          revision,
          graph,
          baseSchemaCache,
          baseConfigCache,
          em,
        );
      },
      { clear: true },
    );

    // Phase 2: Live update OUTSIDE transaction (no DB lock held)
    const compiledGraph = this.graphRegistry.get(revision.graphId);
    await this.waitForGraphCompilationIfNeeded(compiledGraph);
    const shouldApplyLive = compiledGraph?.status === GraphStatus.Running;

    if (shouldApplyLive && compiledGraph) {
      const graph = await this.graphDao.getOne({ id: revision.graphId });
      if (!graph) {
        throw new NotFoundException('GRAPH_NOT_FOUND');
      }
      await this.applyLiveUpdate(graph, revision, compiledGraph);
    }

    // Phase 3: Short DB transaction to finalize
    await this.em.transactional(
      async (em) => {
        const graph = await this.graphDao.getOne(
          { id: revision.graphId },
          undefined,
          em,
        );

        if (!graph) {
          throw new NotFoundException('GRAPH_NOT_FOUND');
        }

        await this.finalizeAppliedRevision(graph, revision, em);
      },
      { clear: true },
    );

    // Emit after Phase 3 transaction commits so the enrichment handler
    // can read the committed Applied status from the database.
    revision.status = GraphRevisionStatus.Applied;
    await this.notificationsService.emit({
      type: NotificationEvent.GraphRevisionApplied,
      graphId: revision.graphId,
      data: revision,
    });
  }

  private async waitForGraphCompilationIfNeeded(
    compiledGraph: CompiledGraph | null | undefined,
  ): Promise<void> {
    if (!compiledGraph || compiledGraph.status !== GraphStatus.Compiling) {
      return;
    }

    const startTime = Date.now();

    while (Date.now() - startTime < 180_000) {
      if (compiledGraph.status !== GraphStatus.Compiling) {
        return;
      }
      await setTimeout(5_000);
    }

    throw new Error(
      `Graph compilation did not complete within 3 minutes. Cannot safely apply revision while graph is still compiling.`,
    );
  }

  private async handleRevisionFailure(
    revision: GraphRevisionEntity,
    error: Error,
  ): Promise<void> {
    this.logger.error(error, `Failed to apply graph revision ${revision.id}`);

    await this.em.transactional(
      async (em) => {
        await this.resetTargetVersionIfNeeded(revision, em);
        await this.markRevisionAsFailed(revision, error, em);
      },
      { clear: true },
    );

    const compiledGraph = this.graphRegistry.get(revision.graphId);
    if (compiledGraph && compiledGraph.status === GraphStatus.Running) {
      try {
        await this.graphRegistry.destroy(revision.graphId);
        await this.graphDao.updateById(revision.graphId, {
          status: GraphStatus.Error,
          error: `Graph stopped due to failed revision ${revision.toVersion}: ${error.message}`,
        });
        await this.notificationsService.emit({
          type: NotificationEvent.Graph,
          graphId: revision.graphId,
          data: { status: GraphStatus.Error },
        });
      } catch (stopError) {
        this.logger.error(
          stopError as Error,
          `Failed to stop graph ${revision.graphId} after revision failure`,
        );
      }
    }

    revision.status = GraphRevisionStatus.Failed;
    revision.error = error.message;
    await this.notificationsService.emit({
      type: NotificationEvent.GraphRevisionFailed,
      graphId: revision.graphId,
      data: revision,
    });
  }

  private async resetTargetVersionIfNeeded(
    revision: GraphRevisionEntity,
    entityManager: EntityManager,
  ): Promise<void> {
    const graph = await this.graphDao.getOne(
      { id: revision.graphId },
      undefined,
      entityManager,
    );

    if (graph && graph.targetVersion === revision.toVersion) {
      await this.graphDao.updateById(
        graph.id,
        { targetVersion: graph.version },
        entityManager,
      );
    }
  }

  private async markRevisionAsFailed(
    revision: GraphRevisionEntity,
    error: Error,
    entityManager: EntityManager,
  ): Promise<void> {
    await this.graphRevisionDao.updateById(
      revision.id,
      { status: GraphRevisionStatus.Failed, error: error.message },
      entityManager,
    );
  }

  private rethrowIfUnrecoverable(error: Error, revisionId: string): void {
    if (
      error instanceof BadRequestException ||
      error instanceof NotFoundException
    ) {
      throw new UnrecoverableError(
        `Graph revision ${revisionId} failed with unrecoverable error: ${error.message}`,
      );
    }
  }

  private async applyLiveUpdate(
    graph: GraphEntity,
    revision: GraphRevisionEntity,
    compiledGraph: CompiledGraph,
  ): Promise<void> {
    // Read name/temporary from the graph entity (source of truth for sync fields)
    // rather than from the revision snapshot which may be stale.
    const project = await this.projectsDao.getOne({
      id: graph.projectId,
      createdBy: graph.createdBy,
    });
    const llmRequestContext =
      await this.llmModelsService.buildLLMRequestContext(
        graph.createdBy,
        project?.settings,
      );
    const metadata = {
      graphId: graph.id,
      name: graph.name,
      version: revision.toVersion,
      temporary: graph.temporary,
      graph_created_by: graph.createdBy,
      graph_project_id: graph.projectId,
      llmRequestContext,
    };

    compiledGraph.metadata = metadata;

    const oldNodeIds = new Set(compiledGraph.nodes.keys());
    const newNodeIds = new Set(
      revision.newConfig.schema.nodes.map((n: GraphNodeSchemaType) => n.id),
    );

    // Remove deleted nodes
    await this.removeDeletedNodes(compiledGraph, oldNodeIds, newNodeIds);

    // Update edges in compiled graph
    const oldEdges = compiledGraph.edges;
    const newEdges = revision.newConfig.schema.edges || [];
    compiledGraph.edges = newEdges;

    // Calculate which nodes need rebuilding
    const nodesToRebuild = this.calculateNodesToRebuild(
      revision.newConfig.schema.nodes,
      compiledGraph,
      oldEdges,
      newEdges,
    );

    // Expand to include dependent nodes
    this.expandToIncludeDependents(nodesToRebuild, newEdges);

    // Rebuild nodes in topological order
    const buildOrder = this.graphCompiler.getBuildOrder(
      revision.newConfig.schema,
    );
    await this.rebuildNodes(
      buildOrder,
      compiledGraph,
      nodesToRebuild,
      metadata,
      newEdges,
      { revisionId: revision.id, toVersion: revision.toVersion },
    );
  }

  private async removeDeletedNodes(
    compiledGraph: CompiledGraph,
    oldNodeIds: Set<string>,
    newNodeIds: Set<string>,
  ): Promise<void> {
    for (const nodeId of oldNodeIds) {
      if (!newNodeIds.has(nodeId)) {
        const node = compiledGraph.nodes.get(nodeId);
        if (node) {
          try {
            await this.graphCompiler.destroyNode(node);
          } catch (error) {
            this.logger.error(
              error as Error,
              `Failed to destroy node ${nodeId} during live update`,
            );
          }
        }
        compiledGraph.nodes.delete(nodeId);
        compiledGraph.state.unregisterNode(nodeId);
      }
    }
  }

  private calculateNodesToRebuild(
    newNodeSchemas: GraphNodeSchemaType[],
    compiledGraph: CompiledGraph,
    oldEdges: GraphEdgeSchemaType[],
    newEdges: GraphEdgeSchemaType[],
  ): Set<string> {
    const nodesToRebuild = new Set<string>();

    for (const nodeSchema of newNodeSchemas) {
      const existingNode = compiledGraph.nodes.get(nodeSchema.id);

      const validatedNewConfig = this.templateRegistry.validateTemplateConfig(
        nodeSchema.template,
        nodeSchema.config,
      );
      const configChanged =
        !existingNode || !isEqual(existingNode.config, validatedNewConfig);

      const edgesChanged = this.haveEdgesChanged(
        nodeSchema.id,
        oldEdges,
        newEdges,
      );

      if (configChanged || edgesChanged) {
        nodesToRebuild.add(nodeSchema.id);
      }
    }

    return nodesToRebuild;
  }

  private haveEdgesChanged(
    nodeId: string,
    oldEdges: GraphEdgeSchemaType[],
    newEdges: GraphEdgeSchemaType[],
  ): boolean {
    const oldIncoming = oldEdges.filter((e) => e.to === nodeId);
    const oldOutgoing = oldEdges.filter((e) => e.from === nodeId);
    const newIncoming = newEdges.filter((e) => e.to === nodeId);
    const newOutgoing = newEdges.filter((e) => e.from === nodeId);

    return (
      !isEqual(oldIncoming, newIncoming) || !isEqual(oldOutgoing, newOutgoing)
    );
  }

  private expandToIncludeDependents(
    nodesToRebuild: Set<string>,
    edges: GraphEdgeSchemaType[],
  ): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) {
        if (nodesToRebuild.has(edge.to) && !nodesToRebuild.has(edge.from)) {
          nodesToRebuild.add(edge.from);
          changed = true;
        }
      }
    }
  }

  private async rebuildNodes(
    buildOrder: GraphNodeSchemaType[],
    compiledGraph: CompiledGraph,
    nodesToRebuild: Set<string>,
    metadata: GraphMetadataSchemaType,
    edges: GraphEdgeSchemaType[],
    revisionContext?: { revisionId: string; toVersion: string },
  ): Promise<void> {
    const totalNodes = nodesToRebuild.size;
    let currentNode = 0;

    for (const nodeSchema of buildOrder) {
      if (!nodesToRebuild.has(nodeSchema.id)) {
        continue;
      }

      const existingNode = compiledGraph.nodes.get(nodeSchema.id);

      const { template, validatedConfig, init } =
        this.graphCompiler.prepareNode(
          nodeSchema,
          compiledGraph.nodes,
          metadata,
          edges,
        );

      if (!existingNode) {
        compiledGraph.state.registerNode(nodeSchema.id);
      }

      currentNode++;

      if (revisionContext) {
        await this.notificationsService.emit({
          type: NotificationEvent.GraphRevisionProgress,
          graphId: metadata.graphId,
          data: {
            revisionId: revisionContext.revisionId,
            graphId: metadata.graphId,
            toVersion: revisionContext.toVersion,
            currentNode,
            totalNodes,
            nodeId: nodeSchema.id,
            phase: 'rebuilding',
          },
        });
      }

      const reconfigured = await this.tryReconfigureInPlace(
        existingNode,
        nodeSchema,
        init,
        validatedConfig,
        compiledGraph,
      );

      if (!reconfigured) {
        // Reconfigure failed or node is new - recreate from scratch
        await this.recreateNode(
          existingNode,
          nodeSchema,
          template,
          validatedConfig,
          init,
          compiledGraph,
        );
      }

      if (revisionContext) {
        await this.notificationsService.emit({
          type: NotificationEvent.GraphRevisionProgress,
          graphId: metadata.graphId,
          data: {
            revisionId: revisionContext.revisionId,
            graphId: metadata.graphId,
            toVersion: revisionContext.toVersion,
            currentNode,
            totalNodes,
            nodeId: nodeSchema.id,
            phase: 'completed',
          },
        });
      }
    }
  }

  private async tryReconfigureInPlace(
    existingNode: CompiledGraphNode | undefined,
    nodeSchema: GraphNodeSchemaType,
    init: GraphNode<unknown>,
    validatedConfig: unknown,
    compiledGraph: CompiledGraph,
  ): Promise<boolean> {
    if (!existingNode || existingNode.template !== nodeSchema.template) {
      return false;
    }

    // Runtime nodes manage external resources (containers, networks, etc). For these,
    // live revisions should rebuild from scratch instead of in-place reconfigure.
    if (existingNode.type === NodeKind.Runtime) {
      return false;
    }

    try {
      await existingNode.handle.configure(init, existingNode.instance);
      existingNode.config = validatedConfig;
      compiledGraph.nodes.set(nodeSchema.id, existingNode);
      compiledGraph.state.attachGraphNode(nodeSchema.id, existingNode);
      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `In-place reconfigure failed for node ${nodeSchema.id}, will recreate: ${errorMessage}`,
      );
      return false;
    }
  }

  private async recreateNode(
    existingNode: CompiledGraphNode | undefined,
    nodeSchema: GraphNodeSchemaType,
    template: NonNullable<ReturnType<typeof this.templateRegistry.getTemplate>>,
    validatedConfig: unknown,
    init: GraphNode<unknown>,
    compiledGraph: CompiledGraph,
  ): Promise<void> {
    if (existingNode) {
      await this.graphCompiler.destroyNode(existingNode);
    }

    const { handle, instance } =
      await this.graphCompiler.createAndConfigureHandle(
        template,
        validatedConfig,
        init,
      );

    const compiledNode: CompiledGraphNode = {
      id: nodeSchema.id,
      type: template.kind,
      template: nodeSchema.template,
      handle,
      instance,
      config: validatedConfig,
    };

    compiledGraph.nodes.set(nodeSchema.id, compiledNode);
    compiledGraph.state.attachGraphNode(nodeSchema.id, compiledNode);
  }

  private async pruneOldRevisions(
    graphId: string,
    txEm: EntityManager,
  ): Promise<void> {
    try {
      const revisionsToKeep = await this.graphRevisionDao.getAll(
        { graphId },
        {
          fields: ['id'],
          orderBy: { createdAt: 'DESC' },
          limit: GraphRevisionService.REVISION_RETENTION_LIMIT,
        },
        txEm,
      );

      const keepIds = revisionsToKeep.map((r) => r.id);

      if (keepIds.length < GraphRevisionService.REVISION_RETENTION_LIMIT) {
        return;
      }

      await this.graphRevisionDao.hardDelete(
        { graphId, id: { $nin: keepIds } },
        txEm,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to prune old revisions for graph ${graphId}: ${(error as Error).message}`,
      );
    }
  }

  public prepareResponse(entity: GraphRevisionEntity): GraphRevisionDto {
    return {
      ...entity,
      error: entity.error ?? undefined,
      configDiff: entity.configDiff as GraphRevisionDto['configDiff'],
      createdAt: new Date(entity.createdAt).toISOString(),
      updatedAt: new Date(entity.updatedAt).toISOString(),
    };
  }

  private normalizeVersion(version: string): string {
    const coerced = coerce(version);
    return coerced?.version ?? version;
  }

  public isVersionLess(a: string, b: string): boolean {
    const av = coerce(a)?.version;
    const bv = coerce(b)?.version;
    if (!av || !bv) {
      return false;
    }
    return compareSemver(av, bv) === -1;
  }

  public generateNextVersion(currentVersion: string): string {
    const normalized = this.normalizeVersion(currentVersion);
    const next = inc(normalized, 'patch');

    if (next) {
      return next;
    }

    // Fallback: manual increment if semver fails
    const parts = normalized
      .split('.')
      .map((part) => (Number.isNaN(Number(part)) ? 0 : parseInt(part, 10)));

    const lastIndex = Math.max(parts.length - 1, 0);
    parts[lastIndex] = (parts[lastIndex] ?? 0) + 1;
    return parts.join('.');
  }

  async getRevisions(
    ctx: AppContextStorage,
    graphId: string,
    query: GraphRevisionQueryDto,
  ): Promise<GraphRevisionDto[]> {
    const userId = ctx.checkSub();
    const where: FilterQuery<GraphRevisionEntity> = {
      graphId,
      createdBy: userId,
    };

    if (query.status) {
      where.status = query.status;
    }

    const revisions = await this.graphRevisionDao.getAll(where, {
      orderBy: { createdAt: 'DESC' },
      ...(typeof query.limit === 'number' ? { limit: query.limit } : {}),
    });

    return revisions.map(this.prepareResponse.bind(this));
  }

  async getRevisionById(
    ctx: AppContextStorage,
    graphId: string,
    revisionId: string,
  ): Promise<GraphRevisionDto> {
    const userId = ctx.checkSub();
    const revision = await this.graphRevisionDao.getOne({
      id: revisionId,
      graphId,
      createdBy: userId,
    });

    if (!revision) {
      throw new NotFoundException('GRAPH_REVISION_NOT_FOUND');
    }

    return this.prepareResponse(revision);
  }
}
