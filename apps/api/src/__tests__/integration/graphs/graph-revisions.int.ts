import { ToolRunnableConfig } from '@langchain/core/tools';
import { INestApplication } from '@nestjs/common';
import { BaseException } from '@packages/common';
import { cloneDeep } from 'lodash';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { environment } from '../../../environments';
import { BaseMcp } from '../../../v1/agent-mcp/services/base-mcp';
import type { BuiltAgentTool } from '../../../v1/agent-tools/tools/base-tool';
import {
  BaseAgentConfigurable,
  ReasoningEffort,
} from '../../../v1/agents/agents.types';
import {
  SimpleAgent,
  SimpleAgentSchemaType,
} from '../../../v1/agents/services/agents/simple-agent';
import { CreateGraphDto } from '../../../v1/graphs/dto/graphs.dto';
import {
  GraphNodeSchemaType,
  GraphRevisionStatus,
  GraphStatus,
} from '../../../v1/graphs/graphs.types';
import { GraphCompiler } from '../../../v1/graphs/services/graph-compiler';
import { GraphRegistry } from '../../../v1/graphs/services/graph-registry';
import { GraphRevisionService } from '../../../v1/graphs/services/graph-revision.service';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { LiteLlmClient } from '../../../v1/litellm/services/litellm.client';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { BaseRuntime } from '../../../v1/runtime/services/base-runtime';
import { RuntimeThreadProvider } from '../../../v1/runtime/services/runtime-thread-provider';
import { ThreadMessageDto } from '../../../v1/threads/dto/threads.dto';
import { ThreadNameGeneratorService } from '../../../v1/threads/services/thread-name-generator.service';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { wait } from '../../test-utils';
import {
  createMockGraphData,
  waitForCondition,
} from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import {
  mockLiteLlmClient,
  mockThreadNameGenerator,
} from '../helpers/test-stubs';
import { getMockLlm } from '../mocks/mock-llm';
import { createTestModule } from '../setup';

const TEST_AGENT_NODE_ID = 'agent-1';

const COMMAND_AGENT_INSTRUCTIONS =
  'You are a command runner. When the user message contains `Run this command: <cmd>` or `Execute shell command: <cmd>`, extract `<cmd>` and execute it exactly using the shell tool. Do not run any other commands, inspections, or tests unless the user explicitly requests them. After running the shell tool, call the finish tool with the stdout (and stderr if present). If the runtime is not yet started, wait briefly and retry once before reporting the failure.';

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Graph Revisions Integration Tests', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let revisionsService: GraphRevisionService;
  let threadsService: ThreadsService;
  let graphRegistry: GraphRegistry;
  let graphCompiler: GraphCompiler;
  const createdGraphIds: string[] = [];
  let coreGraphId: string;
  let testProjectId: string;

  const waitForGraphToBeRunning = async (id: string, timeoutMs = 60000) => {
    const startedAt = Date.now();

    while (true) {
      const graph = await graphsService.findById(contextDataStorage, id);

      if (graph.status === GraphStatus.Running) {
        return graph;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          `Graph ${id} did not reach running status within ${timeoutMs}ms (current status: ${graph.status})`,
        );
      }

      await wait(1000);
    }
  };

  const waitForRevisionStatus = async (
    graphId: string,
    revisionId: string,
    status: GraphRevisionStatus | GraphRevisionStatus[],
    timeoutMs = 60000,
  ) => {
    const startedAt = Date.now();
    const statuses = Array.isArray(status) ? status : [status];

    while (true) {
      const revision = await revisionsService.getRevisionById(
        contextDataStorage,
        graphId,
        revisionId,
      );

      if (revision && statuses.includes(revision.status)) {
        return revision;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          `Revision ${revisionId} did not reach status [${statuses.join(', ')}] within ${timeoutMs}ms (current: ${revision?.status || 'not found'})`,
        );
      }

      await wait(1000);
    }
  };

  const buildThreadConfig = (
    threadId: string,
  ): ToolRunnableConfig<BaseAgentConfigurable> => ({
    configurable: { thread_id: threadId },
  });

  const getRuntimeProvider = (graphId: string, nodeId: string) => {
    const runtimeProvider =
      graphRegistry.getNodeInstance<RuntimeThreadProvider>(graphId, nodeId);
    if (!runtimeProvider) {
      throw new Error(`Runtime node ${nodeId} not found in graph ${graphId}`);
    }
    return runtimeProvider;
  };

  const getRuntimeForThread = async (
    graphId: string,
    nodeId: string,
    threadId: string,
  ): Promise<BaseRuntime> => {
    const runtimeProvider = getRuntimeProvider(graphId, nodeId);
    return runtimeProvider.provide(buildThreadConfig(threadId));
  };

  const getShellTool = (graphId: string, nodeId: string) => {
    const toolNode = graphRegistry.getNodeInstance<{
      tools: BuiltAgentTool[];
    }>(graphId, nodeId);
    const shellTool =
      toolNode?.tools.find((tool) => tool.name === 'shell') ??
      toolNode?.tools[0];
    if (!shellTool) {
      throw new Error(`Shell tool not found in node ${nodeId}`);
    }
    return shellTool;
  };

  const getMcpOutput = (graphId: string, nodeId: string) => {
    const mcpNode = graphRegistry.getNode<BaseMcp>(graphId, nodeId);
    if (!mcpNode) {
      throw new Error(`MCP node ${nodeId} not found in graph ${graphId}`);
    }
    return mcpNode.instance;
  };

  const getContainerHostname = async (runtime: BaseRuntime) => {
    const res = await runtime.exec({ cmd: 'cat /etc/hostname' });
    if (res.fail) {
      throw new Error(
        `Failed to read hostname: exit=${res.exitCode} stderr=${res.stderr}`,
      );
    }
    return res.stdout.trim();
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

  const getThreadMessages = async (
    externalThreadId: string,
  ): Promise<ThreadMessageDto[]> => {
    const thread = await threadsService.getThreadByExternalId(
      contextDataStorage,
      externalThreadId,
    );
    return threadsService.getThreadMessages(contextDataStorage, thread.id);
  };

  const findShellExecution = (
    messages: ThreadMessageDto[],
    options?: { cmdIncludes?: string; stdoutIncludes?: string },
  ): {
    toolName?: string;
    toolCallId?: string;
    result?: {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
  } => {
    // ThreadsService returns messages in DESC order (newest first). We want the latest shell
    // execution, so we must search in the returned order (do NOT reverse).
    if (options?.stdoutIncludes) {
      const stdoutIncludes = options.stdoutIncludes;
      const shellEntry = messages.find(
        (
          entry,
        ): entry is ThreadMessageDto & {
          message: ShellThreadMessage;
        } => {
          if (!isShellThreadMessage(entry.message)) {
            return false;
          }
          const content = entry.message.content;
          const stdout = (content as { stdout?: unknown } | undefined)?.stdout;
          return typeof stdout === 'string' && stdout.includes(stdoutIncludes);
        },
      );

      const result =
        shellEntry?.message.role === 'tool'
          ? (shellEntry.message.content as {
              exitCode?: number;
              stdout?: string;
              stderr?: string;
            })
          : undefined;

      return {
        toolName: shellEntry?.message.name,
        toolCallId: shellEntry?.message.toolCallId,
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
    }

    const aiEntries = messages.filter(
      (
        entry,
      ): entry is ThreadMessageDto & {
        message: Extract<ThreadMessageDto['message'], { role: 'ai' }>;
      } =>
        isAiThreadMessage(entry.message) &&
        Boolean(entry.message.toolCalls?.some((tc) => tc.name === 'shell')),
    );

    const selectShellCall = () => {
      for (const aiEntry of aiEntries) {
        for (const tc of aiEntry.message.toolCalls ?? []) {
          if (tc.name !== 'shell') {
            continue;
          }
          const cmd = (tc.args as { cmd?: unknown } | undefined)?.cmd;
          if (options?.cmdIncludes) {
            if (typeof cmd !== 'string' || !cmd.includes(options.cmdIncludes)) {
              continue;
            }
          }

          const shellEntry = messages.find(
            (
              entry,
            ): entry is ThreadMessageDto & {
              message: ShellThreadMessage;
            } =>
              isShellThreadMessage(entry.message) &&
              entry.message.toolCallId === tc.id,
          );

          return {
            aiMessage: aiEntry.message,
            shellMessage: shellEntry?.message,
          };
        }
      }
      return { aiMessage: undefined, shellMessage: undefined };
    };

    const { aiMessage, shellMessage } = selectShellCall();

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
    revisionsService = app.get<GraphRevisionService>(GraphRevisionService);
    threadsService = app.get<ThreadsService>(ThreadsService);
    graphRegistry = app.get<GraphRegistry>(GraphRegistry);
    graphCompiler = app.get<GraphCompiler>(GraphCompiler);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;

    // Shared graph for revision/merge/conflict semantics. These tests do not require
    // a clean 1.0.0 baseline; they validate relative behavior using the current version.
    const coreGraph = await graphsService.create(
      contextDataStorage,
      createMockGraphData({
        name: `Graph Revisions Core ${Date.now()}`,
      }),
    );
    coreGraphId = coreGraph.id;
    createdGraphIds.push(coreGraphId);

    await graphsService.run(contextDataStorage, coreGraphId);
    await waitForGraphToBeRunning(coreGraphId, 120000);
  }, 180000);

  afterAll(async () => {
    await Promise.all(
      createdGraphIds.map(async (graphId) => {
        try {
          await graphsService.destroy(contextDataStorage, graphId);
        } catch (error: unknown) {
          if (
            error instanceof BaseException &&
            error.errorCode !== 'GRAPH_NOT_RUNNING' &&
            error.errorCode !== 'GRAPH_NOT_FOUND'
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
            error instanceof BaseException &&
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

  beforeEach(() => {
    getMockLlm(app).reset();
  });

  const ensureCoreGraphRunning = async () => {
    const graph = await graphsService.findById(contextDataStorage, coreGraphId);
    if (graph.status === GraphStatus.Running) {
      return;
    }
    await graphsService.run(contextDataStorage, coreGraphId);
    await waitForGraphToBeRunning(coreGraphId, 120000);
  };

  it('applies a revision to a running graph', { timeout: 60000 }, async () => {
    const newInstructions = 'Updated instructions for live revision';

    await ensureCoreGraphRunning();
    const baseGraph = await graphsService.findById(
      contextDataStorage,
      coreGraphId,
    );
    const baseVersion = baseGraph.version;

    const updatedSchema = cloneDeep(baseGraph.schema);
    updatedSchema.nodes = updatedSchema.nodes.map((node) =>
      node.id === TEST_AGENT_NODE_ID
        ? {
            ...node,
            config: {
              ...node.config,
              instructions: newInstructions,
            },
          }
        : node,
    );
    const updateResponse = await graphsService.update(
      contextDataStorage,
      coreGraphId,
      {
        schema: updatedSchema,
        currentVersion: baseVersion,
      },
    );

    expect(updateResponse.revision).toBeDefined();
    expect(updateResponse.revision!.status).toBe(GraphRevisionStatus.Pending);
    expect(updateResponse.revision!.toVersion).not.toBe(baseVersion);
    const revisionId = updateResponse.revision!.id;

    const revision = await waitForRevisionStatus(
      coreGraphId,
      revisionId,
      GraphRevisionStatus.Applied,
    );

    expect(revision.status).toBe(GraphRevisionStatus.Applied);
    expect(revision.error).toBeUndefined();

    const updatedGraph = await graphsService.findById(
      contextDataStorage,
      coreGraphId,
    );
    expect(updatedGraph.version).toBe(revision.toVersion);
    expect(updatedGraph.targetVersion).toBe(revision.toVersion);

    const agentNode = updatedGraph.schema.nodes.find(
      (node: GraphNodeSchemaType) => node.id === TEST_AGENT_NODE_ID,
    );
    expect(agentNode?.config.instructions).toBe(newInstructions);
  });

  it(
    'processes queued revisions sequentially',
    { timeout: 60000 },
    async () => {
      await ensureCoreGraphRunning();
      const baseGraph = await graphsService.findById(
        contextDataStorage,
        coreGraphId,
      );
      const baseVersion = baseGraph.version;

      const firstSchema = cloneDeep(baseGraph.schema);
      firstSchema.nodes = firstSchema.nodes.map((node) =>
        node.id === TEST_AGENT_NODE_ID
          ? {
              ...node,
              config: {
                ...(node.config as SimpleAgentSchemaType),
                instructions: 'First revision instructions',
              } satisfies SimpleAgentSchemaType,
            }
          : node,
      );

      const firstUpdateResponse = await graphsService.update(
        contextDataStorage,
        coreGraphId,
        {
          schema: firstSchema,
          currentVersion: baseVersion,
        },
      );

      expect(firstUpdateResponse.revision).toBeDefined();
      const firstRevision = firstUpdateResponse.revision!;
      expect(firstRevision.toVersion).not.toBe(baseVersion);

      await waitForRevisionStatus(
        coreGraphId,
        firstRevision.id,
        GraphRevisionStatus.Applied,
      );

      const graphAfterFirst = await graphsService.findById(
        contextDataStorage,
        coreGraphId,
      );
      expect(graphAfterFirst.version).toBe(firstRevision.toVersion);

      const secondSchema = cloneDeep(graphAfterFirst.schema);
      secondSchema.nodes = secondSchema.nodes.map((node) =>
        node.id === TEST_AGENT_NODE_ID
          ? {
              ...node,
              config: {
                ...(node.config as SimpleAgentSchemaType),
                instructions: 'Second revision overwrites first',
              } satisfies SimpleAgentSchemaType,
            }
          : node,
      );

      const secondUpdateResponse = await graphsService.update(
        contextDataStorage,
        coreGraphId,
        {
          schema: secondSchema,
          currentVersion: graphAfterFirst.version,
        },
      );

      expect(secondUpdateResponse.revision).toBeDefined();
      const secondRevision = secondUpdateResponse.revision!;
      expect(secondRevision.toVersion).not.toBe(graphAfterFirst.version);

      await waitForRevisionStatus(
        coreGraphId,
        secondRevision.id,
        GraphRevisionStatus.Applied,
      );

      const finalGraph = await graphsService.findById(
        contextDataStorage,
        coreGraphId,
      );
      expect(finalGraph.version).toBe(secondRevision.toVersion);
      expect(finalGraph.targetVersion).toBe(secondRevision.toVersion);

      const agentNode = finalGraph.schema.nodes.find(
        (node: GraphNodeSchemaType) => node.id === TEST_AGENT_NODE_ID,
      );
      expect(agentNode?.config.instructions).toBe(
        'Second revision overwrites first',
      );
    },
  );

  it(
    'merges non-conflicting concurrent edits from multiple users',
    { timeout: 60000 },
    async () => {
      await ensureCoreGraphRunning();
      const baseGraph = await graphsService.findById(
        contextDataStorage,
        coreGraphId,
      );
      const baseVersion = baseGraph.version;
      const baseSchema = baseGraph.schema;

      const userASchema = cloneDeep(baseSchema);
      userASchema.nodes = userASchema.nodes.map((node) =>
        node.id === TEST_AGENT_NODE_ID
          ? {
              ...node,
              config: {
                ...(node.config as SimpleAgentSchemaType),
                instructions: 'User A instructions',
              } satisfies SimpleAgentSchemaType,
            }
          : node,
      );

      const userAUpdate = await graphsService.update(
        contextDataStorage,
        coreGraphId,
        {
          schema: userASchema,
          currentVersion: baseVersion,
        },
      );

      const userARevisionId = userAUpdate.revision?.id;

      const userBSchema = cloneDeep(baseSchema);
      userBSchema.nodes = userBSchema.nodes.map((node) =>
        node.id === TEST_AGENT_NODE_ID
          ? {
              ...node,
              config: {
                ...(node.config as SimpleAgentSchemaType),
                invokeModelName: 'gpt-5.2',
              } satisfies SimpleAgentSchemaType,
            }
          : node,
      );

      const userBUpdate = await graphsService.update(
        contextDataStorage,
        coreGraphId,
        {
          schema: userBSchema,
          currentVersion: baseVersion,
        },
      );

      const userBRevisionId = userBUpdate.revision?.id;

      expect(userARevisionId).toBeDefined();
      expect(userBRevisionId).toBeDefined();

      const revisionIds = [userARevisionId!, userBRevisionId!];

      for (const revisionId of revisionIds) {
        await waitForRevisionStatus(
          coreGraphId,
          revisionId,
          GraphRevisionStatus.Applied,
        );
      }

      await waitForCondition(
        () => graphsService.findById(contextDataStorage, coreGraphId),
        (graph) =>
          graph.version !== baseVersion &&
          graph.targetVersion === graph.version,
        { timeout: 60000, interval: 1000 },
      );

      await wait(500);

      const finalGraph = await graphsService.findById(
        contextDataStorage,
        coreGraphId,
      );
      const agentNode = finalGraph.schema.nodes.find(
        (node: GraphNodeSchemaType) => node.id === TEST_AGENT_NODE_ID,
      );
      expect(agentNode?.config.instructions).toBe('User A instructions');
      expect((agentNode?.config as SimpleAgentSchemaType).invokeModelName).toBe(
        'gpt-5.2',
      );
    },
  );

  it(
    'rejects stale edits and allows refresh-retry flow',
    { timeout: 60000 },
    async () => {
      await ensureCoreGraphRunning();
      const baseGraph = await graphsService.findById(
        contextDataStorage,
        coreGraphId,
      );
      const baseVersion = baseGraph.version;
      const baseSchema = baseGraph.schema;

      const userAInstructions = `User A instructions ${Date.now()}`;
      const userBInstructions = `User B conflicting instructions ${Date.now()}`;

      const userASchema = cloneDeep(baseSchema);
      userASchema.nodes = userASchema.nodes.map((node) =>
        node.id === TEST_AGENT_NODE_ID
          ? {
              ...node,
              config: {
                ...(node.config as SimpleAgentSchemaType),
                instructions: userAInstructions,
              } satisfies SimpleAgentSchemaType,
            }
          : node,
      );

      const userAUpdate = await graphsService.update(
        contextDataStorage,
        coreGraphId,
        {
          schema: userASchema,
          currentVersion: baseVersion,
        },
      );

      expect(userAUpdate.revision).toBeDefined();
      await waitForRevisionStatus(
        coreGraphId,
        userAUpdate.revision!.id,
        GraphRevisionStatus.Applied,
      );

      const graphAfterUserA = await graphsService.findById(
        contextDataStorage,
        coreGraphId,
      );
      const currentVersion = graphAfterUserA.version;

      const userBSchema = cloneDeep(baseSchema);
      userBSchema.nodes = userBSchema.nodes.map((node) =>
        node.id === TEST_AGENT_NODE_ID
          ? {
              ...node,
              config: {
                ...(node.config as SimpleAgentSchemaType),
                instructions: userBInstructions,
              } satisfies SimpleAgentSchemaType,
            }
          : node,
      );

      await expect(
        graphsService.update(contextDataStorage, coreGraphId, {
          schema: userBSchema,
          currentVersion: baseVersion,
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'VERSION_CONFLICT',
      });

      const userBUpdate = await graphsService.update(
        contextDataStorage,
        coreGraphId,
        {
          schema: userBSchema,
          currentVersion: currentVersion,
        },
      );

      expect(userBUpdate.revision).toBeDefined();

      await waitForRevisionStatus(
        coreGraphId,
        userBUpdate.revision!.id,
        GraphRevisionStatus.Applied,
      );

      const finalGraph = await graphsService.findById(
        contextDataStorage,
        coreGraphId,
      );
      const agentNode = finalGraph.schema.nodes.find(
        (node: GraphNodeSchemaType) => node.id === TEST_AGENT_NODE_ID,
      );
      expect(agentNode?.config.instructions).toBe(userBInstructions);
    },
  );

  it(
    'rejects concurrent conflicting edits to same field',
    { timeout: 60000 },
    async () => {
      await ensureCoreGraphRunning();
      const baseGraph = await graphsService.findById(
        contextDataStorage,
        coreGraphId,
      );
      const baseVersion = baseGraph.version;
      const baseSchema = baseGraph.schema;

      const schema1 = cloneDeep(baseSchema);
      schema1.nodes = schema1.nodes.map((node) =>
        node.id === TEST_AGENT_NODE_ID
          ? {
              ...node,
              config: {
                ...(node.config as SimpleAgentSchemaType),
                instructions: 'First edit',
              } satisfies SimpleAgentSchemaType,
            }
          : node,
      );

      const firstResponse = await graphsService.update(
        contextDataStorage,
        coreGraphId,
        {
          schema: schema1,
          currentVersion: baseVersion,
        },
      );
      expect(firstResponse.revision).toBeDefined();

      const schema2 = cloneDeep(baseSchema);
      schema2.nodes = schema2.nodes.map((node) =>
        node.id === TEST_AGENT_NODE_ID
          ? {
              ...node,
              config: {
                ...(node.config as SimpleAgentSchemaType),
                instructions: 'Second conflicting edit',
              } satisfies SimpleAgentSchemaType,
            }
          : node,
      );

      await expect(
        graphsService.update(contextDataStorage, coreGraphId, {
          schema: schema2,
          currentVersion: baseVersion,
        }),
      ).rejects.toMatchObject({
        errorCode: 'MERGE_CONFLICT',
        statusCode: 400,
      });

      await waitForRevisionStatus(
        coreGraphId,
        firstResponse.revision!.id,
        GraphRevisionStatus.Applied,
      );

      const finalGraph = await graphsService.findById(
        contextDataStorage,
        coreGraphId,
      );
      const agentNode = finalGraph.schema.nodes.find(
        (node: GraphNodeSchemaType) => node.id === TEST_AGENT_NODE_ID,
      );
      expect(agentNode?.config.instructions).toBe('First edit');
    },
  );

  it(
    'creates and applies revision for non-running graph',
    { timeout: 60000 },
    async () => {
      const graphData = createMockGraphData();

      const createResponse = await graphsService.create(
        contextDataStorage,
        graphData,
      );
      const graphId = createResponse.id;
      createdGraphIds.push(graphId);

      expect(createResponse.status).toBe(GraphStatus.Created);
      const currentVersion = createResponse.version;

      const updatedSchema = cloneDeep(createResponse.schema);
      updatedSchema.nodes = updatedSchema.nodes.map((node) =>
        node.id === TEST_AGENT_NODE_ID
          ? {
              ...node,
              config: {
                ...node.config,
                instructions: 'Non-running graph instructions',
              },
            }
          : node,
      );

      const updateResponse = await graphsService.update(
        contextDataStorage,
        graphId,
        {
          schema: updatedSchema,
          currentVersion,
        },
      );

      // Should now create a revision even for non-running graphs
      expect(updateResponse.revision).toBeDefined();
      const revisionId = updateResponse.revision!.id;

      // Wait for revision to be applied
      await waitForRevisionStatus(
        graphId,
        revisionId,
        GraphRevisionStatus.Applied,
        30000,
      );

      const updatedGraph = await graphsService.findById(
        contextDataStorage,
        graphId,
      );
      expect(updatedGraph.version).not.toBe(currentVersion);
      expect(updatedGraph.version).toBe(updatedGraph.targetVersion);

      const agentNode = updatedGraph.schema.nodes.find(
        (node: GraphNodeSchemaType) => node.id === TEST_AGENT_NODE_ID,
      );
      expect(agentNode?.config.instructions).toBe(
        'Non-running graph instructions',
      );
    },
  );

  it(
    'applies name-only update synchronously without creating a revision',
    { timeout: 60000 },
    async () => {
      const graphData = createMockGraphData();

      const createResponse = await graphsService.create(
        contextDataStorage,
        graphData,
      );
      const graphId = createResponse.id;
      createdGraphIds.push(graphId);

      expect(createResponse.status).toBe(GraphStatus.Created);
      const currentVersion = createResponse.version;

      const newName = `Renamed graph ${Date.now()}`;

      const updateResponse = await graphsService.update(
        contextDataStorage,
        graphId,
        {
          name: newName,
          currentVersion,
        },
      );

      // Metadata-only updates (name, description) are applied synchronously
      // and do NOT create revisions. Only schema changes create revisions.
      expect(updateResponse.revision).toBeUndefined();
      expect(updateResponse.graph.name).toBe(newName);

      const updatedGraph = await graphsService.findById(
        contextDataStorage,
        graphId,
      );
      expect(updatedGraph.name).toBe(newName);
      // Version stays the same since no schema change occurred
      expect(updatedGraph.version).toBe(currentVersion);
    },
  );

  it(
    'handles non-running graphs gracefully when applying queued revisions',
    { timeout: 60000 },
    async () => {
      const graphData = createMockGraphData();
      const newInstructions = 'Updated instructions for stopped graph';

      const createResponse = await graphsService.create(
        contextDataStorage,
        graphData,
      );
      const graphId = createResponse.id;
      createdGraphIds.push(graphId);
      const currentVersion = createResponse.version;

      await graphsService.run(contextDataStorage, graphId);
      await waitForGraphToBeRunning(graphId);

      const updatedSchema = cloneDeep(createResponse.schema);
      updatedSchema.nodes = updatedSchema.nodes.map((node) =>
        node.id === TEST_AGENT_NODE_ID
          ? {
              ...node,
              config: {
                ...node.config,
                instructions: newInstructions,
              },
            }
          : node,
      );

      const updateResponse = await graphsService.update(
        contextDataStorage,
        graphId,
        {
          schema: updatedSchema,
          currentVersion,
        },
      );

      expect(updateResponse.revision).toBeDefined();
      const revisionId = updateResponse.revision!.id;

      await graphsService.destroy(contextDataStorage, graphId);

      await waitForRevisionStatus(
        graphId,
        revisionId,
        GraphRevisionStatus.Applied,
        30000,
      );

      const appliedRevision = await revisionsService.getRevisionById(
        contextDataStorage,
        graphId,
        revisionId,
      );
      expect(appliedRevision.status).toBe(GraphRevisionStatus.Applied);

      const updatedGraph = await graphsService.findById(
        contextDataStorage,
        graphId,
      );
      expect(updatedGraph.status).toBe(GraphStatus.Stopped);
      expect(updatedGraph.version).toBe(appliedRevision.toVersion);

      const agentNode = updatedGraph.schema.nodes.find(
        (node: GraphNodeSchemaType) => node.id === TEST_AGENT_NODE_ID,
      );
      expect(agentNode?.config.instructions).toBe(newInstructions);
    },
  );

  it(
    'queues revisions when graph is compiling',
    { timeout: 60000 },
    async () => {
      const graphData = createMockGraphData();
      const newInstructions = 'Updated instructions during compilation';

      const createResponse = await graphsService.create(
        contextDataStorage,
        graphData,
      );
      const graphId = createResponse.id;
      createdGraphIds.push(graphId);
      const currentVersion = createResponse.version;

      const originalCompile = graphCompiler.compile.bind(graphCompiler);
      graphCompiler.compile = async (...args) => {
        await wait(2000);
        return originalCompile(...args);
      };

      try {
        const runPromise = graphsService.run(contextDataStorage, graphId);

        await waitForCondition(
          () => graphsService.findById(contextDataStorage, graphId),
          (graph) => graph.status === GraphStatus.Compiling,
          { timeout: 10000, interval: 200 },
        );

        const updatedSchema = cloneDeep(createResponse.schema);
        updatedSchema.nodes = updatedSchema.nodes.map((node) =>
          node.id === TEST_AGENT_NODE_ID
            ? {
                ...node,
                config: {
                  ...node.config,
                  instructions: newInstructions,
                },
              }
            : node,
        );

        const updateResponse = await graphsService.update(
          contextDataStorage,
          graphId,
          {
            schema: updatedSchema,
            currentVersion,
          },
        );

        expect(updateResponse.revision).toBeDefined();
        const revision = updateResponse.revision!;
        expect(revision.status).toBe(GraphRevisionStatus.Pending);

        await runPromise;

        await waitForRevisionStatus(
          graphId,
          revision.id,
          GraphRevisionStatus.Applied,
        );

        const updatedGraph = await graphsService.findById(
          contextDataStorage,
          graphId,
        );
        const agentNode = updatedGraph.schema.nodes.find(
          (node: GraphNodeSchemaType) => node.id === TEST_AGENT_NODE_ID,
        );
        expect(agentNode?.config.instructions).toBe(newInstructions);
      } finally {
        graphCompiler.compile = originalCompile;
      }
    },
  );

  describe('Edge Deletion and Validation', () => {
    it(
      'handles failed revision when removing required edge then applies valid revision',
      { timeout: 180_000 },
      async () => {
        const graphData = createMockGraphData();

        const createResponse = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const graphId = createResponse.id;
        createdGraphIds.push(graphId);
        const currentVersion = createResponse.version;

        await graphsService.run(contextDataStorage, graphId);
        await waitForGraphToBeRunning(graphId);

        const invalidSchema = cloneDeep(createResponse.schema);
        invalidSchema.edges = [];

        const graphBeforeUpdate = await graphsService.findById(
          contextDataStorage,
          graphId,
        );
        expect(graphBeforeUpdate.status).toBe(GraphStatus.Running);

        const graphAfterFailed = await graphsService.findById(
          contextDataStorage,
          graphId,
        );
        expect(graphAfterFailed.version).toBe(currentVersion);
        expect(graphAfterFailed.schema.edges).toHaveLength(1);

        const graphBeforeValid = await graphsService.findById(
          contextDataStorage,
          graphId,
        );
        const currentVersionForSecond = graphBeforeValid.version;

        const validSchema = cloneDeep(graphBeforeValid.schema);
        validSchema.nodes = validSchema.nodes.map((node) =>
          node.id === TEST_AGENT_NODE_ID
            ? {
                ...node,
                config: {
                  ...node.config,
                  instructions: 'Updated after failed revision',
                },
              }
            : node,
        );

        // First update: invalid schema should be rejected before a revision is created.
        await expect(
          graphsService.update(contextDataStorage, graphId, {
            schema: invalidSchema,
            currentVersion,
          }),
        ).rejects.toMatchObject({
          statusCode: 400,
          errorCode: 'MISSING_REQUIRED_CONNECTION',
        });

        // Second update: valid schema should still apply as a live revision.
        const secondUpdateResponse = await graphsService.update(
          contextDataStorage,
          graphId,
          {
            schema: validSchema,
            currentVersion: currentVersionForSecond,
          },
        );

        expect(secondUpdateResponse.revision).toBeDefined();
        const secondRevisionId = secondUpdateResponse.revision!.id;

        const appliedRevision = await waitForRevisionStatus(
          graphId,
          secondRevisionId,
          GraphRevisionStatus.Applied,
          60_000,
        );
        expect(appliedRevision.status).toBe(GraphRevisionStatus.Applied);

        const finalGraph = await graphsService.findById(
          contextDataStorage,
          graphId,
        );
        expect(finalGraph.version).toBe(appliedRevision.toVersion);
        expect(finalGraph.schema.edges).toHaveLength(1);
        expect(finalGraph.schema.edges![0]).toEqual({
          from: 'trigger-1',
          to: 'agent-1',
        });

        const agentNode = finalGraph.schema.nodes.find(
          (node: GraphNodeSchemaType) => node.id === TEST_AGENT_NODE_ID,
        );
        expect(agentNode?.config.instructions).toBe(
          'Updated after failed revision',
        );
      },
    );
  });

  describe('Configuration Changes with Execution Verification', () => {
    it(
      'applies revision when changing agent model and verifies execution',
      { timeout: 120000 },
      async () => {
        const graphData = createMockGraphData();

        const createResponse = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const graphId = createResponse.id;
        createdGraphIds.push(graphId);
        const originalModel = (
          createResponse.schema.nodes.find(
            (node) => node.id === TEST_AGENT_NODE_ID,
          )?.config as SimpleAgentSchemaType
        ).invokeModelName;

        await graphsService.run(contextDataStorage, graphId);
        await waitForGraphToBeRunning(graphId);

        // This graph has no shell tool — the agent calls finish directly.
        // Register one reusable fixture that handles both executions (before and after the revision).
        const mockLlm = getMockLlm(app);
        mockLlm.onChat(
          { hasTools: ['finish'] },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: { purpose: 'done', message: 'Hello!', needsMoreInfo: false },
          },
        );

        const firstExecutionResult = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Say hello'],
            async: false,
          },
        );

        const firstThread = await waitForThreadCompletion(
          firstExecutionResult.externalThreadId,
        );
        expect(firstThread.status).toBe(ThreadStatus.Done);

        const updatedSchema = cloneDeep(createResponse.schema);
        updatedSchema.nodes = updatedSchema.nodes.map((node) =>
          node.id === TEST_AGENT_NODE_ID
            ? {
                ...node,
                config: {
                  ...(node.config as SimpleAgentSchemaType),
                  invokeModelName: 'gpt-5.2',
                } satisfies SimpleAgentSchemaType,
              }
            : node,
        );

        const updateResponse = await graphsService.update(
          contextDataStorage,
          graphId,
          {
            schema: updatedSchema,
            currentVersion: createResponse.version,
          },
        );

        expect(updateResponse.revision).toBeDefined();
        const revisionId = updateResponse.revision!.id;

        await waitForRevisionStatus(
          graphId,
          revisionId,
          GraphRevisionStatus.Applied,
        );

        const updatedGraph = await graphsService.findById(
          contextDataStorage,
          graphId,
        );
        const updatedAgentNode = updatedGraph.schema.nodes.find(
          (node: GraphNodeSchemaType) => node.id === TEST_AGENT_NODE_ID,
        );
        expect(
          (updatedAgentNode?.config as SimpleAgentSchemaType).invokeModelName,
        ).toBe('gpt-5.2');
        expect(
          (updatedAgentNode?.config as SimpleAgentSchemaType).invokeModelName,
        ).not.toBe(originalModel);

        const secondExecutionResult = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Say hello again'],
            async: false,
          },
        );

        const secondThread = await waitForThreadCompletion(
          secondExecutionResult.externalThreadId,
        );
        expect(secondThread.status).toBe(ThreadStatus.Done);
        expect(secondThread.id).not.toBe(firstThread.id);
      },
    );

    it(
      'applies runtime updates and graph continues to work',
      { timeout: 180000 },
      async () => {
        const graphData: CreateGraphDto = {
          name: `Runtime Update Test ${Date.now()}`,
          description: 'Test runtime updates during live revision',
          temporary: true,
          schema: {
            nodes: [
              {
                id: 'trigger-1',
                template: 'manual-trigger',
                config: {},
              },
              {
                id: 'agent-1',
                template: 'simple-agent',
                config: {
                  instructions: COMMAND_AGENT_INSTRUCTIONS,
                  name: 'Test Agent',
                  description: 'Test agent description',
                  summarizeMaxTokens: 272000,
                  summarizeKeepTokens: 30000,
                  invokeModelName: 'gpt-5-mini',
                  invokeModelReasoningEffort: ReasoningEffort.Low,
                  maxIterations: 50,
                } satisfies SimpleAgentSchemaType,
              },
              {
                id: 'shell-1',
                template: 'shell-tool',
                config: {},
              },
              {
                id: 'runtime-1',
                template: 'runtime',
                config: {
                  runtimeType: 'Docker',
                  image: environment.dockerRuntimeImage,
                  env: {
                    TEST_VAR: 'original_value',
                  },
                },
              },
            ],
            edges: [
              { from: 'trigger-1', to: 'agent-1' },
              { from: 'agent-1', to: 'shell-1' },
              { from: 'shell-1', to: 'runtime-1' },
            ],
          },
        };

        const createResponse = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const graphId = createResponse.id;
        createdGraphIds.push(graphId);
        const currentVersion = createResponse.version;

        await graphsService.run(contextDataStorage, graphId);
        await waitForGraphToBeRunning(graphId);

        const threadId = `${graphId}:runtime-update-${Date.now()}`;
        const shellToolBefore = getShellTool(graphId, 'shell-1');
        const { output: firstOutput } = await shellToolBefore.invoke(
          {
            purpose: 'verify runtime before update',
            command: 'echo "test1"',
          },
          buildThreadConfig(threadId),
        );
        expect(
          firstOutput.exitCode,
          `shell failed: ${firstOutput.stderr || firstOutput.stdout}`,
        ).toBe(0);
        expect(firstOutput.stdout).toContain('test1');

        const updatedSchema = cloneDeep(graphData.schema);
        updatedSchema.nodes = updatedSchema.nodes.map((node) =>
          node.id === 'runtime-1'
            ? {
                ...node,
                config: {
                  ...node.config,
                  env: {
                    TEST_VAR: 'updated_value',
                  },
                },
              }
            : node,
        );

        const updateResponse = await graphsService.update(
          contextDataStorage,
          graphId,
          {
            schema: updatedSchema,
            currentVersion,
          },
        );

        expect(updateResponse.revision).toBeDefined();
        const revisionId = updateResponse.revision!.id;

        await waitForRevisionStatus(
          graphId,
          revisionId,
          GraphRevisionStatus.Applied,
        );

        const updatedGraph = await graphsService.findById(
          contextDataStorage,
          graphId,
        );
        const runtimeNode = updatedGraph.schema.nodes.find(
          (node: GraphNodeSchemaType) => node.id === 'runtime-1',
        );
        expect(runtimeNode?.config.env).toEqual({
          TEST_VAR: 'updated_value',
        });

        const shellToolAfter = getShellTool(graphId, 'shell-1');
        const { output: secondOutput } = await shellToolAfter.invoke(
          {
            purpose: 'verify runtime after update',
            command: 'echo "test2"; echo $TEST_VAR',
          },
          buildThreadConfig(threadId),
        );
        expect(
          secondOutput.exitCode,
          `shell failed: ${secondOutput.stderr || secondOutput.stdout}`,
        ).toBe(0);
        expect(secondOutput.stdout).toContain('test2');
        expect(secondOutput.stdout).toContain('updated_value');
      },
    );

    it(
      'keeps shell tool usable after runtime update revision (runtime reload) in the same thread',
      { timeout: 180000 },
      async () => {
        const graphData: CreateGraphDto = {
          name: `Shell runtime reload test ${Date.now()}`,
          description:
            'Shell tool should still execute commands after runtime reload revision',
          temporary: true,
          schema: {
            nodes: [
              {
                id: 'trigger-1',
                template: 'manual-trigger',
                config: {},
              },
              {
                id: 'agent-1',
                template: 'simple-agent',
                config: {
                  instructions: COMMAND_AGENT_INSTRUCTIONS,
                  name: 'Test Agent',
                  description: 'Test agent description',
                  summarizeMaxTokens: 272000,
                  summarizeKeepTokens: 30000,
                  invokeModelName: 'gpt-5-mini',
                  invokeModelReasoningEffort: ReasoningEffort.Low,
                  maxIterations: 50,
                } satisfies SimpleAgentSchemaType,
              },
              {
                id: 'shell-1',
                template: 'shell-tool',
                config: {},
              },
              {
                id: 'runtime-1',
                template: 'runtime',
                config: {
                  runtimeType: 'Docker',
                  image: environment.dockerRuntimeImage,
                  env: {
                    TEST_VAR: 'original',
                  },
                },
              },
            ],
            edges: [
              { from: 'trigger-1', to: 'agent-1' },
              { from: 'agent-1', to: 'shell-1' },
              { from: 'shell-1', to: 'runtime-1' },
            ],
          },
        };

        const createResponse = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const graphId = createResponse.id;
        createdGraphIds.push(graphId);
        const currentVersion = createResponse.version;

        await graphsService.run(contextDataStorage, graphId);
        await waitForGraphToBeRunning(graphId);

        const threadId = `${graphId}:shell-reload-${Date.now()}`;
        const shellToolBefore = getShellTool(graphId, 'shell-1');
        const { output: beforeOutput } = await shellToolBefore.invoke(
          {
            purpose: 'verify shell tool before reload',
            command: 'echo "before-reload"',
          },
          buildThreadConfig(threadId),
        );
        expect(
          beforeOutput.exitCode,
          `shell failed: ${beforeOutput.stderr || beforeOutput.stdout}`,
        ).toBe(0);
        expect(beforeOutput.stdout).toContain('before-reload');
        const runtimeBefore = await getRuntimeForThread(
          graphId,
          'runtime-1',
          threadId,
        );
        const hostnameBefore = await getContainerHostname(runtimeBefore);

        const updatedSchema = cloneDeep(graphData.schema);
        updatedSchema.nodes = updatedSchema.nodes.map((node) =>
          node.id === 'runtime-1'
            ? {
                ...node,
                config: {
                  ...node.config,
                  // Force container recreate (image + env changes)
                  image: environment.dockerRuntimeImage,
                  env: { TEST_VAR: 'updated' },
                },
              }
            : node,
        );

        const updateResponse = await graphsService.update(
          contextDataStorage,
          graphId,
          {
            schema: updatedSchema,
            currentVersion,
          },
        );

        expect(updateResponse.revision).toBeDefined();
        const revisionId = updateResponse.revision!.id;

        await waitForRevisionStatus(
          graphId,
          revisionId,
          GraphRevisionStatus.Applied,
          120000,
        );
        await waitForGraphToBeRunning(graphId, 120000);

        const runtimeAfter = await getRuntimeForThread(
          graphId,
          'runtime-1',
          threadId,
        );
        const hostnameAfter = await getContainerHostname(runtimeAfter);
        expect(hostnameAfter).not.toBe(hostnameBefore);

        const shellToolAfter = getShellTool(graphId, 'shell-1');
        const { output: afterOutput } = await shellToolAfter.invoke(
          {
            purpose: 'verify shell tool after reload',
            command: 'echo "after-reload"',
          },
          buildThreadConfig(threadId),
        );
        expect(
          afterOutput.exitCode,
          `shell failed: ${afterOutput.stderr || afterOutput.stdout}`,
        ).toBe(0);
        expect(afterOutput.stdout).toContain('after-reload');
      },
    );

    it(
      'removes runtime node and graph continues to work without it',
      { timeout: 180000 },
      async () => {
        const graphData: CreateGraphDto = {
          name: `Remove Runtime Test ${Date.now()}`,
          description: 'Test removing runtime during live revision',
          temporary: true,
          schema: {
            nodes: [
              {
                id: 'trigger-1',
                template: 'manual-trigger',
                config: {},
              },
              {
                id: 'agent-1',
                template: 'simple-agent',
                config: {
                  instructions: COMMAND_AGENT_INSTRUCTIONS,
                  name: 'Test Agent',
                  description: 'Test agent description',
                  summarizeMaxTokens: 272000,
                  summarizeKeepTokens: 30000,
                  invokeModelName: 'gpt-5-mini',
                  invokeModelReasoningEffort: ReasoningEffort.Low,
                  maxIterations: 50,
                } satisfies SimpleAgentSchemaType,
              },
              {
                id: 'shell-1',
                template: 'shell-tool',
                config: {},
              },
              {
                id: 'runtime-1',
                template: 'runtime',
                config: {
                  runtimeType: 'Docker',
                  image: environment.dockerRuntimeImage,
                  env: {},
                },
              },
            ],
            edges: [
              { from: 'trigger-1', to: 'agent-1' },
              { from: 'agent-1', to: 'shell-1' },
              { from: 'shell-1', to: 'runtime-1' },
            ],
          },
        };

        const createResponse = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const graphId = createResponse.id;
        createdGraphIds.push(graphId);
        const currentVersion = createResponse.version;

        await graphsService.run(contextDataStorage, graphId);
        await waitForGraphToBeRunning(graphId);

        // Turn 1 (callIndex 0): agent uses tool_search to load the shell tool.
        // Turn 2: shell is available — agent calls shell with the given command.
        // Turn 3: after shell result, agent calls finish to end the thread.
        const mockLlm = getMockLlm(app);
        mockLlm.onChat(
          { callIndex: 0 },
          {
            kind: 'toolCall',
            toolName: 'tool_search',
            args: { query: 'shell' },
          },
        );
        mockLlm.onChat(
          { hasTools: ['shell'] },
          {
            kind: 'toolCall',
            toolName: 'shell',
            args: {
              purpose: 'run command',
              command: 'echo "test with runtime"',
            },
          },
        );
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

        const firstResult = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Run this command: echo "test with runtime"'],
            async: false,
          },
        );

        const firstThread = await waitForThreadCompletion(
          firstResult.externalThreadId,
        );
        expect(firstThread.status).toBe(ThreadStatus.Done);

        const firstMessages = await getThreadMessages(
          firstResult.externalThreadId,
        );
        const firstShell = findShellExecution(firstMessages);
        expect(firstShell.toolCallId).toBeDefined();
        expect(firstShell.toolName).toBe('shell');
        expect(firstShell.result).toBeDefined();
        expect(firstShell.result?.exitCode).toBe(0);
        expect(firstShell.result?.stdout).toContain('test with runtime');

        const updatedSchema = cloneDeep(graphData.schema);
        updatedSchema.nodes = updatedSchema.nodes
          .filter((n) => n.id !== 'runtime-1' && n.id !== 'shell-1')
          .map((node) =>
            node.id === 'agent-1'
              ? {
                  ...node,
                  config: {
                    ...(node.config as SimpleAgentSchemaType),
                    instructions:
                      'You are a helpful assistant. Answer questions directly without using any tools.',
                  } satisfies SimpleAgentSchemaType,
                }
              : node,
          );
        updatedSchema.edges = updatedSchema.edges!.filter(
          (e) => e.to !== 'runtime-1' && e.to !== 'shell-1',
        );

        const updateResponse = await graphsService.update(
          contextDataStorage,
          graphId,
          {
            schema: updatedSchema,
            currentVersion,
          },
        );

        expect(updateResponse.revision).toBeDefined();
        const revisionId = updateResponse.revision!.id;

        await waitForRevisionStatus(
          graphId,
          revisionId,
          GraphRevisionStatus.Applied,
        );

        const updatedGraph = await graphsService.findById(
          contextDataStorage,
          graphId,
        );
        const runtimeNode = updatedGraph.schema.nodes.find(
          (node: GraphNodeSchemaType) => node.id === 'runtime-1',
        );
        const shellNode = updatedGraph.schema.nodes.find(
          (node: GraphNodeSchemaType) => node.id === 'shell-1',
        );
        expect(runtimeNode).toBeUndefined();
        expect(shellNode).toBeUndefined();

        const agentAfter = graphRegistry.getNodeInstance<SimpleAgent>(
          graphId,
          'agent-1',
        );
        const toolsAfter = agentAfter?.getTools() ?? [];
        const shellToolAfter = toolsAfter.find((tool) => tool.name === 'shell');
        expect(shellToolAfter).toBeUndefined();
      },
    );

    it(
      'adds new tool to agent and graph works with it',
      { timeout: 180000 },
      async () => {
        const graphData: CreateGraphDto = {
          name: `Add Tool Test ${Date.now()}`,
          description: 'Test adding tool to agent during live revision',
          temporary: true,
          schema: {
            nodes: [
              {
                id: 'trigger-1',
                template: 'manual-trigger',
                config: {},
              },
              {
                id: 'agent-1',
                template: 'simple-agent',
                config: {
                  instructions: COMMAND_AGENT_INSTRUCTIONS,
                  name: 'Test Agent',
                  description: 'Test agent description',
                  summarizeMaxTokens: 272000,
                  summarizeKeepTokens: 30000,
                  invokeModelName: 'gpt-5-mini',
                  invokeModelReasoningEffort: ReasoningEffort.Low,
                  maxIterations: 50,
                } satisfies SimpleAgentSchemaType,
              },
            ],
            edges: [{ from: 'trigger-1', to: 'agent-1' }],
          },
        };

        const createResponse = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const graphId = createResponse.id;
        createdGraphIds.push(graphId);
        const currentVersion = createResponse.version;

        await graphsService.run(contextDataStorage, graphId);
        await waitForGraphToBeRunning(graphId);

        const updatedSchema = cloneDeep(graphData.schema);
        updatedSchema.nodes.push({
          id: 'shell-1',
          template: 'shell-tool',
          config: {},
        });
        updatedSchema.nodes.push({
          id: 'runtime-1',
          template: 'runtime',
          config: {
            runtimeType: 'Docker',
            image: environment.dockerRuntimeImage,
            env: {},
          },
        });
        updatedSchema.edges!.push({
          from: 'agent-1',
          to: 'shell-1',
        });
        updatedSchema.edges!.push({
          from: 'shell-1',
          to: 'runtime-1',
        });

        const updateResponse = await graphsService.update(
          contextDataStorage,
          graphId,
          {
            schema: updatedSchema,
            currentVersion,
          },
        );

        expect(updateResponse.revision).toBeDefined();
        const revisionId = updateResponse.revision!.id;

        await waitForRevisionStatus(
          graphId,
          revisionId,
          GraphRevisionStatus.Applied,
        );

        const updatedGraph = await graphsService.findById(
          contextDataStorage,
          graphId,
        );
        const shellNode = updatedGraph.schema.nodes.find(
          (node: GraphNodeSchemaType) => node.id === 'shell-1',
        );
        const runtimeNode = updatedGraph.schema.nodes.find(
          (node: GraphNodeSchemaType) => node.id === 'runtime-1',
        );
        expect(shellNode).toBeDefined();
        expect(runtimeNode).toBeDefined();

        await wait(5000);

        // Turn 1 (callIndex 0): agent uses tool_search to load the newly added shell tool.
        // Turn 2: shell is available — agent calls shell with the given command.
        // Turn 3: after shell result, agent calls finish to end the thread.
        const mockLlmNewTool = getMockLlm(app);
        mockLlmNewTool.onChat(
          { callIndex: 0 },
          {
            kind: 'toolCall',
            toolName: 'tool_search',
            args: { query: 'shell' },
          },
        );
        mockLlmNewTool.onChat(
          { hasTools: ['shell'] },
          {
            kind: 'toolCall',
            toolName: 'shell',
            args: {
              purpose: 'run command',
              command: 'echo "hello from new tool"',
            },
          },
        );
        mockLlmNewTool.onChat(
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

        const executeWithNewTool = async () => {
          const result = await graphsService.executeTrigger(
            contextDataStorage,
            graphId,
            'trigger-1',
            {
              messages: ['Run this command: echo "hello from new tool"'],
              async: false,
            },
          );

          const thread = await waitForThreadCompletion(result.externalThreadId);
          const messages = await getThreadMessages(result.externalThreadId);

          return {
            thread,
            shellExecution: findShellExecution(messages),
          };
        };

        const { thread, shellExecution } = await waitForCondition(
          executeWithNewTool,
          ({ shellExecution }) =>
            Boolean(shellExecution.toolCallId) &&
            shellExecution.toolName === 'shell' &&
            Boolean(shellExecution.result),
          { timeout: 90000, interval: 5000 },
        );

        expect([ThreadStatus.Done, ThreadStatus.NeedMoreInfo]).toContain(
          thread.status,
        );
        expect(shellExecution.toolCallId).toBeDefined();
        expect(shellExecution.toolName).toBe('shell');
        expect(shellExecution.result).toBeDefined();
        expect(shellExecution.result?.exitCode).toBe(0);
        expect(shellExecution.result?.stdout).toContain('hello from new tool');
      },
    );

    it(
      'changes resource configuration and graph continues to work',
      { timeout: 180000 },
      async () => {
        const graphData: CreateGraphDto = {
          name: `Resource Config Test ${Date.now()}`,
          description:
            'Test runtime (resource) configuration change during live revision',
          temporary: true,
          schema: {
            nodes: [
              {
                id: 'trigger-1',
                template: 'manual-trigger',
                config: {},
              },
              {
                id: 'agent-1',
                template: 'simple-agent',
                config: {
                  instructions: COMMAND_AGENT_INSTRUCTIONS,
                  name: 'Test Agent',
                  description: 'Test agent description',
                  summarizeMaxTokens: 272000,
                  summarizeKeepTokens: 30000,
                  invokeModelName: 'gpt-5-mini',
                  invokeModelReasoningEffort: ReasoningEffort.Low,
                  maxIterations: 50,
                } satisfies SimpleAgentSchemaType,
              },
              {
                id: 'shell-1',
                template: 'shell-tool',
                config: {},
              },
              {
                id: 'runtime-1',
                template: 'runtime',
                config: {
                  runtimeType: 'Docker',
                  image: environment.dockerRuntimeImage,
                  env: {
                    INITIAL_VAR: 'initial_value',
                  },
                },
              },
            ],
            edges: [
              { from: 'trigger-1', to: 'agent-1' },
              { from: 'agent-1', to: 'shell-1' },
              { from: 'shell-1', to: 'runtime-1' },
            ],
          },
        };

        const createResponse = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const graphId = createResponse.id;
        createdGraphIds.push(graphId);
        const currentVersion = createResponse.version;

        await graphsService.run(contextDataStorage, graphId);
        await waitForGraphToBeRunning(graphId);

        const updatedSchema = cloneDeep(graphData.schema);
        updatedSchema.nodes = updatedSchema.nodes.map((node) =>
          node.id === 'runtime-1'
            ? {
                ...node,
                config: {
                  ...node.config,
                  env: {
                    INITIAL_VAR: 'initial_value',
                    UPDATED_VAR: 'updated_value',
                  },
                },
              }
            : node,
        );

        const updateResponse = await graphsService.update(
          contextDataStorage,
          graphId,
          {
            schema: updatedSchema,
            currentVersion,
          },
        );

        expect(updateResponse.revision).toBeDefined();
        const revisionId = updateResponse.revision!.id;

        await waitForRevisionStatus(
          graphId,
          revisionId,
          GraphRevisionStatus.Applied,
        );

        const updatedGraph = await graphsService.findById(
          contextDataStorage,
          graphId,
        );
        const runtimeNode = updatedGraph.schema.nodes.find(
          (node: GraphNodeSchemaType) => node.id === 'runtime-1',
        );
        expect(runtimeNode?.config.env).toEqual({
          INITIAL_VAR: 'initial_value',
          UPDATED_VAR: 'updated_value',
        });

        // Turn 1 (callIndex 0): agent uses tool_search to load the shell tool.
        // Turn 2: shell is available — agent calls shell with the given command.
        // Turn 3: after shell result, agent calls finish to end the thread.
        const mockLlm = getMockLlm(app);
        mockLlm.onChat(
          { callIndex: 0 },
          {
            kind: 'toolCall',
            toolName: 'tool_search',
            args: { query: 'shell' },
          },
        );
        mockLlm.onChat(
          { hasTools: ['shell'] },
          {
            kind: 'toolCall',
            toolName: 'shell',
            args: {
              purpose: 'run command',
              command: 'echo "test after resource change"',
            },
          },
        );
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

        const result = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Run this command: echo "test after resource change"'],
            async: false,
          },
        );

        const thread = await waitForThreadCompletion(result.externalThreadId);
        expect(thread.status).toBe(ThreadStatus.Done);

        const messages = await getThreadMessages(result.externalThreadId);
        const shellExecution = findShellExecution(messages);
        expect(shellExecution.toolCallId).toBeDefined();
        expect(shellExecution.toolName).toBe('shell');
        expect(shellExecution.result).toBeDefined();
        expect(shellExecution.result?.exitCode).toBe(0);
        expect(shellExecution.result?.stdout).toContain(
          'test after resource change',
        );
      },
    );
  });

  describe('MCP + Graph Revisions', () => {
    it(
      'keeps filesystem MCP usable after runtime update revision (runtime reload)',
      { timeout: 180000 },
      async () => {
        const graphData: CreateGraphDto = {
          name: `MCP runtime update test ${Date.now()}`,
          description:
            'Filesystem MCP should keep working after runtime reload',
          temporary: true,
          schema: {
            nodes: [
              {
                id: 'runtime-1',
                template: 'runtime',
                config: {
                  runtimeType: 'Docker',
                  image: environment.dockerRuntimeImage,
                  env: {
                    TEST_VAR: 'original',
                  },
                },
              },
              {
                id: 'mcp-fs-1',
                template: 'filesystem-mcp',
                config: {
                  readOnly: false,
                },
              },
            ],
            edges: [{ from: 'mcp-fs-1', to: 'runtime-1' }],
          },
        };

        const createResponse = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const graphId = createResponse.id;
        createdGraphIds.push(graphId);
        const currentVersion = createResponse.version;

        await graphsService.run(contextDataStorage, graphId);
        await waitForGraphToBeRunning(graphId);

        const mcpThreadId = `${graphId}:mcp-${Date.now()}`;
        const runtimeBefore = await getRuntimeForThread(
          graphId,
          'runtime-1',
          mcpThreadId,
        );
        const hostnameBefore = await getContainerHostname(runtimeBefore);

        const mcpBefore = getMcpOutput(graphId, 'mcp-fs-1');
        const toolsBefore = await mcpBefore.discoverTools();
        const listDirToolBefore = toolsBefore.find(
          (t: { name: string }) => t.name === 'list_directory',
        );
        expect(listDirToolBefore).toBeDefined();
        const beforeResult = await listDirToolBefore!.invoke(
          {
            path: '/runtime-workspace',
          },
          buildThreadConfig(mcpThreadId),
        );
        expect(beforeResult).toBeDefined();
        expect(beforeResult.output).toBeDefined();

        const updatedSchema = cloneDeep(graphData.schema);
        updatedSchema.nodes = updatedSchema.nodes.map((node) =>
          node.id === 'runtime-1'
            ? {
                ...node,
                config: {
                  ...node.config,
                  // Force container recreate (image + env changes)
                  image: environment.dockerRuntimeImage,
                  env: { TEST_VAR: 'updated' },
                },
              }
            : node,
        );

        const updateResponse = await graphsService.update(
          contextDataStorage,
          graphId,
          {
            schema: updatedSchema,
            currentVersion,
          },
        );

        expect(updateResponse.revision).toBeDefined();
        const revisionId = updateResponse.revision!.id;

        await waitForRevisionStatus(
          graphId,
          revisionId,
          GraphRevisionStatus.Applied,
          120000,
        );

        await waitForGraphToBeRunning(graphId);

        const runtimeAfter = await getRuntimeForThread(
          graphId,
          'runtime-1',
          mcpThreadId,
        );
        const hostnameAfter = await getContainerHostname(runtimeAfter);
        expect(hostnameAfter).not.toBe(hostnameBefore);

        const mcpAfter = getMcpOutput(graphId, 'mcp-fs-1');
        const toolsAfter = await mcpAfter.discoverTools();
        const listDirToolAfter = toolsAfter.find(
          (t: { name: string }) => t.name === 'list_directory',
        );
        expect(listDirToolAfter).toBeDefined();
        const afterResult = await listDirToolAfter!.invoke(
          {
            path: '/runtime-workspace',
          },
          buildThreadConfig(mcpThreadId),
        );
        expect(afterResult).toBeDefined();
        expect(afterResult.output).toBeDefined();
      },
    );

    it(
      'keeps filesystem MCP usable after revision and updates readOnly tools',
      { timeout: 180000 },
      async () => {
        const graphData: CreateGraphDto = {
          name: `MCP config update test ${Date.now()}`,
          description:
            'Filesystem MCP should be usable after revisions and reflect readOnly',
          temporary: true,
          schema: {
            nodes: [
              {
                id: 'trigger-1',
                template: 'manual-trigger',
                config: {},
              },
              {
                id: 'agent-1',
                template: 'simple-agent',
                config: {
                  instructions:
                    'You are a filesystem assistant. List files and directories when asked.',
                  name: 'Filesystem Agent',
                  description: 'Agent with filesystem tools',
                  summarizeMaxTokens: 272000,
                  summarizeKeepTokens: 30000,
                  invokeModelName: 'gpt-5-mini',
                  invokeModelReasoningEffort: ReasoningEffort.Low,
                  maxIterations: 50,
                } satisfies SimpleAgentSchemaType,
              },
              {
                id: 'runtime-1',
                template: 'runtime',
                config: {
                  runtimeType: 'Docker',
                  image: environment.dockerRuntimeImage,
                  env: {},
                },
              },
              {
                id: 'mcp-fs-1',
                template: 'filesystem-mcp',
                config: {
                  readOnly: false,
                },
              },
            ],
            edges: [
              { from: 'trigger-1', to: 'agent-1' },
              { from: 'agent-1', to: 'mcp-fs-1' },
              { from: 'mcp-fs-1', to: 'runtime-1' },
            ],
          },
        };

        const createResponse = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const graphId = createResponse.id;
        createdGraphIds.push(graphId);
        const currentVersion = createResponse.version;

        await graphsService.run(contextDataStorage, graphId);
        await waitForGraphToBeRunning(graphId);

        const mcpThreadId = `${graphId}:mcp-${Date.now()}`;
        const mcpBefore = getMcpOutput(graphId, 'mcp-fs-1');
        const toolsBefore = await mcpBefore.discoverTools();
        const listDirToolBefore = toolsBefore.find(
          (t: { name: string }) => t.name === 'list_directory',
        );
        expect(listDirToolBefore).toBeDefined();
        const beforeResult = await listDirToolBefore!.invoke(
          {
            path: '/runtime-workspace',
          },
          buildThreadConfig(mcpThreadId),
        );
        expect(beforeResult).toBeDefined();
        expect(beforeResult.output).toBeDefined();

        // MCP tools live in the agent's deferred-tools registry (loaded on
        // demand via tool_search), not in the eager `activeTools` returned by
        // getTools(). The MCP itself is the source of truth for which tools
        // are exposed under the current readOnly config.
        expect(
          toolsBefore.find((t: { name: string }) => t.name === 'write_file'),
        ).toBeDefined();

        // Update runtime config to force a revision
        const graph = await graphsService.findById(contextDataStorage, graphId);
        const updatedSchema = cloneDeep(graph.schema);
        const runtimeNode = updatedSchema.nodes.find(
          (n) => n.id === 'runtime-1',
        );
        if (runtimeNode) {
          runtimeNode.config = {
            ...runtimeNode.config,
            env: { FORCED_UPDATE: 'true' },
          };
        }

        const updateResponse = await graphsService.update(
          contextDataStorage,
          graphId,
          {
            schema: updatedSchema,
            currentVersion,
          },
        );

        expect(updateResponse.revision).toBeDefined();
        const revisionId = updateResponse.revision!.id;

        await waitForRevisionStatus(
          graphId,
          revisionId,
          GraphRevisionStatus.Applied,
          120000,
        );

        await waitForGraphToBeRunning(graphId);

        const mcpAfter = getMcpOutput(graphId, 'mcp-fs-1');
        const toolsAfter = await mcpAfter.discoverTools();
        const listDirToolAfter = toolsAfter.find(
          (t: { name: string }) => t.name === 'list_directory',
        );
        expect(listDirToolAfter).toBeDefined();
        const afterResult = await listDirToolAfter!.invoke(
          {
            path: '/runtime-workspace',
          },
          buildThreadConfig(mcpThreadId),
        );
        expect(afterResult).toBeDefined();
        expect(afterResult.output).toBeDefined();

        // Change readOnly mode to true and verify toolset updates
        const graphAfterRuntime = await graphsService.findById(
          contextDataStorage,
          graphId,
        );
        const readOnlySchema = cloneDeep(graphAfterRuntime.schema);
        const mcpNode = readOnlySchema.nodes.find((n) => n.id === 'mcp-fs-1');
        if (mcpNode) {
          mcpNode.config = {
            ...mcpNode.config,
            readOnly: true,
          };
        }

        const readOnlyUpdate = await graphsService.update(
          contextDataStorage,
          graphId,
          {
            schema: readOnlySchema,
            currentVersion: graphAfterRuntime.version,
          },
        );

        expect(readOnlyUpdate.revision).toBeDefined();
        const readOnlyRevisionId = readOnlyUpdate.revision!.id;

        await waitForRevisionStatus(
          graphId,
          readOnlyRevisionId,
          GraphRevisionStatus.Applied,
          120000,
        );

        await waitForGraphToBeRunning(graphId);
        await wait(5000);

        const updatedGraph = await graphsService.findById(
          contextDataStorage,
          graphId,
        );
        const updatedMcpNode = updatedGraph.schema.nodes.find(
          (node: GraphNodeSchemaType) => node.id === 'mcp-fs-1',
        );
        expect(updatedMcpNode?.config.readOnly).toBe(true);

        // After the readOnly=true revision, fetch the rebuilt MCP node and
        // verify the toolset reflects the new config (write tools removed,
        // read tools retained). Agent.getTools() would only show core +
        // tool_search; deferred MCP tools are surfaced via the MCP itself.
        const mcpAfterReadOnly = getMcpOutput(graphId, 'mcp-fs-1');
        const toolsAfterReadOnly = await mcpAfterReadOnly.discoverTools();
        expect(
          toolsAfterReadOnly.find(
            (t: { name: string }) => t.name === 'write_file',
          ),
        ).toBeUndefined();
        expect(
          toolsAfterReadOnly.find(
            (t: { name: string }) => t.name === 'read_text_file',
          ),
        ).toBeDefined();
        expect(
          toolsAfterReadOnly.find(
            (t: { name: string }) => t.name === 'list_directory',
          ),
        ).toBeDefined();
      },
    );

    it(
      'applies revision immediately for non-running graph with MCP config change',
      { timeout: 120000 },
      async () => {
        const graphData: CreateGraphDto = {
          name: `MCP non-running graph test ${Date.now()}`,
          description:
            'MCP readOnly change should create revision even for non-running graph',
          temporary: true,
          schema: {
            nodes: [
              {
                id: 'trigger-1',
                template: 'manual-trigger',
                config: {},
              },
              {
                id: 'agent-1',
                template: 'simple-agent',
                config: {
                  instructions: 'You are a helpful assistant.',
                  name: 'Test Agent',
                  description: 'Test agent description',
                  summarizeMaxTokens: 272000,
                  summarizeKeepTokens: 30000,
                  invokeModelName: 'gpt-5-mini',
                  invokeModelReasoningEffort: ReasoningEffort.Low,
                  maxIterations: 50,
                } satisfies SimpleAgentSchemaType,
              },
              {
                id: 'runtime-1',
                template: 'runtime',
                config: {
                  runtimeType: 'Docker',
                  image: environment.dockerRuntimeImage,
                  env: {},
                },
              },
              {
                id: 'mcp-fs-1',
                template: 'filesystem-mcp',
                config: {
                  readOnly: false,
                },
              },
            ],
            edges: [
              { from: 'trigger-1', to: 'agent-1' },
              { from: 'agent-1', to: 'mcp-fs-1' },
              { from: 'mcp-fs-1', to: 'runtime-1' },
            ],
          },
        };

        const createResponse = await graphsService.create(
          contextDataStorage,
          graphData,
        );
        const graphId = createResponse.id;
        createdGraphIds.push(graphId);
        const currentVersion = createResponse.version;

        expect(createResponse.status).toBe(GraphStatus.Created);

        // Change readOnly mode without running the graph
        const updatedSchema = cloneDeep(graphData.schema);
        const mcpNode = updatedSchema.nodes.find((n) => n.id === 'mcp-fs-1');
        if (mcpNode) {
          mcpNode.config = {
            ...mcpNode.config,
            readOnly: true,
          };
        }

        const updateResponse = await graphsService.update(
          contextDataStorage,
          graphId,
          {
            schema: updatedSchema,
            currentVersion,
          },
        );

        // Should create a revision even for non-running graph
        expect(updateResponse.revision).toBeDefined();
        const revisionId = updateResponse.revision!.id;

        // Wait for revision to be applied
        await waitForRevisionStatus(
          graphId,
          revisionId,
          GraphRevisionStatus.Applied,
          60000,
        );

        // Verify the schema was updated
        const updatedGraph = await graphsService.findById(
          contextDataStorage,
          graphId,
        );
        expect(updatedGraph.version).not.toBe(currentVersion);
        expect(updatedGraph.version).toBe(updatedGraph.targetVersion);

        const updatedMcpNode = updatedGraph.schema.nodes.find(
          (node: GraphNodeSchemaType) => node.id === 'mcp-fs-1',
        );
        expect(updatedMcpNode?.config.readOnly).toBe(true);

        // Now run the graph and verify it works with the updated config
        await graphsService.run(contextDataStorage, graphId);
        await waitForGraphToBeRunning(graphId);

        const mcp = getMcpOutput(graphId, 'mcp-fs-1');
        const tools = await mcp.discoverTools();
        const writeTool = tools.find(
          (t: { name: string }) => t.name === 'write_file',
        );
        const readTool = tools.find(
          (t: { name: string }) => t.name === 'read_text_file',
        );

        expect(writeTool).toBeUndefined();
        expect(readTool).toBeDefined();
      },
    );
  });
});
