import { INestApplication } from '@nestjs/common';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { AiSuggestionsController } from '../../../v1/ai-suggestions/controllers/ai-suggestions.controller';
import { SuggestAgentInstructionsDto } from '../../../v1/ai-suggestions/dto/ai-suggestions.dto';
import { AiSuggestionsService } from '../../../v1/ai-suggestions/services/ai-suggestions.service';
import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import {
  GraphStatus,
  MessageRole,
  NodeKind,
} from '../../../v1/graphs/graphs.types';
import { GraphRegistry } from '../../../v1/graphs/services/graph-registry';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { LiteLlmClient } from '../../../v1/litellm/services/litellm.client';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { MessagesDao } from '../../../v1/threads/dao/messages.dao';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { createMockGraphData } from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import { mockLiteLlmClient } from '../helpers/test-stubs';
import { getMockLlm } from '../mocks/mock-llm';
import { createTestModule, TEST_USER_ID } from '../setup';

let app: INestApplication;
let controller: AiSuggestionsController;
let graphsService: GraphsService;
let graphRegistry: GraphRegistry;
let aiSuggestionsService: AiSuggestionsService;
let graphDao: GraphDao;
let projectsDao: ProjectsDao;
let threadsDao: ThreadsDao;
let messagesDao: MessagesDao;
let testProjectId: string;
// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

beforeAll(async () => {
  app = await createTestModule(async (moduleBuilder) =>
    moduleBuilder
      .overrideProvider(LiteLlmClient)
      .useValue(mockLiteLlmClient)
      .compile(),
  );
  controller = app.get(AiSuggestionsController);
  graphsService = app.get(GraphsService);
  graphRegistry = app.get(GraphRegistry);
  aiSuggestionsService = app.get(AiSuggestionsService);
  graphDao = app.get(GraphDao);
  projectsDao = app.get(ProjectsDao);
  threadsDao = app.get(ThreadsDao);
  messagesDao = app.get(MessagesDao);

  const projectResult = await createTestProject(app);
  testProjectId = projectResult.projectId;
  contextDataStorage = projectResult.ctx;
}, 180_000);

afterAll(async () => {
  if (testProjectId) {
    try {
      await projectsDao.deleteById(testProjectId);
    } catch {
      // best effort cleanup
    }
  }
  await app?.close();
}, 180_000);

describe('AiSuggestionsController (integration)', () => {
  let runningGraphId: string;
  let stoppedGraphId: string;

  const cleanupGraph = async (graphId: string) => {
    try {
      await graphsService.destroy(contextDataStorage, graphId);
    } catch {
      // Graph might not be running or may already be removed
    }

    try {
      await graphsService.delete(contextDataStorage, graphId);
    } catch {
      // Graph may already be deleted
    }
  };

  beforeAll(async () => {
    const runningGraph = await graphsService.create(
      contextDataStorage,
      createMockGraphData(),
    );
    runningGraphId = runningGraph.id;
    await graphsService.run(contextDataStorage, runningGraphId);

    const stoppedGraph = await graphsService.create(
      contextDataStorage,
      createMockGraphData(),
    );
    stoppedGraphId = stoppedGraph.id;
  }, 180_000);

  afterAll(async () => {
    const graphIds = [runningGraphId, stoppedGraphId].filter(Boolean);
    await Promise.all(graphIds.map((id) => cleanupGraph(id)));
  }, 180_000);

  beforeEach(() => {
    getMockLlm(app).reset();
  });

  const ensureGraphRunning = async (graphId: string) => {
    const graph = await graphsService.findById(contextDataStorage, graphId);
    if (graph.status === GraphStatus.Running) {
      return;
    }
    await graphsService.run(contextDataStorage, graphId);
  };

  describe('agent instructions', () => {
    it('returns suggested instructions for a running graph', async () => {
      await ensureGraphRunning(runningGraphId);

      getMockLlm(app).onChat(
        { systemMessage: /rewrite agent system instructions/i },
        {
          kind: 'text',
          content: 'You are a helpful test agent. Answer briefly.',
        },
      );

      const response = await controller.suggestAgentInstructions(
        runningGraphId,
        'agent-1',
        {
          userRequest: 'Shorten the instructions',
        } as SuggestAgentInstructionsDto,
        contextDataStorage,
      );

      expect(response.instructions).toBe(
        'You are a helpful test agent. Answer briefly.',
      );
      expect(response.threadId).toBeDefined();
    }, 30000);

    it('returns error for a non-running graph', async () => {
      await expect(
        controller.suggestAgentInstructions(
          stoppedGraphId,
          'agent-1',
          {
            userRequest: 'Add safety notes',
            threadId: 'thread-stopped',
          } as SuggestAgentInstructionsDto,
          contextDataStorage,
        ),
      ).rejects.toThrowError();
    });

    it(
      'returns generated threadId when not provided',
      { timeout: 30000 },
      async () => {
        await ensureGraphRunning(runningGraphId);

        getMockLlm(app).onChat(
          { systemMessage: /rewrite agent system instructions/i },
          {
            kind: 'text',
            content: 'No thread provided — improved instructions.',
          },
        );

        const response = await controller.suggestAgentInstructions(
          runningGraphId,
          'agent-1',
          { userRequest: 'No thread provided' } as SuggestAgentInstructionsDto,
          contextDataStorage,
        );

        expect(response.instructions).toBe(
          'No thread provided — improved instructions.',
        );
        expect(response.threadId).toBeDefined();
      },
    );
  });
});

describe('AiSuggestionsService (integration)', () => {
  const createdGraphs: string[] = [];
  const createdThreads: string[] = [];
  let serviceTestProjectId: string;

  beforeAll(async () => {
    const project = await projectsDao.create({
      name: 'AI Suggestions Service Test Project',
      createdBy: TEST_USER_ID,
      settings: {},
    });
    serviceTestProjectId = project.id;
  });

  beforeEach(() => {
    getMockLlm(app).reset();
  });

  afterEach(async () => {
    for (const threadId of createdThreads) {
      await messagesDao.hardDelete({ threadId });
      await threadsDao.deleteById(threadId);
    }
    createdThreads.length = 0;

    for (const graphId of createdGraphs) {
      await graphRegistry.destroy(graphId).catch(() => undefined);
      await graphDao.deleteById(graphId);
    }
    createdGraphs.length = 0;
  });

  afterAll(async () => {
    await projectsDao.deleteById(serviceTestProjectId);
    // app closed at file-level afterAll
  });

  it(
    'analyzes a thread and calls LLM with cleaned messages',
    { timeout: 30000 },
    async () => {
      const graph = await graphDao.create({
        name: 'ai-suggestions-graph',
        description: 'test graph',
        error: undefined,
        version: '1.0.0',
        targetVersion: '1.0.0',
        schema: {
          nodes: [
            {
              id: 'agent-1',
              template: 'simple-agent',
              config: { name: 'Primary agent', instructions: 'Do it' },
            },
            { id: 'tool-1', template: 'search-tool', config: {} },
          ],
          edges: [{ from: 'agent-1', to: 'tool-1' }],
        },
        status: GraphStatus.Running,
        metadata: {},
        createdBy: TEST_USER_ID,
        projectId: serviceTestProjectId,
        temporary: false,
      });
      createdGraphs.push(graph.id);

      const agentInstance = {} as unknown;
      const toolInstance = {
        name: 'Search',
        description: 'Search the web',
        __instructions: 'Use it wisely',
      };

      graphRegistry.register(graph.id, {
        metadata: {
          graphId: graph.id,
          version: '1.0.0',
          graph_created_by: TEST_USER_ID,
          graph_project_id: serviceTestProjectId,
          llmRequestContext: { models: undefined },
        },
        nodes: new Map([
          [
            'agent-1',
            {
              id: 'agent-1',
              type: NodeKind.SimpleAgent,
              template: 'simple-agent',
              instance: agentInstance,
              handle: {
                provide: async () => agentInstance,
                configure: async () => undefined,
                destroy: async () => undefined,
              },
              config: { name: 'Primary agent', instructions: 'Do it' },
            },
          ],
          [
            'tool-1',
            {
              id: 'tool-1',
              type: NodeKind.Tool,
              template: 'search-tool',
              instance: toolInstance,
              handle: {
                provide: async () => toolInstance,
                configure: async () => undefined,
                destroy: async () => undefined,
              },
              config: {},
            },
          ],
        ]),
        edges: [{ from: 'agent-1', to: 'tool-1' }],
        state: {} as never,
        destroy: async () => undefined,
        status: GraphStatus.Running,
      });

      const thread = await threadsDao.create({
        graphId: graph.id,
        createdBy: TEST_USER_ID,
        projectId: serviceTestProjectId,
        externalThreadId: `ext-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        metadata: {},
        source: undefined,
        name: 'Test thread',
        status: ThreadStatus.Running,
      });
      createdThreads.push(thread.id);

      await messagesDao.create({
        threadId: thread.id,
        externalThreadId: thread.externalThreadId,
        nodeId: 'agent-1',
        message: { role: MessageRole.System, content: 'System intro' },
      });
      await messagesDao.create({
        threadId: thread.id,
        externalThreadId: thread.externalThreadId,
        nodeId: 'agent-1',
        message: { role: MessageRole.Human, content: 'Hello' },
      });
      await messagesDao.create({
        threadId: thread.id,
        externalThreadId: thread.externalThreadId,
        nodeId: 'agent-1',
        message: {
          role: MessageRole.AI,
          content: 'Calling tool',
          toolCalls: [
            {
              name: 'search',
              args: { query: 'hi' },
              type: 'tool_call',
              id: 'call-1',
            },
          ],
        },
      });
      await messagesDao.create({
        threadId: thread.id,
        externalThreadId: thread.externalThreadId,
        nodeId: 'tool-1',
        message: {
          role: MessageRole.Tool,
          name: 'search',
          content: { result: 'ok' },
          toolCallId: '1',
        },
      });
      await messagesDao.create({
        threadId: thread.id,
        externalThreadId: thread.externalThreadId,
        nodeId: 'tool-1',
        message: {
          role: MessageRole.Tool,
          name: 'shell',
          content: { stdout: 'done', stderr: '', exitCode: 0 },
          toolCallId: '2',
        },
      });

      getMockLlm(app).onChat(
        { systemMessage: /expert AI \/ agent-ops reviewer/i },
        {
          kind: 'text',
          content: 'Tool usage was efficient. No inefficiencies detected.',
        },
      );

      const result = await aiSuggestionsService.analyzeThread(
        contextDataStorage,
        thread.id,
        {
          userInput: 'Please check tools',
        },
      );

      expect(result.analysis).toBe(
        'Tool usage was efficient. No inefficiencies detected.',
      );
      expect(result.conversationId).toBeDefined();
    },
  );
});
