import { INestApplication } from '@nestjs/common';
import { BaseException } from '@packages/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { ReasoningEffort } from '../../../v1/agents/agents.types';
import { SimpleAgentSchemaType } from '../../../v1/agents/services/agents/simple-agent';
import { CreateGraphDto } from '../../../v1/graphs/dto/graphs.dto';
import {
  GraphNodeSchemaType,
  GraphStatus,
} from '../../../v1/graphs/graphs.types';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { ThreadMessageDto } from '../../../v1/threads/dto/threads.dto';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { wait } from '../../test-utils';
import { waitForCondition } from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import { createTestModule, getMockLlm } from '../setup';

const DOCKER_RUNTIME_NODE_ID = 'runtime-1';
const SHELL_TOOL_NODE_ID = 'shell-tool-1';
const AGENT_NODE_ID = 'agent-1';
const TRIGGER_NODE_ID = 'trigger-1';
const DOCKER_PS_COMMAND =
  'Use the shell tool to execute this command: docker ps';
const DOCKER_DIND_IMAGE = 'docker:24.0-dind';
const DOCKER_DIND_INIT_SCRIPT = [
  'dockerd --host=unix:///var/run/docker.sock > /var/log/dockerd.log 2>&1 &',
  "sh -c 'i=0; while [ $i -lt 120 ]; do docker info >/dev/null 2>&1 && exit 0; i=$((i+1)); sleep 1; done; exit 1'",
];

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Docker Runtime Integration', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  const createdGraphIds: string[] = [];
  let testProjectId: string;

  const waitForGraphToBeRunning = async (
    graphId: string,
    timeoutMs = 120000,
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

      await wait(1000);
    }
  };

  const waitForThreadCompletion = async (
    externalThreadId: string,
    timeoutMs = 120000,
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
      { timeout: timeoutMs, interval: 1000 },
    );
  };

  type ShellThreadMessage = Extract<
    ThreadMessageDto['message'],
    { role: 'tool' }
  >;

  const isAiThreadMessage = (
    message: ThreadMessageDto['message'],
  ): message is Extract<ThreadMessageDto['message'], { role: 'ai' }> =>
    message.role === 'ai';

  const isShellThreadMessage = (
    message: ThreadMessageDto['message'],
  ): message is ShellThreadMessage =>
    message.role === 'tool' && message.name === 'shell';

  const getThreadMessages = async (
    externalThreadId: string,
  ): Promise<ThreadMessageDto[]> => {
    const thread = await threadsService.getThreadByExternalId(
      contextDataStorage,
      externalThreadId,
    );
    return threadsService.getThreadMessages(contextDataStorage, thread.id);
  };

  const findShellExecution = (messages: ThreadMessageDto[]) => {
    const aiMessage = messages.find(
      (
        message,
      ): message is ThreadMessageDto & {
        message: Extract<ThreadMessageDto['message'], { role: 'ai' }>;
      } => isAiThreadMessage(message.message),
    )?.message;

    const shellMessage = messages.find(
      (
        message,
      ): message is ThreadMessageDto & {
        message: ShellThreadMessage;
      } => isShellThreadMessage(message.message),
    )?.message;

    const shellToolCall = aiMessage?.toolCalls?.find(
      (toolCall) => toolCall.name === 'shell',
    );

    const result =
      shellMessage?.role === 'tool'
        ? (shellMessage.content as {
            exitCode?: number;
            stdout?: string;
            stderr?: string;
          })
        : undefined;

    return {
      toolName: shellToolCall?.name ?? shellMessage?.name,
      toolCallId: shellToolCall?.id ?? shellMessage?.toolCallId,
      result:
        result &&
        typeof result.exitCode === 'number' &&
        typeof result.stdout === 'string' &&
        typeof result.stderr === 'string'
          ? {
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            }
          : undefined,
    };
  };

  const removeGraphFromCleanup = (graphId: string) => {
    const index = createdGraphIds.indexOf(graphId);
    if (index >= 0) {
      createdGraphIds.splice(index, 1);
    }
  };

  const createDockerInDockerGraphData = (): CreateGraphDto => ({
    name: `Docker-in-Docker Test Graph ${Date.now()}`,
    description:
      'Validates docker runtime graph that runs docker commands by default',
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
              'You are a shell command executor agent. When the user asks you to execute a command, you MUST use the shell tool to execute it. Always respond with the stdout from the shell tool.',
            name: 'Test Agent',
            description: 'Test agent description',
            invokeModelName: 'gpt-5-mini',
            invokeModelReasoningEffort: ReasoningEffort.None,
            maxIterations: 50,
            summarizeMaxTokens: 272000,
            summarizeKeepTokens: 30000,
          } satisfies SimpleAgentSchemaType,
        },
        {
          id: SHELL_TOOL_NODE_ID,
          template: 'shell-tool',
          config: {},
        },
        {
          id: DOCKER_RUNTIME_NODE_ID,
          template: 'runtime',
          config: {
            runtimeType: 'Docker',
            image: DOCKER_DIND_IMAGE,
            initScript: DOCKER_DIND_INIT_SCRIPT,
            initScriptTimeoutMs: 300_000,
          },
        },
      ],
      edges: [
        { from: TRIGGER_NODE_ID, to: AGENT_NODE_ID },
        { from: AGENT_NODE_ID, to: SHELL_TOOL_NODE_ID },
        { from: SHELL_TOOL_NODE_ID, to: DOCKER_RUNTIME_NODE_ID },
      ],
    },
  });

  beforeAll(async () => {
    // Docker-in-docker tests literally exercise nested container behavior;
    // they require the real runtime.
    app = await createTestModule(undefined, { mockRuntime: false });

    graphsService = app.get<GraphsService>(GraphsService);
    threadsService = app.get<ThreadsService>(ThreadsService);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;
  });

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
  }, 180000);

  it(
    'runs docker runtime and executes docker commands through the shell tool',
    { timeout: 180000 },
    async () => {
      const graphData = createDockerInDockerGraphData();

      const createResponse = await graphsService.create(
        contextDataStorage,
        graphData,
      );
      const graphId = createResponse.id;
      createdGraphIds.push(graphId);

      expect(createResponse.status).toBe(GraphStatus.Created);

      const runtimeNode = createResponse.schema.nodes.find(
        (node: GraphNodeSchemaType) => node.id === DOCKER_RUNTIME_NODE_ID,
      );
      expect(runtimeNode).toBeDefined();
      expect(runtimeNode?.template).toBe('runtime');
      expect(runtimeNode?.config.image).toBe(DOCKER_DIND_IMAGE);

      const runResponse = await graphsService.run(contextDataStorage, graphId);
      expect(runResponse.status).toBe(GraphStatus.Running);

      await waitForGraphToBeRunning(graphId);

      // Drive the mocked agent to call shell(docker ps); applyDefaults handles
      // the follow-up finish call after the tool result returns.
      getMockLlm(app).queueChat({
        kind: 'toolCall',
        toolName: 'shell',
        args: {
          purpose: 'Run docker ps inside the docker-in-docker runtime',
          command: 'docker ps',
        },
      });

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        graphId,
        TRIGGER_NODE_ID,
        {
          messages: [DOCKER_PS_COMMAND],
          threadSubId: 'docker-ps-test',
          async: false,
        },
      );

      expect(execution.externalThreadId).toBeDefined();

      const thread = await waitForThreadCompletion(execution.externalThreadId);
      expect(
        [
          ThreadStatus.Done,
          ThreadStatus.NeedMoreInfo,
          ThreadStatus.Stopped,
        ].includes(thread.status),
      ).toBe(true);

      const messages = await waitForCondition(
        () => getThreadMessages(execution.externalThreadId),
        (msgs) => Boolean(findShellExecution(msgs)?.result),
        { timeout: 60000, interval: 1000 },
      );

      const shellExecution = findShellExecution(messages);
      expect(shellExecution?.toolName).toBe('shell');
      expect(shellExecution?.toolCallId).toBeDefined();
      const stdout = shellExecution?.result?.stdout ?? '';
      const stderr = shellExecution?.result?.stderr ?? '';
      const exitCode = shellExecution?.result?.exitCode ?? 1;
      if (exitCode !== 0) {
        throw new Error(
          `docker ps failed (exit ${exitCode}). stdout: ${stdout} stderr: ${stderr}`,
        );
      }

      expect(stdout.length).toBeGreaterThan(0);
      expect(/CONTAINER|IMAGE/i.test(stdout)).toBe(true);

      const destroyResponse = await graphsService.destroy(
        contextDataStorage,
        graphId,
      );
      expect(destroyResponse.status).toBe(GraphStatus.Stopped);

      await graphsService.delete(contextDataStorage, graphId);

      await expect(
        graphsService.findById(contextDataStorage, graphId),
      ).rejects.toMatchObject({
        errorCode: 'GRAPH_NOT_FOUND',
      });

      removeGraphFromCleanup(graphId);
    },
  );
});
