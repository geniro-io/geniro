import { INestApplication } from '@nestjs/common';
import type {
  SdkAssistantMessage,
  SdkUserMessage,
} from '@packages/claude-bridge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AgentEventType } from '../../../v1/agents/services/agents/base-agent';
import { CheckpointStateService } from '../../../v1/agents/services/checkpoint-state.service';
import { ClaudeStreamMapper } from '../../../v1/agents/services/claude/claude-stream-mapper';
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
});
