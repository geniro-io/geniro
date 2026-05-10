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

const THREAD_COMPLETION_STATUSES: ThreadStatus[] = [
  ThreadStatus.Done,
  ThreadStatus.NeedMoreInfo,
  ThreadStatus.Stopped,
];

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('ShellTool persistent sessions (integration)', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  let defaultGraphId: string;
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
      // Persistent-shell session semantics need a real container.
      { mockRuntime: false },
    );
    graphsService = app.get<GraphsService>(GraphsService);
    threadsService = app.get<ThreadsService>(ThreadsService);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;

    const defaultGraph = await graphsService.create(
      contextDataStorage,
      createShellSessionGraphData(),
    );
    defaultGraphId = defaultGraph.id;
    await graphsService.run(contextDataStorage, defaultGraphId);
    await waitForGraphStatus(defaultGraphId, GraphStatus.Running);
  }, 300_000);

  afterAll(async () => {
    if (defaultGraphId) {
      await cleanupGraph(defaultGraphId);
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

  type ShellThreadMessage = Extract<
    ThreadMessageDto['message'],
    { role: 'tool' }
  >;

  const isShellThreadMessage = (
    message: ThreadMessageDto['message'],
  ): message is ShellThreadMessage =>
    message.role === 'tool' && message.name === 'shell';

  /**
   * Returns all shell tool results from a thread's messages, in chronological
   * order (oldest first), correlating AI tool-call args to tool results via
   * toolCallId so we know which command produced which output.
   *
   * Note: `getThreadMessages` returns messages DESC (newest first), so we
   * reverse before building the results array to restore chronological order.
   */
  const findAllShellResults = (
    messages: ThreadMessageDto[],
  ): {
    command: string | undefined;
    exitCode: number;
    stdout: string;
    stderr: string;
  }[] => {
    // Reverse to chronological (oldest first) since API returns newest first.
    const msgs = [...messages].reverse().map((m) => m.message);

    // Build a map from toolCallId → shell command args (from AI messages).
    const callIdToCommand = new Map<string, string>();
    for (const msg of msgs) {
      if (msg.role === 'ai' && Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          if (tc.name === 'shell' && tc.id) {
            const args = tc.args as Record<string, unknown> | undefined;
            const cmd =
              args && typeof args.command === 'string'
                ? args.command
                : undefined;
            callIdToCommand.set(tc.id, cmd ?? '');
          }
        }
      }
    }

    const results: {
      command: string | undefined;
      exitCode: number;
      stdout: string;
      stderr: string;
    }[] = [];

    for (const msg of msgs) {
      if (isShellThreadMessage(msg) && msg.toolCallId) {
        const raw = msg.content as {
          exitCode?: number;
          stdout?: string;
          stderr?: string;
        };
        if (
          typeof raw.exitCode === 'number' &&
          typeof raw.stdout === 'string' &&
          typeof raw.stderr === 'string'
        ) {
          results.push({
            command: callIdToCommand.get(msg.toolCallId),
            exitCode: raw.exitCode,
            stdout: raw.stdout,
            stderr: raw.stderr,
          });
        }
      }
    }

    return results;
  };

  /**
   * Wait until the thread has at least `count` shell tool results persisted.
   */
  const waitForShellResultCount = async (
    externalThreadId: string,
    count: number,
    timeoutMs = 180_000,
  ) => {
    return waitForCondition(
      () => getThreadMessages(externalThreadId),
      (threadMessages) => findAllShellResults(threadMessages).length >= count,
      { timeout: timeoutMs, interval: 2_000 },
    );
  };

  const createShellSessionGraphData = (): CreateGraphDto => ({
    name: `Shell Session Test ${Date.now()}`,
    description: 'Integration test graph for shell session persistence',
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
              'You are a shell session tester. Execute the shell commands provided by the user exactly as requested, in the order given. After all commands complete, call the finish tool.',
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
  });

  it(
    'preserves environment variables and cwd within the same session',
    { timeout: 300_000 },
    async () => {
      const mockLlm = getMockLlm(app);

      // Turn 1 (callIndex 0): shell not yet loaded — search for it.
      mockLlm.onChat(
        { callIndex: 0 },
        { kind: 'toolCall', toolName: 'tool_search', args: { query: 'shell' } },
      );

      // Turn 2 (callIndex 1): shell loaded — set an env variable.
      mockLlm.onChat(
        { callIndex: 1 },
        {
          kind: 'toolCall',
          toolName: 'shell',
          args: { purpose: 'set env', command: 'export PERSIST_FOO=bar' },
        },
      );

      // Turn 3 (callIndex 2): read the env variable (asserts it persisted).
      mockLlm.onChat(
        { callIndex: 2 },
        {
          kind: 'toolCall',
          toolName: 'shell',
          args: { purpose: 'read env', command: 'echo $PERSIST_FOO' },
        },
      );

      // Turn 4 (callIndex 3): change directory.
      mockLlm.onChat(
        { callIndex: 3 },
        {
          kind: 'toolCall',
          toolName: 'shell',
          args: { purpose: 'change dir', command: 'cd /tmp' },
        },
      );

      // Turn 5 (callIndex 4): confirm the cwd persisted.
      mockLlm.onChat(
        { callIndex: 4 },
        {
          kind: 'toolCall',
          toolName: 'shell',
          args: { purpose: 'confirm dir', command: 'pwd' },
        },
      );

      // Turn 6 (callIndex 5): all done — call finish.
      mockLlm.onChat(
        { callIndex: 5 },
        {
          kind: 'toolCall',
          toolName: 'finish',
          args: {
            purpose: 'done',
            message: 'Session persistence verified.',
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
            'Run these commands in order: export PERSIST_FOO=bar, echo $PERSIST_FOO, cd /tmp, pwd',
          ],
          async: false,
          threadSubId: uniqueThreadSubId('shell-session'),
        },
      );

      expect(execution.externalThreadId).toBeDefined();

      const thread = await waitForThreadCompletion(execution.externalThreadId);
      expect(THREAD_COMPLETION_STATUSES).toContain(thread.status);
      expect(thread.status).toBe(ThreadStatus.Done);

      // Wait until all 4 shell results are persisted.
      const messages = await waitForShellResultCount(
        execution.externalThreadId,
        4,
      );
      const shellResults = findAllShellResults(messages);
      expect(shellResults).toHaveLength(4);

      // Index 0: export (exit 0)
      expect(shellResults[0]?.exitCode).toBe(0);

      // Index 1: echo $PERSIST_FOO — env var must have survived across shell calls.
      expect(shellResults[1]?.exitCode).toBe(0);
      expect(shellResults[1]?.stdout.trim()).toBe('bar');

      // Index 2: cd /tmp (exit 0)
      expect(shellResults[2]?.exitCode).toBe(0);

      // Index 3: pwd — cwd must still be /tmp after the cd in a prior call.
      expect(shellResults[3]?.exitCode).toBe(0);
      expect(shellResults[3]?.stdout.trim()).toBe('/tmp');
    },
  );

  it(
    'terminates commands that stop producing output within tailTimeoutMs',
    { timeout: 120_000 },
    async () => {
      const mockLlm = getMockLlm(app);

      // Turn 1 (callIndex 0): search for shell tool.
      mockLlm.onChat(
        { callIndex: 0 },
        { kind: 'toolCall', toolName: 'tool_search', args: { query: 'shell' } },
      );

      // Turn 2: shell loaded — invoke with a short tailTimeoutMs so the sleep
      // phase gets killed before "end" is printed.
      mockLlm.onChat(
        { hasTools: ['shell'] },
        {
          kind: 'toolCall',
          toolName: 'shell',
          args: {
            purpose: 'tail timeout enforcement',
            command: 'echo "start"; sleep 2; echo "end"',
            tailTimeoutMs: 500,
            timeoutMs: 10_000,
          },
        },
      );

      // Turn 3: after the timed-out shell result, call finish.
      // Using hasToolResult + hasTools for specificity 2 so this fixture beats
      // the hasTools-only shell fixture (specificity 1) when the result is in context.
      mockLlm.onChat(
        { hasToolResult: 'shell', hasTools: ['finish'] },
        {
          kind: 'toolCall',
          toolName: 'finish',
          args: {
            purpose: 'done',
            message: 'Tail timeout enforced.',
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
          messages: ['Run: echo "start"; sleep 2; echo "end"'],
          async: false,
          threadSubId: uniqueThreadSubId('shell-tail'),
        },
      );

      expect(execution.externalThreadId).toBeDefined();

      const thread = await waitForThreadCompletion(
        execution.externalThreadId,
        120_000,
      );
      expect(THREAD_COMPLETION_STATUSES).toContain(thread.status);
      expect(thread.status).toBe(ThreadStatus.Done);

      const messages = await waitForShellResultCount(
        execution.externalThreadId,
        1,
      );
      const shellResults = findAllShellResults(messages);
      expect(shellResults.length).toBeGreaterThanOrEqual(1);

      const result = shellResults[0];
      expect(result?.exitCode).toBe(124);
      expect(result?.stdout).toContain('start');
      expect(result?.stdout).not.toContain('end');
      expect(result?.stderr.toLowerCase()).toContain('timed out');
    },
  );
});
