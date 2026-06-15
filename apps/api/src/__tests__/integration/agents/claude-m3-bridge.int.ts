import { HumanMessage } from '@langchain/core/messages';
import { INestApplication } from '@nestjs/common';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { BaseAgentConfigurable } from '../../../v1/agents/agents.types';
import { ClaudeAgent } from '../../../v1/agents/services/agents/claude-agent';
import { ClaudeBootstrapService } from '../../../v1/agents/services/claude/claude-bootstrap.service';
import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import { GraphStatus, MessageRole } from '../../../v1/graphs/graphs.types';
import { LiteLlmClient } from '../../../v1/litellm/services/litellm.client';
import { AgentMessageNotificationHandler } from '../../../v1/notification-handlers/services/event-handlers/agent-message-notification-handler';
import { NotificationEvent } from '../../../v1/notifications/notifications.types';
import type { RuntimeThreadProvider } from '../../../v1/runtime/services/runtime-thread-provider';
import { MessagesDao } from '../../../v1/threads/dao/messages.dao';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { createTestProject } from '../helpers/test-context';
import { MockRuntime } from '../mocks/mock-runtime/mock-runtime';
import { MockRuntimeService } from '../mocks/mock-runtime/mock-runtime.service';
import { createTestModule, TEST_USER_ID } from '../setup';

const NODE_ID = 'claude-agent-m3';
// A bridge launch path — MockRuntime.execStream routes a `node <path>/bridge.mjs`
// launch to the scripted MockBridge.
const BRIDGE_PATH = '/opt/geniro-claude/bridge.mjs';

/**
 * Milestone-3 full-loop suite: a real `ClaudeAgent.run()` driven end-to-end
 * through the REAL transport → stream-mapper → persistence path, with the
 * sandbox bridge subprocess replaced by the in-process scripted MockBridge
 * (MockRuntime.execStream). Bootstrap (the install/deliver work) is mocked to
 * return a bridge path; everything downstream of `execStream` is real.
 */
describe('Claude Agent M3 — MockBridge full loop (integration)', () => {
  let app: INestApplication;
  let graphDao: GraphDao;
  let threadsDao: ThreadsDao;
  let messagesDao: MessagesDao;
  let messageHandler: AgentMessageNotificationHandler;
  let mockRuntimeSvc: MockRuntimeService;

  let projectId: string;
  let graphId: string;
  let internalThreadId: string;
  const externalThreadId = `claude-m3-int-${Date.now()}`;

  beforeAll(async () => {
    app = await createTestModule();
    graphDao = app.get(GraphDao);
    threadsDao = app.get(ThreadsDao);
    messagesDao = app.get(MessagesDao);
    messageHandler = app.get(AgentMessageNotificationHandler);
    mockRuntimeSvc = app.get(MockRuntimeService);

    const testProject = await createTestProject(app);
    projectId = testProject.projectId;

    const graph = await graphDao.create({
      name: 'claude-m3-graph',
      description: 'claude m3 full-loop integration',
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
      name: 'Claude M3 full-loop thread',
      status: ThreadStatus.Running,
    });
    internalThreadId = thread.id;
  }, 120_000);

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

  beforeEach(async () => {
    mockRuntimeSvc.reset();
    // Clear any rows a prior test in this file persisted under the shared thread.
    await messagesDao.hardDelete({ threadId: internalThreadId });
    // Reset the persisted session id so each test starts fresh (no resume).
    await threadsDao.updateById(internalThreadId, {
      status: ThreadStatus.Running,
      metadata: {},
    });
  });

  /**
   * Wire a fresh transient ClaudeAgent to a real MockRuntime (so execStream is
   * the MockBridge), mock the install/cost lookups, and forward message events
   * to the REAL persistence handler. Returns the agent + a run-config.
   */
  const prepareAgent = async (
    costLimitUsd?: number,
  ): Promise<{
    agent: ClaudeAgent;
    config: { configurable: BaseAgentConfigurable };
  }> => {
    const bootstrap = app.get(ClaudeBootstrapService);
    vi.spyOn(bootstrap, 'ensureSessionReady').mockResolvedValue({
      bridgePath: BRIDGE_PATH,
      pluginPaths: [],
    });
    vi.spyOn(bootstrap, 'isSessionResumable').mockResolvedValue(false);
    vi.spyOn(app.get(LiteLlmClient), 'getModelInfo').mockResolvedValue({
      model_info: {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
      },
    } as never);

    const runtime = new MockRuntime(mockRuntimeSvc);
    const agent = await app.resolve(ClaudeAgent);
    agent.setConfig({
      name: 'Claude',
      description: 'm3 full loop',
      instructions: 'be helpful',
      model: 'claude-sonnet-4-6',
    });
    agent.setRuntimeProvider({
      provide: async () => runtime,
      getParams: () => ({ runtimeNodeId: 'rt-1' }),
    } as unknown as RuntimeThreadProvider);

    agent.subscribe(async (event) => {
      if (event.type === 'message') {
        await messageHandler.handle({
          type: NotificationEvent.AgentMessage,
          graphId,
          nodeId: NODE_ID,
          threadId: externalThreadId,
          parentThreadId: externalThreadId,
          data: { messages: event.data.messages },
        });
      }
    });

    return {
      agent,
      config: {
        configurable: {
          thread_id: externalThreadId,
          graph_id: graphId,
          node_id: NODE_ID,
          ...(costLimitUsd !== undefined && {
            effective_cost_limit_usd: costLimitUsd,
          }),
        } as BaseAgentConfigurable,
      },
    };
  };

  it('runs a simple turn end-to-end: persists the assistant message and the session id', async () => {
    const { agent, config } = await prepareAgent();

    mockRuntimeSvc.queueBridge((session) => {
      session.emitAssistant({
        text: 'The thread layer persists messages in PostgreSQL.',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 100, output_tokens: 50 },
        sessionId: 'sess-simple',
      });
      session.emitResult({
        totalCostUsd: 0.0002,
        usage: { input_tokens: 100, output_tokens: 50 },
        sessionId: 'sess-simple',
      });
      session.done('sess-simple');
    });

    const output = await agent.run(
      externalThreadId,
      [new HumanMessage('Where are thread messages persisted?')],
      undefined,
      config,
    );

    expect(output.needsMoreInfo).toBe(false);
    expect(
      output.messages.some((m) => String(m.content).includes('PostgreSQL')),
    ).toBe(true);
    // Cost flows through the full loop (mapper rates + the result's total).
    expect(output.statistics?.usage?.totalPrice).toBeGreaterThan(0);

    // The assistant message reached the DB through the real persistence handler.
    await vi.waitFor(async () => {
      const rows = await messagesDao.getAll(
        { threadId: internalThreadId, nodeId: NODE_ID },
        { orderBy: { createdAt: 'ASC' } },
      );
      const assistant = rows.find(
        (row) =>
          row.role === MessageRole.AI &&
          JSON.stringify(row.message).includes('PostgreSQL'),
      );
      expect(assistant).toBeDefined();
    });

    // The SDK session id landed on the real thread row, keyed by node id.
    const threadRow = await threadsDao.getOne({ externalThreadId });
    expect(
      (threadRow?.metadata as { claudeSessions?: Record<string, string> })
        ?.claudeSessions?.[NODE_ID],
    ).toBe('sess-simple');
  });

  it('ends a question turn as NeedMoreInfo through the real transport and persists the question', async () => {
    const { agent, config } = await prepareAgent();

    mockRuntimeSvc.queueBridge((session) => {
      // The host interrupts on a question; reply with `aborted` to settle.
      session.onCommand((command) => {
        if (command.type === 'interrupt') {
          session.aborted('sess-q');
        }
      });
      session.emitQuestionRequest('q-1', [
        {
          question: 'Which database should the project use?',
          options: [{ label: 'Postgres', description: 'relational' }],
        },
      ]);
    });

    const output = await agent.run(
      externalThreadId,
      [new HumanMessage('Set up the database layer')],
      undefined,
      config,
    );

    expect(output.needsMoreInfo).toBe(true);
    const questionText = String(output.messages.at(-1)!.content);
    expect(questionText).toContain('Which database should the project use?');

    await vi.waitFor(async () => {
      const rows = await messagesDao.getAll(
        { threadId: internalThreadId, nodeId: NODE_ID },
        { orderBy: { createdAt: 'ASC' } },
      );
      expect(
        rows.some(
          (row) =>
            row.role === MessageRole.AI &&
            JSON.stringify(row.message).includes(
              'Which database should the project use?',
            ),
        ),
      ).toBe(true);
    });
  });

  it('surfaces a bridge fatal as a visible failure message and rejects the run', async () => {
    const { agent, config } = await prepareAgent();

    mockRuntimeSvc.queueBridge((session) => {
      session.fatal('bridge stdout error: simulated sandbox death');
    });

    await expect(
      agent.run(
        externalThreadId,
        [new HumanMessage('do something')],
        undefined,
        config,
      ),
    ).rejects.toMatchObject({ errorCode: 'CLAUDE_BRIDGE_FAILED' });

    // The failure explains itself in the conversation, not just a Failed status.
    await vi.waitFor(async () => {
      const rows = await messagesDao.getAll(
        { threadId: internalThreadId, nodeId: NODE_ID },
        { orderBy: { createdAt: 'ASC' } },
      );
      expect(
        rows.some((row) =>
          JSON.stringify(row.message).includes('Claude Agent session failed'),
        ),
      ).toBe(true);
    });
  });
});
