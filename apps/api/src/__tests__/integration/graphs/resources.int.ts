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
const GITHUB_RESOURCE_NODE_ID = 'github-resource-1';

const COMMAND_AGENT_INSTRUCTIONS =
  'You are a command runner. When the user message contains `Run this command: <cmd>` or `Execute shell command: <cmd>`, extract `<cmd>` and execute it exactly using the shell tool. Do not run any other commands, inspections, or tests unless the user explicitly requests them. After running the shell tool, call the finish tool with the stdout (and stderr if present). If the runtime is not yet started, wait briefly and retry once before reporting the failure.';

const TERMINAL_THREAD_STATUSES = [
  ThreadStatus.Done,
  ThreadStatus.Stopped,
  ThreadStatus.NeedMoreInfo,
];

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Graph Resources Integration Tests', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  let resourceGraphId: string;
  let testProjectId: string;

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
    timeoutMs = 120_000,
  ) => {
    return waitForCondition(
      () => graphsService.findById(contextDataStorage, graphId),
      (graph) => graph.status === status,
      { timeout: timeoutMs, interval: 1_000 },
    );
  };

  const waitForThreadCompletion = async (
    externalThreadId: string,
    timeoutMs = 120_000,
  ) => {
    // With async: true the thread may not exist in the DB immediately,
    // so look it up inside the polling loop where errors are retried.
    return waitForCondition(
      async () => {
        const thread = await threadsService.getThreadByExternalId(
          contextDataStorage,
          externalThreadId,
        );
        return threadsService.getThreadById(contextDataStorage, thread.id);
      },
      (currentThread) =>
        TERMINAL_THREAD_STATUSES.includes(currentThread.status),
      { timeout: timeoutMs, interval: 1_000 },
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

    const shellToolCall = aiMessage?.toolCalls?.find(
      (toolCall) => toolCall.name === 'shell',
    );
    const shellToolCallId = shellToolCall?.id;

    const shellMessage = messages
      .map((message) => message.message)
      .find(
        (message): message is ShellThreadMessage =>
          isShellThreadMessage(message) &&
          (shellToolCallId ? message.toolCallId === shellToolCallId : true),
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
      toolCallId: shellToolCallId ?? shellMessage?.toolCallId,
      result,
    };
  };

  const createResourceGraphData = (): CreateGraphDto => {
    const nodes: CreateGraphDto['schema']['nodes'] = [
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
          image: 'node:20',
          env: {},
          initScript: [
            'GH_VERSION=2.67.0 && ARCH=$(dpkg --print-architecture) && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" | tar xz -C /usr/local --strip-components=1',
          ],
          initScriptTimeoutMs: 90_000,
        },
      },
    ];

    nodes.push({
      id: GITHUB_RESOURCE_NODE_ID,
      template: 'github-resource',
      config: {
        auth: false,
      },
    });

    return {
      name: `Resource Graph ${Date.now()}`,
      description: 'Integration test graph for resource nodes',
      temporary: true,
      schema: {
        nodes,
        edges: [
          { from: TRIGGER_NODE_ID, to: AGENT_NODE_ID },
          { from: AGENT_NODE_ID, to: SHELL_NODE_ID },
          { from: SHELL_NODE_ID, to: RUNTIME_NODE_ID },
          { from: SHELL_NODE_ID, to: GITHUB_RESOURCE_NODE_ID },
        ],
      },
    };
  };

  beforeAll(async () => {
    app = await createTestModule();
    graphsService = app.get<GraphsService>(GraphsService);
    threadsService = app.get<ThreadsService>(ThreadsService);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;

    const graph = await graphsService.create(
      contextDataStorage,
      createResourceGraphData(),
    );
    resourceGraphId = graph.id;

    await graphsService.run(contextDataStorage, resourceGraphId);
    await waitForGraphStatus(resourceGraphId, GraphStatus.Running, 120_000);
  }, 120_000);

  afterAll(async () => {
    if (resourceGraphId) {
      await cleanupGraph(resourceGraphId);
    }

    if (testProjectId) {
      try {
        await app.get(ProjectsDao).deleteById(testProjectId);
      } catch {
        // best effort cleanup
      }
    }

    await app.close();
  }, 120_000);

  const ensureGraphRunning = async () => {
    const graph = await graphsService.findById(
      contextDataStorage,
      resourceGraphId,
    );
    if (graph.status === GraphStatus.Running) {
      return;
    }

    await graphsService.run(contextDataStorage, resourceGraphId);
    await waitForGraphStatus(resourceGraphId, GraphStatus.Running, 120_000);
  };

  const uniqueThreadSubId = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  describe('GitHub resource execution', () => {
    it(
      'propagates GitHub resource env and init config to shell tool',
      { timeout: 120_000 },
      async () => {
        await ensureGraphRunning();

        // The mocked LLM short-circuits to `finish` by default, so queue
        // explicit replies that drive the agent through the shell tool.
        const command = 'gh config get git_protocol; gh --version';
        const mockLlm = getMockLlm(app);
        mockLlm.queueChat({
          kind: 'toolCall',
          toolName: 'shell',
          args: { purpose: 'run gh resource command', command },
        });
        mockLlm.queueChat({
          kind: 'toolCall',
          toolName: 'finish',
          args: {
            purpose: 'done',
            message: 'Captured gh resource output',
            needsMoreInfo: false,
          },
        });

        // MockRuntime returns deterministic gh output; the test only verifies
        // env propagation, so the values are minimal but match the assertions.
        getMockRuntime(app).onExec(
          { cmd: 'gh config get git_protocol' },
          {
            exitCode: 0,
            stdout: 'https\ngh version 2.67.0 (mock)\n',
            stderr: '',
          },
        );

        const execution = await graphsService.executeTrigger(
          contextDataStorage,
          resourceGraphId,
          TRIGGER_NODE_ID,
          {
            messages: [`Run this command: ${command}`],
            async: true,
            threadSubId: uniqueThreadSubId('gh-resource'),
          },
        );

        expect(execution.externalThreadId).toBeDefined();

        const thread = await waitForThreadCompletion(
          execution.externalThreadId,
        );
        expect(thread.status).toBe(ThreadStatus.Done);

        const messages = await waitForCondition(
          () => getThreadMessages(execution.externalThreadId),
          (threadMessages) =>
            Boolean(findShellExecution(threadMessages).result),
          { timeout: 120_000, interval: 2_000 },
        );

        const shellExecution = findShellExecution(messages);
        expect(shellExecution.toolName).toBe('shell');
        expect(shellExecution.toolCallId).toBeDefined();
        expect(shellExecution.result).toBeDefined();
        expect(
          shellExecution.result?.exitCode,
          shellExecution.result?.stderr ?? 'missing shell stderr',
        ).toBe(0);
        expect(shellExecution.result?.stdout.toLowerCase() ?? '').toContain(
          'https',
        );
        expect(shellExecution.result?.stdout.toLowerCase() ?? '').toContain(
          'gh version',
        );
        expect(typeof shellExecution.result?.stderr).toBe('string');
      },
    );
  });
});
