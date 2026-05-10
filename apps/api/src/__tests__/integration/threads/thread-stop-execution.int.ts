import { INestApplication } from '@nestjs/common';
import { BaseException } from '@packages/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { ReasoningEffort } from '../../../v1/agents/agents.types';
import { SimpleAgentSchemaType } from '../../../v1/agents/services/agents/simple-agent';
import { CreateGraphDto } from '../../../v1/graphs/dto/graphs.dto';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { ThreadMessageDto } from '../../../v1/threads/dto/threads.dto';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { waitForCondition } from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import { getMockRuntime } from '../mocks/mock-runtime';
import { createTestModule, getMockLlm } from '../setup';

const TRIGGER_NODE_ID = 'trigger-1';
const AGENT_NODE_ID = 'agent-1';
const SHELL_NODE_ID = 'shell-1';
const RUNTIME_NODE_ID = 'runtime-1';

const COMMAND_AGENT_INSTRUCTIONS =
  'You are a command runner. When the user message contains `Run this command: <cmd>` or `Execute shell command: <cmd>`, extract `<cmd>` and execute it exactly using the shell tool. Do not run any other commands. After running the shell tool, call the finish tool with the stdout (and stderr if present).';

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Thread Stop Execution Integration Tests', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  let graphId: string;
  let testProjectId: string;

  beforeAll(async () => {
    app = await createTestModule();
    graphsService = app.get<GraphsService>(GraphsService);
    threadsService = app.get<ThreadsService>(ThreadsService);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;

    // The shell-tool path needs MockRuntime to hang under signal so the abort
    // races real exec semantics. Echo fallback handles the rerun command path.
    getMockRuntime(app).onExec(
      { cmd: 'sleep 60' },
      { hangUntilAbort: true, exitCode: 124, stderr: 'Aborted' },
    );

    const graph = await graphsService.create(
      contextDataStorage,
      createShellStopGraphData(),
    );
    graphId = graph.id;

    await graphsService.run(contextDataStorage, graphId);
    await waitForGraphStatus(graphId, GraphStatus.Running);
  }, 180_000);

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
  }, 180_000);

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

  const createShellStopGraphData = (): CreateGraphDto => {
    return {
      name: `Thread Stop Test ${Date.now()}`,
      description: 'Integration test graph for stopping a thread execution',
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
          { from: TRIGGER_NODE_ID, to: AGENT_NODE_ID },
          { from: AGENT_NODE_ID, to: SHELL_NODE_ID },
          { from: SHELL_NODE_ID, to: RUNTIME_NODE_ID },
        ],
      },
    };
  };

  const ensureGraphRunning = async () => {
    const graph = await graphsService.findById(contextDataStorage, graphId);
    if (graph.status === GraphStatus.Running) {
      return;
    }

    await graphsService.run(contextDataStorage, graphId);
    await waitForGraphStatus(graphId, GraphStatus.Running);
  };

  type ShellThreadMessage = Extract<
    ThreadMessageDto['message'],
    { role: 'tool' }
  >;

  const isShellThreadMessage = (
    message: ThreadMessageDto['message'],
  ): message is ShellThreadMessage =>
    message.role === 'tool' && message.name === 'shell';

  const extractShellResult = (
    message: ThreadMessageDto['message'],
  ): { exitCode: number; stdout: string; stderr: string } | null => {
    if (!isShellThreadMessage(message)) {
      return null;
    }

    const raw =
      message.role === 'tool'
        ? (message.content as {
            exitCode?: number;
            stdout?: string;
            stderr?: string;
          })
        : undefined;

    if (
      typeof raw?.exitCode !== 'number' ||
      typeof raw?.stdout !== 'string' ||
      typeof raw?.stderr !== 'string'
    ) {
      return null;
    }

    return {
      exitCode: raw.exitCode,
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  };

  const getShellResults = (messages: ThreadMessageDto[]) =>
    messages
      .map((m) => extractShellResult(m.message))
      .filter((r): r is { exitCode: number; stdout: string; stderr: string } =>
        Boolean(r),
      );

  const hasShellToolCall = (message: ThreadMessageDto['message']): boolean => {
    if (message.role !== 'ai') {
      return false;
    }
    return (
      Array.isArray(message.toolCalls) &&
      message.toolCalls.some((toolCall) => toolCall.name === 'shell')
    );
  };

  const getThreadMessagesByExternalId = async (externalThreadId: string) => {
    const thread = await threadsService.getThreadByExternalId(
      contextDataStorage,
      externalThreadId,
    );
    return threadsService.getThreadMessages(contextDataStorage, thread.id, {
      limit: 200,
      offset: 0,
    });
  };

  const startShellExecution = async (threadSubId: string) => {
    // Drive the mocked agent to call shell(sleep 60) before the trigger fires.
    getMockLlm(app).queueChat({
      kind: 'toolCall',
      toolName: 'shell',
      args: { purpose: 'sleep for stop test', command: 'sleep 60' },
    });

    const execution = await graphsService.executeTrigger(
      contextDataStorage,
      graphId,
      TRIGGER_NODE_ID,
      {
        messages: ['Run this command: sleep 60'],
        async: true,
        threadSubId,
      },
    );

    const runningThread = await waitForCondition(
      () =>
        threadsService.getThreadByExternalId(
          contextDataStorage,
          execution.externalThreadId,
        ),
      (t) => t.status === ThreadStatus.Running,
      { timeout: 30_000, interval: 1_000 },
    );

    // Ensure the agent has actually decided to run the shell tool before stopping.
    // Otherwise, there's nothing to "abort" into a deterministic exitCode=124 message.
    await waitForCondition(
      () => getThreadMessagesByExternalId(execution.externalThreadId),
      (messages) => messages.some((m) => hasShellToolCall(m.message)),
      { timeout: 30_000, interval: 1_000 },
    );

    return { execution, runningThread };
  };

  const waitForAbortedShellResult = async (externalThreadId: string) =>
    waitForCondition(
      () => getThreadMessagesByExternalId(externalThreadId),
      (messages) =>
        getShellResults(messages).some(
          (result) =>
            result.exitCode === 124 && result.stderr.includes('Aborted'),
        ),
      { timeout: 60_000, interval: 2_000 },
    );

  it.each([
    {
      label: 'stopThreadByExternalId',
      stop: async (threadId: string, externalThreadId: string) =>
        threadsService.stopThreadByExternalId(
          contextDataStorage,
          externalThreadId,
        ),
    },
    {
      label: 'stopThread (by internal id)',
      stop: async (threadId: string) =>
        threadsService.stopThread(contextDataStorage, threadId),
    },
  ])(
    '$label aborts a running execution (ThreadUpdate stopped emitted by GraphStateManager)',
    { timeout: 300_000 },
    async ({ label, stop }) => {
      await ensureGraphRunning();
      const threadSubId = `${label.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}`;

      const { execution, runningThread } =
        await startShellExecution(threadSubId);

      await stop(runningThread.id, execution.externalThreadId);

      const stoppedThread = await waitForCondition(
        () =>
          threadsService.getThreadById(contextDataStorage, runningThread.id),
        (t) => t.status === ThreadStatus.Stopped,
        { timeout: 60_000, interval: 1_000 },
      );
      expect(stoppedThread.status).toBe(ThreadStatus.Stopped);

      const messages = await waitForAbortedShellResult(
        execution.externalThreadId,
      );
      const shellResults = getShellResults(messages);
      expect(
        shellResults.some(
          (result) =>
            result.exitCode === 124 && result.stderr.includes('Aborted'),
        ),
      ).toBe(true);
    },
  );

  it(
    'can stop a running shell thread and then re-trigger the same thread to completion (preserves message history)',
    { timeout: 300_000 },
    async () => {
      await ensureGraphRunning();

      const threadSubId = `stop-rerun-${Date.now()}`;
      const sleepMessage = 'Run this command: sleep 60';

      // Drive the agent: first call → shell(sleep 60).
      getMockLlm(app).queueChat({
        kind: 'toolCall',
        toolName: 'shell',
        args: { purpose: 'sleep for rerun test', command: 'sleep 60' },
      });

      const execution1 = await graphsService.executeTrigger(
        contextDataStorage,
        graphId,
        TRIGGER_NODE_ID,
        {
          messages: [sleepMessage],
          async: true,
          threadSubId,
        },
      );

      const runningThread = await waitForCondition(
        () =>
          threadsService.getThreadByExternalId(
            contextDataStorage,
            execution1.externalThreadId,
          ),
        (t) => t.status === ThreadStatus.Running,
        { timeout: 30_000, interval: 1_000 },
      );

      await waitForCondition(
        () => getThreadMessagesByExternalId(execution1.externalThreadId),
        (messages) => messages.some((m) => hasShellToolCall(m.message)),
        { timeout: 30_000, interval: 1_000 },
      );

      await threadsService.stopThreadByExternalId(
        contextDataStorage,
        execution1.externalThreadId,
      );

      await waitForCondition(
        () =>
          threadsService.getThreadById(contextDataStorage, runningThread.id),
        (t) => t.status === ThreadStatus.Stopped,
        { timeout: 60_000, interval: 1_000 },
      );

      await waitForCondition(
        () => getThreadMessagesByExternalId(execution1.externalThreadId),
        (messages) => getShellResults(messages).some((r) => r.exitCode === 124),
        { timeout: 60_000, interval: 2_000 },
      );

      const rerunToken = `RERUN_OK_${Date.now()}`;
      const rerunMessage = `Run this command: echo "${rerunToken}"`;

      // Drive the agent: rerun call → shell(echo rerunToken). The MockRuntime
      // echo built-in returns the token as stdout so the assertions hold.
      getMockLlm(app).queueChat({
        kind: 'toolCall',
        toolName: 'shell',
        args: {
          purpose: 'echo rerun token',
          command: `echo "${rerunToken}"`,
        },
      });

      const execution2 = await graphsService.executeTrigger(
        contextDataStorage,
        graphId,
        TRIGGER_NODE_ID,
        {
          messages: [rerunMessage],
          async: false,
          threadSubId,
        },
      );

      expect(execution2.externalThreadId).toBe(execution1.externalThreadId);

      const completedThread = await waitForCondition(
        () =>
          threadsService.getThreadByExternalId(
            contextDataStorage,
            execution2.externalThreadId,
          ),
        (t) => t.status === ThreadStatus.Done,
        { timeout: 60_000, interval: 1_000 },
      );

      const messages = await waitForCondition(
        () =>
          threadsService.getThreadMessages(
            contextDataStorage,
            completedThread.id,
            {
              limit: 500,
              offset: 0,
            },
          ),
        (msgs) => {
          const humanContents = msgs
            .filter((m) => m.message.role === 'human')
            .map((m) => m.message.content);

          const shellResults = getShellResults(msgs);

          return (
            humanContents.includes(sleepMessage) &&
            humanContents.includes(rerunMessage) &&
            shellResults.some((r) => r.exitCode === 124) &&
            shellResults.some(
              (r) => r.exitCode === 0 && r.stdout.includes(rerunToken),
            )
          );
        },
        { timeout: 120_000, interval: 2_000 },
      );

      const humanContents = messages
        .filter((m) => m.message.role === 'human')
        .map((m) => m.message.content);
      expect(humanContents).toEqual(
        expect.arrayContaining([sleepMessage, rerunMessage]),
      );

      const shellResults = getShellResults(messages);
      expect(
        shellResults.some(
          (r) => r.exitCode === 124 && r.stderr.includes('Aborted'),
        ),
      ).toBe(true);
      expect(
        shellResults.some(
          (r) => r.exitCode === 0 && r.stdout.includes(rerunToken),
        ),
      ).toBe(true);
    },
  );
});
