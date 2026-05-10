/**
 * Integration test: cost-by-node consistency across writer + reader paths (WU-4 / Step 7)
 *
 * Verifies the cost-by-node invariant introduced in plan-bug4-subagent-node-id.md:
 *   1. AgentMessageNotificationHandler stamps surrogate nodeId
 *      "${parent}::sub::${toolCallId}" for subagent AI messages.
 *   2. MessagesDao.aggregateUsageBySubagentNodeId sums costs per surrogate key.
 *   3. CheckpointStateService.getThreadTokenUsage merges surrogate buckets into byNode,
 *      subtracting from the parent's checkpoint bucket.
 *   4. ThreadsService.getThreadUsageStatistics exposes the 3-key byNode map to callers.
 *   5. Per-subagent DAO aggregate matches the corresponding ToolMessage.__toolTokenUsage.
 *
 * The test does NOT execute a real graph. It drives synthetic messages via
 * AgentMessageNotificationHandler.handle() and mocks PgCheckpointSaver.getTuples.
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

const PARENT_NODE_ID = 'parent-node';
const TOOL_CALL_A = 'call_a';
const TOOL_CALL_B = 'call_b';

/** RequestTokenUsage for each parent AI message ($0.10 each, 2 messages = $0.20 own). */
const PARENT_USAGE = {
  totalPrice: 0.1,
  totalTokens: 1000,
  inputTokens: 700,
  cachedInputTokens: 0,
  outputTokens: 200,
  reasoningTokens: 100,
};

/** RequestTokenUsage for each subagent-A AI message ($0.04 each, 2 = $0.08 total). */
const SUBAGENT_A_USAGE = {
  totalPrice: 0.04,
  totalTokens: 400,
  inputTokens: 280,
  cachedInputTokens: 0,
  outputTokens: 80,
  reasoningTokens: 40,
};

/** RequestTokenUsage for each subagent-B AI message ($0.06 each, 2 = $0.12 total). */
const SUBAGENT_B_USAGE = {
  totalPrice: 0.06,
  totalTokens: 600,
  inputTokens: 420,
  cachedInputTokens: 0,
  outputTokens: 120,
  reasoningTokens: 60,
};

/**
 * Builds a minimal checkpoint tuple that CheckpointStateService reads.
 * Only channel_values is populated with state usage fields; all other fields
 * use safe no-op values (mirrors checkpoint-state.service.spec.ts:makeTuple).
 */
function makeCheckpointTuple(
  nodeId: string,
  state: {
    totalPrice: number;
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  },
) {
  return {
    nodeId,
    checkpoint: {
      id: 'cp-fixture-1',
      ts: '2024-01-01T00:00:00Z',
      channel_values: {
        messages: [],
        summary: '',
        toolsMetadata: {},
        toolUsageGuardActivated: false,
        toolUsageGuardActivatedCount: 0,
        inputTokens: state.inputTokens,
        cachedInputTokens: state.cachedInputTokens,
        outputTokens: state.outputTokens,
        reasoningTokens: state.reasoningTokens,
        totalTokens: state.totalTokens,
        totalPrice: state.totalPrice,
        currentContext: 0,
      },
      channel_versions: {},
      versions_seen: {},
      v: 1,
    },
    metadata: { source: 'loop' as const, step: 1, parents: {} },
    config: {
      configurable: { thread_id: 'fixture-thread', checkpoint_ns: '' },
    },
    pendingWrites: undefined,
    parentConfig: undefined,
  };
}

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

describe('Cost-by-node consistency (integration)', () => {
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

  // IDs established in the one `it` block (set in beforeEach, cleared in afterEach)
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
      name: 'cost-by-node-consistency-project',
      createdBy: TEST_USER_ID,
      settings: {},
    });
    testProjectId = project.id;

    const graph = await graphDao.create({
      name: 'cost-by-node-consistency-graph',
      description: 'Integration test fixture for cost-by-node invariant',
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
    // Restore any spies created in the test
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await graphDao.deleteById(testGraphId);
    await projectsDao.deleteById(testProjectId);
    await app.close();
  });

  it(
    'persists surrogate nodeIds, DAO aggregates match, reader projects byNode, service total unchanged, cross-source values reconcile',
    { timeout: 60_000 },
    async () => {
      // ----------------------------------------------------------------
      // Setup: create thread with deterministic externalThreadId
      // ----------------------------------------------------------------
      externalThreadId = `cost-node-test-${Date.now()}`;

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
      // ----------------------------------------------------------------

      // Helper: build a notification event with the thread's external ID as parentThreadId.
      // The handler resolves the internal thread by externalThreadId = parentThreadId.
      const buildEvent = (messages: (AIMessage | ToolMessage)[]) => ({
        type: NotificationEvent.AgentMessage as const,
        graphId: testGraphId,
        nodeId: PARENT_NODE_ID,
        threadId: externalThreadId,
        parentThreadId: externalThreadId,
        data: { messages },
      });

      // --- 2× parent AI messages (no __subagentCommunication) ---
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
      for (let i = 0; i < 2; i++) {
        const subagentAi = new AIMessage({
          content: `Subagent A message ${i + 1}`,
          additional_kwargs: {
            __subagentCommunication: true,
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
            __toolCallId: TOOL_CALL_B,
            __requestUsage: { ...SUBAGENT_B_USAGE },
          },
        });
        await handler.handle(buildEvent([subagentAi]));
      }

      // --- 1× subagents_run_task ToolMessage for call_a ---
      // __toolTokenUsage = sum of subagent-A's 2 AI messages (0.04 × 2 = 0.08):
      //   inputTokens: 280 × 2 = 560, outputTokens: 80 × 2 = 160,
      //   cachedInputTokens: 0 × 2 = 0, reasoningTokens: 40 × 2 = 80,
      //   totalTokens: 400 × 2 = 800, totalPrice: 0.04 × 2 = 0.08
      const toolMsgA = new ToolMessage({
        tool_call_id: TOOL_CALL_A,
        name: 'subagents_run_task',
        content: JSON.stringify({ result: 'done-a' }),
      });
      Object.assign(toolMsgA, {
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
      await handler.handle(buildEvent([toolMsgA]));

      // --- 1× subagents_run_task ToolMessage for call_b ---
      // __toolTokenUsage = sum of subagent-B's 2 AI messages (0.06 × 2 = 0.12):
      //   inputTokens: 420 × 2 = 840, outputTokens: 120 × 2 = 240,
      //   cachedInputTokens: 0 × 2 = 0, reasoningTokens: 60 × 2 = 120,
      //   totalTokens: 600 × 2 = 1200, totalPrice: 0.06 × 2 = 0.12
      const toolMsgB = new ToolMessage({
        tool_call_id: TOOL_CALL_B,
        name: 'subagents_run_task',
        content: JSON.stringify({ result: 'done-b' }),
      });
      Object.assign(toolMsgB, {
        additional_kwargs: {
          __toolTokenUsage: {
            inputTokens: 840,
            outputTokens: 240,
            cachedInputTokens: 0,
            reasoningTokens: 120,
            totalTokens: 1200,
            totalPrice: 0.12,
          },
        },
      });
      await handler.handle(buildEvent([toolMsgB]));

      // ----------------------------------------------------------------
      // Assertion 1: writer attribution — node_id values in DB
      // ----------------------------------------------------------------
      const allStored = await messagesDao.getAll(
        { threadId },
        { orderBy: { createdAt: 'ASC' } },
      );

      // Total rows: 6 AI + 2 ToolMessage
      expect(allStored).toHaveLength(8);

      const aiRows = allStored.filter((m) => m.message.role === 'ai');
      expect(aiRows).toHaveLength(6);

      const byNodeId = new Map<string, number>();
      for (const row of aiRows) {
        byNodeId.set(row.nodeId, (byNodeId.get(row.nodeId) ?? 0) + 1);
      }

      // Each nodeId should have exactly 2 AI rows
      expect(byNodeId.get(PARENT_NODE_ID)).toBe(2);
      expect(byNodeId.get(`${PARENT_NODE_ID}::sub::${TOOL_CALL_A}`)).toBe(2);
      expect(byNodeId.get(`${PARENT_NODE_ID}::sub::${TOOL_CALL_B}`)).toBe(2);

      // ToolMessage rows go to parent-node since they are not subagent-emitted
      const toolRows = allStored.filter((m) => m.message.role === 'tool');
      expect(toolRows).toHaveLength(2);

      // ----------------------------------------------------------------
      // Assertion 2: DAO aggregation via aggregateUsageBySubagentNodeId
      // ----------------------------------------------------------------
      const daoAggregateMap =
        await messagesDao.aggregateUsageBySubagentNodeId(threadId);

      // Only surrogate keys (::sub::) are returned — parent-node is excluded
      expect(daoAggregateMap.size).toBe(2);

      const daoA = daoAggregateMap.get(
        `${PARENT_NODE_ID}::sub::${TOOL_CALL_A}`,
      );
      const daoB = daoAggregateMap.get(
        `${PARENT_NODE_ID}::sub::${TOOL_CALL_B}`,
      );

      expect(daoA).toBeDefined();
      expect(daoB).toBeDefined();

      // Subagent-A: 2 messages × $0.04 = $0.08 total, 2 × 400 = 800 tokens
      expect(daoA!.totalPrice).toBeCloseTo(0.08, 3);
      expect(daoA!.totalTokens).toBeCloseTo(800, 0);

      // Subagent-B: 2 messages × $0.06 = $0.12 total, 2 × 600 = 1200 tokens
      expect(daoB!.totalPrice).toBeCloseTo(0.12, 3);
      expect(daoB!.totalTokens).toBeCloseTo(1200, 0);

      // Parent-node must NOT appear in the DAO aggregate (filtered by LIKE '%::sub::%')
      expect(daoAggregateMap.has(PARENT_NODE_ID)).toBe(false);

      // ----------------------------------------------------------------
      // Mock checkpoint reader for Assertion 3 and 4
      //
      // The checkpoint carries parent-node's pre-projection rolled-up sum:
      //   parent own $0.20 + child A $0.08 + child B $0.12 = $0.40 total.
      // CheckpointStateService will subtract the DAO aggregates to yield
      // parent-node own = $0.40 − $0.08 − $0.12 = $0.20.
      // ----------------------------------------------------------------
      const CHECKPOINT_TOTAL_PRICE = 0.4;
      const CHECKPOINT_TOTAL_TOKENS = 4000;
      const CHECKPOINT_INPUT_TOKENS = 2800;
      const CHECKPOINT_OUTPUT_TOKENS = 800;
      const CHECKPOINT_REASONING_TOKENS = 400;

      const checkpointSaver = checkpointStateService[
        'checkpointSaver'
      ] as PgCheckpointSaver;
      vi.spyOn(checkpointSaver, 'getTuples').mockResolvedValueOnce([
        makeCheckpointTuple(PARENT_NODE_ID, {
          totalPrice: CHECKPOINT_TOTAL_PRICE,
          totalTokens: CHECKPOINT_TOTAL_TOKENS,
          inputTokens: CHECKPOINT_INPUT_TOKENS,
          cachedInputTokens: 0,
          outputTokens: CHECKPOINT_OUTPUT_TOKENS,
          reasoningTokens: CHECKPOINT_REASONING_TOKENS,
        }),
      ]);

      // ----------------------------------------------------------------
      // Assertion 3: reader projection — CheckpointStateService.getThreadTokenUsage
      // ----------------------------------------------------------------
      const tokenUsage =
        await checkpointStateService.getThreadTokenUsage(externalThreadId);

      expect(tokenUsage).not.toBeNull();

      const byNode = tokenUsage!.byNode;
      expect(byNode).toBeDefined();

      // All 3 keys must be present
      const byNodeKeys = Object.keys(byNode!);
      expect(byNodeKeys).toContain(PARENT_NODE_ID);
      expect(byNodeKeys).toContain(`${PARENT_NODE_ID}::sub::${TOOL_CALL_A}`);
      expect(byNodeKeys).toContain(`${PARENT_NODE_ID}::sub::${TOOL_CALL_B}`);
      expect(byNodeKeys).toHaveLength(3);

      // Parent bucket = checkpoint total − surrogate A − surrogate B
      // $0.40 − $0.08 − $0.12 = $0.20
      expect(byNode![PARENT_NODE_ID]!.totalPrice).toBeCloseTo(0.2, 3);

      // Surrogate buckets must match DAO output exactly
      expect(
        byNode![`${PARENT_NODE_ID}::sub::${TOOL_CALL_A}`]!.totalPrice,
      ).toBeCloseTo(daoA!.totalPrice!, 3);
      expect(
        byNode![`${PARENT_NODE_ID}::sub::${TOOL_CALL_A}`]!.totalTokens,
      ).toBeCloseTo(daoA!.totalTokens, 0);

      expect(
        byNode![`${PARENT_NODE_ID}::sub::${TOOL_CALL_B}`]!.totalPrice,
      ).toBeCloseTo(daoB!.totalPrice!, 3);
      expect(
        byNode![`${PARENT_NODE_ID}::sub::${TOOL_CALL_B}`]!.totalTokens,
      ).toBeCloseTo(daoB!.totalTokens, 0);

      // ----------------------------------------------------------------
      // Assertion 4: ThreadsService.getThreadUsageStatistics
      //
      // Message-scan is authoritative for thread totals.
      // Total = 2 parent AI ($0.20) + 2 subagent-A AI ($0.08) + 2 subagent-B AI ($0.12)
      //       = $0.40
      // byNode must expose all 3 surrogate-aware keys.
      // ----------------------------------------------------------------
      const mockCtx = new AppContextStorage(
        { sub: TEST_USER_ID },
        buildMockRequest(),
      );

      // ThreadsService queries byNode from the checkpoint path (already mocked once
      // above). The second call within getThreadUsageStatistics goes through message-
      // scan which overwrites checkpoint byNode for any nodeId seen in messages.
      // We do not need to mock getTuples again — if the service reads it, it returns
      // null (no checkpoint stub), causing byNode to be built entirely from messages.
      const stats = await threadsService.getThreadUsageStatistics(
        mockCtx,
        threadId,
      );

      // Thread total from message-scan: 2×0.10 + 2×0.04 + 2×0.06 = 0.40
      expect(stats.total.totalPrice).toBeCloseTo(0.4, 3);

      // byNode must contain all 3 surrogate-aware keys
      const statsNodeKeys = Object.keys(stats.byNode);
      expect(statsNodeKeys).toContain(PARENT_NODE_ID);
      expect(statsNodeKeys).toContain(`${PARENT_NODE_ID}::sub::${TOOL_CALL_A}`);
      expect(statsNodeKeys).toContain(`${PARENT_NODE_ID}::sub::${TOOL_CALL_B}`);

      // ----------------------------------------------------------------
      // Assertion 5: cross-source reconciliation
      //
      // For each subagents_run_task ToolMessage, assert that
      //   Σ requestTokenUsage WHERE node_id = '${parent}::sub::${tcid}'
      // equals the ToolMessage's __toolTokenUsage.totalPrice / totalTokens.
      //
      // This pins the invariant: writer stamps correct keys AND the values
      // match tool_token_usage stored on the ToolMessage row.
      // ----------------------------------------------------------------
      const toolMessageRows = allStored.filter(
        (m) => m.message.role === 'tool',
      );
      expect(toolMessageRows).toHaveLength(2);

      // Drive by known toolCallIds — no price-based identity discrimination.
      // ToolMessageDto carries toolCallId directly on the message DTO.
      for (const expectedCallId of [TOOL_CALL_A, TOOL_CALL_B]) {
        const expectedTotalPrice = expectedCallId === TOOL_CALL_A ? 0.08 : 0.12;
        const expectedTotalTokens = expectedCallId === TOOL_CALL_A ? 800 : 1200;
        const surrogateKey = `${PARENT_NODE_ID}::sub::${expectedCallId}`;

        // Find the ToolMessage row by its stored toolCallId (NOT by price).
        // The transformer persists message as ToolMessageDto which has toolCallId.
        const toolRow = toolMessageRows.find(
          (row) =>
            row.message.role === 'tool' &&
            row.message.toolCallId === expectedCallId,
        );
        expect(
          toolRow,
          `ToolMessage for ${expectedCallId} should exist`,
        ).toBeDefined();

        const storedToolUsage = toolRow!.toolTokenUsage;
        expect(storedToolUsage).toBeDefined();
        expect(storedToolUsage!.totalPrice).toBeCloseTo(expectedTotalPrice, 3);
        expect(storedToolUsage!.totalTokens).toBeCloseTo(
          expectedTotalTokens,
          0,
        );

        const daoEntry = daoAggregateMap.get(surrogateKey);
        expect(daoEntry, `surrogate bucket for ${surrogateKey}`).toBeDefined();
        expect(
          Math.abs((daoEntry!.totalPrice ?? 0) - expectedTotalPrice),
        ).toBeLessThan(0.001);
        expect(
          Math.abs((daoEntry!.totalTokens ?? 0) - expectedTotalTokens),
        ).toBeLessThanOrEqual(10);
      }
    },
  );
});
