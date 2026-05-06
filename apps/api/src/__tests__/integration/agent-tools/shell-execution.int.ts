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

const COMMAND_AGENT_INSTRUCTIONS =
  'You are a command runner. When the user message contains `Run this command: <cmd>` or `Execute shell command: <cmd>` (including `Execute shell command with timeoutMs=<ms>: <cmd>`), extract `<cmd>` and execute it exactly using the shell tool. If the message includes `timeoutMs=<number>`, pass that value to the shell tool as timeoutMs. Do not run any other commands, inspections, or tests unless the user explicitly requests them. After running the shell tool, call the finish tool with the stdout (and stderr if present). If the runtime is not yet started, wait briefly and retry once before reporting the failure.';

const THREAD_COMPLETION_STATUSES: ThreadStatus[] = [
  ThreadStatus.Done,
  ThreadStatus.NeedMoreInfo,
  ThreadStatus.Stopped,
];

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Shell Execution Integration Tests', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  let defaultGraphId: string;
  let envGraphId: string;
  let alpineGraphId: string;
  let testProjectId: string;

  beforeAll(async () => {
    app = await createTestModule(
      async (m) =>
        m
          .overrideProvider(LiteLlmClient)
          .useValue(mockLiteLlmClient)
          .overrideProvider(ThreadNameGeneratorService)
          .useValue(mockThreadNameGenerator)
          .compile(),
      // Shell-execution tests assert on real timeouts, exit codes, and
      // custom container images — keep the production runtime here.
      { mockRuntime: false },
    );
    graphsService = app.get<GraphsService>(GraphsService);
    threadsService = app.get<ThreadsService>(ThreadsService);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;

    const defaultGraph = await graphsService.create(
      contextDataStorage,
      createShellExecutionGraphData(),
    );
    defaultGraphId = defaultGraph.id;
    await graphsService.run(contextDataStorage, defaultGraphId);
    await waitForGraphStatus(defaultGraphId, GraphStatus.Running);

    const envGraph = await graphsService.create(
      contextDataStorage,
      createShellExecutionGraphData({
        env: { FOO: 'bar' },
        description: 'Integration test graph for shell execution (env)',
      }),
    );
    envGraphId = envGraph.id;
    await graphsService.run(contextDataStorage, envGraphId);
    await waitForGraphStatus(envGraphId, GraphStatus.Running);

    const alpineGraph = await graphsService.create(
      contextDataStorage,
      createShellExecutionGraphData({
        dockerImage: 'alpine:latest',
        description: 'Integration test graph for shell execution (alpine)',
      }),
    );
    alpineGraphId = alpineGraph.id;
    await graphsService.run(contextDataStorage, alpineGraphId);
    await waitForGraphStatus(alpineGraphId, GraphStatus.Running);
  }, 300_000);

  afterAll(async () => {
    if (defaultGraphId) {
      await cleanupGraph(defaultGraphId);
    }
    if (envGraphId) {
      await cleanupGraph(envGraphId);
    }
    if (alpineGraphId) {
      await cleanupGraph(alpineGraphId);
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
    timeoutMs = 240_000,
  ) => {
    return waitForCondition(
      () => graphsService.findById(contextDataStorage, graphId),
      (graph) => graph.status === status,
      { timeout: timeoutMs, interval: 1_000 },
    );
  };

  const waitForThreadCompletion = async (
    externalThreadId: string,
    timeoutMs = 180_000,
  ) => {
    const thread = await threadsService.getThreadByExternalId(
      contextDataStorage,
      externalThreadId,
    );

    return waitForCondition(
      () => threadsService.getThreadById(contextDataStorage, thread.id),
      (currentThread) =>
        THREAD_COMPLETION_STATUSES.includes(currentThread.status),
      {
        timeout: timeoutMs,
        interval: 1_000,
      },
    );
  };

  const getThreadMessages = async (externalThreadId: string) => {
    const thread = await threadsService.getThreadByExternalId(
      contextDataStorage,
      externalThreadId,
    );
    return threadsService.getThreadMessages(contextDataStorage, thread.id);
  };

  const isAiThreadMessage = (
    message: ThreadMessageDto['message'],
  ): message is Extract<ThreadMessageDto['message'], { role: 'ai' }> =>
    message.role === 'ai';

  type ShellThreadMessage = Extract<
    ThreadMessageDto['message'],
    { role: 'tool' }
  >;

  const isShellThreadMessage = (
    message: ThreadMessageDto['message'],
  ): message is ShellThreadMessage =>
    message.role === 'tool' && message.name === 'shell';

  const findShellExecution = (messages: ThreadMessageDto[]) => {
    const aiMessage = messages
      .map((message) => message.message)
      .find(isAiThreadMessage);

    const shellMessage = messages
      .map((message) => message.message)
      .find(isShellThreadMessage);

    const shellToolCall = aiMessage?.toolCalls?.find(
      (toolCall) => toolCall.name === 'shell',
    );

    const rawResult =
      shellMessage?.role === 'tool'
        ? (shellMessage.content as {
            exitCode?: number;
            stdout?: string;
            stderr?: string;
          })
        : undefined;

    const result =
      rawResult &&
      typeof rawResult.exitCode === 'number' &&
      typeof rawResult.stdout === 'string' &&
      typeof rawResult.stderr === 'string'
        ? {
            exitCode: rawResult.exitCode,
            stdout: rawResult.stdout,
            stderr: rawResult.stderr,
          }
        : undefined;

    return {
      toolName: shellToolCall?.name ?? shellMessage?.name,
      toolCallId: shellToolCall?.id ?? shellMessage?.toolCallId,
      result,
    };
  };

  const waitForShellExecution = async (
    externalThreadId: string,
    timeoutMs = 180_000,
  ) => {
    return waitForCondition(
      () => getThreadMessages(externalThreadId),
      (threadMessages) => Boolean(findShellExecution(threadMessages).result),
      { timeout: timeoutMs, interval: 2_000 },
    );
  };

  interface ShellGraphOptions {
    env?: Record<string, string>;
    dockerImage?: string;
    agentInstructions?: string;
    description?: string;
  }

  const createShellExecutionGraphData = (
    options: ShellGraphOptions = {},
  ): CreateGraphDto => {
    const {
      env = {},
      dockerImage = 'python:3.11-slim',
      agentInstructions = COMMAND_AGENT_INSTRUCTIONS,
      description = 'Integration test graph for shell execution',
    } = options;

    return {
      name: `Shell Execution Test ${Date.now()}`,
      description,
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
              instructions: agentInstructions,
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
              image: dockerImage,
              env,
            },
          },
        ],
        edges: [
          { from: TRIGGER_NODE_ID, to: AGENT_NODE_ID },
          { from: AGENT_NODE_ID, to: SHELL_NODE_ID },
          { from: SHELL_NODE_ID, to: RUNTIME_NODE_ID },
        ],
      },
    };
  };

  const ensureGraphRunning = async (graphId: string) => {
    const graph = await graphsService.findById(contextDataStorage, graphId);
    if (graph.status === GraphStatus.Running) {
      return;
    }
    await graphsService.run(contextDataStorage, graphId);
    await waitForGraphStatus(graphId, GraphStatus.Running);
  };

  const uniqueThreadSubId = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  interface ExecuteShellOptions {
    threadSubId?: string;
    shellResultTimeoutMs?: number;
    /** Extra args to merge into the shell tool call (e.g. timeoutMs). */
    shellArgs?: Record<string, unknown>;
  }

  /**
   * Shared scenario helper: registers mock LLM fixtures for a single shell
   * tool call turn (turn 1) + finish (turn 2), then drives the agent through
   * the full thread lifecycle and returns the shell execution summary for assertion.
   *
   * Must be called AFTER `getMockLlm(app).reset()` (which `beforeEach` does).
   * The caller must NOT call `getMockLlm(app).reset()` after calling this helper.
   */
  const executeShellScenario = async (
    graphId: string,
    message: string,
    command: string,
    options: ExecuteShellOptions = {},
  ) => {
    const mockLlm = getMockLlm(app);

    // Turn 1 (callIndex 0): shell is not yet loaded — agent uses tool_search to find it.
    mockLlm.onChat(
      { callIndex: 0 },
      { kind: 'toolCall', toolName: 'tool_search', args: { query: 'shell' } },
    );

    // Turn 2: shell is now loaded — agent calls shell with the given command.
    // Shell tool schema requires 'purpose' in addition to 'command'.
    mockLlm.onChat(
      { hasTools: ['shell'] },
      {
        kind: 'toolCall',
        toolName: 'shell',
        args: { purpose: 'run command', command, ...options.shellArgs },
      },
    );

    // Turn 3: after the shell result arrives, the agent calls finish to end the thread.
    // Using both hasToolResult + hasTools for specificity 2 so this fixture beats the
    // hasTools-only shell fixture (specificity 1) when the shell result is in context.
    mockLlm.onChat(
      { hasToolResult: 'shell', hasTools: ['finish'] },
      {
        kind: 'toolCall',
        toolName: 'finish',
        args: {
          purpose: 'done',
          message: 'Command executed.',
          needsMoreInfo: false,
        },
      },
    );

    await ensureGraphRunning(graphId);
    const threadSubId = options.threadSubId ?? uniqueThreadSubId('shell');
    const execution = await graphsService.executeTrigger(
      contextDataStorage,
      graphId,
      TRIGGER_NODE_ID,
      {
        messages: [message],
        async: false,
        threadSubId,
      },
    );

    expect(execution.externalThreadId).toBeDefined();

    const thread = await waitForThreadCompletion(execution.externalThreadId);
    expect(THREAD_COMPLETION_STATUSES).toContain(thread.status);
    expect(thread.status).toBe(ThreadStatus.Done);

    const messages = await waitForShellExecution(
      execution.externalThreadId,
      options.shellResultTimeoutMs,
    );

    const summary = findShellExecution(messages);
    expect(summary.toolName).toBe('shell');
    expect(summary.toolCallId).toBeDefined();
    expect(summary.result).toBeDefined();

    return summary;
  };

  describe('Tool call request ordering', () => {
    it(
      'persists shell tool call request before the tool result message',
      { timeout: 360_000 },
      async () => {
        const mockLlm = getMockLlm(app);

        // Turn 1 (callIndex 0): shell is not yet loaded — agent uses tool_search to find it.
        mockLlm.onChat(
          { callIndex: 0 },
          {
            kind: 'toolCall',
            toolName: 'tool_search',
            args: { query: 'shell' },
          },
        );

        // Turn 2: shell is now loaded — agent calls shell with a slow command so the
        // tool result is intentionally delayed, allowing assertion that the AI request
        // message is persisted before the tool result message arrives.
        // Shell tool schema requires 'purpose' in addition to 'command'.
        mockLlm.onChat(
          { hasTools: ['shell'] },
          {
            kind: 'toolCall',
            toolName: 'shell',
            args: {
              purpose: 'run slow command',
              command: 'sleep 15; echo "done-after-sleep"',
            },
          },
        );

        // Turn 3: after the slow shell completes, finish the thread cleanly.
        // Must include valid finish schema fields (purpose, message, needsMoreInfo).
        // Using hasToolResult + hasTools for specificity 2 so this fixture beats the
        // hasTools-only shell fixture (specificity 1) when the shell result is in context.
        mockLlm.onChat(
          { hasToolResult: 'shell', hasTools: ['finish'] },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: {
              purpose: 'done',
              message: 'Command executed.',
              needsMoreInfo: false,
            },
          },
        );

        await ensureGraphRunning(defaultGraphId);

        const execution = await graphsService.executeTrigger(
          contextDataStorage,
          defaultGraphId,
          TRIGGER_NODE_ID,
          {
            messages: [
              'Execute shell command: sleep 15; echo "done-after-sleep"',
            ],
            async: true,
            threadSubId: uniqueThreadSubId('shell-ordering'),
          },
        );

        expect(execution.externalThreadId).toBeDefined();

        const threadId = execution.externalThreadId;

        // Wait until the LLM-produced AI message with the shell tool call is persisted,
        // but the tool result message is not yet present (command is intentionally slow).
        const messagesWithRequestOnly = await waitForCondition(
          () => getThreadMessages(threadId),
          (threadMessages) => {
            const msgs = threadMessages.map((m) => m.message);
            const aiIndex = msgs.findIndex(
              (m) =>
                m.role === 'ai' &&
                Array.isArray(m.toolCalls) &&
                m.toolCalls.some((tc) => tc.name === 'shell'),
            );
            if (aiIndex < 0) {
              return false;
            }

            const ai = msgs[aiIndex];
            if (!ai || ai.role !== 'ai') {
              return false;
            }

            const shellToolCall = ai.toolCalls?.find(
              (tc) => tc.name === 'shell',
            );
            if (!shellToolCall?.id) {
              return false;
            }

            // Title should already be present on the request (generated from tool schema).
            if (
              typeof shellToolCall.title !== 'string' ||
              shellToolCall.title.length === 0
            ) {
              return false;
            }

            const toolIndex = msgs.findIndex(
              (m) =>
                m.role === 'tool' &&
                m.name === 'shell' &&
                m.toolCallId === shellToolCall.id,
            );

            return toolIndex < 0;
          },
          { timeout: 120_000, interval: 1_000 },
        );

        const msgsNow = messagesWithRequestOnly.map((m) => m.message);
        const aiNowIndex = msgsNow.findIndex(
          (m) =>
            m.role === 'ai' &&
            Array.isArray(m.toolCalls) &&
            m.toolCalls.some((tc) => tc.name === 'shell'),
        );
        expect(aiNowIndex).toBeGreaterThanOrEqual(0);

        const aiNow = msgsNow[aiNowIndex];
        expect(aiNow && aiNow.role === 'ai').toBe(true);
        if (!aiNow || aiNow.role !== 'ai') {
          throw new Error('Expected ai message with shell tool call.');
        }

        const shellCall = aiNow.toolCalls?.find((tc) => tc.name === 'shell');
        expect(shellCall?.id).toBeDefined();
        expect(typeof shellCall?.title).toBe('string');
        expect(shellCall?.title?.length).toBeGreaterThan(0);

        // Wait for completion and verify the tool result arrives after the request.
        await waitForThreadCompletion(threadId, 300_000);

        const finalMessages = await waitForShellExecution(threadId);
        const requestEntry = finalMessages.find((entry) => {
          const m = entry.message;
          return (
            m.role === 'ai' &&
            Array.isArray(m.toolCalls) &&
            m.toolCalls.some((tc) => tc.id === shellCall?.id)
          );
        });

        const resultEntry = finalMessages.find((entry) => {
          const m = entry.message;
          return (
            m.role === 'tool' &&
            m.name === 'shell' &&
            m.toolCallId === shellCall?.id
          );
        });

        expect(requestEntry).toBeDefined();
        expect(resultEntry).toBeDefined();

        // Thread messages API returns messages ordered by createdAt DESC, so compare timestamps
        // instead of relying on array index ordering.
        const requestTime = requestEntry
          ? new Date(requestEntry.createdAt).getTime()
          : NaN;
        const resultTime = resultEntry
          ? new Date(resultEntry.createdAt).getTime()
          : NaN;

        expect(Number.isFinite(requestTime)).toBe(true);
        expect(Number.isFinite(resultTime)).toBe(true);
        expect(requestTime).toBeLessThan(resultTime);
      },
    );
  });

  describe('Runtime shell command execution', () => {
    it(
      'runs a simple shell command end-to-end',
      { timeout: 120_000 },
      async () => {
        const result = await executeShellScenario(
          defaultGraphId,
          'Execute shell command: printf "Hello from integration test"',
          'printf "Hello from integration test"',
        );

        expect(result.result?.exitCode).toBe(0);
        expect(result.result?.stdout.trim()).toBe(
          'Hello from integration test',
        );
      },
    );

    it(
      'propagates runtime environment variables into the shell tool',
      { timeout: 120_000 },
      async () => {
        const result = await executeShellScenario(
          envGraphId,
          'Execute shell command: printf "%s" "$FOO"',
          'printf "%s" "$FOO"',
        );

        expect(result.result?.exitCode).toBe(0);
        expect(result.result?.stdout.trim()).toBe('bar');
      },
    );
  });

  describe('Custom runtime images', () => {
    it(
      'executes commands in an alpine runtime',
      { timeout: 120_000 },
      async () => {
        const result = await executeShellScenario(
          alpineGraphId,
          'Execute shell command: uname -a',
          'uname -a',
          { shellResultTimeoutMs: 240_000 },
        );

        expect(result.result?.exitCode).toBe(0);
        expect(result.result?.stdout.toLowerCase()).toContain('linux');
      },
    );
  });

  describe('Shell command error handling', () => {
    it(
      'surfaces stderr for invalid commands',
      { timeout: 120_000 },
      async () => {
        const result = await executeShellScenario(
          defaultGraphId,
          'Execute shell command: invalidcommandthatdoesnotexist',
          'invalidcommandthatdoesnotexist',
        );

        expect(result.result?.exitCode).not.toBe(0);
        expect(result.result?.stderr.toLowerCase()).toContain(
          'invalidcommandthatdoesnotexist',
        );
        expect(result.result?.stderr.toLowerCase()).toContain('not found');
      },
    );
  });

  describe('Shell command timeout behavior', () => {
    it(
      'applies overall timeout for long running commands',
      { timeout: 120_000 },
      async () => {
        const result = await executeShellScenario(
          defaultGraphId,
          'Execute shell command with timeoutMs=2000: sleep 5',
          'sleep 5',
          { shellArgs: { timeoutMs: 2000 } },
        );

        expect(result.result?.exitCode).toBe(124);
        expect(result.result?.stderr).toContain('Command timed out');
      },
    );
  });
});
