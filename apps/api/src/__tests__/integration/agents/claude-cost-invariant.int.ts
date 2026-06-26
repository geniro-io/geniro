import type { DynamicStructuredTool } from '@langchain/core/tools';
import { INestApplication } from '@nestjs/common';
import type {
  SdkAssistantMessage,
  SdkUserMessage,
} from '@packages/claude-bridge';
import type { DefaultLogger } from '@packages/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';

import { AgentEventType } from '../../../v1/agents/services/agents/base-agent';
import { CheckpointStateService } from '../../../v1/agents/services/checkpoint-state.service';
import { ClaudeStreamMapper } from '../../../v1/agents/services/claude/claude-stream-mapper';
import { ClaudeToolDispatcher } from '../../../v1/agents/services/claude/claude-tool-dispatcher';
import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import { GraphStatus, MessageRole } from '../../../v1/graphs/graphs.types';
import { RequestTokenUsage } from '../../../v1/litellm/litellm.types';
import { AgentMessageNotificationHandler } from '../../../v1/notification-handlers/services/event-handlers/agent-message-notification-handler';
import { NotificationEvent } from '../../../v1/notifications/notifications.types';
import { MessagesDao } from '../../../v1/threads/dao/messages.dao';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { createTestProject } from '../helpers/test-context';
import { createTestModule, TEST_USER_ID } from '../setup';

const NODE_ID = 'claude-agent-1';
const PRICE_PER_CALL = 0.01;

const assistantMessage = (
  id: string,
  text: string,
  parentToolUseId: string | null = null,
): SdkAssistantMessage => ({
  type: 'assistant',
  session_id: 'sess-int-1',
  parent_tool_use_id: parentToolUseId,
  message: {
    id,
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 50 },
  },
});

/**
 * Targeted integration test for the Claude Agent cost pipeline
 * (milestone-1 step 9): persistence parity through the real
 * AgentMessageNotificationHandler, and the redefined byNode invariant for
 * checkpoint-less threads — for every node K (parent and `::sub::`
 * surrogates), `Σ messages.requestTokenUsage WHERE node_id = K` must equal
 * `getThreadTokenUsage(...).byNode[K]` sourced from the message-scan
 * fallback.
 */
describe('Claude Agent cost invariant (checkpoint-less threads)', () => {
  let app: INestApplication;
  let graphDao: GraphDao;
  let threadsDao: ThreadsDao;
  let messagesDao: MessagesDao;
  let messageHandler: AgentMessageNotificationHandler;
  let checkpointState: CheckpointStateService;

  let projectId: string;
  let graphId: string;
  let internalThreadId: string;
  const externalThreadId = `claude-int-${Date.now()}`;

  beforeAll(async () => {
    app = await createTestModule();
    graphDao = app.get(GraphDao);
    threadsDao = app.get(ThreadsDao);
    messagesDao = app.get(MessagesDao);
    messageHandler = app.get(AgentMessageNotificationHandler);
    checkpointState = app.get(CheckpointStateService);

    const testProject = await createTestProject(app);
    projectId = testProject.projectId;

    const graph = await graphDao.create({
      name: 'claude-cost-invariant-graph',
      description: 'targeted claude cost test',
      error: undefined,
      version: '1.0.0',
      targetVersion: '1.0.0',
      schema: {
        nodes: [
          {
            id: NODE_ID,
            template: 'claude-agent',
            config: { name: 'Claude', instructions: 'test' },
          },
        ],
        edges: [],
      },
      status: GraphStatus.Running,
      metadata: {},
      createdBy: TEST_USER_ID,
      projectId,
      temporary: false,
    });
    graphId = graph.id;

    const thread = await threadsDao.create({
      graphId,
      createdBy: TEST_USER_ID,
      projectId,
      externalThreadId,
      metadata: {},
      source: undefined,
      name: 'Claude cost test thread',
      status: ThreadStatus.Running,
    });
    internalThreadId = thread.id;
  }, 60000);

  afterAll(async () => {
    if (internalThreadId) {
      await messagesDao.hardDelete({ threadId: internalThreadId });
      await threadsDao.hardDeleteById(internalThreadId);
    }
    if (graphId) {
      await graphDao.hardDeleteById(graphId);
    }
    await app.close();
  });

  it(
    'persists mapper output with usage + surrogate node ids, and the byNode fallback reconciles with the message scan',
    { timeout: 30000 },
    async () => {
      // 1. Run a fixed SDK stream through the real mapper: two parent
      //    assistant calls (one with a tool round-trip) and one SDK-subagent
      //    assistant call (parent_tool_use_id set).
      const events: AgentEventType[] = [];
      const mapper = new ClaudeStreamMapper({
        threadId: externalThreadId,
        config: {
          configurable: {
            thread_id: externalThreadId,
            graph_id: graphId,
            node_id: NODE_ID,
            run_id: 'run-int-1',
          },
        },
        model: 'claude-sonnet-4-6',
        emit: (event) => events.push(event),
        calculatePriceUsd: () => PRICE_PER_CALL,
      });

      const withToolUse: SdkAssistantMessage = {
        ...assistantMessage('m1', 'using a tool'),
        message: {
          ...assistantMessage('m1', 'using a tool').message,
          content: [
            { type: 'text', text: 'using a tool' },
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'Bash',
              input: { cmd: 'ls' },
            },
          ],
        },
      };
      const toolResult: SdkUserMessage = {
        type: 'user',
        session_id: 'sess-int-1',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' },
          ],
        },
      };

      mapper.onSdkMessage(withToolUse);
      mapper.onSdkMessage(toolResult);
      mapper.onSdkMessage(assistantMessage('m2', 'done with the tool'));
      mapper.onSdkMessage(assistantMessage('m3', 'subagent work', 'tu-sub-1'));
      // Second subagent with DISTINCT token counts — a cross-bucket
      // attribution swap between the two surrogates must fail the byNode
      // assertions below (cost-accounting rule: parent + ≥2 subagents).
      const subagentTwo = assistantMessage('m4', 'subagent two', 'tu-sub-2');
      subagentTwo.message.usage = { input_tokens: 400, output_tokens: 100 };
      mapper.onSdkMessage(subagentTwo);
      // The mapper lag-1 buffers each assistant message until the next SDK
      // message (or the result) arrives — mirror ClaudeAgent.run, which
      // always flushes after the stream outcome settles.
      mapper.flush();

      // 2. Pipe every emitted message event through the REAL persistence
      //    handler (the writer side of the cost-by-node contract).
      for (const event of events) {
        if (event.type !== 'message') {
          continue;
        }
        await messageHandler.handle({
          type: NotificationEvent.AgentMessage,
          graphId,
          nodeId: NODE_ID,
          threadId: externalThreadId,
          parentThreadId: externalThreadId,
          data: { messages: event.data.messages },
        });
      }

      // 3. Writer-side assertions: usage stored on AI rows, surrogate node id
      //    applied to the SDK-subagent message, ToolMessage row present,
      //    __answeredToolCallNames denormalized.
      const rows = await messagesDao.getAll(
        { threadId: internalThreadId },
        { orderBy: { createdAt: 'ASC' } },
      );

      const aiRows = rows.filter((r) => r.role === MessageRole.AI);
      expect(aiRows).toHaveLength(4);
      // Select by node id, not insertion index — sequential inserts can share
      // a ms-precision createdAt, making positional asserts tie-brittle.
      const subTwoRow = aiRows.find(
        (r) => r.nodeId === `${NODE_ID}::sub::tu-sub-2`,
      );
      expect(subTwoRow!.requestTokenUsage).toMatchObject({
        inputTokens: 400,
        outputTokens: 100,
        totalTokens: 500,
        totalPrice: PRICE_PER_CALL,
      });
      for (const row of aiRows.filter((r) => r !== subTwoRow)) {
        expect(row.requestTokenUsage).toMatchObject({
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          totalPrice: PRICE_PER_CALL,
        });
      }

      const surrogateRows = rows.filter((r) => r.nodeId.includes('::sub::'));
      expect(surrogateRows).toHaveLength(2);
      expect(surrogateRows.map((r) => r.nodeId).sort()).toEqual([
        `${NODE_ID}::sub::tu-sub-1`,
        `${NODE_ID}::sub::tu-sub-2`,
      ]);

      const toolRows = rows.filter((r) => r.role === MessageRole.Tool);
      expect(toolRows).toHaveLength(1);
      // Tool rows must NOT carry request usage (double-counting guard);
      // the nullable column reads back as null.
      expect(toolRows[0]!.requestTokenUsage ?? null).toBeNull();

      const answeringRow = rows.find((r) => r.answeredToolCallNames?.length);
      expect(answeringRow?.answeredToolCallNames).toEqual(['Bash']);

      // 4. Reader side: the thread has NO checkpoints (Claude Agent), so
      //    getThreadTokenUsage must fall back to the message scan — and for
      //    every K, byNode[K] must equal the direct message aggregation.
      const usage = await checkpointState.getThreadTokenUsage(externalThreadId);
      expect(usage).not.toBeNull();
      expect(usage!.byNode).toBeDefined();

      // NOTE: byNode on the checkpoint-less path is built from the same
      // aggregateUsageByNodeId call — this loop pins shape parity, not
      // writer/reader reconciliation; the hard-value asserts below do that.
      const directBuckets =
        await messagesDao.aggregateUsageByNodeId(internalThreadId);
      expect(Object.keys(usage!.byNode!).sort()).toEqual(
        Array.from(directBuckets.keys()).sort(),
      );
      for (const [nodeId, direct] of directBuckets) {
        expect(usage!.byNode![nodeId]).toMatchObject({
          inputTokens: direct.inputTokens,
          outputTokens: direct.outputTokens,
          totalTokens: direct.totalTokens,
          totalPrice: direct.totalPrice,
        });
      }

      // Each surrogate keeps ITS OWN token counts — an attribution swap
      // between the two subagent buckets fails here.
      expect(usage!.byNode![`${NODE_ID}::sub::tu-sub-1`]).toMatchObject({
        inputTokens: 100,
        totalTokens: 150,
      });
      expect(usage!.byNode![`${NODE_ID}::sub::tu-sub-2`]).toMatchObject({
        inputTokens: 400,
        totalTokens: 500,
      });

      // Thread total == Σ per-message prices (2 parent + 2 subagent calls).
      expect(usage!.totalPrice).toBeCloseTo(4 * PRICE_PER_CALL, 10);

      // Σ byNode == thread total (no double counting between parent and
      // surrogate buckets on the message-scan path).
      const byNodeSum = Object.values(
        usage!.byNode! as Record<string, RequestTokenUsage>,
      ).reduce((sum, u) => sum + (u.totalPrice ?? 0), 0);
      expect(byNodeSum).toBeCloseTo(usage!.totalPrice ?? 0, 10);
    },
  );

  it(
    'persists dispatcher-reported tool usage on the synthesized ToolMessage without disturbing the requestUsage invariant (M2 MCP-proxied tools)',
    { timeout: 30000 },
    async () => {
      const events: AgentEventType[] = [];
      const mapper = new ClaudeStreamMapper({
        threadId: externalThreadId,
        config: {
          configurable: {
            thread_id: externalThreadId,
            graph_id: graphId,
            node_id: NODE_ID,
            run_id: 'run-int-2',
          },
        },
        model: 'claude-sonnet-4-6',
        emit: (event) => events.push(event),
        calculatePriceUsd: () => PRICE_PER_CALL,
      });

      // Assistant calls a forwarded Geniro tool through the in-bridge MCP
      // server; the host dispatcher reports the tool's own LLM usage.
      const mcpToolUse: SdkAssistantMessage = {
        ...assistantMessage('m10', 'searching the knowledge base'),
        message: {
          ...assistantMessage('m10', 'searching the knowledge base').message,
          content: [
            { type: 'text', text: 'searching the knowledge base' },
            {
              type: 'tool_use',
              id: 'tu-mcp-1',
              name: 'mcp__geniro__knowledge_search_docs',
              input: { task: 'find persistence docs' },
            },
          ],
        },
      };
      const toolOwnUsage: RequestTokenUsage = {
        inputTokens: 40,
        cachedInputTokens: 0,
        outputTokens: 10,
        totalTokens: 50,
        totalPrice: 0.005,
      };
      const mcpToolResult: SdkUserMessage = {
        type: 'user',
        session_id: 'sess-int-1',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-mcp-1',
              content: 'PASSAGE: messages persist in PostgreSQL',
            },
          ],
        },
      };

      mapper.onSdkMessage(mcpToolUse);
      mapper.recordToolUsage('knowledge_search_docs', toolOwnUsage);
      mapper.onSdkMessage(mcpToolResult);
      mapper.onSdkMessage(assistantMessage('m11', 'found it'));
      mapper.flush();

      for (const event of events) {
        if (event.type !== 'message') {
          continue;
        }
        await messageHandler.handle({
          type: NotificationEvent.AgentMessage,
          graphId,
          nodeId: NODE_ID,
          threadId: externalThreadId,
          parentThreadId: externalThreadId,
          data: { messages: event.data.messages },
        });
      }

      // Writer side: the ToolMessage row carries the dispatcher-reported
      // usage in the dedicated column (and still no request usage).
      const rows = await messagesDao.getAll(
        { threadId: internalThreadId },
        { orderBy: { createdAt: 'ASC' } },
      );
      const mcpToolRow = rows.find(
        (row) =>
          row.role === MessageRole.Tool && row.name === 'knowledge_search_docs',
      );
      expect(mcpToolRow).toBeDefined();
      expect(mcpToolRow!.toolTokenUsage).toMatchObject({
        inputTokens: 40,
        outputTokens: 10,
        totalTokens: 50,
        totalPrice: 0.005,
      });
      expect(mcpToolRow!.requestTokenUsage ?? null).toBeNull();
      // The tool name reaches persistence with the mcp__geniro__ prefix
      // stripped — per-tool cost surfaces group by the Geniro name.
      expect(JSON.stringify(mcpToolRow!.message)).not.toContain(
        'mcp__geniro__',
      );

      // Reader side: byNode still reconciles with the direct message scan
      // for every node (tool usage is display-only and must not leak into
      // the requestUsage buckets).
      const usage = await checkpointState.getThreadTokenUsage(externalThreadId);
      const directBuckets =
        await messagesDao.aggregateUsageByNodeId(internalThreadId);
      for (const [nodeId, direct] of directBuckets) {
        expect(usage!.byNode![nodeId]).toMatchObject({
          inputTokens: direct.inputTokens,
          outputTokens: direct.outputTokens,
          totalTokens: direct.totalTokens,
          totalPrice: direct.totalPrice,
        });
      }
    },
  );

  it(
    'folds a forwarded communication_exec peer call into the caller-node tool usage AND the cross-turn cost seed (M4 Claude peer)',
    { timeout: 30000 },
    async () => {
      // Shared thread: assert on the DELTA this call adds to the seed.
      const seedBefore =
        await messagesDao.aggregateToolUsageTotalPrice(internalThreadId);

      const events: AgentEventType[] = [];
      const mapper = new ClaudeStreamMapper({
        threadId: externalThreadId,
        config: {
          configurable: {
            thread_id: externalThreadId,
            graph_id: graphId,
            node_id: NODE_ID,
            run_id: 'run-int-3',
          },
        },
        model: 'claude-sonnet-4-6',
        emit: (event) => events.push(event),
        calculatePriceUsd: () => PRICE_PER_CALL,
      });

      // A Claude caller invokes a connected peer via the forwarded
      // communication_exec tool; the dispatcher reports the peer's run-scoped
      // spend (calleeUsage) as this tool's own usage.
      const commToolUse: SdkAssistantMessage = {
        ...assistantMessage('m20', 'asking the peer'),
        message: {
          ...assistantMessage('m20', 'asking the peer').message,
          content: [
            { type: 'text', text: 'asking the peer' },
            {
              type: 'tool_use',
              id: 'tu-comm-1',
              name: 'mcp__geniro__communication_exec',
              input: {
                agent: 'Config Specialist',
                message: 'Use auth.config.ts.',
                purpose: 'answer the peer',
              },
            },
          ],
        },
      };
      const peerUsage: RequestTokenUsage = {
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 30,
        totalTokens: 150,
        totalPrice: 0.012,
      };
      const commToolResult: SdkUserMessage = {
        type: 'user',
        session_id: 'sess-int-1',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-comm-1',
              content: 'Done — modified auth.config.ts.',
            },
          ],
        },
      };

      mapper.onSdkMessage(commToolUse);
      mapper.recordToolUsage('communication_exec', peerUsage);
      mapper.onSdkMessage(commToolResult);
      mapper.onSdkMessage(assistantMessage('m21', 'peer finished'));
      mapper.flush();

      for (const event of events) {
        if (event.type !== 'message') {
          continue;
        }
        await messageHandler.handle({
          type: NotificationEvent.AgentMessage,
          graphId,
          nodeId: NODE_ID,
          threadId: externalThreadId,
          parentThreadId: externalThreadId,
          data: { messages: event.data.messages },
        });
      }

      // Writer side: the peer's spend lands as toolTokenUsage on the
      // communication_exec result row, attributed to the CALLER node (no
      // ::sub:: surrogate), with no request usage on the tool message.
      const rows = await messagesDao.getAll(
        { threadId: internalThreadId },
        { orderBy: { createdAt: 'ASC' } },
      );
      const commRow = rows.find(
        (row) =>
          row.role === MessageRole.Tool && row.name === 'communication_exec',
      );
      expect(commRow).toBeDefined();
      expect(commRow!.nodeId).toBe(NODE_ID);
      expect(commRow!.toolTokenUsage).toMatchObject({
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        totalPrice: 0.012,
      });
      expect(commRow!.requestTokenUsage ?? null).toBeNull();

      // Cross-turn seed: aggregateToolUsageTotalPrice now picks up this peer
      // spend (the term aggregatePriorSpendUsd adds), so a prior turn's peer
      // call is not forgotten by the next turn's cost-limit gate.
      const seedAfter =
        await messagesDao.aggregateToolUsageTotalPrice(internalThreadId);
      expect(seedAfter - seedBefore).toBeCloseTo(0.012, 10);
    },
  );

  it(
    'keeps request- and tool-token usage on disjoint messages so the cross-turn cost seed counts each spend once (M4 no double-count)',
    { timeout: 30000 },
    async () => {
      // Persist a representative mixed turn into the (shared) thread: a parent
      // assistant call, a forwarded communication_exec peer call (tool usage on
      // the CALLER node), and a ::sub:: SDK-subagent assistant call (request
      // usage on a surrogate node id). aggregatePriorSpendUsd sums BOTH the
      // request-usage and tool-usage columns; that is only double-count-safe
      // because the two columns never co-occur on one message and a ::sub::
      // surrogate never carries tool usage. This test pins both invariants on
      // real persisted rows — the safety claim in MessagesDao's docstring.
      //
      // This file shares one thread across tests (no beforeEach reset), so these
      // rows accumulate onto prior tests' rows. That is benign by construction:
      // both the seed and the ground truth below scan the FULL thread, so the
      // reconciliation is superset-invariant — do not add a beforeEach reset
      // assuming isolation, it would not change the result but would weaken the
      // cross-turn-seed realism this pins.
      const events: AgentEventType[] = [];
      const mapper = new ClaudeStreamMapper({
        threadId: externalThreadId,
        config: {
          configurable: {
            thread_id: externalThreadId,
            graph_id: graphId,
            node_id: NODE_ID,
            run_id: 'run-int-no-double-count',
          },
        },
        model: 'claude-sonnet-4-6',
        emit: (event) => events.push(event),
        calculatePriceUsd: () => PRICE_PER_CALL,
      });

      const commToolUse: SdkAssistantMessage = {
        ...assistantMessage('m30', 'asking the peer again'),
        message: {
          ...assistantMessage('m30', 'asking the peer again').message,
          content: [
            { type: 'text', text: 'asking the peer again' },
            {
              type: 'tool_use',
              id: 'tu-comm-2',
              name: 'mcp__geniro__communication_exec',
              input: { agent: 'Peer', message: 'go', purpose: 'delegate' },
            },
          ],
        },
      };
      const peerUsage: RequestTokenUsage = {
        inputTokens: 200,
        cachedInputTokens: 0,
        outputTokens: 40,
        totalTokens: 240,
        totalPrice: 0.02,
      };
      const commToolResult: SdkUserMessage = {
        type: 'user',
        session_id: 'sess-int-1',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-comm-2', content: 'done' },
          ],
        },
      };

      mapper.onSdkMessage(commToolUse);
      mapper.recordToolUsage('communication_exec', peerUsage);
      mapper.onSdkMessage(commToolResult);
      // A ::sub:: SDK-subagent assistant call — request usage on a surrogate id.
      mapper.onSdkMessage(assistantMessage('m31', 'subagent work', 'tu-sub-9'));
      mapper.onSdkMessage(assistantMessage('m32', 'wrapping up'));
      mapper.flush();

      for (const event of events) {
        if (event.type !== 'message') {
          continue;
        }
        await messageHandler.handle({
          type: NotificationEvent.AgentMessage,
          graphId,
          nodeId: NODE_ID,
          threadId: externalThreadId,
          parentThreadId: externalThreadId,
          data: { messages: event.data.messages },
        });
      }

      const rows = await messagesDao.getAll(
        { threadId: internalThreadId },
        { orderBy: { createdAt: 'ASC' } },
      );

      // The thread really does carry both column families and a ::sub::
      // surrogate (else the disjointness asserts below pass vacuously).
      expect(rows.some((r) => r.requestTokenUsage != null)).toBe(true);
      expect(rows.some((r) => r.toolTokenUsage != null)).toBe(true);
      expect(rows.some((r) => r.nodeId.includes('::sub::'))).toBe(true);

      // (1) No single message carries BOTH columns — the disjointness the
      //     aggregatePriorSpendUsd docstring relies on.
      expect(
        rows.filter(
          (r) => r.requestTokenUsage != null && r.toolTokenUsage != null,
        ),
      ).toHaveLength(0);

      // (2) No ::sub:: surrogate row carries tool usage — the LangGraph
      //     subagent-as-tool fold that would double-count never appears on a
      //     Claude thread.
      expect(
        rows.filter(
          (r) => r.nodeId.includes('::sub::') && r.toolTokenUsage != null,
        ),
      ).toHaveLength(0);

      // (3) The two terms aggregatePriorSpendUsd adds reconcile with an
      //     independent per-row ground truth — each spend counted exactly once.
      const requestSeed = Array.from(
        (await messagesDao.aggregateUsageByNodeId(internalThreadId)).values(),
      ).reduce((sum, u) => sum + (u.totalPrice ?? 0), 0);
      const toolSeed =
        await messagesDao.aggregateToolUsageTotalPrice(internalThreadId);
      const groundTruthRequest = rows.reduce(
        (sum, r) => sum + (r.requestTokenUsage?.totalPrice ?? 0),
        0,
      );
      const groundTruthTool = rows.reduce(
        (sum, r) => sum + (r.toolTokenUsage?.totalPrice ?? 0),
        0,
      );

      expect(requestSeed).toBeCloseTo(groundTruthRequest, 10);
      expect(toolSeed).toBeCloseTo(groundTruthTool, 10);
      expect(requestSeed + toolSeed).toBeCloseTo(
        groundTruthRequest + groundTruthTool,
        10,
      );
    },
  );

  it(
    'stamps each forwarded communication_exec delegation with its own parent tool_use_id (Communication-block join) without disturbing byNode',
    { timeout: 30000 },
    async () => {
      // The parent (Manager) Claude stream makes TWO distinct communication_exec
      // calls; each records a DISTINCT SDK tool_use_id on its parent AI message.
      const events: AgentEventType[] = [];
      const mapper = new ClaudeStreamMapper({
        threadId: externalThreadId,
        config: {
          configurable: {
            thread_id: externalThreadId,
            graph_id: graphId,
            node_id: NODE_ID,
            run_id: 'run-int-join',
          },
        },
        model: 'claude-sonnet-4-6',
        emit: (event) => events.push(event),
        calculatePriceUsd: () => PRICE_PER_CALL,
      });

      const commCall = (msgId: string, tuId: string): SdkAssistantMessage => ({
        ...assistantMessage(msgId, 'delegating to a peer'),
        message: {
          ...assistantMessage(msgId, 'delegating to a peer').message,
          content: [
            { type: 'text', text: 'delegating to a peer' },
            {
              type: 'tool_use',
              id: tuId,
              name: 'mcp__geniro__communication_exec',
              input: { agent: 'Engineer', message: 'go', purpose: 'delegate' },
            },
          ],
        },
      });

      mapper.onSdkMessage(commCall('m40', 'tu-comm-A'));
      mapper.onSdkMessage(commCall('m41', 'tu-comm-B'));

      // A REAL dispatcher wired to that mapper. The stub communication_exec tool
      // captures the __toolCallId the dispatcher synthesizes into its config —
      // the id a delegated agent's inner messages inherit (agents.utils) and the
      // id the UI groups Communication blocks by.
      const capturedToolCallIds: (string | undefined)[] = [];
      const commTool = {
        invoke: async (
          _args: unknown,
          cfg: { configurable?: { __toolCallId?: string } },
        ) => {
          capturedToolCallIds.push(cfg.configurable?.__toolCallId);
          return { output: 'peer answered' };
        },
      };
      const dispatcher = new ClaudeToolDispatcher({
        tools: new Map([
          ['communication_exec', commTool as unknown as DynamicStructuredTool],
        ]),
        config: {
          configurable: {
            thread_id: externalThreadId,
            thread_created_by: TEST_USER_ID,
            node_id: NODE_ID,
          },
        },
        mapper,
        logger: mockDeep<DefaultLogger>(),
        signal: new AbortController().signal,
        send: () => {},
      });

      // Bridge correlation ids (tool-bridge-*) are a DIFFERENT id space from the
      // SDK tool_use_ids; the dispatcher must recover the latter by name (FIFO).
      dispatcher.dispatch({
        id: 'tool-bridge-1',
        toolName: 'communication_exec',
        args: {},
      });
      dispatcher.dispatch({
        id: 'tool-bridge-2',
        toolName: 'communication_exec',
        args: {},
      });
      await new Promise((resolve) => setImmediate(resolve));

      // Each delegation gets ITS OWN parent tool_use_id (FIFO) — so distinct
      // delegations render as distinct Communication blocks instead of folding
      // into one. The bridge ids never leak into __toolCallId.
      expect(capturedToolCallIds).toEqual(['tu-comm-A', 'tu-comm-B']);

      // A third call with no pending tool_use_id falls back to the bridge id —
      // never throws, never mis-attributes to a sibling.
      dispatcher.dispatch({
        id: 'tool-bridge-3',
        toolName: 'communication_exec',
        args: {},
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(capturedToolCallIds[2]).toBe('tool-bridge-3');

      // Cost-by-node is unaffected: persist the parent comm stream through the
      // real handler; both parent AI rows key by the plain node id (no ::sub::
      // surrogate — communication_exec is __interAgentCommunication, not
      // __subagentCommunication), and byNode still reconciles with the scan.
      mapper.flush();
      for (const event of events) {
        if (event.type !== 'message') {
          continue;
        }
        await messageHandler.handle({
          type: NotificationEvent.AgentMessage,
          graphId,
          nodeId: NODE_ID,
          threadId: externalThreadId,
          parentThreadId: externalThreadId,
          data: { messages: event.data.messages },
        });
      }

      // NOTE: on the checkpoint-less path getThreadTokenUsage reads via the same
      // aggregateUsageByNodeId scan, so this loop pins byNode SHAPE parity, not a
      // writer/reader regression (the genuine cost-by-node regression guard, with
      // distinct per-surrogate token values, lives in the first test of this
      // file). The load-bearing assertion FOR THIS FIX is capturedToolCallIds
      // above; the nodeId === NODE_ID check below pins that the changed
      // __toolCallId never shifts an inter-agent message into a ::sub:: bucket.
      const usage = await checkpointState.getThreadTokenUsage(externalThreadId);
      const directBuckets =
        await messagesDao.aggregateUsageByNodeId(internalThreadId);
      for (const [nodeId, direct] of directBuckets) {
        expect(usage!.byNode![nodeId]).toMatchObject({
          inputTokens: direct.inputTokens,
          outputTokens: direct.outputTokens,
          totalTokens: direct.totalTokens,
          totalPrice: direct.totalPrice,
        });
      }

      // The two communication_exec calls created NO ::sub:: surrogate rows —
      // changing __toolCallId on the inter-agent path must not shift a bucket.
      const rows = await messagesDao.getAll(
        { threadId: internalThreadId },
        { orderBy: { createdAt: 'ASC' } },
      );
      // Rows that MADE a communication_exec call (denormalized toolCallNames) —
      // NOT rows that merely answered one (__answeredToolCallNames), which a
      // ::sub:: subagent row from a sibling test legitimately carries.
      const commAiRows = rows.filter(
        (r) =>
          r.role === MessageRole.AI &&
          (r.toolCallNames ?? []).includes('communication_exec'),
      );
      expect(commAiRows.length).toBeGreaterThanOrEqual(2);
      for (const row of commAiRows) {
        expect(row.nodeId).toBe(NODE_ID);
      }
    },
  );
});
