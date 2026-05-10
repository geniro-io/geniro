import { INestApplication } from '@nestjs/common';
import { BaseException } from '@packages/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { ReasoningEffort } from '../../../v1/agents/agents.types';
import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import {
  CreateGraphDto,
  UpdateGraphDto,
} from '../../../v1/graphs/dto/graphs.dto';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { createMockGraphData } from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import { createTestModule } from '../setup';

let contextDataStorage: AppContextStorage;

describe('Graph Preview Integration Tests', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let graphDao: GraphDao;
  const createdGraphIds: string[] = [];
  let testProjectId: string;

  const registerGraph = (graphId: string) => {
    if (!createdGraphIds.includes(graphId)) {
      createdGraphIds.push(graphId);
    }
  };

  const cleanupGraph = async (graphId: string) => {
    try {
      await graphsService.destroy(contextDataStorage, graphId);
    } catch (error: unknown) {
      if (
        !(error instanceof BaseException) ||
        (error.errorCode !== 'GRAPH_NOT_FOUND' &&
          error.errorCode !== 'GRAPH_NOT_RUNNING')
      ) {
        throw error;
      }
    }

    try {
      await graphsService.delete(contextDataStorage, graphId);
    } catch (error: unknown) {
      if (
        !(error instanceof BaseException) ||
        error.errorCode !== 'GRAPH_NOT_FOUND'
      ) {
        throw error;
      }
    }
  };

  beforeAll(async () => {
    app = await createTestModule();
    graphsService = app.get<GraphsService>(GraphsService);
    graphDao = app.get<GraphDao>(GraphDao);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;
  }, 60_000);

  afterEach(async () => {
    for (const graphId of createdGraphIds) {
      await cleanupGraph(graphId);
    }
    createdGraphIds.length = 0;
  }, 60_000);

  afterAll(async () => {
    if (testProjectId) {
      try {
        await app.get(ProjectsDao).deleteById(testProjectId);
      } catch {
        // best effort cleanup
      }
    }

    const suppressRedisClose = (reason: unknown) => {
      if (
        reason instanceof Error &&
        reason.message === 'Connection is closed.'
      ) {
        return;
      }
      throw reason;
    };
    process.on('unhandledRejection', suppressRedisClose);

    if (app) {
      await app.close();
    }

    process.removeListener('unhandledRejection', suppressRedisClose);
  }, 180_000);

  describe('getGraphsPreview', () => {
    it('should return preview data for all graphs', async () => {
      const graph = await graphsService.create(
        contextDataStorage,
        createMockGraphData({
          name: `Preview Test ${Date.now()}`,
          schema: {
            nodes: [
              {
                id: 'agent-1',
                template: 'simple-agent',
                config: {
                  name: 'My Agent',
                  description: 'Agent description',
                  instructions: 'You are a helpful agent',
                  invokeModelName: 'gpt-5-mini',
                  invokeModelReasoningEffort: ReasoningEffort.None,
                  summarizeMaxTokens: 272000,
                  summarizeKeepTokens: 30000,
                },
              },
              {
                id: 'trigger-1',
                template: 'manual-trigger',
                config: {},
              },
            ],
            edges: [{ from: 'trigger-1', to: 'agent-1' }],
          },
        }),
      );
      registerGraph(graph.id);

      const previews = await graphsService.getGraphsPreview(contextDataStorage);

      const preview = previews.find((p) => p.id === graph.id);
      expect(preview).toBeDefined();
      expect(preview!.name).toBe(graph.name);
      expect(preview!.status).toBe(GraphStatus.Created);
      expect(preview!.version).toBe('1.0.0');
      expect(preview!.targetVersion).toBe('1.0.0');
      expect(preview!.nodeCount).toBe(2);
      expect(preview!.edgeCount).toBe(1);
      expect(preview!.runningThreads).toBe(0);
      expect(preview!.totalThreads).toBe(0);

      // Verify agents are included
      expect(preview!.agents).toHaveLength(1);
      expect(preview!.agents[0]).toMatchObject({
        nodeId: 'agent-1',
        name: 'My Agent',
      });

      // Verify trigger nodes are included
      expect(preview!.triggerNodes).toHaveLength(1);
      expect(preview!.triggerNodes[0]).toMatchObject({
        id: 'trigger-1',
        template: 'manual-trigger',
      });

      // Verify timestamps are valid ISO strings
      expect(() => new Date(preview!.createdAt)).not.toThrow();
      expect(() => new Date(preview!.updatedAt)).not.toThrow();
    });

    it('should return preview without heavy schema/metadata columns', async () => {
      const graph = await graphsService.create(
        contextDataStorage,
        createMockGraphData({
          name: `Lightweight Preview ${Date.now()}`,
          metadata: {
            nodes: [
              { id: 'agent-1', name: 'Custom Agent Name', x: 100, y: 200 },
              { id: 'trigger-1', name: 'Custom Trigger', x: 300, y: 100 },
            ],
            zoom: 1.5,
          },
        }),
      );
      registerGraph(graph.id);

      const previews = await graphsService.getGraphsPreview(contextDataStorage);

      const preview = previews.find((p) => p.id === graph.id);
      expect(preview).toBeDefined();

      // Verify node display names are computed from metadata
      expect(preview!.nodeDisplayNames).toBeDefined();
      expect(preview!.nodeDisplayNames['agent-1']).toBe('Custom Agent Name');
      expect(preview!.nodeDisplayNames['trigger-1']).toBe('Custom Trigger');

      // Verify the preview does NOT include the raw schema or metadata
      // (these are not fields on GraphPreviewDto)
      const previewRecord = preview as unknown as Record<string, unknown>;
      expect(previewRecord.schema).toBeUndefined();
      expect(previewRecord.metadata).toBeUndefined();
    });

    it('should filter previews by IDs', async () => {
      const graph1 = await graphsService.create(
        contextDataStorage,
        createMockGraphData({ name: `Filter Test A ${Date.now()}` }),
      );
      registerGraph(graph1.id);

      const graph2 = await graphsService.create(
        contextDataStorage,
        createMockGraphData({ name: `Filter Test B ${Date.now()}` }),
      );
      registerGraph(graph2.id);

      const previews = await graphsService.getGraphsPreview(
        contextDataStorage,
        { ids: [graph1.id] },
      );

      const ids = previews.map((p) => p.id);
      expect(ids).toContain(graph1.id);
      expect(ids).not.toContain(graph2.id);
    });

    it('should return empty array when no graphs match', async () => {
      const previews = await graphsService.getGraphsPreview(
        contextDataStorage,
        { ids: ['00000000-0000-0000-0000-000000000099'] },
      );

      expect(previews).toEqual([]);
    });

    it('returns DTO costLimitUsd from graph.settings.costLimitUsd', async () => {
      const graph = await graphsService.create(
        contextDataStorage,
        createMockGraphData({ name: `CostLimit Preview ${Date.now()}` }),
      );
      registerGraph(graph.id);

      await graphsService.update(contextDataStorage, graph.id, {
        currentVersion: graph.version,
        costLimitUsd: 2.5,
      } as UpdateGraphDto);

      const previews = await graphsService.getGraphsPreview(
        contextDataStorage,
        {
          ids: [graph.id],
        },
      );

      expect(previews).toHaveLength(1);
      expect(previews[0]!.costLimitUsd).toBe(2.5);
    });
  });

  describe('GraphDao.getPreview', () => {
    it('should select only lightweight columns without schema/metadata/agents', async () => {
      const graph = await graphsService.create(
        contextDataStorage,
        createMockGraphData({ name: `DAO Preview ${Date.now()}` }),
      );
      registerGraph(graph.id);

      const rows = await graphDao.getPreview(
        { id: { $in: [graph.id] } },
        { orderBy: { updatedAt: 'DESC' } },
      );

      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.id).toBe(graph.id);
      expect(row.name).toBe(graph.name);
      expect(row.version).toBe('1.0.0');
      expect(row.status).toBe(GraphStatus.Created);

      // These heavy columns should NOT be loaded by getPreview
      const rowRecord = row as unknown as Record<string, unknown>;
      expect(rowRecord.schema).toBeUndefined();
      expect(rowRecord.metadata).toBeUndefined();
      expect(rowRecord.agents).toBeUndefined();
    });

    it('projects settings column including costLimitUsd', async () => {
      const graph = await graphsService.create(
        contextDataStorage,
        createMockGraphData({ name: `DAO Settings Preview ${Date.now()}` }),
      );
      registerGraph(graph.id);

      await graphsService.update(contextDataStorage, graph.id, {
        currentVersion: graph.version,
        costLimitUsd: 2.5,
      } as UpdateGraphDto);

      const result = await graphDao.getPreview({ id: graph.id });

      expect(result).toHaveLength(1);
      const row = result[0]!;
      expect(row.settings).toBeDefined();
      expect(row.settings.costLimitUsd).toBe(2.5);
    });
  });

  describe('GraphDao.getSchemaAndMetadata', () => {
    it('should return schema, metadata, and agents for given graph IDs', async () => {
      const graph = await graphsService.create(
        contextDataStorage,
        createMockGraphData({
          name: `SchemaMetadata Test ${Date.now()}`,
          metadata: {
            nodes: [{ id: 'agent-1', name: 'Named Agent' }],
          },
        }),
      );
      registerGraph(graph.id);

      const result = await graphDao.getSchemaAndMetadata([graph.id]);

      expect(result.size).toBe(1);
      const data = result.get(graph.id)!;
      expect(data.schema).toBeDefined();
      expect(data.schema.nodes).toHaveLength(2);
      expect(data.metadata).toBeDefined();
      expect(data.agents).toBeDefined();
    });

    it('should return empty map for empty input', async () => {
      const result = await graphDao.getSchemaAndMetadata([]);
      expect(result.size).toBe(0);
    });

    it('should return data for multiple graph IDs', async () => {
      const graph1 = await graphsService.create(
        contextDataStorage,
        createMockGraphData({ name: `SchemaMetadata Multi 1 ${Date.now()}` }),
      );
      registerGraph(graph1.id);

      const graph2 = await graphsService.create(
        contextDataStorage,
        createMockGraphData({ name: `SchemaMetadata Multi 2 ${Date.now()}` }),
      );
      registerGraph(graph2.id);

      const result = await graphDao.getSchemaAndMetadata([
        graph1.id,
        graph2.id,
      ]);

      expect(result.size).toBe(2);
      expect(result.get(graph1.id)).toBeDefined();
      expect(result.get(graph2.id)).toBeDefined();
    });
  });
});
