import { HumanMessage } from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { INestApplication } from '@nestjs/common';
import type { BridgeCommand } from '@packages/claude-bridge';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { CommunicationToolGroup } from '../../../v1/agent-tools/tools/common/communication/communication-tool-group';
import { BaseAgentConfigurable } from '../../../v1/agents/agents.types';
import { ClaudeAgent } from '../../../v1/agents/services/agents/claude-agent';
import { ClaudeBootstrapService } from '../../../v1/agents/services/claude/claude-bootstrap.service';
import { AgentCommunicationToolTemplate } from '../../../v1/graph-templates/templates/tools/agent-communication-tool.template';
import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import {
  GraphStatus,
  MessageRole,
  NodeKind,
} from '../../../v1/graphs/graphs.types';
import type { GraphRegistry } from '../../../v1/graphs/services/graph-registry';
import { LiteLlmClient } from '../../../v1/litellm/services/litellm.client';
import { LitellmVirtualKeyService } from '../../../v1/litellm/services/litellm-virtual-key.service';
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

  it(
    'forwards communication_exec and round-trips a real peer call through the bridge frame (Claude caller → Claude peer)',
    { timeout: 60_000 },
    async () => {
      // The M2 seam test drives ClaudeToolDispatcher.dispatch directly; this
      // closes the last-mile gap. A real ClaudeAgent.run whose MockBridge session
      // emits an actual `tool_call_request: communication_exec` frame — the exact
      // wire a live SDK session takes when a cloud agent calls a peer — and the
      // host's real transport → dispatcher must invoke the peer and answer the
      // bridge with a `tool_call_response`, all without a sandbox or a live LLM.
      const { agent: caller, config } = await prepareAgent();

      // The peer's run issues a per-thread virtual key; keep it off LiteLLM.
      const virtualKeys = app.get(LitellmVirtualKeyService);
      const issueSpy = vi
        .spyOn(virtualKeys, 'issueThreadKey')
        .mockResolvedValue({ key: 'sk-test-vkey' } as never);
      const revokeSpy = vi
        .spyOn(virtualKeys, 'revokeThreadKey')
        .mockResolvedValue(undefined as never);

      try {
        // PEER ("Developer") — a second real ClaudeAgent reached through the real
        // communication tool, running on its own MockBridge scenario.
        const peer = await app.resolve(ClaudeAgent);
        peer.setConfig({
          name: 'Developer',
          description: 'implements changes',
          instructions: 'be helpful',
          model: 'claude-sonnet-4-6',
        });
        peer.setRuntimeProvider({
          provide: async () => new MockRuntime(mockRuntimeSvc),
          getParams: () => ({ runtimeNodeId: 'rt-peer' }),
        } as unknown as RuntimeThreadProvider);

        // Real communication tool wired to the peer via a stub registry.
        const peerNode = {
          type: NodeKind.ClaudeAgent,
          instance: peer,
          config: { name: 'Developer', description: 'implements changes' },
        };
        const registryStub = {
          filterAgentNodeIds: () => ['developer-node'],
          getNode: () => peerNode,
        } as unknown as GraphRegistry;
        const template = new AgentCommunicationToolTemplate(
          app.get(CommunicationToolGroup),
          registryStub,
        );
        const handle = await template.create();
        const instance = (await handle.provide({} as never)) as {
          tools: { name: string; invoke: unknown }[];
        };
        await handle.configure(
          {
            config: {},
            inputNodeIds: new Set<string>(),
            outputNodeIds: new Set(['developer-node']),
            metadata: {
              graphId,
              nodeId: 'comm-tool-1',
              version: '1',
              graph_created_by: TEST_USER_ID,
              graph_project_id: projectId,
            },
          } as never,
          instance as never,
        );
        const execTool = instance.tools.find(
          (tool) => tool.name === 'communication_exec',
        ) as unknown as DynamicStructuredTool;
        expect(execTool).toBeDefined();

        // The caller carries communication_exec, so ClaudeAgent.run forwards it in
        // the start frame AND wires it into the host-side dispatcher.
        caller.addTool(execTool);

        const PEER_ANSWER = 'Implemented the change in auth.config.ts.';

        let callerTools: { name: string }[] | undefined;
        let toolResponse:
          | Extract<BridgeCommand, { type: 'tool_call_response' }>
          | undefined;

        // CALLER scenario (consumed FIRST — FIFO): emit the communication_exec
        // tool-call frame, then end the turn once the host answers it.
        mockRuntimeSvc.queueBridge((session) => {
          callerTools = session.startOptions.tools;
          session.onCommand((command) => {
            if (
              command.type === 'tool_call_response' &&
              command.id === 'tc-peer-1'
            ) {
              toolResponse = command;
              session.emitResult({ totalCostUsd: 0, sessionId: 'sess-caller' });
              session.done('sess-caller');
            }
          });
          session.emitAssistant({
            text: 'Delegating to the developer.',
            model: 'claude-sonnet-4-6',
            sessionId: 'sess-caller',
          });
          session.emitToolCallRequest('tc-peer-1', 'communication_exec', {
            agent: 'Developer',
            message: 'Update auth.config.ts.',
            purpose: 'delegate config update',
          });
        });

        // PEER scenario (consumed SECOND — when communication_exec runs peer.run):
        // one priced assistant turn carrying the answer, then result + done.
        mockRuntimeSvc.queueBridge((session) => {
          session.emitAssistant({
            text: PEER_ANSWER,
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 100, output_tokens: 50 },
            sessionId: 'sess-peer',
          });
          session.emitResult({
            totalCostUsd: 0.0002,
            usage: { input_tokens: 100, output_tokens: 50 },
            sessionId: 'sess-peer',
          });
          session.done('sess-peer');
        });

        const output = await caller.run(
          externalThreadId,
          [new HumanMessage('Ask the developer to update the config.')],
          undefined,
          config,
        );

        // 1) communication_exec was forwarded into the session — it reached the
        //    bridge `start` frame as a tool definition.
        expect(callerTools?.some((t) => t.name === 'communication_exec')).toBe(
          true,
        );

        // 2) The frame round-tripped: the host answered the caller's bridge with a
        //    successful tool_call_response carrying the peer's real answer.
        expect(toolResponse?.type).toBe('tool_call_response');
        expect(toolResponse?.error).toBeUndefined();
        expect(toolResponse?.result).toContain('auth.config.ts');

        // 3) The caller's turn completed normally (no escalation).
        expect(output.needsMoreInfo).toBe(false);

        // 4) The peer's run-scoped spend folded into the caller's cost. The
        //    caller's own turn was priced at 0, so the total IS the peer's
        //    $0.0002 (100 in @1e-6 + 50 out @2e-6).
        expect(output.statistics?.usage?.totalPrice).toBeGreaterThan(0);
        expect(output.statistics?.usage?.totalPrice).toBeCloseTo(0.0002, 6);
      } finally {
        issueSpy.mockRestore();
        revokeSpy.mockRestore();
      }
    },
  );
});
