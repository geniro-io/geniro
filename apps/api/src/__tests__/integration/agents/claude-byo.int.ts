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
import { ClaudeAuthMode } from '../../../v1/agents/services/claude/claude-session.types';
import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import { GraphStatus, MessageRole } from '../../../v1/graphs/graphs.types';
import { LiteLlmClient } from '../../../v1/litellm/services/litellm.client';
import { LitellmVirtualKeyService } from '../../../v1/litellm/services/litellm-virtual-key.service';
import { AgentMessageNotificationHandler } from '../../../v1/notification-handlers/services/event-handlers/agent-message-notification-handler';
import { NotificationEvent } from '../../../v1/notifications/notifications.types';
import type { RuntimeThreadProvider } from '../../../v1/runtime/services/runtime-thread-provider';
import { SecretsService } from '../../../v1/secrets/services/secrets.service';
import { SecretsStoreService } from '../../../v1/secrets-store/services/secrets-store.service';
import { MessagesDao } from '../../../v1/threads/dao/messages.dao';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { createTestProject } from '../helpers/test-context';
import { MockRuntime } from '../mocks/mock-runtime/mock-runtime';
import { MockRuntimeService } from '../mocks/mock-runtime/mock-runtime.service';
import { createTestModule, TEST_USER_ID } from '../setup';

const NODE_ID = 'claude-byo-1';
const BRIDGE_PATH = '/opt/geniro-claude/bridge.mjs';
const SECRET_REF = 'my-anthropic-key';
const BYO_KEY = 'sk-ant-api03-int-byo-key';

/**
 * Integration coverage for the Claude Agent BYO (bring-your-own Anthropic key)
 * auth mode through the REAL DI graph and persistence path, with the sandbox
 * bridge replaced by the in-process MockBridge. The unit suite
 * (claude-agent.spec.ts) pins the env injection + every fail-closed case at the
 * run() boundary; this file proves the BYO path also resolves the secret
 * host-side through the real SecretsService wiring, issues NO LiteLLM virtual
 * key, and keeps the cost invariant (Σ persisted requestTokenUsage == the SDK
 * billed total) end-to-end.
 */
describe('Claude Agent BYO Anthropic key (integration)', () => {
  let app: INestApplication;
  let graphDao: GraphDao;
  let threadsDao: ThreadsDao;
  let messagesDao: MessagesDao;
  let messageHandler: AgentMessageNotificationHandler;
  let mockRuntimeSvc: MockRuntimeService;

  let projectId: string;
  let graphId: string;
  let internalThreadId: string;
  const externalThreadId = `claude-byo-int-${Date.now()}`;

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
      name: 'claude-byo-graph',
      description: 'claude BYO integration',
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
      name: 'Claude BYO thread',
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
    vi.restoreAllMocks();
    await messagesDao.hardDelete({ threadId: internalThreadId });
    await threadsDao.updateById(internalThreadId, {
      status: ThreadStatus.Running,
      metadata: {},
    });
  });

  /**
   * Wire a fresh transient ClaudeAgent (resolved through the real DI graph, so
   * SecretsService + SecretsStoreService are the live providers) to a
   * MockRuntime, mock the install/cost lookups, spy the secret resolution, and
   * forward message events to the REAL persistence handler.
   */
  const prepareByoAgent = async (
    over?: Partial<BaseAgentConfigurable>,
  ): Promise<{
    agent: ClaudeAgent;
    config: { configurable: BaseAgentConfigurable };
    resolveSpy: ReturnType<typeof vi.spyOn>;
    issueSpy: ReturnType<typeof vi.spyOn>;
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

    // Host-side secret resolution: the real SecretsService is spied so no
    // OpenBao round-trip is needed, but it is the SAME singleton ClaudeAgent
    // injected — proving the DI wiring.
    const resolveSpy = vi
      .spyOn(app.get(SecretsService), 'resolveSecretValue')
      .mockResolvedValue(BYO_KEY);
    vi.spyOn(app.get(SecretsStoreService), 'isAvailable').mockReturnValue(true);
    // A BYO run must NOT issue a LiteLLM virtual key — spy so the test can
    // assert it never fired.
    const issueSpy = vi.spyOn(
      app.get(LitellmVirtualKeyService),
      'issueThreadKey',
    );

    const runtime = new MockRuntime(mockRuntimeSvc);
    const agent = await app.resolve(ClaudeAgent);
    agent.setConfig({
      name: 'Claude',
      description: 'byo integration',
      instructions: 'be helpful',
      model: 'claude-sonnet-4-6',
      authMode: ClaudeAuthMode.ByoAnthropic,
      apiKeySecretRef: SECRET_REF,
    });
    agent.setRuntimeProvider({
      provide: async () => runtime,
      getParams: () => ({ runtimeNodeId: 'rt-byo' }),
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
      resolveSpy,
      issueSpy,
      config: {
        configurable: {
          thread_id: externalThreadId,
          graph_id: graphId,
          node_id: NODE_ID,
          graph_project_id: projectId,
          ...over,
        } as BaseAgentConfigurable,
      },
    };
  };

  it(
    'resolves the BYO key host-side, issues NO virtual key, and keeps cost parity (Σ persisted == billed)',
    { timeout: 30_000 },
    async () => {
      const { agent, config, resolveSpy, issueSpy } = await prepareByoAgent();

      const BILLED_USD = 0.0002;
      mockRuntimeSvc.queueBridge((session) => {
        session.emitAssistant({
          text: 'Routed through your own Anthropic account.',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 50 },
          sessionId: 'sess-byo',
        });
        session.emitResult({
          totalCostUsd: BILLED_USD,
          usage: { input_tokens: 100, output_tokens: 50 },
          sessionId: 'sess-byo',
        });
        session.done('sess-byo');
      });

      const output = await agent.run(
        externalThreadId,
        [new HumanMessage('Use my key.')],
        undefined,
        config,
      );

      // The secret was resolved host-side, project-scoped, by name.
      expect(resolveSpy).toHaveBeenCalledWith(projectId, SECRET_REF);
      // No LiteLLM virtual key was issued for a BYO run.
      expect(issueSpy).not.toHaveBeenCalled();
      expect(output.needsMoreInfo).toBe(false);

      // Cost flows through the BYO loop: the run total equals the billed total.
      expect(output.statistics?.usage?.totalPrice).toBeCloseTo(BILLED_USD, 6);

      // Cost parity through real persistence: Σ persisted AI requestTokenUsage
      // prices == the SDK billed total (the BYO key does not change the
      // reconciliation; total_cost_usd stays primary).
      await vi.waitFor(async () => {
        const rows = await messagesDao.getAll(
          { threadId: internalThreadId, nodeId: NODE_ID },
          { orderBy: { createdAt: 'ASC' } },
        );
        const persistedTotal = rows
          .filter((r) => r.role === MessageRole.AI)
          .reduce((sum, r) => sum + (r.requestTokenUsage?.totalPrice ?? 0), 0);
        expect(persistedTotal).toBeCloseTo(BILLED_USD, 6);
      });
    },
  );

  it('fails closed through the real DI when the secrets store is unavailable', async () => {
    const { agent, config, resolveSpy } = await prepareByoAgent();
    vi.mocked(app.get(SecretsStoreService).isAvailable).mockReturnValue(false);

    await expect(
      agent.run(externalThreadId, [new HumanMessage('hi')], undefined, config),
    ).rejects.toMatchObject({ errorCode: 'CLAUDE_BYO_STORE_UNAVAILABLE' });
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
