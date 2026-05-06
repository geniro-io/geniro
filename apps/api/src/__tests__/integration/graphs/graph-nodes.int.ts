import { INestApplication } from '@nestjs/common';
import { BaseException } from '@packages/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppContextStorage } from '../../../auth/app-context-storage';
import {
  GraphNodesQueryDto,
  GraphNodeWithStatusSchema,
} from '../../../v1/graphs/dto/graphs.dto';
import { GraphNodeStatus, GraphStatus } from '../../../v1/graphs/graphs.types';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { ThreadMessageDto } from '../../../v1/threads/dto/threads.dto';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { wait } from '../../test-utils';
import {
  createMockGraphData,
  waitForCondition,
} from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import { getMockLlm } from '../mocks/mock-llm';
import { createTestModule } from '../setup';

type GraphNodeWithStatus = z.infer<typeof GraphNodeWithStatusSchema>;

const AGENT_NODE_ID = 'agent-1';
const TRIGGER_NODE_ID = 'trigger-1';

const ALLOWED_STATUSES: GraphNodeStatus[] = [
  GraphNodeStatus.Idle,
  GraphNodeStatus.Running,
  GraphNodeStatus.Starting,
  GraphNodeStatus.Stopped,
];

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Graph Nodes Integration Tests', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  const createdGraphIds: string[] = [];
  let basicGraphId: string;
  let mcpGraphId: string;
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
        (error.errorCode !== 'GRAPH_NOT_RUNNING' &&
          error.errorCode !== 'GRAPH_NOT_FOUND')
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

  const waitForGraphToBeRunning = async (
    graphId: string,
    timeoutMs = 120_000,
  ) => {
    const startedAt = Date.now();

    while (true) {
      const graph = await graphsService.findById(contextDataStorage, graphId);

      if (graph.status === GraphStatus.Running) {
        return graph;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          `Graph ${graphId} did not reach running status within ${timeoutMs}ms (current status: ${graph.status})`,
        );
      }

      await wait(1_000);
    }
  };

  const waitForThreadCompletion = async (
    externalThreadId: string,
    timeoutMs = 120_000,
  ) => {
    return waitForCondition(
      () =>
        threadsService.getThreadByExternalId(
          contextDataStorage,
          externalThreadId,
        ),
      (thread) =>
        [
          ThreadStatus.Done,
          ThreadStatus.Stopped,
          ThreadStatus.NeedMoreInfo,
        ].includes(thread.status),
      { timeout: timeoutMs, interval: 1_000 },
    );
  };

  const getThreadMessages = async (
    externalThreadId: string,
  ): Promise<ThreadMessageDto[]> => {
    const thread = await threadsService.getThreadByExternalId(
      contextDataStorage,
      externalThreadId,
    );
    return threadsService.getThreadMessages(contextDataStorage, thread.id);
  };

  const extractRunId = (messages: ThreadMessageDto[]): string | undefined => {
    for (const entry of messages) {
      // runId is extracted to a top-level field on the message DTO by
      // MessageTransformerService (from __runId in additionalKwargs).
      const message = entry.message as { runId?: string | null };
      if (typeof message.runId === 'string' && message.runId.length > 0) {
        return message.runId;
      }

      // Fallback: check additionalKwargs for legacy keys
      const additionalKwargs =
        (entry.message as { additionalKwargs?: Record<string, unknown> })
          .additionalKwargs ?? {};
      const runId = additionalKwargs['__runId'] ?? additionalKwargs['run_id'];
      if (typeof runId === 'string' && runId.length > 0) {
        return runId;
      }
    }

    return undefined;
  };

  const extractPendingMessageContent = (
    message: unknown,
  ): string | undefined => {
    if (!message || typeof message !== 'object') {
      return undefined;
    }

    if (typeof (message as { content?: unknown }).content === 'string') {
      return (message as { content?: string }).content;
    }

    const lcKwargs = (
      message as {
        lc_kwargs?: { content?: unknown };
        kwargs?: { content?: unknown };
      }
    ).lc_kwargs;

    if (typeof lcKwargs?.content === 'string') {
      return lcKwargs.content;
    }

    const kwargs = (message as { kwargs?: { content?: unknown } }).kwargs;
    if (typeof kwargs?.content === 'string') {
      return kwargs.content;
    }

    return undefined;
  };

  const waitForSnapshots = async (
    graphId: string,
    query: Partial<GraphNodesQueryDto>,
    predicate: (nodes: GraphNodeWithStatus[]) => boolean,
    timeoutMs = 120_000,
  ) => {
    return waitForCondition(
      () =>
        graphsService.getCompiledNodes(
          contextDataStorage,
          graphId,
          query as GraphNodesQueryDto,
        ),
      predicate,
      { timeout: timeoutMs, interval: 1_000 },
    );
  };

  beforeAll(async () => {
    app = await createTestModule();
    graphsService = app.get<GraphsService>(GraphsService);
    threadsService = app.get<ThreadsService>(ThreadsService);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;

    const basic = await graphsService.create(
      contextDataStorage,
      createMockGraphData({
        name: `Graph Nodes Basic ${Date.now()}`,
      }),
    );
    basicGraphId = basic.id;
    registerGraph(basicGraphId);
    await graphsService.run(contextDataStorage, basicGraphId);
    await waitForGraphToBeRunning(basicGraphId);

    const mcpGraph = await graphsService.create(
      contextDataStorage,
      createMockGraphData({
        name: `Graph Nodes MCP ${Date.now()}`,
        schema: {
          nodes: [
            {
              id: 'runtime-1',
              template: 'runtime',
              config: { runtimeType: 'Docker' },
            },
            {
              id: 'mcp-1',
              template: 'filesystem-mcp',
              config: {
                readOnly: false,
              },
            },
            {
              id: AGENT_NODE_ID,
              template: 'simple-agent',
              config: {
                // Avoid tool execution in this test; we only need MCP tool discovery during graph build.
              },
            },
            {
              id: TRIGGER_NODE_ID,
              template: 'manual-trigger',
              config: {},
            },
          ],
          edges: [
            { from: AGENT_NODE_ID, to: 'mcp-1' },
            { from: 'mcp-1', to: 'runtime-1' },
            { from: TRIGGER_NODE_ID, to: AGENT_NODE_ID },
          ],
        },
      }),
    );
    mcpGraphId = mcpGraph.id;
    registerGraph(mcpGraphId);
    await graphsService.run(contextDataStorage, mcpGraphId);
    await waitForGraphToBeRunning(mcpGraphId, 180_000);
  }, 300_000);

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

    await app.close();
  }, 300_000);

  const uniqueThreadSubId = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ensureGraphRunning = async (graphId: string) => {
    const graph = await graphsService.findById(contextDataStorage, graphId);
    if (graph.status === GraphStatus.Running) {
      return;
    }
    await graphsService.run(contextDataStorage, graphId);
    await waitForGraphToBeRunning(graphId);
  };

  it('rejects compiled node requests when graph is not running', async () => {
    const graph = await graphsService.create(
      contextDataStorage,
      createMockGraphData(),
    );
    registerGraph(graph.id);

    await expect(
      graphsService.getCompiledNodes(
        contextDataStorage,
        graph.id,
        {} as GraphNodesQueryDto,
      ),
    ).rejects.toMatchObject({
      errorCode: 'GRAPH_NOT_RUNNING',
      statusCode: 400,
    });
  });

  it(
    'returns compiled node snapshots for a running graph',
    { timeout: 120_000 },
    async () => {
      await ensureGraphRunning(basicGraphId);
      const graph = await graphsService.findById(
        contextDataStorage,
        basicGraphId,
      );

      const nodes = await waitForSnapshots(
        basicGraphId,
        {},
        (snapshots) => snapshots.length >= graph.schema.nodes.length,
      );

      expect(nodes.length).toBeGreaterThan(0);
      const nodeIds = nodes.map((node) => node.id);
      expect(nodeIds).toEqual(
        expect.arrayContaining([AGENT_NODE_ID, TRIGGER_NODE_ID]),
      );

      nodes.forEach((node) => {
        expect(ALLOWED_STATUSES).toContain(node.status);
        if (node.error !== undefined && node.error !== null) {
          expect(typeof node.error).toBe('string');
        }
        expect(node.metadata).toBeUndefined();
      });
    },
  );

  it(
    'filters node snapshots by thread and run identifiers',
    { timeout: 120_000 },
    async () => {
      await ensureGraphRunning(basicGraphId);

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        basicGraphId,
        TRIGGER_NODE_ID,
        {
          messages: [
            'Please summarize this synthetically and confirm completion.',
          ],
          threadSubId: uniqueThreadSubId('node-status-thread'),
          async: false,
        },
      );
      expect(execution.externalThreadId).toBeDefined();

      await waitForThreadCompletion(execution.externalThreadId);

      const threadFiltered = await waitForSnapshots(
        basicGraphId,
        { threadId: execution.externalThreadId },
        (snapshots) =>
          snapshots.some(
            (node) =>
              node.id === AGENT_NODE_ID &&
              node.metadata?.threadId === execution.externalThreadId,
          ),
      );

      const agentThreadNode = threadFiltered.find(
        (node) => node.id === AGENT_NODE_ID,
      );
      expect(agentThreadNode?.metadata?.threadId).toBe(
        execution.externalThreadId,
      );

      const messages = await getThreadMessages(execution.externalThreadId);
      const runIdFromMessages = extractRunId(messages);
      const runIdFromMetadata = agentThreadNode?.metadata?.runId;
      const effectiveRunId = runIdFromMetadata ?? runIdFromMessages;
      expect(effectiveRunId).toBeDefined();

      const runFiltered = await waitForSnapshots(
        basicGraphId,
        { runId: effectiveRunId },
        (snapshots) =>
          snapshots.some(
            (node) =>
              node.id === AGENT_NODE_ID &&
              node.metadata?.runId === effectiveRunId,
          ),
      );

      const agentRunNode = runFiltered.find(
        (node) => node.id === AGENT_NODE_ID,
      );
      expect(agentRunNode?.metadata?.runId).toBe(effectiveRunId);

      runFiltered.forEach((node) => {
        expect(ALLOWED_STATUSES).toContain(node.status);
      });

      await graphsService.destroy(contextDataStorage, basicGraphId);

      await expect(
        graphsService.getCompiledNodes(
          contextDataStorage,
          basicGraphId,
          {} as GraphNodesQueryDto,
        ),
      ).rejects.toMatchObject({
        errorCode: 'GRAPH_NOT_RUNNING',
        statusCode: 400,
      });
    },
  );

  it(
    'exposes agent pending messages through additional node metadata',
    { timeout: 120_000 },
    async () => {
      await ensureGraphRunning(basicGraphId);

      // Mocked LLM resolves instantly, so the first run would finish before the
      // second trigger arrives (no `appendMessages` path, no pending-message
      // window). Delay the first finish-tool reply so the run stays active long
      // enough for the follow-up trigger to land in `appendMessages`.
      const mockLlm = getMockLlm(app);
      mockLlm.onChat(
        {
          lastUserMessage: 'Start long running task',
          hasTools: ['finish'],
        },
        {
          kind: 'toolCall',
          toolName: 'finish',
          args: { purpose: 'done', message: 'OK', needsMoreInfo: false },
          delayMs: 5_000,
        },
      );

      const threadSubId = uniqueThreadSubId('pending-metadata-thread');
      const firstExecution = await graphsService.executeTrigger(
        contextDataStorage,
        basicGraphId,
        TRIGGER_NODE_ID,
        {
          messages: ['Start long running task'],
          threadSubId,
          async: true,
        },
      );
      const threadId = firstExecution.externalThreadId;

      await waitForSnapshots(basicGraphId, { threadId }, (snapshots) =>
        snapshots.some(
          (node) =>
            node.id === AGENT_NODE_ID &&
            node.status === GraphNodeStatus.Running,
        ),
      );

      await graphsService.executeTrigger(
        contextDataStorage,
        basicGraphId,
        TRIGGER_NODE_ID,
        {
          messages: ['Follow-up while running'],
          threadSubId,
          async: true,
        },
      );

      const nodesWithPending = await waitForSnapshots(
        basicGraphId,
        { threadId },
        (snapshots) =>
          snapshots.some((node) => {
            if (node.id !== AGENT_NODE_ID) {
              return false;
            }
            const metadata = node.additionalNodeMetadata as
              | { pendingMessages?: unknown[] }
              | undefined;
            return (
              Array.isArray(metadata?.pendingMessages) &&
              metadata.pendingMessages.length > 0
            );
          }),
      );

      const agentNode = nodesWithPending.find(
        (node) => node.id === AGENT_NODE_ID,
      );
      const pendingMetadata = agentNode?.additionalNodeMetadata as
        | { pendingMessages?: { content?: string }[] }
        | undefined;

      expect(pendingMetadata?.pendingMessages).toBeDefined();
      expect(pendingMetadata?.pendingMessages?.length).toBeGreaterThan(0);
      const pendingMessageContent = extractPendingMessageContent(
        pendingMetadata?.pendingMessages?.[0],
      );

      expect(pendingMessageContent).toBe('Follow-up while running');

      await waitForThreadCompletion(threadId);

      const nodesAfterCompletion = await waitForSnapshots(
        basicGraphId,
        { threadId },
        (snapshots) =>
          snapshots.some(
            (node) =>
              node.id === AGENT_NODE_ID &&
              !(
                (
                  node.additionalNodeMetadata as {
                    pendingMessages?: unknown[];
                  }
                )?.pendingMessages?.length ?? 0
              ),
          ),
      );

      const clearedNode = nodesAfterCompletion.find(
        (node) => node.id === AGENT_NODE_ID,
      );
      expect(
        (
          clearedNode?.additionalNodeMetadata as {
            pendingMessages?: unknown[];
          }
        )?.pendingMessages,
      ).toEqual([]);
    },
  );

  it(
    'exposes connected tool list (including MCP tools) through additional node metadata',
    { timeout: 180_000 },
    async () => {
      await ensureGraphRunning(mcpGraphId);

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        mcpGraphId,
        TRIGGER_NODE_ID,
        {
          messages: ['No tools needed. Reply with a short acknowledgement.'],
          threadSubId: uniqueThreadSubId('connected-tools-metadata-thread'),
          async: false,
        },
      );

      await waitForThreadCompletion(execution.externalThreadId);

      const snapshots = await waitForSnapshots(
        mcpGraphId,
        { threadId: execution.externalThreadId },
        (nodes) =>
          nodes.some(
            (n) =>
              n.id === AGENT_NODE_ID &&
              typeof (n.additionalNodeMetadata as Record<string, unknown>)?.[
                'connectedTools'
              ] === 'object',
          ),
      );

      const agentNode = snapshots.find((n) => n.id === AGENT_NODE_ID);
      const meta = agentNode?.additionalNodeMetadata as
        | {
            connectedTools?: {
              name?: string;
              description?: string;
              schema?: unknown;
            }[];
            connectedMcp?: unknown;
          }
        | undefined;

      expect(meta?.connectedTools).toBeDefined();
      expect(Array.isArray(meta?.connectedTools)).toBe(true);

      // Should include MCP filesystem tool(s) after execution
      // Note: our Filesystem MCP maps the filesystem server tools and currently exposes
      // `read_text_file` (not `read_file`).
      const readFileTool = meta?.connectedTools?.find((t) =>
        ['read_text_file', 'read_file'].includes(String(t?.name ?? '')),
      );
      expect(readFileTool).toBeDefined();
      expect(typeof readFileTool?.description).toBe('string');
      // Schema should be serialized the same way as /templates (draft-7 JSON schema)
      expect(
        (readFileTool?.schema as { $schema?: unknown } | undefined)?.$schema,
      ).toBe('http://json-schema.org/draft-07/schema#');

      // Ensure we don't expose connectedMcp anymore
      expect(meta?.connectedMcp).toBeUndefined();
    },
  );
});
