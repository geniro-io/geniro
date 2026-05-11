import { INestApplication } from '@nestjs/common';
import { BaseException } from '@packages/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { ReasoningEffort } from '../../../v1/agents/agents.types';
import { SimpleAgentSchemaType } from '../../../v1/agents/services/agents/simple-agent';
import { CreateGraphDto } from '../../../v1/graphs/dto/graphs.dto';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { LiteLlmClient } from '../../../v1/litellm/services/litellm.client';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { ThreadMessageDto } from '../../../v1/threads/dto/threads.dto';
import { ThreadNameGeneratorService } from '../../../v1/threads/services/thread-name-generator.service';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { waitForCondition } from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import {
  mockLiteLlmClient,
  mockThreadNameGenerator,
} from '../helpers/test-stubs';
import { getMockLlm } from '../mocks/mock-llm';
import { createTestModule } from '../setup';

const TRIGGER_NODE_ID = 'trigger-1';
const AGENT_NODE_ID = 'agent-1';
const SHELL_NODE_ID = 'shell-1';
const RUNTIME_NODE_ID = 'runtime-1';
const FILES_NODE_ID = 'files-1';

const THREAD_COMPLETION_STATUSES: ThreadStatus[] = [
  ThreadStatus.Done,
  ThreadStatus.NeedMoreInfo,
  ThreadStatus.Stopped,
];

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Deferred Tool Loading Integration Tests', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  let shellOnlyGraphId: string;
  let multiToolGraphId: string;
  let testProjectId: string;

  const waitForGraphToBeRunning = async (
    graphId: string,
    timeoutMs = 120_000,
  ) => {
    return waitForCondition(
      () => graphsService.findById(contextDataStorage, graphId),
      (graph) => graph.status === GraphStatus.Running,
      { timeout: timeoutMs, interval: 1_000 },
    );
  };

  const waitForThreadCompletion = async (
    externalThreadId: string,
    timeoutMs = 120_000,
  ) => {
    const thread = await threadsService.getThreadByExternalId(
      contextDataStorage,
      externalThreadId,
    );

    return waitForCondition(
      () => threadsService.getThreadById(contextDataStorage, thread.id),
      (t) => THREAD_COMPLETION_STATUSES.includes(t.status),
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
    const messages = await threadsService.getThreadMessages(
      contextDataStorage,
      thread.id,
    );

    return messages.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
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

  const createShellOnlyGraphData = (): CreateGraphDto => ({
    name: `Deferred Tool Loading Shell Test ${Date.now()}`,
    description: 'Integration test graph for deferred tool loading with shell',
    temporary: true,
    schema: {
      nodes: [
        {
          id: TRIGGER_NODE_ID,
          template: 'manual-trigger',
          config: {},
        },
        {
          id: AGENT_NODE_ID,
          template: 'simple-agent',
          config: {
            instructions:
              'You are a helpful assistant with access to tools. Use tool_search to discover tools when needed. After finding and using a tool, call the finish tool with your result.',
            name: 'Test Agent',
            description: 'Test agent for deferred tool loading',
            invokeModelName: 'gpt-5-mini',
            invokeModelReasoningEffort: ReasoningEffort.None,
            maxIterations: 50,
            summarizeMaxTokens: 272000,
            summarizeKeepTokens: 30000,
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
        { from: TRIGGER_NODE_ID, to: AGENT_NODE_ID },
        { from: AGENT_NODE_ID, to: SHELL_NODE_ID },
        { from: SHELL_NODE_ID, to: RUNTIME_NODE_ID },
      ],
    },
  });

  const createMultiToolGraphData = (): CreateGraphDto => ({
    name: `Deferred Tool Loading Multi-Tool Test ${Date.now()}`,
    description:
      'Integration test graph for deferred tool loading with multiple tools',
    temporary: true,
    schema: {
      nodes: [
        {
          id: TRIGGER_NODE_ID,
          template: 'manual-trigger',
          config: {},
        },
        {
          id: AGENT_NODE_ID,
          template: 'simple-agent',
          config: {
            instructions:
              'You are a helpful assistant with access to tools. Use tool_search to discover available tools. After completing your task, call the finish tool with a summary of what you found.',
            name: 'Test Agent',
            description:
              'Test agent for deferred tool loading with multiple tools',
            invokeModelName: 'gpt-5-mini',
            invokeModelReasoningEffort: ReasoningEffort.None,
            maxIterations: 50,
            summarizeMaxTokens: 272000,
            summarizeKeepTokens: 30000,
          } satisfies SimpleAgentSchemaType,
        },
        {
          id: SHELL_NODE_ID,
          template: 'shell-tool',
          config: {},
        },
        {
          id: FILES_NODE_ID,
          template: 'files-tool',
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
        { from: TRIGGER_NODE_ID, to: AGENT_NODE_ID },
        { from: AGENT_NODE_ID, to: SHELL_NODE_ID },
        { from: AGENT_NODE_ID, to: FILES_NODE_ID },
        { from: SHELL_NODE_ID, to: RUNTIME_NODE_ID },
        { from: FILES_NODE_ID, to: RUNTIME_NODE_ID },
      ],
    },
  });

  const ensureGraphRunning = async (graphId: string) => {
    const graph = await graphsService.findById(contextDataStorage, graphId);
    if (graph.status === GraphStatus.Running) {
      return;
    }
    await graphsService.run(contextDataStorage, graphId);
    await waitForGraphToBeRunning(graphId);
  };

  const uniqueThreadSubId = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    app = await createTestModule(async (m) =>
      m
        .overrideProvider(LiteLlmClient)
        .useValue(mockLiteLlmClient)
        .overrideProvider(ThreadNameGeneratorService)
        .useValue(mockThreadNameGenerator)
        .compile(),
    );
    graphsService = app.get<GraphsService>(GraphsService);
    threadsService = app.get<ThreadsService>(ThreadsService);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;

    const shellOnlyGraph = await graphsService.create(
      contextDataStorage,
      createShellOnlyGraphData(),
    );
    shellOnlyGraphId = shellOnlyGraph.id;
    await graphsService.run(contextDataStorage, shellOnlyGraphId);
    await waitForGraphToBeRunning(shellOnlyGraphId);

    const multiToolGraph = await graphsService.create(
      contextDataStorage,
      createMultiToolGraphData(),
    );
    multiToolGraphId = multiToolGraph.id;
    await graphsService.run(contextDataStorage, multiToolGraphId);
    await waitForGraphToBeRunning(multiToolGraphId);
  }, 180_000);

  afterAll(async () => {
    const graphIds = [shellOnlyGraphId, multiToolGraphId].filter(Boolean);
    await Promise.all(graphIds.map((graphId) => cleanupGraph(graphId)));

    if (testProjectId) {
      try {
        await app.get(ProjectsDao).deleteById(testProjectId);
      } catch {
        // best effort cleanup
      }
    }

    await app.close();
  }, 180_000);

  beforeEach(() => {
    getMockLlm(app).reset();
  });

  it(
    'agent uses tool_search to find and load a tool',
    { timeout: 120_000 },
    async () => {
      const mockLlm = getMockLlm(app);

      // Turn 1: agent does not have shell bound yet — calls tool_search to discover it.
      mockLlm.onChat(
        { callIndex: 0 },
        { kind: 'toolCall', toolName: 'tool_search', args: { query: 'shell' } },
      );

      // Turn 2: shell is now bound — agent calls it with the requested command.
      mockLlm.onChat(
        { hasTools: ['shell'] },
        {
          kind: 'toolCall',
          toolName: 'shell',
          args: { purpose: 'run echo', command: 'echo hello world' },
        },
      );

      // Turn 3: after the shell result arrives, the agent finishes.
      // Combined matcher (specificity 2) beats the hasTools-only shell fixture (specificity 1).
      mockLlm.onChat(
        { hasToolResult: 'shell', hasTools: ['finish'] },
        {
          kind: 'toolCall',
          toolName: 'finish',
          args: {
            purpose: 'done',
            message: 'Shell executed.',
            needsMoreInfo: false,
          },
        },
      );

      await ensureGraphRunning(shellOnlyGraphId);

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        shellOnlyGraphId,
        TRIGGER_NODE_ID,
        {
          messages: [
            "Use tool_search to find the shell tool, then use the shell tool to run 'echo hello world'",
          ],
          async: false,
          threadSubId: uniqueThreadSubId('deferred-tool-search'),
        },
      );

      expect(execution.externalThreadId).toBeDefined();

      const thread = await waitForThreadCompletion(execution.externalThreadId);
      expect(THREAD_COMPLETION_STATUSES).toContain(thread.status);

      const messages = await getThreadMessages(execution.externalThreadId);
      const rawMessages = messages.map((m) => m.message);

      const toolSearchCall = rawMessages.find(
        (m) =>
          m.role === 'ai' &&
          Array.isArray(m.toolCalls) &&
          m.toolCalls.some((tc) => tc.name === 'tool_search'),
      );
      expect(toolSearchCall).toBeDefined();

      const shellToolCall = rawMessages.find(
        (m) =>
          m.role === 'ai' &&
          Array.isArray(m.toolCalls) &&
          m.toolCalls.some((tc) => tc.name === 'shell'),
      );
      expect(shellToolCall).toBeDefined();

      const shellResult = rawMessages.find(
        (m) => m.role === 'tool' && m.name === 'shell',
      );
      expect(shellResult).toBeDefined();
    },
  );

  it(
    'tool_search results include deferred tools',
    { timeout: 120_000 },
    async () => {
      const mockLlm = getMockLlm(app);

      // Turn 1: agent calls tool_search to discover file-related tools.
      mockLlm.onChat(
        { callIndex: 0 },
        { kind: 'toolCall', toolName: 'tool_search', args: { query: 'file' } },
      );

      // Turn 2: after the tool_search result arrives, the agent reports and finishes.
      // Combined matcher (specificity 2) is unambiguous.
      mockLlm.onChat(
        { hasToolResult: 'tool_search', hasTools: ['finish'] },
        {
          kind: 'toolCall',
          toolName: 'finish',
          args: {
            purpose: 'done',
            message: 'Found file tools via tool_search.',
            needsMoreInfo: false,
          },
        },
      );

      await ensureGraphRunning(multiToolGraphId);

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        multiToolGraphId,
        TRIGGER_NODE_ID,
        {
          messages: [
            "Use tool_search to search for 'file' tools. Tell me what tools you found.",
          ],
          async: false,
          threadSubId: uniqueThreadSubId('deferred-tool-search-results'),
        },
      );

      expect(execution.externalThreadId).toBeDefined();

      const thread = await waitForThreadCompletion(execution.externalThreadId);
      expect(thread.status).toBe(ThreadStatus.Done);

      const messages = await getThreadMessages(execution.externalThreadId);
      const rawMessages = messages.map((m) => m.message);

      const toolSearchCall = rawMessages.find(
        (m) =>
          m.role === 'ai' &&
          Array.isArray(m.toolCalls) &&
          m.toolCalls.some((tc) => tc.name === 'tool_search'),
      );
      expect(toolSearchCall).toBeDefined();

      const toolSearchResult = rawMessages.find(
        (m) => m.role === 'tool' && m.name === 'tool_search',
      );
      expect(toolSearchResult).toBeDefined();

      if (toolSearchResult && toolSearchResult.role === 'tool') {
        const content = toolSearchResult.content as {
          results?: { name: string }[];
          message?: string;
        };
        const hasFileResults =
          (Array.isArray(content.results) &&
            content.results.some((r) =>
              r.name.toLowerCase().includes('file'),
            )) ||
          (typeof content.message === 'string' &&
            content.message.toLowerCase().includes('file'));
        expect(hasFileResults).toBe(true);
      }

      const finishMessage = rawMessages.find(
        (m) => m.role === 'tool' && m.name === 'finish',
      );
      expect(finishMessage).toBeDefined();
    },
  );

  it(
    'auto-search fallback loads deferred tool when called directly',
    { timeout: 120_000 },
    async () => {
      const mockLlm = getMockLlm(app);

      // Turn 1: agent calls shell directly without tool_search — the runtime's
      // auto-search fallback should bind the tool transparently.
      mockLlm.onChat(
        { callIndex: 0 },
        {
          kind: 'toolCall',
          toolName: 'shell',
          args: { purpose: 'run echo', command: 'echo auto-fallback test' },
        },
      );

      // Turn 2: after the shell result arrives, the agent finishes.
      // Combined matcher (specificity 2) beats any single-field matcher.
      mockLlm.onChat(
        { hasToolResult: 'shell', hasTools: ['finish'] },
        {
          kind: 'toolCall',
          toolName: 'finish',
          args: {
            purpose: 'done',
            message: 'Auto-fallback executed.',
            needsMoreInfo: false,
          },
        },
      );

      await ensureGraphRunning(shellOnlyGraphId);

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        shellOnlyGraphId,
        TRIGGER_NODE_ID,
        {
          messages: [
            "Run the shell command 'echo auto-fallback test'. You can call the shell tool directly.",
          ],
          async: false,
          threadSubId: uniqueThreadSubId('deferred-auto-fallback'),
        },
      );

      expect(execution.externalThreadId).toBeDefined();

      const thread = await waitForThreadCompletion(execution.externalThreadId);
      expect(THREAD_COMPLETION_STATUSES).toContain(thread.status);

      const messages = await getThreadMessages(execution.externalThreadId);
      const rawMessages = messages.map((m) => m.message);

      const shellToolUsed = rawMessages.some(
        (m) =>
          (m.role === 'ai' &&
            Array.isArray(m.toolCalls) &&
            m.toolCalls.some((tc) => tc.name === 'shell')) ||
          (m.role === 'tool' && m.name === 'shell'),
      );
      expect(shellToolUsed).toBe(true);
    },
  );
});
