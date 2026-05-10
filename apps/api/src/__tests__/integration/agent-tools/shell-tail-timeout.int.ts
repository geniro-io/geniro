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

describe('ShellTool tail timeout behavior (integration)', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  let graphId: string;
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
      // Tail-timeout assertions need real subprocess timing.
      { mockRuntime: false },
    );
    graphsService = app.get<GraphsService>(GraphsService);
    threadsService = app.get<ThreadsService>(ThreadsService);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;

    const graph = await graphsService.create(
      contextDataStorage,
      createTailTimeoutGraphData(),
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

  const cleanupGraph = async (gId: string) => {
    try {
      await graphsService.destroy(contextDataStorage, gId);
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
      await graphsService.delete(contextDataStorage, gId);
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
    gId: string,
    status: GraphStatus,
    timeoutMs = 240_000,
  ) => {
    return waitForCondition(
      () => graphsService.findById(contextDataStorage, gId),
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

  const createTailTimeoutGraphData = (): CreateGraphDto => ({
    name: `Shell Tail Timeout Test ${Date.now()}`,
    description: 'Integration test graph for shell tail timeout behavior',
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
  });

  const ensureGraphRunning = async (gId: string) => {
    const graph = await graphsService.findById(contextDataStorage, gId);
    if (graph.status === GraphStatus.Running) {
      return;
    }
    await graphsService.run(contextDataStorage, gId);
    await waitForGraphStatus(gId, GraphStatus.Running);
  };

  const uniqueThreadSubId = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  interface ExecuteTailTimeoutScenarioOptions {
    /** Shell args to merge into the shell tool call (e.g. timeoutMs, tailTimeoutMs). */
    shellArgs?: Record<string, unknown>;
    /** Timeout for waiting on shell result (ms). */
    shellResultTimeoutMs?: number;
  }

  /**
   * Registers mock LLM fixtures for a single shell tool call turn (turn 1 via
   * tool_search + turn 2 via shell) + finish (turn 3), then drives the agent
   * through the full thread lifecycle and returns { exitCode, stdout, stderr }.
   *
   * Must be called AFTER getMockLlm(app).reset() (which beforeEach does).
   */
  const executeTailTimeoutScenario = async (
    command: string,
    options: ExecuteTailTimeoutScenarioOptions = {},
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
    const execution = await graphsService.executeTrigger(
      contextDataStorage,
      graphId,
      TRIGGER_NODE_ID,
      {
        messages: [`Execute shell command: ${command}`],
        async: false,
        threadSubId: uniqueThreadSubId('tail-timeout'),
      },
    );

    expect(execution.externalThreadId).toBeDefined();

    const thread = await waitForThreadCompletion(
      execution.externalThreadId,
      options.shellResultTimeoutMs ?? 180_000,
    );
    expect(THREAD_COMPLETION_STATUSES).toContain(thread.status);
    expect(thread.status).toBe(ThreadStatus.Done);

    const shellMessage = await waitForCondition(
      async () => {
        const innerThread = await threadsService.getThreadByExternalId(
          contextDataStorage,
          execution.externalThreadId,
        );
        return threadsService.getThreadMessages(
          contextDataStorage,
          innerThread.id,
        );
      },
      (msgs) =>
        msgs.some(
          (m) => m.message.role === 'tool' && m.message.name === 'shell',
        ),
      { timeout: options.shellResultTimeoutMs ?? 180_000, interval: 1_000 },
    );

    const toolMsg = shellMessage
      .map((m) => m.message)
      .find((m) => m.role === 'tool' && m.name === 'shell');

    expect(toolMsg).toBeDefined();
    expect(toolMsg?.role).toBe('tool');

    const rawContent = toolMsg?.role === 'tool' ? toolMsg.content : undefined;
    const content = rawContent as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    };

    expect(typeof content?.exitCode).toBe('number');
    expect(typeof content?.stdout).toBe('string');
    expect(typeof content?.stderr).toBe('string');

    return {
      exitCode: content.exitCode as number,
      stdout: content.stdout as string,
      stderr: content.stderr as string,
    };
  };

  it(
    'does not timeout for Python heredoc commands with no immediate output',
    { timeout: 60_000 },
    async () => {
      const command = `python - <<'EOF'
import csv,sys,io
data = [["col1", "col2"], ["value1", "value2"]]
for row in data:
    print(",".join(row))
EOF`;

      const result = await executeTailTimeoutScenario(command, {
        shellArgs: { timeoutMs: 10_000, tailTimeoutMs: 3_000 },
        shellResultTimeoutMs: 60_000,
      });

      // Exit code 0 = success, 124 = timeout
      expect(result.exitCode).toBe(0);
      expect(result.exitCode).not.toBe(124);
      expect(result.stdout).toContain('col1,col2');
      expect(result.stdout).toContain('value1,value2');
    },
  );

  it(
    'handles complex heredoc with file processing (user original scenario)',
    { timeout: 120_000 },
    async () => {
      const command = `python - <<'PY'
import csv, sys, io
# Simulate CSV processing like the user's original issue
lines = """Area,Item,Element
US,Prices,Value
UK,CPI,Index""".splitlines()

reader = csv.reader(lines)
header = next(reader)
print(f"Header: {','.join(header)}")

for row in reader:
    print(f"Row: {','.join(row)}")
PY`;

      const result = await executeTailTimeoutScenario(command, {
        shellArgs: { timeoutMs: 15_000, tailTimeoutMs: 5_000 },
        shellResultTimeoutMs: 120_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.exitCode).not.toBe(124);
      expect(result.stdout).toContain('Header: Area,Item,Element');
      expect(result.stdout).toContain('Row: US,Prices,Value');
      expect(result.stdout).toContain('Row: UK,CPI,Index');
    },
  );

  it(
    'still times out if command hangs after producing output',
    { timeout: 120_000 },
    async () => {
      const command = 'echo "start" && sleep 10';

      const result = await executeTailTimeoutScenario(command, {
        shellArgs: { timeoutMs: 20_000, tailTimeoutMs: 3_000 },
        shellResultTimeoutMs: 120_000,
      });

      // Should timeout (exit 124)
      expect(result.exitCode).toBe(124);
      expect(result.stdout).toContain('start');
    },
  );
});
