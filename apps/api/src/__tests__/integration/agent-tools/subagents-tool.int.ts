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
const SUBAGENTS_TOOL_NODE_ID = 'subagents-1';
const RUNTIME_NODE_ID = 'runtime-1';

/**
 * Parent agent instructions — very explicit to avoid LLM loops:
 * - Skip subagents_list (we hardcode the agentId)
 * - Use system:simple (has shell with no codebase_search prerequisite)
 * - Tell the parent exactly what to do step by step
 */
const SUBAGENT_INSTRUCTIONS =
  'You are an orchestrator agent. ' +
  'When the user gives you a command to delegate, immediately call subagents_run_task with ' +
  'agentId="system:simple", intelligence="fast", and pass the user message as the task. ' +
  'Do NOT call subagents_list — you already know the agent ID. ' +
  "After receiving the subagent's result, call the finish tool with the subagent's response.";

const THREAD_COMPLETION_STATUSES: ThreadStatus[] = [
  ThreadStatus.Done,
  ThreadStatus.NeedMoreInfo,
  ThreadStatus.Stopped,
];

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Subagents Tool Integration Tests', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  let graphId: string;
  let testProjectId: string;

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

    const graph = await graphsService.create(
      contextDataStorage,
      createSubagentGraphData(),
    );
    graphId = graph.id;
    await graphsService.run(contextDataStorage, graphId);
    await waitForGraphStatus(graphId, GraphStatus.Running);
  }, 300_000);

  afterAll(async () => {
    if (graphId) {
      await cleanupGraph(graphId);
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

  beforeEach(() => {
    getMockLlm(app).reset();
  });

  const cleanupGraph = async (id: string) => {
    try {
      await graphsService.destroy(contextDataStorage, id);
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
      await graphsService.delete(contextDataStorage, id);
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
    id: string,
    status: GraphStatus,
    timeoutMs = 240_000,
  ) => {
    return waitForCondition(
      () => graphsService.findById(contextDataStorage, id),
      (graph) => graph.status === status,
      { timeout: timeoutMs, interval: 1_000 },
    );
  };

  const waitForThreadCompletion = async (
    externalThreadId: string,
    timeoutMs = 240_000,
  ) => {
    const thread = await threadsService.getThreadByExternalId(
      contextDataStorage,
      externalThreadId,
    );

    return waitForCondition(
      () => threadsService.getThreadById(contextDataStorage, thread.id),
      (currentThread) =>
        THREAD_COMPLETION_STATUSES.includes(currentThread.status),
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

  const ensureGraphRunning = async (id: string) => {
    const graph = await graphsService.findById(contextDataStorage, id);
    if (graph.status === GraphStatus.Running) {
      return;
    }
    await graphsService.run(contextDataStorage, id);
    await waitForGraphStatus(id, GraphStatus.Running);
  };

  const uniqueThreadSubId = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  function createSubagentGraphData(): CreateGraphDto {
    return {
      name: `Subagent Integration Test ${Date.now()}`,
      description: 'Graph that exercises subagent tool behavior',
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
              instructions: SUBAGENT_INSTRUCTIONS,
              name: 'Orchestrator Agent',
              description: 'Agent that delegates to subagents',
              invokeModelName: 'gpt-5-mini',
              invokeModelReasoningEffort: ReasoningEffort.None,
              maxIterations: 20,
              summarizeMaxTokens: 272000,
              summarizeKeepTokens: 30000,
            } satisfies SimpleAgentSchemaType,
          },
          {
            id: SUBAGENTS_TOOL_NODE_ID,
            template: 'subagents-tool',
            config: {},
          },
          {
            id: RUNTIME_NODE_ID,
            template: 'runtime',
            config: {
              runtimeType: 'Docker',
              image: 'python:3.11-slim',
            },
          },
        ],
        edges: [
          { from: TRIGGER_NODE_ID, to: AGENT_NODE_ID },
          { from: AGENT_NODE_ID, to: SUBAGENTS_TOOL_NODE_ID },
          { from: SUBAGENTS_TOOL_NODE_ID, to: RUNTIME_NODE_ID },
        ],
      },
    };
  }

  it(
    'should invoke subagent tool and produce result with streamed messages',
    { timeout: 300_000 },
    async () => {
      const mockLlm = getMockLlm(app);

      /**
       * Multi-turn sequence using queueChat (FIFO):
       *
       * Parent agent turns:
       *   Queue 0 — tool_search (subagents tools are deferred-loaded, parent must search first)
       *   Queue 1 — subagents_run_task (subagents tool loaded, parent delegates task)
       *
       * SubAgent (system:simple) turns — shell tool is pre-configured, no tool_search needed:
       *   Queue 2 — shell command (subagent executes the delegated task)
       *   Queue 3 — text reply (subagent completes with a text result, no finish tool)
       *
       * Parent agent resumes:
       *   Queue 4 — finish (parent reports subagent result and ends the thread)
       */
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'tool_search',
        args: { query: 'subagents' },
      });
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'subagents_run_task',
        args: {
          agentId: 'system:simple',
          task: 'Run "echo hello_from_subagent" in the shell and return the output.',
          purpose: 'delegate echo task',
        },
      });
      // SubAgent turn: run the shell command
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'shell',
        args: {
          purpose: 'run echo command',
          command: 'echo hello_from_subagent',
        },
      });
      // SubAgent completes with a text result (no finish tool — SubAgent ends on text response)
      mockLlm.queueChat({
        kind: 'text',
        content: 'The shell command output was: hello_from_subagent',
      });
      // Parent receives subagent result, calls finish
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'finish',
        args: {
          purpose: 'done',
          message: 'The shell command output was: hello_from_subagent',
          needsMoreInfo: false,
        },
      });

      await ensureGraphRunning(graphId);

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        graphId,
        TRIGGER_NODE_ID,
        {
          messages: [
            'Delegate this: run "echo hello_from_subagent" in the shell and return the output.',
          ],
          async: false,
          threadSubId: uniqueThreadSubId('subagent-basic'),
        },
      );

      const thread = await waitForThreadCompletion(execution.externalThreadId);
      // Accept any terminal status — we're testing subagent tool integration, not LLM behavior
      expect(THREAD_COMPLETION_STATUSES).toContain(thread.status);

      const messages = await getThreadMessages(execution.externalThreadId);

      // Should have a subagents_run_task tool result message
      const subagentToolMsg = messages.find(
        (msg) =>
          msg.message.role === 'tool' &&
          msg.message.name === 'subagents_run_task',
      );
      expect(subagentToolMsg).toBeDefined();

      // The tool result should contain the subagent's output (either success or max iterations message)
      const toolContent = subagentToolMsg!.message.content as Record<
        string,
        unknown
      >;
      expect(toolContent).toHaveProperty('result');
      expect(typeof toolContent.result).toBe('string');
      expect((toolContent.result as string).length).toBeGreaterThan(0);

      // Should have streamed intermediate messages with correct metadata
      const streamedMessages = messages.filter((msg) => {
        const kw = msg.message.additionalKwargs as Record<string, unknown>;
        return kw?.__streamedRealtime === true;
      });

      // Subagent should have produced at least some messages during execution
      expect(streamedMessages.length).toBeGreaterThanOrEqual(1);

      // All streamed messages should be hidden from LLM
      for (const msg of streamedMessages) {
        const kw = msg.message.additionalKwargs as Record<string, unknown>;
        expect(kw.__hideForLlm).toBe(true);
      }

      // All streamed messages should be linked to a tool call
      for (const msg of streamedMessages) {
        const kw = msg.message.additionalKwargs as Record<string, unknown>;
        expect(typeof kw.__toolCallId).toBe('string');
        expect((kw.__toolCallId as string).length).toBeGreaterThan(0);
      }
    },
  );

  it(
    'should include subagent token usage statistics in tool result',
    { timeout: 300_000 },
    async () => {
      const mockLlm = getMockLlm(app);

      /**
       * Multi-turn sequence using queueChat (FIFO):
       *
       * Parent agent turns:
       *   Queue 0 — tool_search (deferred loading)
       *   Queue 1 — subagents_run_task (parent delegates)
       *
       * SubAgent (system:simple) turns:
       *   Queue 2 — shell command (subagent runs pwd)
       *   Queue 3 — text reply (subagent returns result)
       *
       * Parent agent resumes:
       *   Queue 4 — finish
       */
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'tool_search',
        args: { query: 'subagents' },
      });
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'subagents_run_task',
        args: {
          agentId: 'system:simple',
          task: 'Run "pwd" in the shell and return the output.',
          purpose: 'delegate pwd task',
        },
      });
      // SubAgent turn: run pwd
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'shell',
        args: { purpose: 'run pwd', command: 'pwd' },
      });
      // SubAgent completes with text
      mockLlm.queueChat({
        kind: 'text',
        content: 'The current directory is /runtime-workspace',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cachedInputTokens: 0,
          totalPrice: 0.001,
        },
      });
      // Parent calls finish
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'finish',
        args: {
          purpose: 'done',
          message: 'The current directory is /runtime-workspace',
          needsMoreInfo: false,
        },
      });

      await ensureGraphRunning(graphId);

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        graphId,
        TRIGGER_NODE_ID,
        {
          messages: [
            'Delegate this: run "pwd" in the shell and return the output.',
          ],
          async: false,
          threadSubId: uniqueThreadSubId('subagent-usage'),
        },
      );

      const thread = await waitForThreadCompletion(execution.externalThreadId);
      // Accept any terminal status — we're testing token usage tracking
      expect(THREAD_COMPLETION_STATUSES).toContain(thread.status);

      const messages = await getThreadMessages(execution.externalThreadId);

      const subagentToolMsg = messages.find(
        (msg) =>
          msg.message.role === 'tool' &&
          msg.message.name === 'subagents_run_task',
      );
      expect(subagentToolMsg).toBeDefined();

      // Tool result should have statistics with iteration count
      const toolContent = subagentToolMsg!.message.content as Record<
        string,
        unknown
      >;
      const stats = toolContent.statistics as Record<string, unknown>;
      expect(stats).toBeDefined();
      expect(typeof stats.totalIterations).toBe('number');
      expect(stats.totalIterations).toBeGreaterThanOrEqual(1);

      // Token usage should be recorded on the tool message
      const kw = subagentToolMsg!.message.additionalKwargs as Record<
        string,
        unknown
      >;
      const requestUsage = kw.__requestUsage as Record<string, unknown>;
      expect(requestUsage).toBeDefined();
      expect(typeof requestUsage.inputTokens).toBe('number');
      expect(typeof requestUsage.outputTokens).toBe('number');
      expect(typeof requestUsage.totalTokens).toBe('number');
    },
  );
});
