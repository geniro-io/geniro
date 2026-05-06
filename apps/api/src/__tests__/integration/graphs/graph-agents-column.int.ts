import { INestApplication } from '@nestjs/common';
import { BaseException } from '@packages/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { ReasoningEffort } from '../../../v1/agents/agents.types';
import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import { CreateGraphDto } from '../../../v1/graphs/dto/graphs.dto';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { GraphRevisionService } from '../../../v1/graphs/services/graph-revision.service';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import {
  createMockGraphData,
  waitForCondition,
} from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import { createTestModule } from '../setup';

let contextDataStorage: AppContextStorage;

describe('Graph Agents Column Integration Tests', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let graphDao: GraphDao;
  let threadsService: ThreadsService;
  let threadsDao: ThreadsDao;
  let graphRevisionService: GraphRevisionService;
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
    threadsService = app.get<ThreadsService>(ThreadsService);
    threadsDao = app.get<ThreadsDao>(ThreadsDao);
    graphRevisionService = app.get<GraphRevisionService>(GraphRevisionService);

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
    // Allow in-flight async operations (e.g. checkpoint writes from async trigger
    // executions) to settle before closing the DB connection pool.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (app) {
      await app.close();
    }
  }, 60_000);

  describe('graph create populates agents', () => {
    it('should populate agents column with simple-agent nodes on creation', async () => {
      const graphData = createMockGraphData({
        name: `Agents Column Test ${Date.now()}`,
        schema: {
          nodes: [
            {
              id: 'agent-1',
              template: 'simple-agent',
              config: {
                name: 'My Agent',
                description: 'A test agent',
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
      });

      const graph = await graphsService.create(contextDataStorage, graphData);
      registerGraph(graph.id);

      // Fetch the raw entity to check the agents column
      const entity = await graphDao.getOne({ id: graph.id });
      expect(entity).toBeDefined();
      expect(entity!.agents).toBeDefined();
      expect(entity!.agents).toHaveLength(1);
      expect(entity!.agents![0]).toMatchObject({
        nodeId: 'agent-1',
        name: 'My Agent',
        description: 'A test agent',
      });
    });

    it('should populate agents with multiple agent nodes', async () => {
      const graphData = createMockGraphData({
        name: `Multi-Agent Column Test ${Date.now()}`,
        schema: {
          nodes: [
            {
              id: 'agent-1',
              template: 'simple-agent',
              config: {
                name: 'Agent Alpha',
                description: 'First agent',
                instructions: 'You are the first agent',
                invokeModelName: 'gpt-5-mini',
                invokeModelReasoningEffort: ReasoningEffort.None,
                summarizeMaxTokens: 272000,
                summarizeKeepTokens: 30000,
              },
            },
            {
              id: 'agent-2',
              template: 'simple-agent',
              config: {
                name: 'Agent Beta',
                instructions: 'You are the second agent',
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
          edges: [
            { from: 'trigger-1', to: 'agent-1' },
            { from: 'trigger-1', to: 'agent-2' },
          ],
        },
      });

      const graph = await graphsService.create(contextDataStorage, graphData);
      registerGraph(graph.id);

      const entity = await graphDao.getOne({ id: graph.id });
      expect(entity).toBeDefined();
      expect(entity!.agents).toHaveLength(2);

      const agentNames = entity!.agents!.map((a) => a.name).sort();
      expect(agentNames).toEqual(['Agent Alpha', 'Agent Beta']);

      // Agent Beta has no explicit description, but createMockGraphData merges
      // the base config which includes a default description.
      const agentBeta = entity!.agents!.find((a) => a.name === 'Agent Beta');
      expect(agentBeta!.description).toBe('Test agent description');
    });

    it('should reject graph creation when manual-trigger has no agent connection', async () => {
      // A manual-trigger requires at least one connection to a simpleAgent kind node.
      // Creating a graph without that connection should fail validation.
      const graphData: CreateGraphDto = {
        name: `No-Agent Graph ${Date.now()}`,
        description: 'Graph without any agent nodes',
        temporary: true,
        schema: {
          nodes: [
            {
              id: 'trigger-1',
              template: 'manual-trigger',
              config: {},
            },
          ],
          edges: [],
        },
      };

      await expect(
        graphsService.create(contextDataStorage, graphData),
      ).rejects.toThrow(/requires at least one connection/);
    });
  });

  describe('getAgentsByGraphIds returns correct data', () => {
    it('should return agents map for multiple graph IDs', async () => {
      const graph1 = await graphsService.create(
        contextDataStorage,
        createMockGraphData({
          name: `AgentMap Test 1 ${Date.now()}`,
        }),
      );
      registerGraph(graph1.id);

      const graph2 = await graphsService.create(
        contextDataStorage,
        createMockGraphData({
          name: `AgentMap Test 2 ${Date.now()}`,
          schema: {
            nodes: [
              {
                id: 'agent-1',
                template: 'simple-agent',
                config: {
                  name: 'Graph2 Agent',
                  description: 'Agent in second graph',
                  instructions: 'You are an agent in graph 2',
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
      registerGraph(graph2.id);

      const agentsMap = await graphDao.getAgentsByGraphIds([
        graph1.id,
        graph2.id,
      ]);

      expect(agentsMap.size).toBe(2);
      // Both graphs have a simple-agent node
      expect(agentsMap.get(graph1.id)!.length).toBeGreaterThanOrEqual(1);
      expect(agentsMap.get(graph2.id)!.length).toBe(1);
      expect(agentsMap.get(graph2.id)![0]!.name).toBe('Graph2 Agent');
    });

    it('should return empty map for empty input', async () => {
      const agentsMap = await graphDao.getAgentsByGraphIds([]);
      expect(agentsMap.size).toBe(0);
    });
  });

  describe('revision apply updates agents', () => {
    it(
      'should update agents column after revision is applied',
      { timeout: 60_000 },
      async () => {
        const graph = await graphsService.create(
          contextDataStorage,
          createMockGraphData({
            name: `Revision Agent Test ${Date.now()}`,
          }),
        );
        registerGraph(graph.id);

        // Verify initial agents
        const initialEntity = await graphDao.getOne({ id: graph.id });
        expect(initialEntity!.agents).toHaveLength(1);
        expect(initialEntity!.agents![0]!.name).toBe('Test Agent');

        // Update the graph schema with a renamed agent
        await graphsService.update(contextDataStorage, graph.id, {
          currentVersion: graph.version,
          schema: {
            nodes: [
              {
                id: 'agent-1',
                template: 'simple-agent',
                config: {
                  name: 'Renamed Agent',
                  description: 'Updated description',
                  instructions: 'You are updated',
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
        });

        // Wait for revision to be applied (polling the version). Pass
        // `refresh: true` so each poll re-fetches from the DB instead of
        // returning the cached pre-revision instance — tests share the
        // global EM with the worker, unlike HTTP requests which get their
        // own EM fork via @mikro-orm/nestjs middleware.
        await waitForCondition(
          async () => {
            const entity = await graphDao.getOne(
              { id: graph.id },
              { refresh: true },
            );
            return entity!;
          },
          (entity) => entity.version !== graph.version,
          { timeout: 30_000, interval: 500 },
        );

        // Verify agents column was updated
        const updatedEntity = await graphDao.getOne(
          { id: graph.id },
          { refresh: true },
        );
        expect(updatedEntity!.agents).toHaveLength(1);
        expect(updatedEntity!.agents![0]).toMatchObject({
          nodeId: 'agent-1',
          name: 'Renamed Agent',
          description: 'Updated description',
        });
      },
    );
  });

  describe('thread list includes agents', () => {
    it('should include agents in thread response when listing threads', async () => {
      // Create a graph and run it
      const graph = await graphsService.create(
        contextDataStorage,
        createMockGraphData({
          name: `Thread Agents Test ${Date.now()}`,
        }),
      );
      registerGraph(graph.id);
      await graphsService.run(contextDataStorage, graph.id);

      // Wait for graph to be running
      await waitForCondition(
        () => graphsService.findById(contextDataStorage, graph.id),
        (g) => g.status === GraphStatus.Running,
        { timeout: 60_000, interval: 1_000 },
      );

      // Execute a trigger to create a thread
      const triggerResult = await graphsService.executeTrigger(
        contextDataStorage,
        graph.id,
        'trigger-1',
        {
          messages: ['Hello agent'],
          async: true,
        },
      );

      // Wait for thread to be created
      await waitForCondition(
        () =>
          threadsService.getThreadByExternalId(
            contextDataStorage,
            triggerResult.externalThreadId,
          ),
        () => true,
        { timeout: 30_000, interval: 500 },
      );

      // List threads
      const threads = await threadsService.getThreads(contextDataStorage, {
        graphId: graph.id,
        limit: 50,
        offset: 0,
      });

      expect(threads.length).toBeGreaterThanOrEqual(1);
      const thread = threads.find(
        (t) => t.externalThreadId === triggerResult.externalThreadId,
      );
      expect(thread).toBeDefined();
      expect(thread!.agents).toBeDefined();
      expect(thread!.agents!.length).toBeGreaterThanOrEqual(1);
      expect(thread!.agents![0]!.nodeId).toBe('agent-1');
      expect(thread!.agents![0]!.name).toBe('Test Agent');

      // Wait for the async agent execution to finish (any non-running state)
      // before cleanup tears down the DB connection pool.
      await waitForCondition(
        async () => {
          const t = await threadsDao.getOne({
            externalThreadId: triggerResult.externalThreadId,
          });
          return t!;
        },
        (t) => t.status !== ThreadStatus.Running,
        { timeout: 90_000, interval: 1_000 },
      );
    }, 120_000);
  });
});
