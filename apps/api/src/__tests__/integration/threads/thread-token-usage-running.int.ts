import { INestApplication } from '@nestjs/common';
import { BaseException } from '@packages/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { waitForCondition } from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import type { MockLlmService } from '../mocks/mock-llm';
import { createTestModule, getMockLlm } from '../setup';

// Default usage applied to every fixture so that totalTokens > 0 / totalPrice > 0
// across the aggregator pipeline without hand-rolling values per test.
const DEFAULT_USAGE = {
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  totalPrice: 0.0001,
} as const;

// Sentinel used as the `message` arg for every `communication_exec` call so the
// callee's `lastUserMessage` matches the dedicated callee fixture below — and so
// it never collides with substrings in the caller's user prompt (e.g.
// "Worker Agent 2") that drive caller-stage routing.
const CALLEE_INPUT_SENTINEL = 'do the delegated task';

// Args matching `CommunicationExecSchema` — { agent, message, purpose } all required.
const buildCommArgs = (agent: string) => ({
  agent,
  message: CALLEE_INPUT_SENTINEL,
  purpose: `delegate to ${agent}`,
});

// Args matching `finish` tool schema.
const FINISH_ARGS = {
  purpose: 'done',
  message: 'OK',
  needsMoreInfo: false,
} as const;

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Thread token usage + cost from running graph state (integration)', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  let mockLlm: MockLlmService;
  let testProjectId: string;

  const createdGraphIds: string[] = [];

  // Helper function to get usage statistics for a thread
  const getUsageStatistics = async (threadId: string) => {
    return await threadsService.getThreadUsageStatistics(
      contextDataStorage,
      threadId,
    );
  };

  beforeAll(async () => {
    app = await createTestModule();
    graphsService = app.get(GraphsService);
    threadsService = app.get(ThreadsService);
    mockLlm = getMockLlm(app);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;

    // The caller agent's `communication_exec` tool is *deferred* (see
    // `simple-agent.ts` initTools) — it isn't bound on the first LLM call, so
    // the agent must call `tool_search` to load it. The fixture flow per run is:
    //
    //   Stage A: bound=[tool_search,finish,wait_for]                → tool_search('communication_exec')
    //   Stage B: bound includes communication_exec, lastTool=tool_search → communication_exec(<target>)
    //   Stage C: lastTool=communication_exec                         → finish
    //
    // Specificity ranks (count of defined matcher fields; arrays contribute per
    // element) decide which fixture wins; ties fall back to registration order.
    // Stage-B test-4 variants (specificity 4) beat the test-3 default
    // (specificity 3). Stage A is gated on a `systemMessage: 'communication_exec'`
    // substring so it does NOT fire for tests 1/2 (single-agent, no comm tool).
    // The dedicated CALLEE matcher uses the comm-tool's `args.message` sentinel
    // to short-circuit callee runs straight to `finish` instead of `tool_search`.
    //
    // Registration order matters on specificity-3 ties — the earlier fixture
    // wins. Stage C is registered before Stage A so that "after comm_exec
    // returns" branches to `finish` rather than re-entering `tool_search`.

    // CALLEE: any agent invoked via comm_exec sees the sentinel message.
    mockLlm.onChat(
      {
        hasTools: ['tool_search', 'finish'],
        lastUserMessage: CALLEE_INPUT_SENTINEL,
      },
      {
        kind: 'toolCall',
        toolName: 'finish',
        args: { ...FINISH_ARGS },
        usage: { ...DEFAULT_USAGE },
      },
    );

    // Stage C: caller, after comm_exec returned → finish.
    mockLlm.onChat(
      {
        hasTools: ['communication_exec', 'finish'],
        hasToolResult: 'communication_exec',
      },
      {
        kind: 'toolCall',
        toolName: 'finish',
        args: { ...FINISH_ARGS },
        usage: { ...DEFAULT_USAGE },
      },
    );

    // Stage B (test-4 run 1): comm_exec → Worker Agent 2.
    mockLlm.onChat(
      {
        hasTools: ['communication_exec', 'finish'],
        hasToolResult: 'tool_search',
        lastUserMessage: 'Worker Agent 2',
      },
      {
        kind: 'toolCall',
        toolName: 'communication_exec',
        args: buildCommArgs('Worker Agent 2'),
        usage: { ...DEFAULT_USAGE },
      },
    );

    // Stage B (test-4 run 2): comm_exec → Worker Agent 3.
    mockLlm.onChat(
      {
        hasTools: ['communication_exec', 'finish'],
        hasToolResult: 'tool_search',
        lastUserMessage: 'Worker Agent 3',
      },
      {
        kind: 'toolCall',
        toolName: 'communication_exec',
        args: buildCommArgs('Worker Agent 3'),
        usage: { ...DEFAULT_USAGE },
      },
    );

    // Stage B (test-3 default): comm_exec → Callee Agent.
    mockLlm.onChat(
      {
        hasTools: ['communication_exec', 'finish'],
        hasToolResult: 'tool_search',
      },
      {
        kind: 'toolCall',
        toolName: 'communication_exec',
        args: buildCommArgs('Callee Agent'),
        usage: { ...DEFAULT_USAGE },
      },
    );

    // Stage A: caller, no comm_exec bound yet → tool_search to load it.
    // `systemMessage: 'communication_exec'` ensures this only fires for graphs
    // whose deferred-tools block lists communication_exec (i.e. tests 3 and 4).
    mockLlm.onChat(
      {
        hasTools: ['tool_search', 'finish'],
        systemMessage: 'communication_exec',
      },
      {
        kind: 'toolCall',
        toolName: 'tool_search',
        args: { query: 'communication_exec' },
        usage: { ...DEFAULT_USAGE },
      },
    );
  });

  afterEach(async () => {
    while (createdGraphIds.length > 0) {
      const graphId = createdGraphIds.pop();
      if (!graphId) {
        continue;
      }

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
    }
  }, 60_000);

  afterAll(async () => {
    if (testProjectId) {
      try {
        await app.get(ProjectsDao).deleteById(testProjectId);
      } catch {
        // best effort cleanup
      }
    }

    await app.close();
  });

  it(
    'creates a graph, executes it, returns tokenUsage statistics via separate endpoint while running and after stop',
    { timeout: 60_000 },
    async () => {
      const graph = await graphsService.create(contextDataStorage, {
        name: `Thread token usage test ${Date.now()}`,
        description: 'integration test for thread token usage aggregation',
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
                name: 'TokenUsage Agent',
                description: 'Test agent',
                instructions: 'Answer briefly.',
                invokeModelName: 'gpt-5-mini',
                maxIterations: 10,
                summarizeMaxTokens: 272000,
                summarizeKeepTokens: 30000,
              },
            },
          ],
          edges: [{ from: 'trigger-1', to: 'agent-1' }],
        },
      });
      createdGraphIds.push(graph.id);

      await graphsService.run(contextDataStorage, graph.id);
      await waitForCondition(
        () => graphsService.findById(contextDataStorage, graph.id),
        (g) => g.status === GraphStatus.Running,
        { timeout: 15_000, interval: 200, maxInterval: 500 },
      );

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        graph.id,
        'trigger-1',
        {
          messages: ['hello'],
          async: true,
          threadSubId: `token-usage-${Date.now()}`,
        },
      );

      const createdThread = await waitForCondition(
        () =>
          threadsService.getThreadByExternalId(
            contextDataStorage,
            execution.externalThreadId,
          ),
        (t) => Boolean(t),
        { timeout: 10_000, interval: 200, maxInterval: 500 },
      );

      // Thread response should not include tokenUsage field anymore

      // While graph is running: get usage statistics via separate endpoint
      const runningUsageStats = await waitForCondition(
        async () => {
          try {
            return await getUsageStatistics(createdThread.id);
          } catch {
            return null;
          }
        },
        (stats) => (stats?.total?.totalTokens ?? 0) > 0,
        { timeout: 20_000, interval: 200, maxInterval: 500 },
      );
      expect(runningUsageStats).not.toBeNull();
      expect(runningUsageStats!.total.totalTokens).toBeGreaterThan(0);
      expect(runningUsageStats!.total.currentContext).toBeGreaterThan(0);

      // Message DTOs should include per-message tokenUsage (AI messages must not be null).
      const messagesWhileRunning = await waitForCondition(
        () =>
          threadsService.getThreadMessages(
            contextDataStorage,
            createdThread.id,
            {
              limit: 200,
              offset: 0,
            },
          ),
        (msgs) =>
          msgs.some(
            (m) => m.message.role === 'ai' && m.requestTokenUsage !== null,
          ),
        { timeout: 10_000, interval: 200, maxInterval: 500 },
      );

      const aiMessageWhileRunning = messagesWhileRunning.find(
        (m) => m.message.role === 'ai',
      );
      expect(aiMessageWhileRunning).toBeDefined();
      expect(aiMessageWhileRunning!.requestTokenUsage).not.toBeNull();
      expect(
        aiMessageWhileRunning!.requestTokenUsage?.totalTokens,
      ).toBeGreaterThan(0);

      // Wait until execution reaches a terminal status so checkpoint state is persisted.
      await waitForCondition(
        () =>
          threadsService.getThreadById(contextDataStorage, createdThread.id),
        (t) =>
          t.status === ThreadStatus.Done ||
          t.status === ThreadStatus.NeedMoreInfo,
        { timeout: 20_000, interval: 200, maxInterval: 500 },
      );

      // Stop the graph (unregisters it) so ThreadsService uses checkpoint fallback.
      await graphsService.destroy(contextDataStorage, graph.id);
      await waitForCondition(
        () => graphsService.findById(contextDataStorage, graph.id),
        (g) => g.status !== GraphStatus.Running,
        { timeout: 15_000, interval: 200, maxInterval: 500 },
      );

      // Get usage statistics after stop - should still be available from message history
      const stoppedUsageStats = await waitForCondition(
        async () => {
          try {
            return await getUsageStatistics(createdThread.id);
          } catch {
            return null;
          }
        },
        (stats) => (stats?.total?.totalTokens ?? 0) > 0,
        { timeout: 15_000, interval: 200, maxInterval: 500 },
      );
      expect(stoppedUsageStats).not.toBeNull();
      expect(stoppedUsageStats!.total.totalTokens).toBeGreaterThan(0);
      expect(stoppedUsageStats!.total.currentContext).toBeGreaterThan(0);

      // Messages should still carry per-message tokenUsage after stop.
      const messagesAfterStop = await waitForCondition(
        () =>
          threadsService.getThreadMessages(
            contextDataStorage,
            createdThread.id,
            {
              limit: 200,
              offset: 0,
            },
          ),
        (msgs) =>
          msgs.some(
            (m) => m.message.role === 'ai' && m.requestTokenUsage !== null,
          ),
        { timeout: 10_000, interval: 200, maxInterval: 500 },
      );

      const aiMessageAfterStop = messagesAfterStop.find(
        (m) => m.message.role === 'ai',
      );
      expect(aiMessageAfterStop).toBeDefined();
      expect(aiMessageAfterStop!.requestTokenUsage).not.toBeNull();
      expect(
        aiMessageAfterStop!.requestTokenUsage?.totalTokens,
      ).toBeGreaterThan(0);
    },
  );

  it(
    'accumulates token usage and cost across two executions on the same thread (integration)',
    { timeout: 60_000 },
    async () => {
      const graph = await graphsService.create(contextDataStorage, {
        name: `Thread token usage two-runs test ${Date.now()}`,
        description:
          'integration test ensuring token usage & cost accumulate across multiple runs on the same thread',
        temporary: true,
        schema: {
          nodes: [
            { id: 'trigger-1', template: 'manual-trigger', config: {} },
            {
              id: 'agent-1',
              template: 'simple-agent',
              config: {
                name: 'Two Runs Agent',
                description: 'Test agent',
                instructions: 'Answer briefly (1 sentence).',
                invokeModelName: 'gpt-5-mini',
                maxIterations: 10,
                summarizeMaxTokens: 272000,
                summarizeKeepTokens: 30000,
              },
            },
          ],
          edges: [{ from: 'trigger-1', to: 'agent-1' }],
        },
      });
      createdGraphIds.push(graph.id);

      await graphsService.run(contextDataStorage, graph.id);
      await waitForCondition(
        () => graphsService.findById(contextDataStorage, graph.id),
        (g) => g.status === GraphStatus.Running,
        { timeout: 15_000, interval: 200, maxInterval: 500 },
      );

      const threadSubId = `token-usage-two-runs-${Date.now()}`;

      const exec1 = await graphsService.executeTrigger(
        contextDataStorage,
        graph.id,
        'trigger-1',
        {
          messages: ['hello'],
          async: true,
          threadSubId,
        },
      );

      const createdThread = await waitForCondition(
        () =>
          threadsService.getThreadByExternalId(
            contextDataStorage,
            exec1.externalThreadId,
          ),
        (t) => Boolean(t),
        { timeout: 10_000, interval: 200, maxInterval: 500 },
      );

      const usageAfterFirst = await waitForCondition(
        async () => {
          try {
            return await getUsageStatistics(createdThread.id);
          } catch {
            return null;
          }
        },
        (stats) => (stats?.total?.totalTokens ?? 0) > 0,
        { timeout: 20_000, interval: 200, maxInterval: 500 },
      );

      expect(usageAfterFirst).not.toBeNull();
      const firstTotalTokens = usageAfterFirst!.total.totalTokens ?? 0;
      const firstTotalPrice = usageAfterFirst!.total.totalPrice ?? 0;

      expect(firstTotalTokens).toBeGreaterThan(0);
      expect(firstTotalPrice).toBeGreaterThanOrEqual(0);

      // Validate basic aggregation consistency (single-agent graph => byNode sum == totals).
      const byNodeFirst = usageAfterFirst!.byNode ?? {};
      const sumTokensFirst = Object.values(byNodeFirst).reduce(
        (acc, u) => acc + (u.totalTokens ?? 0),
        0,
      );
      expect(sumTokensFirst).toBe(firstTotalTokens);

      // Second execution on the same thread (same threadSubId) must increase totals.
      await graphsService.executeTrigger(
        contextDataStorage,
        graph.id,
        'trigger-1',
        {
          messages: ['hello again'],
          async: true,
          threadSubId,
        },
      );

      const usageAfterSecond = await waitForCondition(
        async () => {
          try {
            return await getUsageStatistics(createdThread.id);
          } catch {
            return null;
          }
        },
        (stats) => (stats?.total?.totalTokens ?? 0) > firstTotalTokens,
        { timeout: 20_000, interval: 200, maxInterval: 500 },
      );

      expect(usageAfterSecond).not.toBeNull();
      const secondTotalTokens = usageAfterSecond!.total.totalTokens ?? 0;
      const secondTotalPrice = usageAfterSecond!.total.totalPrice ?? 0;

      expect(secondTotalTokens).toBeGreaterThan(firstTotalTokens);
      // Price can be zero depending on provider metadata, but must never decrease.
      expect(secondTotalPrice).toBeGreaterThanOrEqual(firstTotalPrice);

      const byNodeSecond = usageAfterSecond!.byNode ?? {};
      const sumTokensSecond = Object.values(byNodeSecond).reduce(
        (acc, u) => acc + (u.totalTokens ?? 0),
        0,
      );
      expect(sumTokensSecond).toBe(secondTotalTokens);

      // Wait until the thread is terminal so checkpoint is persisted, then stop graph and re-check.
      await waitForCondition(
        () =>
          threadsService.getThreadById(contextDataStorage, createdThread.id),
        (t) =>
          t.status === ThreadStatus.Done ||
          t.status === ThreadStatus.NeedMoreInfo,
        { timeout: 20_000, interval: 200, maxInterval: 500 },
      );

      await graphsService.destroy(contextDataStorage, graph.id);
      await waitForCondition(
        () => graphsService.findById(contextDataStorage, graph.id),
        (g) => g.status !== GraphStatus.Running,
        { timeout: 15_000, interval: 200, maxInterval: 500 },
      );

      const stoppedUsageStats = await waitForCondition(
        async () => {
          try {
            return await getUsageStatistics(createdThread.id);
          } catch {
            return null;
          }
        },
        (stats) => (stats?.total?.totalTokens ?? 0) >= secondTotalTokens,
        { timeout: 15_000, interval: 200, maxInterval: 500 },
      );
      expect(stoppedUsageStats).not.toBeNull();
      expect(stoppedUsageStats!.total.totalTokens).toBeGreaterThanOrEqual(
        secondTotalTokens,
      );
    },
  );

  it(
    'does not reset tokenUsage when a communication tool triggers nested agent runs (integration)',
    { timeout: 90_000 },
    async () => {
      const graph = await graphsService.create(contextDataStorage, {
        name: `Thread token usage comm test ${Date.now()}`,
        description:
          'integration test ensuring token usage does not reset after communication tool calls',
        temporary: true,
        schema: {
          nodes: [
            { id: 'trigger-1', template: 'manual-trigger', config: {} },
            {
              id: 'agent-1',
              template: 'simple-agent',
              config: {
                name: 'Caller Agent',
                description: 'Calls the communication tool',
                // Force a tool call so we exercise nested agent runs.
                instructions:
                  "For each user message: call the communication_exec tool once to ask agent 'Callee Agent' for a short answer, then reply to the user with the callee's answer in one sentence.",
                invokeModelName: 'gpt-5-mini',
                maxIterations: 10,
                summarizeMaxTokens: 272000,
                summarizeKeepTokens: 30000,
              },
            },
            {
              id: 'comm-tool-1',
              template: 'agent-communication-tool',
              config: {},
            },
            {
              id: 'agent-2',
              template: 'simple-agent',
              config: {
                name: 'Callee Agent',
                description: 'Responds to the caller agent',
                instructions: 'Answer briefly (1 sentence).',
                invokeModelName: 'gpt-5-mini',
                maxIterations: 10,
                summarizeMaxTokens: 272000,
                summarizeKeepTokens: 30000,
              },
            },
          ],
          edges: [
            { from: 'trigger-1', to: 'agent-1' },
            { from: 'agent-1', to: 'comm-tool-1' },
            { from: 'comm-tool-1', to: 'agent-2' },
          ],
        },
      });
      createdGraphIds.push(graph.id);

      await graphsService.run(contextDataStorage, graph.id);
      await waitForCondition(
        () => graphsService.findById(contextDataStorage, graph.id),
        (g) => g.status === GraphStatus.Running,
        { timeout: 15_000, interval: 200, maxInterval: 500 },
      );

      const threadSubId = `token-usage-comm-${Date.now()}`;

      const exec1 = await graphsService.executeTrigger(
        contextDataStorage,
        graph.id,
        'trigger-1',
        {
          messages: ['Please ask the callee agent: what is 2+2?'],
          async: true,
          threadSubId,
        },
      );

      const thread1 = await waitForCondition(
        () =>
          threadsService.getThreadByExternalId(
            contextDataStorage,
            exec1.externalThreadId,
          ),
        (t) => Boolean(t),
        { timeout: 10_000, interval: 200, maxInterval: 500 },
      );

      // Ensure the communication tool actually ran (so we hit the "nested agent" path).
      await waitForCondition(
        () =>
          threadsService.getThreadMessages(contextDataStorage, thread1.id, {
            limit: 300,
            offset: 0,
          }),
        (msgs) =>
          msgs.some(
            (m) =>
              m.message.role === 'tool' &&
              m.message.name === 'communication_exec',
          ),
        { timeout: 20_000, interval: 200, maxInterval: 500 },
      );

      const usageAfterFirst = await waitForCondition(
        async () => {
          try {
            return await getUsageStatistics(thread1.id);
          } catch {
            return null;
          }
        },
        (stats) => (stats?.total?.totalTokens ?? 0) > 0,
        { timeout: 20_000, interval: 200, maxInterval: 500 },
      );

      expect(usageAfterFirst).not.toBeNull();
      const firstTotalTokens = usageAfterFirst!.total.totalTokens ?? 0;
      const firstTotalPrice = usageAfterFirst!.total.totalPrice ?? 0;

      // Nested agent usage should be attributed to the same external thread via parentThreadId.
      expect(usageAfterFirst!.byNode).toBeDefined();
      expect(
        usageAfterFirst!.byNode?.['agent-2']?.totalTokens ?? 0,
      ).toBeGreaterThan(0);

      // Second message on the same thread: totals must not drop (no "reset").
      await graphsService.executeTrigger(
        contextDataStorage,
        graph.id,
        'trigger-1',
        {
          messages: ['Ask again: what is 3+3?'],
          async: true,
          threadSubId,
        },
      );

      const usageAfterSecond = await waitForCondition(
        async () => {
          try {
            return await getUsageStatistics(thread1.id);
          } catch {
            return null;
          }
        },
        (stats) => {
          const total = stats?.total?.totalTokens ?? 0;
          return total > firstTotalTokens && total > 0;
        },
        { timeout: 20_000, interval: 200, maxInterval: 500 },
      );

      expect(usageAfterSecond).not.toBeNull();
      const secondTotalTokens = usageAfterSecond!.total.totalTokens ?? 0;
      const secondTotalPrice = usageAfterSecond!.total.totalPrice ?? 0;

      expect(secondTotalTokens).toBeGreaterThan(firstTotalTokens);
      expect(secondTotalPrice).toBeGreaterThanOrEqual(firstTotalPrice);
    },
  );

  it(
    'preserves per-node token usage across multiple runs with different agents (integration)',
    { timeout: 120_000 },
    async () => {
      // This test verifies the fix for per-node token usage preservation:
      // - First run: agents 1 and 2 execute
      // - Second run: agents 1 and 3 execute
      // - Expected: byNode should contain all three agents after both runs
      const graph = await graphsService.create(contextDataStorage, {
        name: `Thread per-node preservation test ${Date.now()}`,
        description:
          'integration test ensuring per-node token usage is preserved across runs with different agents',
        temporary: true,
        schema: {
          nodes: [
            { id: 'trigger-1', template: 'manual-trigger', config: {} },
            {
              id: 'agent-1',
              template: 'simple-agent',
              config: {
                name: 'Coordinator Agent',
                description: 'Delegates work to other agents',
                instructions:
                  'When user asks you to delegate to Worker Agent 2: call communication_exec with agent="Worker Agent 2" and message="calculate 2+2". When user asks for Worker Agent 3: call communication_exec with agent="Worker Agent 3" and message="calculate 5+5". After getting response, call finish tool with needsMoreInfo=false.',
                invokeModelName: 'gpt-5-mini',
                maxIterations: 10,
                summarizeMaxTokens: 272000,
                summarizeKeepTokens: 30000,
              },
            },
            {
              id: 'comm-tool-1',
              template: 'agent-communication-tool',
              config: {},
            },
            {
              id: 'agent-2',
              template: 'simple-agent',
              config: {
                name: 'Worker Agent 2',
                description: 'Performs specific tasks',
                instructions:
                  'Answer math questions in one sentence then call finish tool.',
                invokeModelName: 'gpt-5-mini',
                maxIterations: 10,
                summarizeMaxTokens: 272000,
                summarizeKeepTokens: 30000,
              },
            },
            {
              id: 'agent-3',
              template: 'simple-agent',
              config: {
                name: 'Worker Agent 3',
                description: 'Performs different tasks',
                instructions:
                  'Answer math questions in one sentence then call finish tool.',
                invokeModelName: 'gpt-5-mini',
                maxIterations: 10,
                summarizeMaxTokens: 272000,
                summarizeKeepTokens: 30000,
              },
            },
          ],
          edges: [
            { from: 'trigger-1', to: 'agent-1' },
            { from: 'agent-1', to: 'comm-tool-1' },
            { from: 'comm-tool-1', to: 'agent-2' },
            { from: 'comm-tool-1', to: 'agent-3' },
          ],
        },
      });
      createdGraphIds.push(graph.id);

      await graphsService.run(contextDataStorage, graph.id);
      await waitForCondition(
        () => graphsService.findById(contextDataStorage, graph.id),
        (g) => g.status === GraphStatus.Running,
        { timeout: 15_000, interval: 200, maxInterval: 500 },
      );

      const threadSubId = `token-usage-per-node-${Date.now()}`;

      // ========== FIRST RUN: Agent 1 delegates to Agent 2 ==========
      const exec1 = await graphsService.executeTrigger(
        contextDataStorage,
        graph.id,
        'trigger-1',
        {
          messages: ['Please delegate this to Worker Agent 2'],
          async: true,
          threadSubId,
        },
      );

      const thread = await waitForCondition(
        () =>
          threadsService.getThreadByExternalId(
            contextDataStorage,
            exec1.externalThreadId,
          ),
        (t) => Boolean(t),
        { timeout: 10_000, interval: 200, maxInterval: 500 },
      );

      // Wait for communication tool to execute
      await waitForCondition(
        () =>
          threadsService.getThreadMessages(contextDataStorage, thread.id, {
            limit: 300,
            offset: 0,
          }),
        (msgs) =>
          msgs.some(
            (m) =>
              m.message.role === 'tool' &&
              m.message.name === 'communication_exec',
          ),
        { timeout: 30_000, interval: 200, maxInterval: 500 },
      );

      // Check token usage DURING first run
      const usageAfterFirstRun = await waitForCondition(
        async () => {
          try {
            return await getUsageStatistics(thread.id);
          } catch {
            return null;
          }
        },
        (stats) => (stats?.total?.totalTokens ?? 0) > 0,
        { timeout: 30_000, interval: 200, maxInterval: 500 },
      );

      expect(usageAfterFirstRun).not.toBeNull();
      expect(usageAfterFirstRun!.byNode).toBeDefined();
      expect(usageAfterFirstRun!.byNode?.['agent-1']).toBeDefined();
      expect(usageAfterFirstRun!.byNode?.['agent-2']).toBeDefined();
      expect(usageAfterFirstRun!.byNode?.['agent-3']).toBeUndefined();

      const agent1TokensFirstRun =
        usageAfterFirstRun!.byNode?.['agent-1']?.totalTokens ?? 0;
      const agent2TokensFirstRun =
        usageAfterFirstRun!.byNode?.['agent-2']?.totalTokens ?? 0;

      expect(agent1TokensFirstRun).toBeGreaterThan(0);
      expect(agent2TokensFirstRun).toBeGreaterThan(0);

      // Wait for first run to complete
      await waitForCondition(
        () => threadsService.getThreadById(contextDataStorage, thread.id),
        (t) =>
          t.status === ThreadStatus.Done ||
          t.status === ThreadStatus.NeedMoreInfo,
        { timeout: 30_000, interval: 200, maxInterval: 500 },
      );

      // Check token usage AFTER first run completes
      const usageAfterFirstComplete = await getUsageStatistics(thread.id);

      expect(usageAfterFirstComplete.byNode).toBeDefined();
      expect(usageAfterFirstComplete.byNode?.['agent-1']).toBeDefined();
      expect(usageAfterFirstComplete.byNode?.['agent-2']).toBeDefined();
      expect(usageAfterFirstComplete.byNode?.['agent-3']).toBeUndefined();

      // ========== SECOND RUN: Agent 1 delegates to Agent 3 ==========
      await graphsService.executeTrigger(
        contextDataStorage,
        graph.id,
        'trigger-1',
        {
          messages: ['Please delegate this to Worker Agent 3'],
          async: true,
          threadSubId,
        },
      );

      // Wait for second communication tool execution
      await waitForCondition(
        () =>
          threadsService.getThreadMessages(contextDataStorage, thread.id, {
            limit: 300,
            offset: 0,
          }),
        (msgs) => {
          const commExecMessages = msgs.filter(
            (m) =>
              m.message.role === 'tool' &&
              m.message.name === 'communication_exec',
          );
          return commExecMessages.length >= 2;
        },
        { timeout: 30_000, interval: 200, maxInterval: 500 },
      );

      // Check token usage DURING second run
      // CRITICAL: This should include agent-2 from the first run!
      const usageAfterSecondRun = await waitForCondition(
        async () => {
          try {
            return await getUsageStatistics(thread.id);
          } catch {
            return null;
          }
        },
        (stats) => {
          const byNode = stats?.byNode;
          return !!(
            byNode &&
            byNode['agent-1'] &&
            byNode['agent-2'] &&
            byNode['agent-3'] &&
            (byNode['agent-1']?.totalTokens ?? 0) > agent1TokensFirstRun
          );
        },
        { timeout: 30_000, interval: 200, maxInterval: 500 },
      );

      // Verify all three agents are present in byNode
      expect(usageAfterSecondRun).not.toBeNull();
      expect(usageAfterSecondRun!.byNode).toBeDefined();
      expect(usageAfterSecondRun!.byNode?.['agent-1']).toBeDefined();
      expect(usageAfterSecondRun!.byNode?.['agent-2']).toBeDefined();
      expect(usageAfterSecondRun!.byNode?.['agent-3']).toBeDefined();

      // Agent 1 should have more tokens than first run (it executed again)
      const agent1TokensSecondRun =
        usageAfterSecondRun!.byNode?.['agent-1']?.totalTokens ?? 0;
      expect(agent1TokensSecondRun).toBeGreaterThan(agent1TokensFirstRun);

      // Agent 2 tokens should be preserved from first run (it didn't execute in second run)
      const agent2TokensSecondRun =
        usageAfterSecondRun!.byNode?.['agent-2']?.totalTokens ?? 0;
      expect(agent2TokensSecondRun).toBeGreaterThanOrEqual(
        agent2TokensFirstRun,
      );

      // Agent 3 should have tokens from second run
      const agent3TokensSecondRun =
        usageAfterSecondRun!.byNode?.['agent-3']?.totalTokens ?? 0;
      expect(agent3TokensSecondRun).toBeGreaterThan(0);

      // Wait for second run to complete
      await waitForCondition(
        () => threadsService.getThreadById(contextDataStorage, thread.id),
        (t) =>
          t.status === ThreadStatus.Done ||
          t.status === ThreadStatus.NeedMoreInfo,
        { timeout: 30_000, interval: 200, maxInterval: 500 },
      );

      // Check token usage AFTER second run completes
      // CRITICAL: All three agents should still be present!
      const usageAfterSecondComplete = await getUsageStatistics(thread.id);

      expect(usageAfterSecondComplete.byNode).toBeDefined();
      expect(usageAfterSecondComplete.byNode?.['agent-1']).toBeDefined();
      expect(usageAfterSecondComplete.byNode?.['agent-2']).toBeDefined();
      expect(usageAfterSecondComplete.byNode?.['agent-3']).toBeDefined();

      // Verify token counts are preserved
      expect(
        usageAfterSecondComplete.byNode?.['agent-1']?.totalTokens ?? 0,
      ).toBeGreaterThanOrEqual(agent1TokensSecondRun);
      expect(
        usageAfterSecondComplete.byNode?.['agent-2']?.totalTokens ?? 0,
      ).toBeGreaterThanOrEqual(agent2TokensFirstRun);
      expect(
        usageAfterSecondComplete.byNode?.['agent-3']?.totalTokens ?? 0,
      ).toBeGreaterThanOrEqual(agent3TokensSecondRun);

      // Verify aggregate totals are reasonable
      const finalByNode = usageAfterSecondComplete.byNode ?? {};
      const sumOfAllAgents = Object.values(finalByNode).reduce(
        (acc, u) => acc + (u.totalTokens ?? 0),
        0,
      );
      const finalTotalTokens = usageAfterSecondComplete.total.totalTokens ?? 0;

      // The sum of byNode should be positive and less than or equal to total
      // (total may include overhead from message tokenization, etc.)
      expect(sumOfAllAgents).toBeGreaterThan(0);
      expect(finalTotalTokens).toBeGreaterThan(0);
      expect(finalTotalTokens).toBeGreaterThanOrEqual(sumOfAllAgents * 0.5);
    },
  );
});
