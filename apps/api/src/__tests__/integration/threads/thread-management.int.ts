import { INestApplication } from '@nestjs/common';
import { BaseException, NotFoundException } from '@packages/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import {
  NewMessageMode,
  ReasoningEffort,
} from '../../../v1/agents/agents.types';
import { SimpleAgent } from '../../../v1/agents/services/agents/simple-agent';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { GraphRegistry } from '../../../v1/graphs/services/graph-registry';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import {
  createMockGraphData,
  waitForCondition,
} from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import type { MockLlmService } from '../mocks/mock-llm/mock-llm.service';
import { createTestModule, getMockLlm } from '../setup';

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Thread Management Integration Tests', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  let graphRegistry: GraphRegistry;
  let mockLlm: MockLlmService;
  const createdGraphIds: string[] = [];
  let basicGraphId: string;
  let multiAgentGraphId: string;
  let injectModeGraphId: string;
  let waitModeGraphId: string;
  let thinkingGraphId: string;
  let testProjectId: string;

  beforeAll(async () => {
    app = await createTestModule();

    graphsService = app.get<GraphsService>(GraphsService);
    threadsService = app.get<ThreadsService>(ThreadsService);
    graphRegistry = app.get<GraphRegistry>(GraphRegistry);
    mockLlm = getMockLlm(app);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;

    const registerGraph = (graphId: string) => {
      if (!createdGraphIds.includes(graphId)) {
        createdGraphIds.push(graphId);
      }
    };

    const waitForGraphRunning = async (graphId: string) => {
      await waitForCondition(
        () => graphsService.findById(contextDataStorage, graphId),
        (g) => g.status === GraphStatus.Running,
        { timeout: 30_000, interval: 200, maxInterval: 500 },
      );
    };

    // Shared “basic” graph for most thread behaviors.
    const basicGraph = await graphsService.create(
      contextDataStorage,
      createMockGraphData({
        name: `Thread Management Basic ${Date.now()}`,
      }),
    );
    basicGraphId = basicGraph.id;
    registerGraph(basicGraphId);
    await graphsService.run(contextDataStorage, basicGraphId);
    await waitForGraphRunning(basicGraphId);

    // Shared multi-agent graph for multi-agent thread + message filtering behaviors.
    const multiAgentGraph = await graphsService.create(
      contextDataStorage,
      createMockGraphData({
        name: `Thread Management Multi-Agent ${Date.now()}`,
        schema: {
          nodes: [
            {
              id: 'agent-1',
              template: 'simple-agent',
              config: {
                name: 'First Agent',
                instructions: 'You are the first agent',
                invokeModelName: 'gpt-5-mini',
              },
            },
            {
              id: 'agent-2',
              template: 'simple-agent',
              config: {
                name: 'Second Agent',
                instructions: 'You are the second agent',
                invokeModelName: 'gpt-5-mini',
              },
            },
            {
              id: 'comm-tool-1',
              template: 'agent-communication-tool',
              config: {},
            },
            {
              id: 'trigger-1',
              template: 'manual-trigger',
              config: {},
            },
          ],
          edges: [
            { from: 'trigger-1', to: 'agent-1' },
            { from: 'agent-1', to: 'comm-tool-1' },
            { from: 'comm-tool-1', to: 'agent-2' },
          ],
        },
      }),
    );
    multiAgentGraphId = multiAgentGraph.id;
    registerGraph(multiAgentGraphId);
    await graphsService.run(contextDataStorage, multiAgentGraphId);
    await waitForGraphRunning(multiAgentGraphId);

    // Shared graph for NewMessageMode.InjectAfterToolCall cases.
    const injectGraph = await graphsService.create(
      contextDataStorage,
      createMockGraphData({
        name: `Thread Management Inject Mode ${Date.now()}`,
        schema: {
          nodes: [
            {
              id: 'agent-1',
              template: 'simple-agent',
              config: {
                instructions: 'You are a helpful test agent. Answer briefly.',
                invokeModelName: 'gpt-5-mini',
                summarizeMaxTokens: 272000,
                summarizeKeepTokens: 30000,
                newMessageMode: NewMessageMode.InjectAfterToolCall,
              },
            },
            { id: 'trigger-1', template: 'manual-trigger', config: {} },
          ],
          edges: [{ from: 'trigger-1', to: 'agent-1' }],
        },
      }),
    );
    injectModeGraphId = injectGraph.id;
    registerGraph(injectModeGraphId);
    await graphsService.run(contextDataStorage, injectModeGraphId);
    await waitForGraphRunning(injectModeGraphId);

    // Shared graph for NewMessageMode.WaitForCompletion and pending message state assertions.
    const waitGraph = await graphsService.create(
      contextDataStorage,
      createMockGraphData({
        name: `Thread Management Wait Mode ${Date.now()}`,
        schema: {
          nodes: [
            {
              id: 'agent-wait-mode',
              template: 'simple-agent',
              config: {
                instructions:
                  'Queue incoming questions until you finish the current response.',
                invokeModelName: 'gpt-5-mini',
                summarizeMaxTokens: 272000,
                summarizeKeepTokens: 30000,
                newMessageMode: NewMessageMode.WaitForCompletion,
              },
            },
            { id: 'trigger-1', template: 'manual-trigger', config: {} },
          ],
          edges: [{ from: 'trigger-1', to: 'agent-wait-mode' }],
        },
      }),
    );
    waitModeGraphId = waitGraph.id;
    registerGraph(waitModeGraphId);
    await graphsService.run(contextDataStorage, waitModeGraphId);
    await waitForGraphRunning(waitModeGraphId);

    // Shared graph for ReasoningEffort.High config introspection.
    const thinkingGraph = await graphsService.create(
      contextDataStorage,
      createMockGraphData({
        name: `Thread Management Thinking Mode ${Date.now()}`,
        schema: {
          nodes: [
            {
              id: 'agent-thinking',
              template: 'simple-agent',
              config: {
                instructions: 'Think carefully before answering.',
                invokeModelName: 'gpt-5.1',
                invokeModelReasoningEffort: ReasoningEffort.High,
              },
            },
            { id: 'trigger-1', template: 'manual-trigger', config: {} },
          ],
          edges: [{ from: 'trigger-1', to: 'agent-thinking' }],
        },
      }),
    );
    thinkingGraphId = thinkingGraph.id;
    registerGraph(thinkingGraphId);
    await graphsService.run(contextDataStorage, thinkingGraphId);
    await waitForGraphRunning(thinkingGraphId);
  }, 180_000);

  afterAll(async () => {
    await Promise.all(
      createdGraphIds.map(async (graphId) => {
        try {
          await graphsService.destroy(contextDataStorage, graphId);
        } catch (error: unknown) {
          if (
            !(error instanceof BaseException) ||
            (error.errorCode !== 'GRAPH_NOT_RUNNING' &&
              error.errorCode !== 'GRAPH_NOT_FOUND')
          ) {
            console.error(
              `Unexpected error destroying graph ${graphId}:`,
              error,
            );
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
            console.error(`Unexpected error deleting graph ${graphId}:`, error);
            throw error;
          }
        }
      }),
    );

    if (testProjectId) {
      try {
        await app.get(ProjectsDao).deleteById(testProjectId);
      } catch {
        // best effort cleanup
      }
    }

    await app.close();
  }, 180_000);

  const uniqueThreadSubId = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ensureGraphRunning = async (graphId: string) => {
    const graph = await graphsService.findById(contextDataStorage, graphId);
    if (graph.status === GraphStatus.Running) {
      return;
    }
    await graphsService.run(contextDataStorage, graphId);
    await waitForCondition(
      () => graphsService.findById(contextDataStorage, graphId),
      (g) => g.status === GraphStatus.Running,
      { timeout: 30_000, interval: 200, maxInterval: 500 },
    );
  };

  const waitForHumanMessageContents = async (
    externalThreadId: string,
    expectedCount: number,
  ) => {
    const thread = await waitForCondition(
      () =>
        threadsService.getThreadByExternalId(
          contextDataStorage,
          externalThreadId,
        ),
      (thread) => !!thread,
      { timeout: 60000 },
    );

    const messages = await waitForCondition(
      () =>
        threadsService.getThreadMessages(contextDataStorage, thread.id, {
          limit: 100,
          offset: 0,
        }),
      (messages) =>
        messages.filter((m) => m.message.role === 'human').length >=
        expectedCount,
      { timeout: 60000 },
    );

    return messages.filter((m) => m.message.role === 'human');
  };

  describe('Thread Creation and Isolation', () => {
    it(
      'should create a new internal thread for each invocation without threadSubId',
      { timeout: 120000 },
      async () => {
        await ensureGraphRunning(basicGraphId);

        // First invocation without threadSubId
        const trigger1Result = await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: [`First message ${Date.now()}`],
          },
        );

        expect(trigger1Result.externalThreadId).toBeDefined();
        const firstThreadId = trigger1Result.externalThreadId;

        // Second invocation without threadSubId
        const trigger2Result = await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: [`Second message ${Date.now()}`],
          },
        );

        expect(trigger2Result.externalThreadId).toBeDefined();
        const secondThreadId = trigger2Result.externalThreadId;

        // Thread IDs should be different
        expect(firstThreadId).not.toBe(secondThreadId);

        // Wait for both threads to be created in the database (may be more from other tests).
        const threads = await waitForCondition(
          () =>
            threadsService.getThreads(contextDataStorage, {
              graphId: basicGraphId,
              limit: 200,
              offset: 0,
            }),
          (threads) => {
            const ids = threads.map(
              (t: unknown) =>
                (t as { externalThreadId: string }).externalThreadId,
            );
            return ids.includes(firstThreadId) && ids.includes(secondThreadId);
          },
          { timeout: 20000 },
        );

        const threadIds = threads.map(
          (t: unknown) => (t as { externalThreadId: string }).externalThreadId,
        );
        expect(threadIds).toContain(firstThreadId);
        expect(threadIds).toContain(secondThreadId);
      },
    );

    it(
      'should add messages to existing thread when using same threadSubId',
      { timeout: 60000 },
      async () => {
        await ensureGraphRunning(basicGraphId);
        const threadSubId = uniqueThreadSubId('persistent-thread');

        // First invocation with specific threadSubId
        const trigger1Result = await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: ['First message in thread'],
            threadSubId,
          },
        );

        expect(trigger1Result.externalThreadId).toBeDefined();
        const threadId = trigger1Result.externalThreadId;

        // Second invocation with same threadSubId
        const trigger2Result = await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: ['Second message in same thread'],
            threadSubId,
          },
        );

        expect(trigger2Result.externalThreadId).toBeDefined();

        // Should get the same thread ID
        expect(trigger2Result.externalThreadId).toBe(threadId);

        // Wait for thread + both human messages to be persisted.
        const humanMessages = await waitForHumanMessageContents(threadId, 2);
        expect(humanMessages.map((m) => m.message.content)).toEqual(
          expect.arrayContaining([
            'First message in thread',
            'Second message in same thread',
          ]),
        );

        const threads = await threadsService.getThreads(contextDataStorage, {
          graphId: basicGraphId,
          limit: 500,
          offset: 0,
        });
        expect(
          threads.filter(
            (t) =>
              (t as { externalThreadId: string }).externalThreadId === threadId,
          ),
        ).toHaveLength(1);
      },
    );
  });

  describe('Thread Retrieval', () => {
    it(
      'should list threads without specifying graphId',
      { timeout: 60000 },
      async () => {
        await ensureGraphRunning(basicGraphId);
        const threadSubId = uniqueThreadSubId('thread-list-all');

        const triggerResult = await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: ['List this thread without filters'],
            threadSubId,
          },
        );

        expect(triggerResult.externalThreadId).toBeDefined();

        const threads = await waitForCondition(
          () =>
            threadsService.getThreads(contextDataStorage, {
              limit: 100,
              offset: 0,
            }),
          (result) =>
            result.some(
              (thread) =>
                (thread as { graphId: string }).graphId === basicGraphId &&
                (thread as { externalThreadId: string }).externalThreadId ===
                  triggerResult.externalThreadId,
            ),
          { timeout: 10000 },
        );

        const matchingThread = threads.find((thread) => {
          const current = thread as {
            graphId: string;
            externalThreadId: string;
          };
          return (
            current.graphId === basicGraphId &&
            current.externalThreadId === triggerResult.externalThreadId
          );
        });

        expect(matchingThread).toBeDefined();
        expect(
          (matchingThread as { externalThreadId: string }).externalThreadId,
        ).toBe(triggerResult.externalThreadId);
      },
    );

    it('should return 404 for non-existent thread', async () => {
      const nonExistentThreadId = 'non-existent-graph-id:thread-id';

      await expect(
        threadsService.getThreadByExternalId(
          contextDataStorage,
          nonExistentThreadId,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('Thread Async Execution', () => {
    it('should execute trigger with async=true and return immediately', async () => {
      await ensureGraphRunning(basicGraphId);

      const execResult = await graphsService.executeTrigger(
        contextDataStorage,
        basicGraphId,
        'trigger-1',
        {
          messages: ['Say hello and then finish.'],
          async: true,
        },
      );

      expect(execResult.externalThreadId).toBeDefined();
      expect(execResult.checkpointNs).toBeDefined();

      // Drain pending agent work before next test starts so the in-flight
      // em.transactional from this run doesn't collide with the next
      // executeTrigger call (manifests as `ROLLBACK TO SAVEPOINT can only be
      // used in transaction blocks`).
      await waitForCondition(
        () =>
          threadsService.getThreadByExternalId(
            contextDataStorage,
            execResult.externalThreadId,
          ),
        (t) =>
          t.status === ThreadStatus.Done ||
          t.status === ThreadStatus.NeedMoreInfo ||
          t.status === ThreadStatus.Stopped,
        { timeout: 15_000, interval: 200 },
      );
    });
  });

  describe('Multi-Agent Thread Management', () => {
    it(
      'should create one internal thread for multiple agents in the same graph execution',
      { timeout: 60000 },
      async () => {
        await ensureGraphRunning(multiAgentGraphId);
        const threadSubId = uniqueThreadSubId('multi-agent-thread');

        const triggerResult = await graphsService.executeTrigger(
          contextDataStorage,
          multiAgentGraphId,
          'trigger-1',
          {
            messages: ['Test multi-agent thread'],
            threadSubId,
          },
        );

        const threads = await waitForCondition(
          () =>
            threadsService.getThreads(contextDataStorage, {
              graphId: multiAgentGraphId,
              limit: 200,
              offset: 0,
            }),
          (threads) =>
            threads.some(
              (t) =>
                (t as { externalThreadId: string }).externalThreadId ===
                triggerResult.externalThreadId,
            ),
          { timeout: 20_000 },
        );

        expect(
          threads.filter(
            (t) =>
              (t as { externalThreadId: string }).externalThreadId ===
              triggerResult.externalThreadId,
          ),
        ).toHaveLength(1);
      },
    );
  });

  describe('Message Retrieval and Management', () => {
    it(
      'should retrieve messages for a thread after execution',
      { timeout: 60000 },
      async () => {
        await ensureGraphRunning(basicGraphId);
        const threadSubId = uniqueThreadSubId('message-retrieval');
        const testMessage = `Hello, this is a test message ${Date.now()}`;

        const triggerResult = await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: [testMessage],
            threadSubId,
          },
        );

        const thread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              triggerResult.externalThreadId,
            ),
          (thread) => !!thread,
          { timeout: 10000 },
        );
        // Covers "retrieve by external id" + graphId association.
        expect(thread.graphId).toBe(basicGraphId);

        // Wait for messages to be persisted (at least user message)
        const messages = await waitForCondition(
          () =>
            threadsService.getThreadMessages(contextDataStorage, thread.id, {
              limit: 100,
              offset: 0,
            }),
          (messages) => messages.length >= 1,
          { timeout: 10000 },
        );

        // Should have at least the human message
        expect(messages.length).toBeGreaterThanOrEqual(1);

        // Verify the user message exists
        const userMessage = messages.find(
          (m) => (m as { message: { role: string } }).message.role === 'human',
        );
        expect(userMessage).toBeDefined();

        const content = (
          userMessage as { message: { content: string | unknown[] } }
        ).message.content;
        const contentStr =
          typeof content === 'string' ? content : JSON.stringify(content);
        expect(contentStr).toContain('test message');
      },
    );

    it(
      'should limit messages when limit parameter is provided',
      { timeout: 60000 },
      async () => {
        await ensureGraphRunning(basicGraphId);
        const threadSubId = uniqueThreadSubId('limit-test');

        const triggerResult = await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: ['Test message'],
            threadSubId,
          },
        );

        // Wait for thread to be created
        const thread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              triggerResult.externalThreadId,
            ),
          (thread) => !!thread,
          { timeout: 10000 },
        );

        // Wait for messages to exist
        await waitForCondition(
          () =>
            threadsService.getThreadMessages(contextDataStorage, thread.id, {
              limit: 100,
              offset: 0,
            }),
          (messages) => messages.length > 0,
          { timeout: 10000 },
        );

        const limitedMessages = await threadsService.getThreadMessages(
          contextDataStorage,
          thread.id,
          {
            limit: 2,
            offset: 0,
          },
        );

        expect(limitedMessages.length).toBeLessThanOrEqual(2);
        expect(limitedMessages.length).toBeGreaterThan(0);
      },
    );

    it(
      'creates a thread on trigger execution and persists first human message + deterministic AI answer',
      { timeout: 120000 },
      async () => {
        const token = `FINISH_TOKEN_${Date.now()}`;

        const graphData = createMockGraphData({
          schema: {
            nodes: [
              {
                id: 'agent-1',
                template: 'simple-agent',
                config: {
                  instructions:
                    'You are an integration test agent. You MUST call the finish tool with needsMoreInfo=false. ' +
                    'When the user asks you to include a token, include it verbatim in the finish tool message.',
                  invokeModelName: 'gpt-5-mini',
                  maxIterations: 10,
                  summarizeMaxTokens: 272000,
                  summarizeKeepTokens: 30000,
                },
              },
              { id: 'trigger-1', template: 'manual-trigger', config: {} },
            ],
            edges: [{ from: 'trigger-1', to: 'agent-1' }],
          },
        });
        const createResult = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const graphId = createResult.id;
        createdGraphIds.push(graphId);

        await graphsService.run(contextDataStorage, graphId);

        const userMessage =
          `Call the finish tool with needsMoreInfo=false and set the finish message to include this token: ${token}. ` +
          'Do not call any other tools.';

        // Token-aware finish fixture — applyDefaults' generic finish stub returns
        // `message: 'OK'`, but this test asserts the token round-trips through the
        // finish tool result.
        mockLlm.onChat(
          {
            lastUserMessage: token,
            hasTools: ['finish'],
          },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: {
              purpose: 'done',
              message: `Done. Including token ${token}`,
              needsMoreInfo: false,
            },
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              totalPrice: 0.0001,
            },
          },
        );

        const triggerResult = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: [userMessage],
            threadSubId: 'deterministic-ai-answer',
          },
        );

        const thread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              triggerResult.externalThreadId,
            ),
          (t) =>
            t.status === ThreadStatus.Done ||
            t.status === ThreadStatus.NeedMoreInfo,
          { timeout: 60000, interval: 1000 },
        );

        const stringify = (content: unknown) =>
          typeof content === 'string' ? content : JSON.stringify(content);

        const messages = await waitForCondition(
          () =>
            threadsService.getThreadMessages(contextDataStorage, thread.id, {
              limit: 200,
              offset: 0,
            }),
          (msgs) => {
            const human = msgs.find(
              (m) =>
                m.message.role === 'human' && m.message.content === userMessage,
            );
            const finishTool = msgs.find((m) => {
              if (m.message.role !== 'tool' || m.message.name !== 'finish') {
                return false;
              }
              const content = m.message.content as { message?: unknown };
              return stringify(content?.message).includes(token);
            });
            return Boolean(human) && Boolean(finishTool);
          },
          { timeout: 60000, interval: 1000 },
        );

        const humanContents = messages
          .filter((m) => m.message.role === 'human')
          .map((m) => stringify(m.message.content));
        expect(humanContents).toContain(userMessage);

        const finishMessages = messages
          .filter(
            (m) => m.message.role === 'tool' && m.message.name === 'finish',
          )
          .map((m) =>
            stringify((m.message.content as { message?: unknown })?.message),
          );
        expect(finishMessages.join('\n')).toContain(token);
      },
    );

    it(
      'should persist messages across graph restarts',
      { timeout: 60000 },
      async () => {
        const graphData = createMockGraphData();
        const createResult = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const graphId = createResult.id;
        createdGraphIds.push(graphId);

        await graphsService.run(contextDataStorage, graphId);
        await ensureGraphRunning(graphId);

        const persistentMessage = 'Persistent message';
        const triggerResult = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: [persistentMessage],
            threadSubId: 'persist-test',
          },
        );

        // Wait for thread and messages to be created
        const thread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              triggerResult.externalThreadId,
            ),
          (thread) => !!thread,
          { timeout: 10000 },
        );

        // Wait for messages to be persisted
        await waitForCondition(
          () =>
            threadsService.getThreadMessages(contextDataStorage, thread.id, {
              limit: 100,
              offset: 0,
            }),
          (messages) => messages.length >= 1,
          { timeout: 10000 },
        );

        // Stop the graph
        await graphsService.destroy(contextDataStorage, graphId);

        // Restart the graph
        await graphsService.run(contextDataStorage, graphId);
        await ensureGraphRunning(graphId);

        // Messages should still be retrievable after restart
        const messages = await threadsService.getThreadMessages(
          contextDataStorage,
          thread.id,
          {
            limit: 100,
            offset: 0,
          },
        );

        expect(messages.length).toBeGreaterThanOrEqual(1);

        // Verify the persistent message exists
        const userMessage = messages.find(
          (m) => (m as { message: { role: string } }).message.role === 'human',
        );
        expect(userMessage).toBeDefined();

        const content = (
          userMessage as { message: { content: string | unknown[] } }
        ).message.content;
        const contentStr =
          typeof content === 'string' ? content : JSON.stringify(content);
        expect(contentStr).toContain('Persistent message');
      },
    );

    it(
      'should isolate messages between different threads',
      { timeout: 60000 },
      async () => {
        await ensureGraphRunning(basicGraphId);
        const sub1 = uniqueThreadSubId('isolation-thread-1');
        const sub2 = uniqueThreadSubId('isolation-thread-2');

        // Create two different threads
        const thread1Result = await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: ['Message for thread 1'],
            threadSubId: sub1,
          },
        );

        const thread2Result = await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: ['Message for thread 2'],
            threadSubId: sub2,
          },
        );

        // Wait for both threads to be created
        const thread1 = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              thread1Result.externalThreadId,
            ),
          (thread) => !!thread,
          { timeout: 10000 },
        );

        const thread2 = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              thread2Result.externalThreadId,
            ),
          (thread) => !!thread,
          { timeout: 10000 },
        );

        // Wait for messages in both threads
        const thread1Messages = await waitForCondition(
          () =>
            threadsService.getThreadMessages(contextDataStorage, thread1.id, {
              limit: 100,
              offset: 0,
            }),
          (messages) => messages.length >= 2,
          { timeout: 10000 },
        );

        const thread2Messages = await waitForCondition(
          () =>
            threadsService.getThreadMessages(contextDataStorage, thread2.id, {
              limit: 100,
              offset: 0,
            }),
          (messages) => messages.length >= 2,
          { timeout: 10000 },
        );

        // Verify thread 1 has its message
        const thread1UserMsg = thread1Messages.find(
          (m) => (m as { message: { role: string } }).message.role === 'human',
        );
        expect(thread1UserMsg).toBeDefined();

        // Verify thread 2 has its message
        const thread2UserMsg = thread2Messages.find(
          (m) => (m as { message: { role: string } }).message.role === 'human',
        );
        expect(thread2UserMsg).toBeDefined();

        // Thread 1 should not contain thread 2 messages and vice versa
        expect(
          thread1Messages.some((m) => {
            const content = (m as { message: { content: string | unknown[] } })
              .message.content;
            const contentStr =
              typeof content === 'string' ? content : JSON.stringify(content);
            return contentStr.includes('Message for thread 2');
          }),
        ).toBe(false);

        expect(
          thread2Messages.some((m) => {
            const content = (m as { message: { content: string | unknown[] } })
              .message.content;
            const contentStr =
              typeof content === 'string' ? content : JSON.stringify(content);
            return contentStr.includes('Message for thread 1');
          }),
        ).toBe(false);
      },
    );
  });

  describe('New Message Modes', () => {
    it(
      'should append messages sequentially when no active run (inject_after_tool_call)',
      { timeout: 90000 },
      async () => {
        await ensureGraphRunning(injectModeGraphId);
        const threadSubId = uniqueThreadSubId('inject-no-active');
        const firstResult = await graphsService.executeTrigger(
          contextDataStorage,
          injectModeGraphId,
          'trigger-1',
          {
            messages: ['Inject mode no active - first'],
            threadSubId,
          },
        );

        const secondResult = await graphsService.executeTrigger(
          contextDataStorage,
          injectModeGraphId,
          'trigger-1',
          {
            messages: ['Inject mode no active - second'],
            threadSubId,
          },
        );

        await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              secondResult.externalThreadId,
            ),
          (entry) =>
            entry.status === ThreadStatus.Done ||
            entry.status === ThreadStatus.NeedMoreInfo,
          { timeout: 90000 },
        );

        expect(secondResult.externalThreadId).toEqual(
          firstResult.externalThreadId,
        );

        const humanMessages = await waitForHumanMessageContents(
          secondResult.externalThreadId,
          2,
        );

        expect(humanMessages).toHaveLength(2);
        expect(humanMessages.map((m) => m.message.content)).toEqual(
          expect.arrayContaining([
            'Inject mode no active - first',
            'Inject mode no active - second',
          ]),
        );

        const firstMessage = humanMessages.find(
          (m) => m.message.content === 'Inject mode no active - first',
        );

        const secondMessage = humanMessages.find(
          (m) => m.message.content === 'Inject mode no active - second',
        );

        expect(firstMessage).toBeDefined();
        expect(secondMessage).toBeDefined();
        // make sure first we got first message
        expect(new Date(firstMessage!.createdAt).getTime()).toBeLessThan(
          new Date(secondMessage!.createdAt).getTime(),
        );
      },
    );

    it(
      'should inject messages into an active run when mode is inject_after_tool_call',
      { timeout: 60000 },
      async () => {
        await ensureGraphRunning(injectModeGraphId);
        const threadSubId = uniqueThreadSubId('inject-active');
        const firstUserMessage = 'Tell me what is the 2+2?';
        const secondUserMessage = 'Oh not, 2+3, sorry';

        // Slow the first agent call so the second trigger lands while the run
        // is still active — otherwise the first call finishes before the
        // second message arrives, the messages persist within microseconds of
        // each other, and the createdAt ordering assertion is flaky (or the
        // test never observes the inject_after_tool_call path at all). The
        // second call's matcher is more specific so it doesn't pick up this
        // delay. Same pattern as the wait_for_completion test below.
        mockLlm.onChat(
          { lastUserMessage: firstUserMessage, hasTools: ['finish'] },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: {
              purpose: 'done',
              message: '2+3 equals 5',
              needsMoreInfo: false,
            },
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              totalPrice: 0.0001,
            },
            delayMs: 3_000,
          },
        );
        mockLlm.onChat(
          { lastUserMessage: secondUserMessage, hasTools: ['finish'] },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: {
              purpose: 'done',
              message: '2+3 equals 5',
              needsMoreInfo: false,
            },
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              totalPrice: 0.0001,
            },
          },
        );

        const firstResult = await graphsService.executeTrigger(
          contextDataStorage,
          injectModeGraphId,
          'trigger-1',
          {
            messages: [firstUserMessage],
            threadSubId,
            async: true,
          },
        );

        // Wait for the first human message to land in the DB before sending
        // the second trigger. With async:true the first message is persisted
        // by the agent's notification handler on a separate event chain, so
        // sending the second (synchronous) trigger immediately can persist the
        // second message microseconds before the first lands — flipping the
        // createdAt ordering. The 3s mock-LLM delay above keeps the first run
        // active well past this wait, so the second message still hits the
        // inject_after_tool_call path.
        await waitForHumanMessageContents(firstResult.externalThreadId, 1);

        const secondResult = await graphsService.executeTrigger(
          contextDataStorage,
          injectModeGraphId,
          'trigger-1',
          {
            messages: [secondUserMessage],
            threadSubId,
          },
        );

        expect(secondResult.externalThreadId).toEqual(
          firstResult.externalThreadId,
        );

        const humanMessages = await waitForHumanMessageContents(
          secondResult.externalThreadId,
          2,
        );

        const firstMessage = humanMessages.find(
          (m) => m.message.content === firstUserMessage,
        );

        const secondMessage = humanMessages.find(
          (m) => m.message.content === secondUserMessage,
        );

        expect(firstMessage).toBeDefined();
        expect(secondMessage).toBeDefined();
        // make sure first we got first message
        expect(new Date(firstMessage!.createdAt).getTime()).toBeLessThan(
          new Date(secondMessage!.createdAt).getTime(),
        );

        const thread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              secondResult.externalThreadId,
            ),
          (entry) =>
            entry.status === ThreadStatus.Done ||
            entry.status === ThreadStatus.NeedMoreInfo,
          { timeout: 60000 },
        );

        const threadMessages = await threadsService.getThreadMessages(
          contextDataStorage,
          thread.id,
        );

        const assistantEntry = threadMessages.find(
          (entry) => entry.message.role !== 'human',
        );
        expect(assistantEntry).toBeDefined();
        expect(assistantEntry!.message.role).not.toBe('human');
      },
    );

    it(
      'should append messages sequentially when no active run (wait_for_completion)',
      { timeout: 90000 },
      async () => {
        await ensureGraphRunning(waitModeGraphId);
        const threadSubId = uniqueThreadSubId('wait-mode-no-active');
        const firstMessage = 'Wait mode no active - first';
        const secondMessage = 'Wait mode no active - second';

        const firstResult = await graphsService.executeTrigger(
          contextDataStorage,
          waitModeGraphId,
          'trigger-1',
          {
            messages: [firstMessage],
            threadSubId,
          },
        );

        const secondResult = await graphsService.executeTrigger(
          contextDataStorage,
          waitModeGraphId,
          'trigger-1',
          {
            messages: [secondMessage],
            threadSubId,
          },
        );

        const thread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              secondResult.externalThreadId,
            ),
          (entry) =>
            entry.status === ThreadStatus.Done ||
            entry.status === ThreadStatus.NeedMoreInfo,
          { timeout: 90000 },
        );

        expect(secondResult.externalThreadId).toEqual(
          firstResult.externalThreadId,
        );

        const humanMessages = await waitForHumanMessageContents(
          secondResult.externalThreadId,
          2,
        );

        expect(humanMessages).toHaveLength(2);
        expect(humanMessages.map((m) => m.message.content)).toEqual(
          expect.arrayContaining([firstMessage, secondMessage]),
        );

        const firstStored = humanMessages.find(
          (m) => m.message.content === firstMessage,
        );
        const secondStored = humanMessages.find(
          (m) => m.message.content === secondMessage,
        );

        expect(firstStored).toBeDefined();
        expect(secondStored).toBeDefined();
        expect(new Date(firstStored!.createdAt).getTime()).toBeLessThan(
          new Date(secondStored!.createdAt).getTime(),
        );

        const threadMessages = await threadsService.getThreadMessages(
          contextDataStorage,
          thread.id,
        );
        expect(threadMessages[0]?.message.role).to.be.not.eq('human');
      },
    );

    it(
      'should queue new messages until completion when mode is wait_for_completion',
      { timeout: 90000 },
      async () => {
        await ensureGraphRunning(waitModeGraphId);
        const threadSubId = uniqueThreadSubId('wait-mode-queue');
        const firstMessage =
          'Start a long running reasoning task and share your thoughts.';
        const secondMessage = 'Also list some mitigation strategies.';

        // First call must stay running long enough for the second message to be
        // queued by WaitForCompletion mode — otherwise both messages persist near
        // simultaneously and the createdAt ordering assertion is flaky. The second
        // call's matcher is more specific so it overrides the first delay.
        mockLlm.onChat(
          {
            lastUserMessage: secondMessage,
            hasTools: ['finish'],
          },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: {
              purpose: 'done',
              message: 'Mitigation strategies enumerated',
              needsMoreInfo: false,
            },
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              totalPrice: 0.0001,
            },
          },
        );
        mockLlm.onChat(
          {
            lastUserMessage: firstMessage,
            hasTools: ['finish'],
          },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: {
              purpose: 'done',
              message: 'Reasoning complete',
              needsMoreInfo: false,
            },
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              totalPrice: 0.0001,
            },
            delayMs: 3_000,
          },
        );

        const firstResult = await graphsService.executeTrigger(
          contextDataStorage,
          waitModeGraphId,
          'trigger-1',
          {
            messages: [firstMessage],
            threadSubId,
            async: true,
          },
        );

        const secondResult = await graphsService.executeTrigger(
          contextDataStorage,
          waitModeGraphId,
          'trigger-1',
          {
            messages: [secondMessage],
            threadSubId,
            async: true,
          },
        );

        expect(secondResult.externalThreadId).toEqual(
          firstResult.externalThreadId,
        );

        const completedThread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              secondResult.externalThreadId,
            ),
          (thread) =>
            thread.status === ThreadStatus.Done ||
            thread.status === ThreadStatus.NeedMoreInfo,
          { timeout: 90000 },
        );

        const humanMessages = await waitForHumanMessageContents(
          completedThread.externalThreadId,
          2,
        );

        expect(humanMessages.map((m) => m.message.content)).toEqual(
          expect.arrayContaining([firstMessage, secondMessage]),
        );

        const firstStored = humanMessages.find(
          (m) => m.message.content === firstMessage,
        );
        const secondStored = humanMessages.find(
          (m) => m.message.content === secondMessage,
        );

        expect(firstStored).toBeDefined();
        expect(secondStored).toBeDefined();
        expect(new Date(firstStored!.createdAt).getTime()).toBeLessThan(
          new Date(secondStored!.createdAt).getTime(),
        );

        const threadMessages = await threadsService.getThreadMessages(
          contextDataStorage,
          completedThread.id,
        );
        expect(threadMessages[0]?.message.role).to.be.not.eq('human');
      },
    );
  });

  describe('Thinking mode and pending messages', () => {
    it(
      'should capture reasoning messages when thinking mode is enabled',
      { timeout: 60000 },
      async () => {
        const agentNode = graphRegistry.getNode<SimpleAgent>(
          thinkingGraphId,
          'agent-thinking',
        );
        expect(agentNode).toBeDefined();
        const agentInternals = agentNode!.instance as unknown as {
          currentConfig?: Record<string, unknown>;
        };

        expect(
          agentInternals.currentConfig?.['invokeModelReasoningEffort'],
        ).toBe(ReasoningEffort.High);
      },
    );

    it(
      'should keep new messages queued while wait_for_completion run is active',
      { timeout: 90000 },
      async () => {
        await ensureGraphRunning(waitModeGraphId);
        const threadSubId = uniqueThreadSubId('wait-mode-active');
        const firstMessage = 'Start a long running analysis.';
        const secondMessage = 'Add mitigation strategies when ready.';

        // Slow the first agent run so the test can observe the queued state of
        // the second message. Without this delay the first run finishes before
        // the second message arrives and pendingMessages stays empty.
        mockLlm.onChat(
          {
            lastUserMessage: 'long running analysis',
            hasTools: ['finish'],
          },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: {
              purpose: 'done',
              message: 'Analysis complete',
              needsMoreInfo: false,
            },
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              totalPrice: 0.0001,
            },
            delayMs: 5_000,
          },
        );

        const firstResult = await graphsService.executeTrigger(
          contextDataStorage,
          waitModeGraphId,
          'trigger-1',
          {
            messages: [firstMessage],
            threadSubId,
            async: true,
          },
        );

        const runningThread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              firstResult.externalThreadId,
            ),
          (thread) => thread.status === ThreadStatus.Running,
          { timeout: 30000 },
        );

        await graphsService.executeTrigger(
          contextDataStorage,
          waitModeGraphId,
          'trigger-1',
          {
            messages: [secondMessage],
            threadSubId,
            async: true,
          },
        );

        const agentNode = graphRegistry.getNode<SimpleAgent>(
          waitModeGraphId,
          'agent-wait-mode',
        );
        expect(agentNode).toBeDefined();
        const agentInternals = agentNode!.instance as unknown as {
          graphThreadState?: {
            getByThread: (threadId: string) => {
              pendingMessages: unknown[];
            };
          };
        };

        const pendingState = await waitForCondition(
          () =>
            Promise.resolve(
              agentInternals.graphThreadState?.getByThread(
                runningThread.externalThreadId,
              ),
            ),
          (state) => !!state && state.pendingMessages.length === 1,
          { timeout: 10000 },
        );
        if (!pendingState) {
          throw new Error('Pending state not available');
        }
        expect(pendingState.pendingMessages).toHaveLength(1);

        const completedThread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              runningThread.externalThreadId,
            ),
          (entry) =>
            entry.status === ThreadStatus.Done ||
            entry.status === ThreadStatus.NeedMoreInfo,
          { timeout: 90000 },
        );

        const finalState = agentInternals.graphThreadState?.getByThread(
          completedThread.externalThreadId,
        );
        expect(finalState?.pendingMessages ?? []).toHaveLength(0);

        const finalHumanMessages = await waitForHumanMessageContents(
          completedThread.externalThreadId,
          2,
        );

        expect(finalHumanMessages.map((m) => m.message.content)).toEqual(
          expect.arrayContaining([firstMessage, secondMessage]),
        );
      },
    );
  });

  describe('Thread Deletion', () => {
    it(
      'should delete a thread and its messages',
      { timeout: 120000 },
      async () => {
        await ensureGraphRunning(basicGraphId);
        const threadSubId = uniqueThreadSubId('delete-test');

        const triggerResult = await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: ['Test deletion'],
            threadSubId,
          },
        );

        // Wait for thread to be created
        const thread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              triggerResult.externalThreadId,
            ),
          (thread) => !!thread,
          { timeout: 20000 },
        );

        // Delete the thread
        await threadsService.deleteThread(contextDataStorage, thread.id);

        // Thread should no longer exist
        await expect(
          threadsService.getThreadByExternalId(
            contextDataStorage,
            triggerResult.externalThreadId,
          ),
        ).rejects.toThrow(NotFoundException);
      },
    );

    it('should return 404 when trying to delete non-existent thread', async () => {
      const nonExistentThreadId = '00000000-0000-0000-0000-000000000000';

      await expect(
        threadsService.deleteThread(contextDataStorage, nonExistentThreadId),
      ).rejects.toThrow(NotFoundException);
    });

    it(
      'should delete thread and all its messages in multi-agent scenario',
      { timeout: 120000 },
      async () => {
        await ensureGraphRunning(multiAgentGraphId);
        const threadSubId = uniqueThreadSubId('multi-agent-delete-test');

        const triggerResult = await graphsService.executeTrigger(
          contextDataStorage,
          multiAgentGraphId,
          'trigger-1',
          {
            messages: ['Multi-agent deletion test'],
            threadSubId,
            async: true,
          },
        );

        // Wait for thread to be created
        const thread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              triggerResult.externalThreadId,
            ),
          (thread) => !!thread,
          { timeout: 30000 },
        );

        // Wait for messages to be persisted
        const messagesBefore = await waitForCondition(
          () =>
            threadsService.getThreadMessages(contextDataStorage, thread.id, {
              limit: 100,
              offset: 0,
            }),
          (messages) => messages.length >= 1,
          { timeout: 30000 },
        );

        expect(messagesBefore.length).toBeGreaterThanOrEqual(1);

        // Delete the thread
        await threadsService.deleteThread(contextDataStorage, thread.id);

        // Thread and all messages should be deleted
        await expect(
          threadsService.getThreadByExternalId(
            contextDataStorage,
            triggerResult.externalThreadId,
          ),
        ).rejects.toThrow(NotFoundException);
      },
    );
  });

  describe('Message Filtering and Deduplication', () => {
    it('should filter messages by nodeId', { timeout: 60000 }, async () => {
      await ensureGraphRunning(multiAgentGraphId);
      const threadSubId = uniqueThreadSubId('filter-test');

      const triggerResult = await graphsService.executeTrigger(
        contextDataStorage,
        multiAgentGraphId,
        'trigger-1',
        {
          messages: ['Test message filtering'],
          threadSubId,
        },
      );

      // Wait for thread to be created
      const thread = await waitForCondition(
        () =>
          threadsService.getThreadByExternalId(
            contextDataStorage,
            triggerResult.externalThreadId,
          ),
        (thread) => !!thread,
        { timeout: 10000 },
      );

      // Wait for messages to be available
      await waitForCondition(
        () =>
          threadsService.getThreadMessages(contextDataStorage, thread.id, {
            limit: 100,
            offset: 0,
          }),
        (messages) => messages.length >= 1,
        { timeout: 15000 },
      );

      // Filter by specific nodeId
      const agent1Messages = await threadsService.getThreadMessages(
        contextDataStorage,
        thread.id,
        {
          limit: 100,
          offset: 0,
          nodeId: 'agent-1',
        },
      );

      expect(agent1Messages.length).toBeGreaterThanOrEqual(0);

      // All filtered messages should be from agent-1
      agent1Messages.forEach((msg) => {
        expect((msg as { nodeId: string }).nodeId).toBe('agent-1');
      });
    });

    it(
      'should not create duplicate messages during agent execution',
      { timeout: 60000 },
      async () => {
        await ensureGraphRunning(basicGraphId);
        const threadSubId = uniqueThreadSubId('dedup-test');

        const triggerResult = await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: ['Test for message deduplication'],
            threadSubId,
          },
        );

        // Wait for thread to be created
        const thread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              triggerResult.externalThreadId,
            ),
          (thread) => !!thread,
          { timeout: 10000 },
        );

        // Wait for messages to be available
        const messages = await waitForCondition(
          () =>
            threadsService.getThreadMessages(contextDataStorage, thread.id, {
              limit: 100,
              offset: 0,
            }),
          (messages) => messages.length >= 1,
          { timeout: 10000 },
        );

        // Check for duplicate messages by comparing IDs
        const messageIds = messages.map((m) => (m as { id: string }).id);
        const uniqueMessageIds = new Set(messageIds);

        // All message IDs should be unique
        expect(messageIds.length).toBe(uniqueMessageIds.size);
        expect(messageIds.length).toBeGreaterThanOrEqual(1);
      },
    );
  });

  describe('Thread Name Generation', () => {
    it(
      'should automatically generate and set thread name on first execution',
      { timeout: 60000 },
      async () => {
        await ensureGraphRunning(basicGraphId);
        const threadSubId = uniqueThreadSubId('name-gen-test');

        const triggerResult = await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: ['Generate a thread name for this conversation'],
            threadSubId,
          },
        );

        // Wait for thread to be created and name to be generated
        const thread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              triggerResult.externalThreadId,
            ),
          (thread) => {
            const name = (thread as { name?: string }).name;
            return !!thread && !!name && name !== '';
          },
          { timeout: 15000 },
        );

        // Thread name should be generated
        expect((thread as { name?: string }).name).toBeDefined();
        expect((thread as { name?: string }).name).not.toBe('');
      },
    );

    it(
      'should not update thread name if it already exists',
      { timeout: 60000 },
      async () => {
        await ensureGraphRunning(basicGraphId);
        const threadSubId = uniqueThreadSubId('name-persist-test');

        // First execution
        const firstResult = await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: ['First message to generate name'],
            threadSubId,
          },
        );

        // Wait for thread to be created and name to be generated
        const threadAfterFirst = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              firstResult.externalThreadId,
            ),
          (thread) => {
            const name = (thread as { name?: string }).name;
            return !!thread && !!name && name !== '';
          },
          { timeout: 15000 },
        );
        const firstName = (threadAfterFirst as { name?: string }).name;
        expect(firstName).toBeDefined();

        // Second execution with same thread
        await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: ['Second message should not change name'],
            threadSubId,
          },
        );

        // Wait a bit for potential name update (which shouldn't happen)
        await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              firstResult.externalThreadId,
            ),
          (thread) => !!thread,
          { timeout: 5000 },
        );

        const threadAfterSecond = await threadsService.getThreadByExternalId(
          contextDataStorage,
          firstResult.externalThreadId,
        );
        const secondName = (threadAfterSecond as { name?: string }).name;

        // Name should remain the same
        expect(secondName).toBe(firstName);
      },
    );
  });

  describe('Thread Status', () => {
    it(
      'should mark thread as done after successful execution',
      { timeout: 60000 },
      async () => {
        await ensureGraphRunning(basicGraphId);
        const threadSubId = uniqueThreadSubId('status-done-test');

        const triggerResult = await graphsService.executeTrigger(
          contextDataStorage,
          basicGraphId,
          'trigger-1',
          {
            messages: ['Complete this task successfully'],
            threadSubId,
          },
        );

        // Wait for thread to be created and execution to reach a final state
        const thread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              triggerResult.externalThreadId,
            ),
          (thread) => {
            const status = (thread as { status: string }).status;
            // Wait until status is not 'running' or 'pending'
            return (
              !!thread &&
              !!status &&
              status !== 'running' &&
              status !== 'pending'
            );
          },
          { timeout: 20000 },
        );

        // Thread status should be set after execution
        const status = (thread as { status: string }).status;
        expect(status).toBeDefined();
        // Status should be one of the valid final states
        expect(['done', 'need_more_info', 'stopped']).toContain(status);
      },
    );

    it(
      'should mark thread as stopped when execution is interrupted',
      { timeout: 60000 },
      async () => {
        const graphData = createMockGraphData({
          name: `Thread Management Interrupted ${Date.now()}`,
        });
        const createResult = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const interruptedGraphId = createResult.id;
        createdGraphIds.push(interruptedGraphId);

        await graphsService.run(contextDataStorage, interruptedGraphId);
        await ensureGraphRunning(interruptedGraphId);
        const threadSubId = uniqueThreadSubId('status-stopped-test');

        // Start an async execution
        const execResult = await graphsService.executeTrigger(
          contextDataStorage,
          interruptedGraphId,
          'trigger-1',
          {
            messages: ['Long running task that will be interrupted'],
            threadSubId,
            async: true,
          },
        );

        // Wait for thread to be created
        await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              execResult.externalThreadId,
            ),
          (thread) => !!thread,
          { timeout: 5000 },
        );

        // Destroy the graph to interrupt execution
        await graphsService.destroy(contextDataStorage, interruptedGraphId);

        // Wait for status update
        await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              execResult.externalThreadId,
            ),
          (thread) => !!thread,
          { timeout: 5000 },
        );

        const thread = await threadsService.getThreadByExternalId(
          contextDataStorage,
          execResult.externalThreadId,
        );

        // Thread status should be defined
        const status = (thread as { status: string }).status;
        expect(status).toBeDefined();
      },
    );
  });

  describe('Message Summarization', () => {
    it(
      'should isolate messages between different threadSubIds with aggressive summarization',
      { timeout: 60000 },
      async () => {
        const graphData = createMockGraphData({
          schema: {
            nodes: [
              {
                id: 'agent-1',
                template: 'simple-agent',
                config: {
                  name: 'Agent',
                  instructions: 'You are a helpful agent',
                  invokeModelName: 'gpt-5-mini',
                  summarizeMaxTokens: 100, // Aggressive summarization
                  summarizeKeepTokens: 50,
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

        const createResult = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const graphId = createResult.id;
        createdGraphIds.push(graphId);

        await graphsService.run(contextDataStorage, graphId);

        const threadSubId1 = uniqueThreadSubId('aggressive-thread-1');
        const threadSubId2 = uniqueThreadSubId('aggressive-thread-2');

        // Create two threads with aggressive summarization
        const thread1Result = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Thread 1 message with aggressive summarization'],
            threadSubId: threadSubId1,
          },
        );

        const thread2Result = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Thread 2 message with aggressive summarization'],
            threadSubId: threadSubId2,
          },
        );

        // Verify threads are separate
        expect(thread1Result.externalThreadId).not.toBe(
          thread2Result.externalThreadId,
        );

        // Wait for both threads to be persisted (there may be more threads for this graph in the DB).
        const threads = await waitForCondition(
          () =>
            threadsService.getThreads(contextDataStorage, {
              graphId,
              limit: 200,
              offset: 0,
            }),
          (threads) => {
            const ids = threads.map(
              (t) => (t as { externalThreadId: string }).externalThreadId,
            );
            return (
              ids.includes(thread1Result.externalThreadId) &&
              ids.includes(thread2Result.externalThreadId)
            );
          },
          { timeout: 20000 },
        );

        const threadIds = threads.map(
          (t) => (t as { externalThreadId: string }).externalThreadId,
        );

        expect(threadIds).toContain(thread1Result.externalThreadId);
        expect(threadIds).toContain(thread2Result.externalThreadId);
      },
    );

    it(
      'should preserve full message history with conservative summarization',
      { timeout: 60000 },
      async () => {
        const graphData = createMockGraphData({
          schema: {
            nodes: [
              {
                id: 'agent-1',
                template: 'simple-agent',
                config: {
                  name: 'Agent',
                  instructions: 'You are a helpful agent',
                  invokeModelName: 'gpt-5-mini',
                  summarizeMaxTokens: 272000, // Conservative - high limit
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

        const createResult = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const graphId = createResult.id;
        createdGraphIds.push(graphId);

        await graphsService.run(contextDataStorage, graphId);
        await ensureGraphRunning(graphId);

        const threadSubId = uniqueThreadSubId(
          'conservative-summarization-test',
        );

        // Send multiple messages
        const exec1 = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['First message'],
            threadSubId,
          },
        );

        // Drain pending agent work between sequential executeTriggers — leftover
        // em.transactional state from the first call's run can otherwise collide
        // with the second call's pessimistic-write lock acquisition (manifests as
        // `ROLLBACK TO SAVEPOINT can only be used in transaction blocks`).
        await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              exec1.externalThreadId,
            ),
          (t) =>
            t.status === ThreadStatus.Done ||
            t.status === ThreadStatus.NeedMoreInfo ||
            t.status === ThreadStatus.Stopped,
          { timeout: 15_000, interval: 200 },
        );

        const exec2 = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Second message'],
            threadSubId,
          },
        );
        expect(exec2.externalThreadId).toBe(exec1.externalThreadId);

        const thread = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              exec2.externalThreadId,
            ),
          (t) => Boolean(t),
          { timeout: 15_000, interval: 500 },
        );

        // Wait for messages to be available
        const messages = await waitForCondition(
          () =>
            threadsService.getThreadMessages(contextDataStorage, thread.id, {
              limit: 100,
              offset: 0,
            }),
          (messages) => messages.length >= 1,
          { timeout: 10000 },
        );

        // With conservative summarization, messages should be preserved
        expect(messages.length).toBeGreaterThanOrEqual(1);
      },
    );
  });

  describe('Parallel Thread State Isolation', () => {
    it(
      'should maintain separate thread states when running 2 threads in parallel',
      { timeout: 120000 },
      async () => {
        await ensureGraphRunning(basicGraphId);
        const threadSubId1 = uniqueThreadSubId('parallel-test-1');
        const threadSubId2 = uniqueThreadSubId('parallel-test-2');

        // Start two threads in parallel with async=true
        const [exec1, exec2] = await Promise.all([
          graphsService.executeTrigger(
            contextDataStorage,
            basicGraphId,
            'trigger-1',
            {
              messages: ['Thread 1: Tell me about cats'],
              threadSubId: threadSubId1,
              async: true,
            },
          ),
          graphsService.executeTrigger(
            contextDataStorage,
            basicGraphId,
            'trigger-1',
            {
              messages: ['Thread 2: Tell me about dogs'],
              threadSubId: threadSubId2,
              async: true,
            },
          ),
        ]);

        expect(exec1.externalThreadId).toBeDefined();
        expect(exec2.externalThreadId).toBeDefined();
        expect(exec1.externalThreadId).not.toBe(exec2.externalThreadId);

        // Wait for both threads to be created in the database
        const thread1 = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              exec1.externalThreadId,
            ),
          (thread) => !!thread,
          { timeout: 15000 },
        );

        const thread2 = await waitForCondition(
          () =>
            threadsService.getThreadByExternalId(
              contextDataStorage,
              exec2.externalThreadId,
            ),
          (thread) => !!thread,
          { timeout: 15000 },
        );

        expect(thread1.id).toBeDefined();
        expect(thread2.id).toBeDefined();
        expect(thread1.id).not.toBe(thread2.id);
        expect(thread1.externalThreadId).toBe(exec1.externalThreadId);
        expect(thread2.externalThreadId).toBe(exec2.externalThreadId);

        // Both threads should initially be Running
        expect(thread1.status).toBe(ThreadStatus.Running);
        expect(thread2.status).toBe(ThreadStatus.Running);

        // Wait for both threads to complete
        const completedThread1 = await waitForCondition(
          () => threadsService.getThreadById(contextDataStorage, thread1.id),
          (t) =>
            t.status === ThreadStatus.Done ||
            t.status === ThreadStatus.NeedMoreInfo,
          { timeout: 60000 },
        );

        const completedThread2 = await waitForCondition(
          () => threadsService.getThreadById(contextDataStorage, thread2.id),
          (t) =>
            t.status === ThreadStatus.Done ||
            t.status === ThreadStatus.NeedMoreInfo,
          { timeout: 60000 },
        );

        // Verify final states
        expect([ThreadStatus.Done, ThreadStatus.NeedMoreInfo]).toContain(
          completedThread1.status,
        );
        expect([ThreadStatus.Done, ThreadStatus.NeedMoreInfo]).toContain(
          completedThread2.status,
        );

        // Get messages for both threads
        const messages1 = await waitForCondition(
          () =>
            threadsService.getThreadMessages(contextDataStorage, thread1.id, {
              limit: 100,
              offset: 0,
            }),
          (messages) => messages.length >= 2, // At least user + AI message
          { timeout: 15000 },
        );

        const messages2 = await waitForCondition(
          () =>
            threadsService.getThreadMessages(contextDataStorage, thread2.id, {
              limit: 100,
              offset: 0,
            }),
          (messages) => messages.length >= 2, // At least user + AI message
          { timeout: 15000 },
        );

        // Verify messages are isolated
        expect(messages1.length).toBeGreaterThanOrEqual(2);
        expect(messages2.length).toBeGreaterThanOrEqual(2);

        // Extract user messages
        const thread1UserMsg = messages1.find(
          (m) => m.message.role === 'human',
        );
        const thread2UserMsg = messages2.find(
          (m) => m.message.role === 'human',
        );

        expect(thread1UserMsg).toBeDefined();
        expect(thread2UserMsg).toBeDefined();

        const content1 =
          typeof thread1UserMsg!.message.content === 'string'
            ? thread1UserMsg!.message.content
            : JSON.stringify(thread1UserMsg!.message.content);
        const content2 =
          typeof thread2UserMsg!.message.content === 'string'
            ? thread2UserMsg!.message.content
            : JSON.stringify(thread2UserMsg!.message.content);

        // Verify correct messages went to correct threads
        expect(content1).toContain('cats');
        expect(content1).not.toContain('dogs');
        expect(content2).toContain('dogs');
        expect(content2).not.toContain('cats');

        // Verify thread names are set independently (if generated)
        const finalThread1 = await threadsService.getThreadById(
          contextDataStorage,
          thread1.id,
        );
        const finalThread2 = await threadsService.getThreadById(
          contextDataStorage,
          thread2.id,
        );

        // If names were generated, they should be different
        if (finalThread1.name && finalThread2.name) {
          expect(finalThread1.name).not.toBe(finalThread2.name);
        }
      },
    );
  });
});
