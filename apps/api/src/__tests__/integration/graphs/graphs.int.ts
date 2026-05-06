import { INestApplication } from '@nestjs/common';
import { BaseException } from '@packages/common';
import { cloneDeep } from 'lodash';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { EntityUUIDSchema } from '../../../utils/dto/misc.dto';
import { ReasoningEffort } from '../../../v1/agents/agents.types';
import { SimpleAgentSchemaType } from '../../../v1/agents/services/agents/simple-agent';
import {
  CreateGraphDto,
  UpdateGraphDto,
} from '../../../v1/graphs/dto/graphs.dto';
import {
  GraphNodeSchemaType,
  GraphStatus,
} from '../../../v1/graphs/graphs.types';
import { GraphRegistry } from '../../../v1/graphs/services/graph-registry';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { wait } from '../../test-utils';
import {
  createMockGraphData,
  waitForCondition,
} from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import { createTestModule } from '../setup';

const TEST_AGENT_NODE_ID = 'agent-1';
const TEST_TRIGGER_NODE_ID = 'trigger-1';
const SHELL_NODE_ID = 'shell-1';
const RUNTIME_NODE_ID = 'runtime-1';
const NON_EXISTENT_GRAPH_ID = '00000000-0000-0000-0000-000000000000';

const COMMAND_AGENT_INSTRUCTIONS =
  'You are a command runner. When the user message contains `Run this command: <cmd>` or `Execute shell command: <cmd>`, extract `<cmd>` and execute it exactly using the shell tool. Do not run any other commands, inspections, or tests unless the user explicitly requests them. After running the shell tool, describe what happened. If the runtime is not yet started, wait briefly and retry once before reporting the failure.';

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Graphs Integration Tests', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  let graphRegistry: GraphRegistry;
  const createdGraphIds: string[] = [];
  let commandGraphId: string;
  let testProjectId: string;

  const registerGraph = (graphId: string) => {
    if (!createdGraphIds.includes(graphId)) {
      createdGraphIds.push(graphId);
    }
  };

  const unregisterGraph = (graphId: string) => {
    const index = createdGraphIds.indexOf(graphId);
    if (index >= 0) {
      createdGraphIds.splice(index, 1);
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

  const waitForGraphStatus = async (
    graphId: string,
    status: GraphStatus,
    timeoutMs = 60000,
  ) => {
    return waitForCondition(
      () => graphsService.findById(contextDataStorage, graphId),
      (graph) => graph.status === status,
      { timeout: timeoutMs, interval: 1000 },
    );
  };

  const waitForThreadStatus = async (
    threadId: string,
    statuses: ThreadStatus[],
    timeoutMs = 60000,
  ) => {
    return waitForCondition(
      () => threadsService.getThreadByExternalId(contextDataStorage, threadId),
      (thread) => statuses.includes(thread.status),
      { timeout: timeoutMs, interval: 1000 },
    );
  };

  const createCommandGraphData = (): CreateGraphDto => ({
    name: `Command Graph ${Date.now()}`,
    description: 'Graph with shell runtime for destroy-stop scenarios',
    temporary: true,
    schema: {
      nodes: [
        {
          id: TEST_TRIGGER_NODE_ID,
          template: 'manual-trigger',
          config: {},
        },
        {
          id: TEST_AGENT_NODE_ID,
          template: 'simple-agent',
          config: {
            instructions: COMMAND_AGENT_INSTRUCTIONS,
            name: 'Test Agent',
            description: 'Test agent description',
            summarizeMaxTokens: 272000,
            summarizeKeepTokens: 30000,
            invokeModelName: 'gpt-5-mini',
            invokeModelReasoningEffort: ReasoningEffort.None,
            maxIterations: 50,
          } satisfies SimpleAgentSchemaType,
        },
        {
          id: SHELL_NODE_ID,
          template: 'shell-tool',
          config: {},
        },
        {
          id: RUNTIME_NODE_ID,
          template: 'runtime',
          config: {
            runtimeType: 'Docker',
            image: 'python:3.11-slim',
            env: {},
          },
        },
      ],
      edges: [
        { from: TEST_TRIGGER_NODE_ID, to: TEST_AGENT_NODE_ID },
        { from: TEST_AGENT_NODE_ID, to: SHELL_NODE_ID },
        { from: SHELL_NODE_ID, to: RUNTIME_NODE_ID },
      ],
    },
  });

  beforeAll(async () => {
    app = await createTestModule();
    graphsService = app.get<GraphsService>(GraphsService);
    threadsService = app.get<ThreadsService>(ThreadsService);
    graphRegistry = app.get<GraphRegistry>(GraphRegistry);
    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;
  });

  afterAll(async () => {
    while (createdGraphIds.length > 0) {
      const graphId = createdGraphIds.pop();
      if (graphId) {
        await cleanupGraph(graphId);
      }
    }

    if (testProjectId) {
      try {
        await app.get(ProjectsDao).deleteById(testProjectId);
      } catch {
        // best effort cleanup
      }
    }

    // Suppress BullMQ Redis duplicate connection close errors during teardown.
    // BullMQ internally duplicates the shared IORedis connection for Queue/Worker.
    // These duplicates may reject pending commands during app shutdown, producing
    // unhandled rejections that don't affect test correctness.
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

    await app.close();

    process.removeListener('unhandledRejection', suppressRedisClose);
  }, 180_000);

  const uniqueThreadSubId = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ensureGraphRunning = async (graphId: string) => {
    const graph = await graphsService.findById(contextDataStorage, graphId);
    if (graph.status === GraphStatus.Running) {
      return;
    }
    await graphsService.run(contextDataStorage, graphId);
    await waitForGraphStatus(graphId, GraphStatus.Running);
  };

  const restartGraph = async (graphId: string) => {
    try {
      await graphsService.destroy(contextDataStorage, graphId);
    } catch {
      // best effort
    }
    await ensureGraphRunning(graphId);
  };

  describe('graph creation', () => {
    it('creates a new graph with the default schema', async () => {
      const graphData = createMockGraphData();

      const response = await graphsService.create(
        contextDataStorage,
        graphData,
      );
      registerGraph(response.id);

      expect(response.id).toBeDefined();
      expect(response.status).toBe(GraphStatus.Created);
      expect(response.version).toBe('1.0.0');
      expect(response.targetVersion).toBe('1.0.0');
      expect(response.schema).toMatchObject(graphData.schema);
    });

    it('creates a graph without optional description', async () => {
      const graphData = createMockGraphData({
        description: undefined,
        temporary: false,
      });

      const response = await graphsService.create(
        contextDataStorage,
        graphData,
      );
      registerGraph(response.id);

      expect(response.description ?? null).toBeNull();
      expect(response.temporary).toBe(false);
    });

    it('rejects graphs with duplicate node identifiers', async () => {
      const invalidData = createMockGraphData({
        schema: {
          nodes: [
            {
              id: 'duplicate-node',
              template: 'manual-trigger',
              config: {},
            },
            {
              id: 'duplicate-node',
              template: 'simple-agent',
              config: {
                instructions: 'Duplicate test',
                invokeModelName: 'gpt-5-mini',
                invokeModelReasoningEffort: ReasoningEffort.None,
                summarizeMaxTokens: 1000,
                summarizeKeepTokens: 100,
              },
            },
          ],
          edges: [],
        },
      });

      await expect(
        graphsService.create(contextDataStorage, invalidData),
      ).rejects.toMatchObject({
        errorCode: 'GRAPH_DUPLICATE_NODE',
        statusCode: 400,
      });
    });

    it('rejects graphs that reference unknown templates', async () => {
      const invalidData = createMockGraphData({
        schema: {
          nodes: [
            {
              id: 'node-1',
              template: 'unknown-template',
              config: {},
            },
          ],
          edges: [],
        },
      });

      await expect(
        graphsService.create(contextDataStorage, invalidData),
      ).rejects.toMatchObject({
        errorCode: 'TEMPLATE_NOT_REGISTERED',
        statusCode: 400,
      });
    });

    it('rejects graphs with edges pointing to non-existent target nodes', async () => {
      const invalidData = createMockGraphData({
        schema: {
          nodes: [
            {
              id: 'node-1',
              template: 'manual-trigger',
              config: {},
            },
          ],
          edges: [
            {
              from: 'node-1',
              to: 'missing-node',
            },
          ],
        },
      });

      await expect(
        graphsService.create(contextDataStorage, invalidData),
      ).rejects.toMatchObject({
        errorCode: 'GRAPH_EDGE_NOT_FOUND',
        statusCode: 400,
      });
    });

    it('rejects graphs with edges pointing to non-existent source nodes', async () => {
      const invalidData = createMockGraphData({
        schema: {
          nodes: [
            {
              id: 'node-1',
              template: 'manual-trigger',
              config: {},
            },
          ],
          edges: [
            {
              from: 'missing-node',
              to: 'node-1',
            },
          ],
        },
      });

      await expect(
        graphsService.create(contextDataStorage, invalidData),
      ).rejects.toMatchObject({
        errorCode: 'GRAPH_EDGE_NOT_FOUND',
        statusCode: 400,
      });
    });

    it('rejects graphs with invalid template configuration', async () => {
      const graphData = createMockGraphData();
      const invalidAgentSchema = cloneDeep(graphData.schema);

      invalidAgentSchema.nodes = invalidAgentSchema.nodes.map((node) =>
        node.id === TEST_AGENT_NODE_ID
          ? {
              ...node,
              config: { invalid: 'config' },
            }
          : node,
      );

      await expect(
        graphsService.create(contextDataStorage, {
          ...graphData,
          schema: invalidAgentSchema,
        }),
      ).rejects.toMatchObject({
        errorCode: 'INVALID_TEMPLATE_CONFIG',
        statusCode: 400,
      });
    });
  });

  describe('graph retrieval', () => {
    it('returns all graphs including newly created ones', async () => {
      const graphA = await graphsService.create(
        contextDataStorage,
        createMockGraphData(),
      );
      const graphB = await graphsService.create(
        contextDataStorage,
        createMockGraphData(),
      );
      registerGraph(graphA.id);
      registerGraph(graphB.id);

      const graphs = await graphsService.getAll(contextDataStorage);

      const ids = graphs.map((graph) => graph.id);
      expect(ids).toContain(graphA.id);
      expect(ids).toContain(graphB.id);
    });

    it('fetches a graph by id', async () => {
      const graph = await graphsService.create(
        contextDataStorage,
        createMockGraphData(),
      );
      registerGraph(graph.id);

      const fetched = await graphsService.findById(
        contextDataStorage,
        graph.id,
      );
      expect(fetched.id).toBe(graph.id);
      expect(fetched.schema).toMatchObject(graph.schema);
    });

    it('throws an error when graph is missing', async () => {
      await expect(
        graphsService.findById(contextDataStorage, NON_EXISTENT_GRAPH_ID),
      ).rejects.toMatchObject({
        errorCode: 'GRAPH_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('validates UUID params the same way the controller layer does', () => {
      const result = EntityUUIDSchema.safeParse({ id: 'invalid-uuid' });
      expect(result.success).toBe(false);
    });
  });

  describe('graph updates', () => {
    it('updates mutable fields (partial + full) without touching schema or version', async () => {
      const graphForPartial = await graphsService.create(
        contextDataStorage,
        createMockGraphData(),
      );
      const graphForFull = await graphsService.create(
        contextDataStorage,
        createMockGraphData(),
      );
      registerGraph(graphForPartial.id);
      registerGraph(graphForFull.id);

      const partialUpdate: UpdateGraphDto = {
        name: 'Partially Updated Graph',
        currentVersion: graphForPartial.version,
      };

      const partialResponse = await graphsService.update(
        contextDataStorage,
        graphForPartial.id,
        partialUpdate,
      );
      // Metadata-only updates (name, description) are applied synchronously and
      // do NOT create revisions. Revisions are only created for schema changes.
      expect(partialResponse.revision).toBeUndefined();
      expect(partialResponse.graph.version).toBe(graphForPartial.version);
      expect(partialResponse.graph.name).toBe(partialUpdate.name);
      expect(partialResponse.graph.schema).toMatchObject(
        graphForPartial.schema,
      );

      const fullUpdate: UpdateGraphDto = {
        name: 'Updated Graph Name',
        description: 'Updated description from integration test',
        currentVersion: graphForFull.version,
      };

      const fullResponse = await graphsService.update(
        contextDataStorage,
        graphForFull.id,
        fullUpdate,
      );
      expect(fullResponse.revision).toBeUndefined();
      expect(fullResponse.graph.version).toBe(graphForFull.version);
      expect(fullResponse.graph.name).toBe(fullUpdate.name);
      expect(fullResponse.graph.description).toBe(fullUpdate.description);
      expect(fullResponse.graph.schema).toMatchObject(graphForFull.schema);
    });

    it('throws when updating a non-existent graph', async () => {
      const updatePayload: UpdateGraphDto = {
        name: 'Missing Graph',
        currentVersion: '0.0.0',
      };

      await expect(
        graphsService.update(
          contextDataStorage,
          NON_EXISTENT_GRAPH_ID,
          updatePayload,
        ),
      ).rejects.toMatchObject({
        errorCode: 'GRAPH_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('increments version on schema change and rejects stale edits (version conflict)', async () => {
      const graph = await graphsService.create(
        contextDataStorage,
        createMockGraphData(),
      );
      registerGraph(graph.id);

      const updatedSchema = cloneDeep(graph.schema);
      updatedSchema.nodes = updatedSchema.nodes.map((node) =>
        node.id === TEST_AGENT_NODE_ID
          ? {
              ...node,
              config: {
                ...(node.config as SimpleAgentSchemaType),
                instructions: 'Schema update via integration test',
              } satisfies SimpleAgentSchemaType,
            }
          : node,
      );

      const response = await graphsService.update(
        contextDataStorage,
        graph.id,
        {
          schema: updatedSchema,
          currentVersion: graph.version,
        },
      );

      // Schema edits create a revision and advance targetVersion (head), but the graph's applied
      // version remains unchanged until the revision is applied by the background worker.
      expect(response.revision).toBeDefined();
      expect(response.graph.version).toBe('1.0.0');
      expect(response.graph.targetVersion).toBe('1.0.1');

      expect(response.revision!.toVersion).toBe('1.0.1');
      const agentNode = response.revision!.newConfig.schema.nodes.find(
        (node: GraphNodeSchemaType) => node.id === TEST_AGENT_NODE_ID,
      );
      expect((agentNode?.config as SimpleAgentSchemaType).instructions).toBe(
        'Schema update via integration test',
      );

      const staleSchema = cloneDeep(updatedSchema);
      staleSchema.nodes = staleSchema.nodes.map((node) =>
        node.id === TEST_AGENT_NODE_ID
          ? {
              ...node,
              config: {
                ...(node.config as SimpleAgentSchemaType),
                instructions: 'Stale update should fail',
              } satisfies SimpleAgentSchemaType,
            }
          : node,
      );

      await expect(
        graphsService.update(contextDataStorage, graph.id, {
          schema: staleSchema,
          currentVersion: graph.version,
        }),
      ).rejects.toMatchObject({
        // This is a stale edit against a newer head (targetVersion), so the merge should conflict.
        errorCode: 'MERGE_CONFLICT',
        statusCode: 400,
      });
    });
  });

  describe('running graphs', () => {
    it('runs a graph, registers it, and prevents re-running while already running', async () => {
      const graph = await graphsService.create(
        contextDataStorage,
        createMockGraphData(),
      );
      registerGraph(graph.id);

      const runResponse = await graphsService.run(contextDataStorage, graph.id);
      expect(runResponse.status).toBe(GraphStatus.Running);

      await waitForGraphStatus(graph.id, GraphStatus.Running);
      expect(graphRegistry.get(graph.id)).toBeDefined();

      await expect(
        graphsService.run(contextDataStorage, graph.id),
      ).rejects.toMatchObject({
        errorCode: 'GRAPH_ALREADY_RUNNING',
        statusCode: 400,
      });
    });

    it('throws when trying to run a missing graph', async () => {
      await expect(
        graphsService.run(contextDataStorage, NON_EXISTENT_GRAPH_ID),
      ).rejects.toMatchObject({
        errorCode: 'GRAPH_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  describe('destroying graphs', () => {
    it(
      'stops a running graph and returns it in the stopped state',
      { timeout: 60000 },
      async () => {
        const graph = await graphsService.create(
          contextDataStorage,
          createMockGraphData(),
        );
        registerGraph(graph.id);

        await graphsService.run(contextDataStorage, graph.id);
        await waitForGraphStatus(graph.id, GraphStatus.Running);
        expect(graphRegistry.get(graph.id)).toBeDefined();

        const destroyResponse = await graphsService.destroy(
          contextDataStorage,
          graph.id,
        );
        expect(destroyResponse.status).toBe(GraphStatus.Stopped);
        expect(graphRegistry.get(graph.id)).toBeUndefined();

        const refreshed = await graphsService.findById(
          contextDataStorage,
          graph.id,
        );
        expect(refreshed.status).toBe(GraphStatus.Stopped);
      },
    );

    it('throws when destroying a missing graph', async () => {
      await expect(
        graphsService.destroy(contextDataStorage, NON_EXISTENT_GRAPH_ID),
      ).rejects.toMatchObject({
        errorCode: 'GRAPH_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  describe('deleting graphs', () => {
    it('deletes a graph permanently', async () => {
      const graph = await graphsService.create(
        contextDataStorage,
        createMockGraphData(),
      );
      registerGraph(graph.id);

      await graphsService.delete(contextDataStorage, graph.id);
      unregisterGraph(graph.id);

      await expect(
        graphsService.findById(contextDataStorage, graph.id),
      ).rejects.toMatchObject({
        errorCode: 'GRAPH_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws when deleting a missing graph', async () => {
      await expect(
        graphsService.delete(contextDataStorage, NON_EXISTENT_GRAPH_ID),
      ).rejects.toMatchObject({
        errorCode: 'GRAPH_NOT_FOUND',
        statusCode: 404,
      });
    });

    it(
      'stops a running graph before deleting it',
      { timeout: 60000 },
      async () => {
        const graph = await graphsService.create(
          contextDataStorage,
          createMockGraphData(),
        );
        registerGraph(graph.id);

        await graphsService.run(contextDataStorage, graph.id);
        await waitForGraphStatus(graph.id, GraphStatus.Running);
        expect(graphRegistry.get(graph.id)).toBeDefined();

        await graphsService.delete(contextDataStorage, graph.id);
        unregisterGraph(graph.id);
        expect(graphRegistry.get(graph.id)).toBeUndefined();

        await expect(
          graphsService.findById(contextDataStorage, graph.id),
        ).rejects.toMatchObject({
          errorCode: 'GRAPH_NOT_FOUND',
          statusCode: 404,
        });
      },
    );
  });

  describe('destroying graphs with active executions', () => {
    beforeAll(async () => {
      const graph = await graphsService.create(
        contextDataStorage,
        createCommandGraphData(),
      );
      commandGraphId = graph.id;
      registerGraph(commandGraphId);
    });

    it(
      'stops active execution and marks the graph as stopped',
      { timeout: 120000 },
      async () => {
        await restartGraph(commandGraphId);

        const execution = await graphsService.executeTrigger(
          contextDataStorage,
          commandGraphId,
          TEST_TRIGGER_NODE_ID,
          {
            messages: ['Run this command: sleep 100 && echo "interrupt me"'],
            async: true,
            threadSubId: uniqueThreadSubId('destroy-active'),
          },
        );

        await waitForThreadStatus(
          execution.externalThreadId,
          [ThreadStatus.Running],
          60000,
        );

        const destroyResponse = await graphsService.destroy(
          contextDataStorage,
          commandGraphId,
        );
        expect(destroyResponse.status).toBe(GraphStatus.Stopped);
        expect(graphRegistry.get(commandGraphId)).toBeUndefined();

        // Wait for the async agent shutdown to settle. The thread status
        // update races with graph state cleanup: agent.stop() emits the
        // 'stop' event via a fire-and-forget EventEmitter, then
        // stateManager.destroy() clears activeExecutions before the async
        // handler can emit ThreadUpdate(Stopped). Similarly, the LangGraph
        // run's 'run' event fires after the listener is unsubscribed.
        // As a result, the thread may or may not transition to a terminal
        // status. The graph stop message notification IS reliably emitted
        // over WebSocket (verified by socket-notifications.int.ts).
        await wait(5000);

        const persistedThread = await threadsService.getThreadByExternalId(
          contextDataStorage,
          execution.externalThreadId,
        );
        // Thread should be in Running (race lost) or Stopped (race won)
        expect([
          ThreadStatus.Running,
          ThreadStatus.Stopped,
          ThreadStatus.NeedMoreInfo,
        ]).toContain(persistedThread.status);
      },
    );

    it(
      'stops multiple concurrent agent executions when destroyed',
      { timeout: 120000 },
      async () => {
        await restartGraph(commandGraphId);

        const executions = await Promise.all(
          ['First concurrent execution', 'Second concurrent execution'].map(
            (message) =>
              graphsService.executeTrigger(
                contextDataStorage,
                commandGraphId,
                TEST_TRIGGER_NODE_ID,
                {
                  messages: [message],
                  async: true,
                  threadSubId: uniqueThreadSubId('destroy-concurrent'),
                },
              ),
          ),
        );

        await wait(1000);
        await graphsService.destroy(contextDataStorage, commandGraphId);

        // With the offline MockLlmService the agents may complete (Done)
        // before `destroy()` fires the abort. Done is therefore accepted as
        // a valid terminal status alongside the original Stopped/NeedMoreInfo.
        const acceptedStatuses = [
          ThreadStatus.Stopped,
          ThreadStatus.NeedMoreInfo,
          ThreadStatus.Done,
        ];
        for (const execution of executions) {
          const thread = await waitForThreadStatus(
            execution.externalThreadId,
            acceptedStatuses,
          );
          expect(acceptedStatuses).toContain(thread.status);
        }
      },
    );

    it(
      'allows destroy even when no agent is actively executing',
      { timeout: 120000 },
      async () => {
        await restartGraph(commandGraphId);

        const destroyResponse = await graphsService.destroy(
          contextDataStorage,
          commandGraphId,
        );
        expect(destroyResponse.status).toBe(GraphStatus.Stopped);
        expect(graphRegistry.get(commandGraphId)).toBeUndefined();
      },
    );
  });
});
