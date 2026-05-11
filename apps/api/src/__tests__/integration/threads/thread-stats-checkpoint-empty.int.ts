/**
 * Integration test: Thread usage statistics when checkpoint is empty/null (WU-C / Step 8)
 *
 * Verifies the Bug A and Bug B fixes introduced in plan-bugs-ab-thread-stats.md:
 *
 *   Bug A — currentContext reconciled from messages when checkpoint returns null:
 *   - `getThreadTokenUsage` returns null when PgCheckpointSaver.getTuples yields []
 *   - `getThreadUsageStatistics` falls back to Math.max across all message currentContext values
 *   - result.total.currentContext === Math.max across all AI messages (42_000)
 *   - result.byNode is populated entirely from message-scan (not checkpoint)
 *
 *   Bug B — reasoningTokens preserved through persistence path:
 *   - __requestUsage.reasoningTokens is stored in messages.request_token_usage column
 *   - Message-scan accumulates reasoningTokens into messageTotalUsage.reasoningTokens
 *   - result.total.reasoningTokens === sum of all 6 AI messages' reasoningTokens (240)
 *
 * The test does NOT execute a real graph. It drives synthetic messages via
 * AgentMessageNotificationHandler.handle() and mocks PgCheckpointSaver.getTuples
 * to simulate the empty-NS root checkpoint topology.
 */

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { INestApplication } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { CheckpointStateService } from '../../../v1/agents/services/checkpoint-state.service';
import { PgCheckpointSaver } from '../../../v1/agents/services/pg-checkpoint-saver';
import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { AgentMessageNotificationHandler } from '../../../v1/notification-handlers/services/event-handlers/agent-message-notification-handler';
import { NotificationEvent } from '../../../v1/notifications/notifications.types';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { MessagesDao } from '../../../v1/threads/dao/messages.dao';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { createTestModule, TEST_USER_ID } from '../setup';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PARENT_NODE_ID = 'parent-node-bugab';
const TOOL_CALL_A = 'call_a';
const TOOL_CALL_B = 'call_b';

/**
 * RequestTokenUsage for each parent AI message.
 * currentContext: 30_000 — represents parent context window at time of request.
 * reasoningTokens: 50 — contributes to Bug B sum.
 */
const PARENT_USAGE = {
  totalPrice: 0.05,
  totalTokens: 500,
  inputTokens: 350,
  cachedInputTokens: 0,
  outputTokens: 100,
  reasoningTokens: 50,
  currentContext: 30_000,
};

/**
 * RequestTokenUsage for each subagent-A AI message.
 * currentContext: 35_000 — higher than parent, lower than subagent-B.
 * reasoningTokens: 30 — contributes to Bug B sum.
 */
const SUBAGENT_A_USAGE = {
  totalPrice: 0.03,
  totalTokens: 300,
  inputTokens: 210,
  cachedInputTokens: 0,
  outputTokens: 60,
  reasoningTokens: 30,
  currentContext: 35_000,
};

/**
 * RequestTokenUsage for each subagent-B AI message.
 * currentContext: 42_000 — highest across all messages (expected Math.max result).
 * reasoningTokens: 40 — contributes to Bug B sum.
 */
const SUBAGENT_B_USAGE = {
  totalPrice: 0.04,
  totalTokens: 400,
  inputTokens: 280,
  cachedInputTokens: 0,
  outputTokens: 80,
  reasoningTokens: 40,
  currentContext: 42_000,
};

/**
 * Expected totals across all 6 AI messages:
 *   reasoningTokens: 2×50 + 2×30 + 2×40 = 240 (Bug B assertion)
 *   currentContext: Math.max(30_000, 35_000, 42_000) = 42_000 (Bug A assertion)
 */
const EXPECTED_REASONING_TOKENS = 240;
const EXPECTED_CURRENT_CONTEXT = 42_000;

/**
 * Build a minimal FastifyRequest mock with no headers.
 * AppContextStorage only reads headers — this is sufficient for ctx.checkSub().
 */
function buildMockRequest(): FastifyRequest {
  return {
    headers: {},
  } as unknown as FastifyRequest;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Thread usage statistics with empty checkpoint (Bug A + Bug B integration)', () => {
  let app: INestApplication;
  let handler: AgentMessageNotificationHandler;
  let messagesDao: MessagesDao;
  let threadsDao: ThreadsDao;
  let graphDao: GraphDao;
  let projectsDao: ProjectsDao;
  let checkpointStateService: CheckpointStateService;
  let threadsService: ThreadsService;

  let testProjectId: string;
  let testGraphId: string;

  // IDs established in the `it` block; cleared in afterEach
  let threadId: string;
  let externalThreadId: string;

  beforeAll(async () => {
    app = await createTestModule();

    handler = app.get(AgentMessageNotificationHandler);
    messagesDao = app.get(MessagesDao);
    threadsDao = app.get(ThreadsDao);
    graphDao = app.get(GraphDao);
    projectsDao = app.get(ProjectsDao);
    checkpointStateService = app.get(CheckpointStateService);
    threadsService = app.get(ThreadsService);

    const project = await projectsDao.create({
      name: 'thread-stats-checkpoint-empty-project',
      createdBy: TEST_USER_ID,
      settings: {},
    });
    testProjectId = project.id;

    const graph = await graphDao.create({
      name: 'thread-stats-checkpoint-empty-graph',
      description:
        'Integration test fixture for Bug A + Bug B thread stats fixes',
      version: '1.0.0',
      targetVersion: '1.0.0',
      schema: { nodes: [], edges: [] },
      status: GraphStatus.Running,
      metadata: {},
      createdBy: TEST_USER_ID,
      projectId: testProjectId,
      temporary: true,
    });
    testGraphId = graph.id;
  }, 60_000);

  afterEach(async () => {
    // Cleanup messages first (FK), then thread
    if (threadId) {
      await messagesDao.hardDelete({ threadId });
      await threadsDao.deleteById(threadId);
    }
    // Reset thread/externalThread IDs for next test
    threadId = '';
    externalThreadId = '';
    // Restore any spies created in the test
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await graphDao.deleteById(testGraphId);
    await projectsDao.deleteById(testProjectId);
    await app.close();
  });

  it(
    'Bug A: currentContext falls back to message-scan Math.max when checkpoint is null; Bug B: reasoningTokens summed correctly across all 6 AI messages',
    { timeout: 60_000 },
    async () => {
      // ----------------------------------------------------------------
      // Setup: create thread with deterministic externalThreadId
      // ----------------------------------------------------------------
      externalThreadId = `bugab-test-${Date.now()}`;

      const thread = await threadsDao.create({
        graphId: testGraphId,
        createdBy: TEST_USER_ID,
        projectId: testProjectId,
        externalThreadId,
        metadata: {},
        status: ThreadStatus.Running,
      });
      threadId = thread.id;

      // ----------------------------------------------------------------
      // Drive synthetic messages through handler.handle()
      // The handler resolves the thread by externalThreadId = parentThreadId.
      // ----------------------------------------------------------------
      const buildEvent = (messages: (AIMessage | ToolMessage)[]) => ({
        type: NotificationEvent.AgentMessage as const,
        graphId: testGraphId,
        nodeId: PARENT_NODE_ID,
        threadId: externalThreadId,
        parentThreadId: externalThreadId,
        data: { messages },
      });

      // --- 2× parent AI messages (no __subagentCommunication) ---
      // These are non-subagent AI messages: processed in the isAiMessage && requestUsage path.
      for (let i = 0; i < 2; i++) {
        const parentAi = new AIMessage({
          content: `Parent AI message ${i + 1}`,
          additional_kwargs: {
            __requestUsage: { ...PARENT_USAGE },
          },
        });
        await handler.handle(buildEvent([parentAi]));
      }

      // --- 2× subagent-A AI messages ---
      // __subagentCommunication drives surrogate nodeId stamping in handler.
      // Also tagged __hideForLlm so ThreadsService routes them through the
      // subagent-internal path (accumulateUsage + accumulateByNode).
      for (let i = 0; i < 2; i++) {
        const subagentAi = new AIMessage({
          content: `Subagent A message ${i + 1}`,
          additional_kwargs: {
            __subagentCommunication: true,
            __hideForLlm: true,
            __toolCallId: TOOL_CALL_A,
            __requestUsage: { ...SUBAGENT_A_USAGE },
          },
        });
        await handler.handle(buildEvent([subagentAi]));
      }

      // --- 2× subagent-B AI messages ---
      for (let i = 0; i < 2; i++) {
        const subagentAi = new AIMessage({
          content: `Subagent B message ${i + 1}`,
          additional_kwargs: {
            __subagentCommunication: true,
            __hideForLlm: true,
            __toolCallId: TOOL_CALL_B,
            __requestUsage: { ...SUBAGENT_B_USAGE },
          },
        });
        await handler.handle(buildEvent([subagentAi]));
      }

      // --- 1× subagents_run_task ToolMessage for call_a ---
      // __toolTokenUsage = sum of subagent-A's 2 AI messages (0.03 × 2 = 0.06):
      //   inputTokens: 210 × 2 = 420, outputTokens: 60 × 2 = 120,
      //   cachedInputTokens: 0, reasoningTokens: 30 × 2 = 60,
      //   totalTokens: 300 × 2 = 600, totalPrice: 0.03 × 2 = 0.06
      const toolMsgA = new ToolMessage({
        tool_call_id: TOOL_CALL_A,
        name: 'subagents_run_task',
        content: JSON.stringify({ result: 'done-a' }),
      });
      Object.assign(toolMsgA, {
        additional_kwargs: {
          __toolTokenUsage: {
            inputTokens: 420,
            outputTokens: 120,
            cachedInputTokens: 0,
            reasoningTokens: 60,
            totalTokens: 600,
            totalPrice: 0.06,
          },
        },
      });
      await handler.handle(buildEvent([toolMsgA]));

      // --- 1× subagents_run_task ToolMessage for call_b ---
      // __toolTokenUsage = sum of subagent-B's 2 AI messages (0.04 × 2 = 0.08):
      //   inputTokens: 280 × 2 = 560, outputTokens: 80 × 2 = 160,
      //   cachedInputTokens: 0, reasoningTokens: 40 × 2 = 80,
      //   totalTokens: 400 × 2 = 800, totalPrice: 0.04 × 2 = 0.08
      const toolMsgB = new ToolMessage({
        tool_call_id: TOOL_CALL_B,
        name: 'subagents_run_task',
        content: JSON.stringify({ result: 'done-b' }),
      });
      Object.assign(toolMsgB, {
        additional_kwargs: {
          __toolTokenUsage: {
            inputTokens: 560,
            outputTokens: 160,
            cachedInputTokens: 0,
            reasoningTokens: 80,
            totalTokens: 800,
            totalPrice: 0.08,
          },
        },
      });
      await handler.handle(buildEvent([toolMsgB]));

      // ----------------------------------------------------------------
      // Verify messages were persisted (8 total: 6 AI + 2 ToolMessage)
      // ----------------------------------------------------------------
      const allStored = await messagesDao.getAll(
        { threadId },
        { orderBy: { createdAt: 'ASC' } },
      );
      expect(allStored).toHaveLength(8);

      const aiRows = allStored.filter((m) => m.message.role === 'ai');
      expect(aiRows).toHaveLength(6);

      // ----------------------------------------------------------------
      // Bug A repro: mock PgCheckpointSaver.getTuples to return [] so
      // CheckpointStateService.getThreadTokenUsage returns null.
      // This simulates multi-agent topologies that never write the
      // empty-NS root checkpoint.
      // ----------------------------------------------------------------
      const checkpointSaver = checkpointStateService[
        'checkpointSaver'
      ] as PgCheckpointSaver;
      vi.spyOn(checkpointSaver, 'getTuples').mockResolvedValue([]);

      // Verify the mock is effective — getThreadTokenUsage must return null
      const checkpointResult = await checkpointStateService.getThreadTokenUsage(
        externalThreadId,
        '',
      );
      expect(
        checkpointResult,
        'getThreadTokenUsage must return null when getTuples yields [] (Bug A repro prereq)',
      ).toBeNull();

      // ----------------------------------------------------------------
      // Build context for getThreadUsageStatistics call
      // ----------------------------------------------------------------
      const mockCtx = new AppContextStorage(
        { sub: TEST_USER_ID },
        buildMockRequest(),
      );

      // ----------------------------------------------------------------
      // Call the service under test — the Bug A + Bug B fix paths
      // ----------------------------------------------------------------
      const result = await threadsService.getThreadUsageStatistics(
        mockCtx,
        threadId,
      );

      // ----------------------------------------------------------------
      // Bug A — currentContext reconciled from messages when checkpoint is null
      //
      // totalUsage.currentContext starts at 0 (checkpoint was null).
      // messageTotalUsage.currentContext = Math.max(30_000, 35_000, 42_000) = 42_000.
      // Final: Math.max(0, 42_000) = 42_000.
      // ----------------------------------------------------------------
      expect(
        result.total.currentContext,
        'Bug A: currentContext must be > 0 when checkpoint is null (messages-fallback)',
      ).toBeGreaterThan(0);

      expect(
        result.total.currentContext,
        'Bug A: currentContext must equal Math.max across all AI messages (42_000)',
      ).toBe(EXPECTED_CURRENT_CONTEXT);

      // ----------------------------------------------------------------
      // Bug A — byNode populated from message-scan when checkpoint is null
      //
      // With no checkpoint, byNodeUsage is seeded empty. The message-scan
      // loop (accumulateByNode) populates it from messages.node_id column.
      // At minimum: parent-node-bugab, surrogate-A, surrogate-B.
      // ----------------------------------------------------------------
      // byNode must have exactly 3 entries: parent + two surrogate nodes.
      // Surrogate node IDs are stamped by AgentMessageNotificationHandler as
      // `${parentNodeId}::sub::${toolCallId}` when __subagentCommunication is set.
      const SURROGATE_A = `${PARENT_NODE_ID}::sub::${TOOL_CALL_A}`;
      const SURROGATE_B = `${PARENT_NODE_ID}::sub::${TOOL_CALL_B}`;

      expect(
        Object.keys(result.byNode).length,
        'Bug A: byNode must have exactly 3 entries (parent + 2 surrogates) from message-scan',
      ).toBe(3);

      // Parent node: 2 messages × PARENT_USAGE.inputTokens (350) = 700
      expect(result.byNode).toHaveProperty(PARENT_NODE_ID);
      expect(result.byNode[PARENT_NODE_ID]?.inputTokens).toBe(
        PARENT_USAGE.inputTokens * 2,
      );

      // Surrogate A: 2 messages × SUBAGENT_A_USAGE.inputTokens (210) = 420
      expect(result.byNode).toHaveProperty(SURROGATE_A);
      expect(result.byNode[SURROGATE_A]?.inputTokens).toBe(
        SUBAGENT_A_USAGE.inputTokens * 2,
      );

      // Surrogate B: 2 messages × SUBAGENT_B_USAGE.inputTokens (280) = 560
      expect(result.byNode).toHaveProperty(SURROGATE_B);
      expect(result.byNode[SURROGATE_B]?.inputTokens).toBe(
        SUBAGENT_B_USAGE.inputTokens * 2,
      );

      // ----------------------------------------------------------------
      // Bug B — reasoningTokens summed correctly across all 6 AI messages
      //
      // All 6 AI messages carry __requestUsage.reasoningTokens persisted in
      // the request_token_usage column. Message-scan accumulates them:
      //   Parent (2 msgs): 2 × 50 = 100
      //   Subagent A (2 msgs): 2 × 30 = 60
      //   Subagent B (2 msgs): 2 × 40 = 80
      //   Total: 240
      //
      // If Bug B were present (reasoningTokens stripped by extractTokenUsageFromResponse),
      // all persisted values would be 0 and the total would be 0.
      // ----------------------------------------------------------------
      expect(
        result.total.reasoningTokens,
        'Bug B: reasoningTokens must be summed across all 6 AI messages (2×50 + 2×30 + 2×40 = 240)',
      ).toBe(EXPECTED_REASONING_TOKENS);
    },
  );
});
