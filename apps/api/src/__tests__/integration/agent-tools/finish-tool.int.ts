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
import { wait } from '../../test-utils';
import { waitForCondition } from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import {
  mockLiteLlmClient,
  mockThreadNameGenerator,
} from '../helpers/test-stubs';
import { getMockLlm } from '../mocks/mock-llm';
import { createTestModule } from '../setup';

type FinishToolMessage = Extract<ThreadMessageDto['message'], { role: 'tool' }>;

type FinishToolPayload = {
  message: string;
  needsMoreInfo?: boolean;
  purpose?: string;
};

const AGENT_NODE_ID = 'agent-1';
const TRIGGER_NODE_ID = 'trigger-1';

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Finish Tool Integration Tests', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  let doneGraphId: string;
  let needMoreInfoGraphId: string;
  let testProjectId: string;

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
    const thread = await threadsService.getThreadByExternalId(
      contextDataStorage,
      externalThreadId,
    );

    return waitForCondition(
      () => threadsService.getThreadById(contextDataStorage, thread.id),
      (t) =>
        [
          ThreadStatus.Done,
          ThreadStatus.Stopped,
          ThreadStatus.NeedMoreInfo,
        ].includes(t.status),
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

  const isFinishToolMessage = (
    message: ThreadMessageDto['message'],
  ): message is FinishToolMessage =>
    message.role === 'tool' && message.name === 'finish';

  const findFinishToolMessage = (messages: ThreadMessageDto[]) =>
    messages.find(
      (msg): msg is ThreadMessageDto & { message: FinishToolMessage } =>
        isFinishToolMessage(msg.message),
    );

  const createFinishToolGraphData = (
    instructions: string,
    overrides?: Partial<CreateGraphDto['schema']>,
  ): CreateGraphDto => ({
    name: `Finish Tool Integration ${Date.now()}`,
    description: 'Graph that exercises finish tool behavior',
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
            instructions,
            name: 'Test Agent',
            description: 'Test agent description',
            invokeModelName: 'gpt-5-mini',
            invokeModelReasoningEffort: ReasoningEffort.None,
            maxIterations: 50,
            summarizeMaxTokens: 272000,
            summarizeKeepTokens: 30000,
          } satisfies SimpleAgentSchemaType,
        },
      ],
      edges: [{ from: TRIGGER_NODE_ID, to: AGENT_NODE_ID }],
      ...overrides,
    },
  });

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

    const doneGraph = await graphsService.create(
      contextDataStorage,
      createFinishToolGraphData(
        'You are a helpful assistant. When you can answer the user directly, call the finish tool with needsMoreInfo=false and include your final response. Always call the finish tool to end your answer even without being reminded.',
      ),
    );
    doneGraphId = doneGraph.id;
    await graphsService.run(contextDataStorage, doneGraphId);
    await waitForGraphToBeRunning(doneGraphId);

    const needMoreInfoGraph = await graphsService.create(
      contextDataStorage,
      createFinishToolGraphData(
        'You are a helpful assistant. When you lack details, call finish with needsMoreInfo=true and ask a single clarifying question.',
      ),
    );
    needMoreInfoGraphId = needMoreInfoGraph.id;
    await graphsService.run(contextDataStorage, needMoreInfoGraphId);
    await waitForGraphToBeRunning(needMoreInfoGraphId);
  }, 180_000);

  afterAll(async () => {
    const graphIds = [doneGraphId, needMoreInfoGraphId].filter(Boolean);
    await Promise.all(
      graphIds.map(async (graphId) => {
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

  beforeEach(() => {
    getMockLlm(app).reset();
  });

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

  it(
    'records finish tool response when agent completes a task',
    { timeout: 120_000 },
    async () => {
      const mockLlm = getMockLlm(app);

      // The finish-tool graph has no shell or other deferred tools — only finish
      // and tool_search are available. The agent calls finish directly on the
      // first turn to complete the task.
      mockLlm.onChat(
        { hasTools: ['finish'] },
        {
          kind: 'toolCall',
          toolName: 'finish',
          args: {
            purpose: 'done',
            message: 'I am Test Agent.',
            needsMoreInfo: false,
          },
        },
      );

      await ensureGraphRunning(doneGraphId);

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        doneGraphId,
        TRIGGER_NODE_ID,
        {
          messages: ['What is your name?'],
          async: false,
          threadSubId: uniqueThreadSubId('finish-done'),
        },
      );

      const thread = await waitForThreadCompletion(execution.externalThreadId);
      expect(thread.status).toBe(ThreadStatus.Done);

      const messages = await getThreadMessages(execution.externalThreadId);
      const finishMessage = findFinishToolMessage(messages);

      expect(finishMessage).toBeDefined();
      const finishPayload = finishMessage!.message.content as FinishToolPayload;
      expect(finishPayload.needsMoreInfo).toBe(false);
      expect(finishPayload.message.length).toBeGreaterThan(0);

      const finishMessages = messages.filter((msg) =>
        isFinishToolMessage(msg.message),
      );
      expect(finishMessages).toHaveLength(1);
    },
  );

  it(
    'sets thread status to need_more_info when finish tool requests clarification',
    { timeout: 120_000 },
    async () => {
      const mockLlm = getMockLlm(app);

      // Agent calls finish with needsMoreInfo=true to request clarification.
      mockLlm.onChat(
        { hasTools: ['finish'] },
        {
          kind: 'toolCall',
          toolName: 'finish',
          args: {
            purpose: 'clarification needed',
            message: 'Could you please clarify what you need help with?',
            needsMoreInfo: true,
          },
        },
      );

      await ensureGraphRunning(needMoreInfoGraphId);

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        needMoreInfoGraphId,
        TRIGGER_NODE_ID,
        {
          messages: ['Help me with something'],
          async: false,
          threadSubId: uniqueThreadSubId('finish-need-more'),
        },
      );

      const thread = await waitForThreadCompletion(execution.externalThreadId);
      expect(thread.status).toBe(ThreadStatus.NeedMoreInfo);

      const messages = await getThreadMessages(execution.externalThreadId);
      const finishMessage = findFinishToolMessage(messages);
      expect(finishMessage).toBeDefined();

      const finishPayload = finishMessage!.message.content as FinishToolPayload;
      expect(finishPayload.needsMoreInfo).toBe(true);
      expect(finishPayload.message.length).toBeGreaterThan(0);
    },
  );

  it(
    'does not inject tool guard prompts when agent voluntarily calls finish',
    { timeout: 120_000 },
    async () => {
      const mockLlm = getMockLlm(app);

      // Agent calls finish voluntarily — no guard prompts should be injected.
      mockLlm.onChat(
        { hasTools: ['finish'] },
        {
          kind: 'toolCall',
          toolName: 'finish',
          args: {
            purpose: 'answer',
            message: 'The answer is 4.',
            needsMoreInfo: false,
          },
        },
      );

      await ensureGraphRunning(doneGraphId);

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        doneGraphId,
        TRIGGER_NODE_ID,
        {
          messages: ['What is 2 + 2?'],
          async: false,
          threadSubId: uniqueThreadSubId('finish-voluntary'),
        },
      );

      const thread = await waitForThreadCompletion(execution.externalThreadId);
      expect(thread.status).toBe(ThreadStatus.Done);

      const messages = await getThreadMessages(execution.externalThreadId);
      const guardMessages = messages.filter(
        (msg) =>
          msg.message.role === 'system' &&
          msg.message.content.toLowerCase().includes('call a tool'),
      );
      expect(guardMessages).toHaveLength(0);

      const finishMessage = findFinishToolMessage(messages);
      expect(finishMessage).toBeDefined();
      const finishPayload = finishMessage!.message.content as FinishToolPayload;
      expect(finishPayload.needsMoreInfo).toBe(false);
    },
  );
});
