import { HumanMessage } from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { INestApplication } from '@nestjs/common';
import type { BridgeCommand } from '@packages/claude-bridge';
import type { DefaultLogger } from '@packages/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';

import { AppContextStorage } from '../../../auth/app-context-storage';
import type { ToolInvokeResult } from '../../../v1/agent-tools/tools/base-tool';
import { CommunicationToolGroup } from '../../../v1/agent-tools/tools/common/communication/communication-tool-group';
import { KnowledgeSearchDocsTool } from '../../../v1/agent-tools/tools/common/knowledge/knowledge-search-docs.tool';
import { BaseAgentConfigurable } from '../../../v1/agents/agents.types';
import { AgentEventType } from '../../../v1/agents/services/agents/base-agent';
import { ClaudeAgent } from '../../../v1/agents/services/agents/claude-agent';
import { ClaudeBootstrapService } from '../../../v1/agents/services/claude/claude-bootstrap.service';
import type { ClaudeBridgeHandlers } from '../../../v1/agents/services/claude/claude-bridge-transport';
import { ClaudeBridgeTransport } from '../../../v1/agents/services/claude/claude-bridge-transport';
import { buildBridgeToolDefinitions } from '../../../v1/agents/services/claude/claude-session.utils';
import type { ClaudeStreamMapper } from '../../../v1/agents/services/claude/claude-stream-mapper';
import { ClaudeToolDispatcher } from '../../../v1/agents/services/claude/claude-tool-dispatcher';
import { AgentCommunicationToolTemplate } from '../../../v1/graph-templates/templates/tools/agent-communication-tool.template';
import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import {
  GraphStatus,
  MessageRole,
  NodeKind,
} from '../../../v1/graphs/graphs.types';
import type { GraphRegistry } from '../../../v1/graphs/services/graph-registry';
import { KnowledgeDocDao } from '../../../v1/knowledge/dao/knowledge-doc.dao';
import { KnowledgeService } from '../../../v1/knowledge/services/knowledge.service';
import { LiteLlmClient } from '../../../v1/litellm/services/litellm.client';
import { LitellmVirtualKeyService } from '../../../v1/litellm/services/litellm-virtual-key.service';
import { AgentMessageNotificationHandler } from '../../../v1/notification-handlers/services/event-handlers/agent-message-notification-handler';
import { NotificationEvent } from '../../../v1/notifications/notifications.types';
import type { RuntimeThreadProvider } from '../../../v1/runtime/services/runtime-thread-provider';
import { MessagesDao } from '../../../v1/threads/dao/messages.dao';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { createTestProject } from '../helpers/test-context';
import { applyDefaults, getMockLlm } from '../mocks/mock-llm';
import { createTestModule, TEST_USER_ID } from '../setup';

const NODE_ID = 'claude-agent-m2';

/**
 * Milestone-2 integration slices that are hermetically testable without a
 * sandbox (the MockBridge full-loop suite is milestone 3):
 * - host-side dispatch of a forwarded Geniro tool, end-to-end through the
 *   REAL knowledge_search_docs tool against the real DB;
 * - the top-level AskUserQuestion turn-end: needsMoreInfo output, the
 *   question persisted through the real persistence handler, the SDK session
 *   id persisted on the real thread row, and the answer resuming the SAME
 *   session.
 */
describe('Claude Agent M2 — tools & questions (integration)', () => {
  let app: INestApplication;
  let graphDao: GraphDao;
  let threadsDao: ThreadsDao;
  let messagesDao: MessagesDao;
  let messageHandler: AgentMessageNotificationHandler;
  let knowledgeService: KnowledgeService;
  let docDao: KnowledgeDocDao;

  let ctx: AppContextStorage;
  let projectId: string;
  let graphId: string;
  let internalThreadId: string;
  const externalThreadId = `claude-m2-int-${Date.now()}`;
  const createdDocIds: string[] = [];

  beforeAll(async () => {
    app = await createTestModule();
    graphDao = app.get(GraphDao);
    threadsDao = app.get(ThreadsDao);
    messagesDao = app.get(MessagesDao);
    messageHandler = app.get(AgentMessageNotificationHandler);
    knowledgeService = app.get(KnowledgeService);
    docDao = app.get(KnowledgeDocDao);

    const testProject = await createTestProject(app);
    projectId = testProject.projectId;
    ctx = testProject.ctx;

    const graph = await graphDao.create({
      name: 'claude-m2-graph',
      description: 'claude m2 integration',
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
      name: 'Claude M2 test thread',
      status: ThreadStatus.Running,
    });
    internalThreadId = thread.id;
  }, 120_000);

  afterAll(async () => {
    for (const id of createdDocIds) {
      await docDao.deleteById(id);
    }
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
    'dispatches a forwarded knowledge_search_docs call through the real tool',
    { timeout: 60_000 },
    async () => {
      const mockLlm = getMockLlm(app);
      mockLlm.reset();
      mockLlm.onJsonRequest(
        {
          lastUserMessage:
            /You generate summaries for internal knowledge base documents/i,
        },
        { kind: 'json', content: { summary: 'Persistence layer summary.' } },
      );
      applyDefaults(mockLlm);

      const doc = await knowledgeService.createDoc(ctx, {
        title: 'Thread persistence',
        content: 'Geniro threads persist messages in PostgreSQL via MikroORM.',
        tags: [],
      });
      createdDocIds.push(doc.id);

      // Doc selection runs inside the tool; return the seeded doc's publicId.
      mockLlm.onJsonRequest(
        {
          lastUserMessage:
            /You select relevant knowledge documents for a query/i,
        },
        { kind: 'json', content: { ids: [doc.publicId], comment: null } },
      );

      const builtTool = (await app.resolve(KnowledgeSearchDocsTool)).build({});
      // The wire definition the bridge MCP server would register.
      const [definition] = buildBridgeToolDefinitions([builtTool]);
      expect(definition).toMatchObject({ name: 'knowledge_search_docs' });
      expect(definition!.inputSchema).toMatchObject({ type: 'object' });

      const sent: BridgeCommand[] = [];
      const recordToolUsage = vi.fn();
      const dispatcher = new ClaudeToolDispatcher({
        tools: new Map([[builtTool.name, builtTool]]),
        config: {
          configurable: {
            thread_id: externalThreadId,
            graph_created_by: TEST_USER_ID,
            graph_project_id: projectId,
          } as BaseAgentConfigurable,
        },
        mapper: { recordToolUsage } as unknown as ClaudeStreamMapper,
        logger: mockDeep<DefaultLogger>(),
        signal: new AbortController().signal,
        send: (command) => sent.push(command),
      });

      dispatcher.dispatch({
        id: 'tool-int-1',
        toolName: 'knowledge_search_docs',
        args: { task: 'Where are thread messages persisted?' },
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));

      const response = sent[0] as {
        type: string;
        id: string;
        result?: string;
        error?: string;
      };
      expect(response.type).toBe('tool_call_response');
      expect(response.id).toBe('tool-int-1');
      expect(response.error).toBeUndefined();
      expect(response.result).toContain('Thread persistence');
      expect(response.result).toContain(doc.publicId);
    },
  );

  it(
    'ends a top-level question turn as NeedMoreInfo, persists question + session, and resumes the same session with the answer',
    { timeout: 60_000 },
    async () => {
      const bootstrap = app.get(ClaudeBootstrapService);
      const virtualKeys = app.get(LitellmVirtualKeyService);
      const liteLlmClient = app.get(LiteLlmClient);

      const ensureSpy = vi
        .spyOn(bootstrap, 'ensureSessionReady')
        .mockResolvedValue({ bridgePath: '/opt/b.mjs', pluginPaths: [] });
      const resumableSpy = vi
        .spyOn(bootstrap, 'isSessionResumable')
        .mockResolvedValue(true);
      const issueSpy = vi
        .spyOn(virtualKeys, 'issueThreadKey')
        .mockResolvedValue({ key: 'sk-test-vkey' } as never);
      const revokeSpy = vi
        .spyOn(virtualKeys, 'revokeThreadKey')
        .mockResolvedValue(undefined as never);
      const modelInfoSpy = vi
        .spyOn(liteLlmClient, 'getModelInfo')
        .mockResolvedValue({
          model_info: {
            input_cost_per_token: 0.000001,
            output_cost_per_token: 0.000002,
          },
        } as never);

      let capturedHandlers: ClaudeBridgeHandlers | undefined;
      const fakeTransport = {
        send: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        isFinished: vi.fn().mockReturnValue(false),
      };
      const startSpy = vi
        .spyOn(ClaudeBridgeTransport, 'start')
        .mockImplementation(async (params) => {
          capturedHandlers = params.handlers;
          return fakeTransport as unknown as ClaudeBridgeTransport;
        });

      try {
        const agent = await app.resolve(ClaudeAgent);
        agent.setConfig({
          name: 'Claude',
          description: 'm2 test',
          instructions: 'be helpful',
          model: 'claude-sonnet-4-6',
        });
        agent.setRuntimeProvider({
          provide: vi.fn().mockResolvedValue({ getWorkdir: () => '/ws' }),
          getParams: () => ({ runtimeNodeId: 'rt-1' }),
        } as unknown as RuntimeThreadProvider);

        const runEvents: Extract<AgentEventType, { type: 'run' }>[] = [];
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
          if (event.type === 'run') {
            runEvents.push(event);
          }
        });

        const config = {
          configurable: {
            thread_id: externalThreadId,
            graph_id: graphId,
            node_id: NODE_ID,
          } as BaseAgentConfigurable,
        };

        // Turn 1: the model asks a question — the turn ends as NeedMoreInfo.
        const run1 = agent.run(
          externalThreadId,
          [new HumanMessage('Set up the database layer')],
          undefined,
          config,
        );
        await vi.waitFor(() => expect(fakeTransport.send).toHaveBeenCalled());
        capturedHandlers!.onQuestionRequest!({
          id: 'q-1',
          questions: [
            {
              question: 'Which database should the project use?',
              options: [{ label: 'Postgres', description: 'relational' }],
            },
          ],
        });
        expect(fakeTransport.interrupt).toHaveBeenCalled();
        capturedHandlers!.onAborted('sess-q1');

        const output1 = await run1;
        expect(output1.needsMoreInfo).toBe(true);
        expect(runEvents).toHaveLength(1);
        expect(runEvents[0]!.data.result?.needsMoreInfo).toBe(true);

        // The question is persisted as a visible AI message through the REAL
        // persistence handler.
        await vi.waitFor(async () => {
          const rows = await messagesDao.getAll(
            { threadId: internalThreadId, nodeId: NODE_ID },
            { orderBy: { createdAt: 'ASC' } },
          );
          const question = rows.find(
            (row) =>
              row.role === MessageRole.AI &&
              JSON.stringify(row.message).includes(
                'Which database should the project use?',
              ),
          );
          expect(question).toBeDefined();
        });

        // The SDK session id landed on the real thread row, keyed by node id.
        const threadRow = await threadsDao.getOne({ externalThreadId });
        expect(
          (threadRow?.metadata as { claudeSessions?: Record<string, string> })
            ?.claudeSessions?.[NODE_ID],
        ).toBe('sess-q1');

        // Turn 2: the user's answer resumes the SAME SDK session.
        fakeTransport.send.mockClear();
        const run2 = agent.run(
          externalThreadId,
          [new HumanMessage('Postgres')],
          undefined,
          config,
        );
        await vi.waitFor(() => expect(fakeTransport.send).toHaveBeenCalled());
        const startFrame = fakeTransport.send.mock.calls[0]![0] as {
          type: string;
          options: { prompt: string; resume?: string };
        };
        expect(startFrame.type).toBe('start');
        expect(startFrame.options.resume).toBe('sess-q1');
        expect(startFrame.options.prompt).toBe('Postgres');

        capturedHandlers!.onDone('sess-q1');
        const output2 = await run2;
        expect(output2.needsMoreInfo).toBe(false);
      } finally {
        startSpy.mockRestore();
        ensureSpy.mockRestore();
        resumableSpy.mockRestore();
        issueSpy.mockRestore();
        revokeSpy.mockRestore();
        modelInfoSpy.mockRestore();
      }
    },
  );

  it(
    'relays a Claude-callee question to the parent with run-scoped cost, and the parent answer resumes the same session (subagent mode)',
    { timeout: 60_000 },
    async () => {
      const bootstrap = app.get(ClaudeBootstrapService);
      const virtualKeys = app.get(LitellmVirtualKeyService);
      const liteLlmClient = app.get(LiteLlmClient);

      const ensureSpy = vi
        .spyOn(bootstrap, 'ensureSessionReady')
        .mockResolvedValue({ bridgePath: '/opt/b.mjs', pluginPaths: [] });
      const resumableSpy = vi
        .spyOn(bootstrap, 'isSessionResumable')
        .mockResolvedValue(true);
      const issueSpy = vi
        .spyOn(virtualKeys, 'issueThreadKey')
        .mockResolvedValue({ key: 'sk-test-vkey' } as never);
      const revokeSpy = vi
        .spyOn(virtualKeys, 'revokeThreadKey')
        .mockResolvedValue(undefined as never);
      const modelInfoSpy = vi
        .spyOn(liteLlmClient, 'getModelInfo')
        .mockResolvedValue({
          model_info: {
            input_cost_per_token: 0.000001,
            output_cost_per_token: 0.000002,
          },
        } as never);

      let capturedHandlers: ClaudeBridgeHandlers | undefined;
      const fakeTransport = {
        send: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        isFinished: vi.fn().mockReturnValue(false),
      };
      const startSpy = vi
        .spyOn(ClaudeBridgeTransport, 'start')
        .mockImplementation(async (params) => {
          capturedHandlers = params.handlers;
          return fakeTransport as unknown as ClaudeBridgeTransport;
        });

      try {
        const claudeAgent = await app.resolve(ClaudeAgent);
        claudeAgent.setConfig({
          name: 'Claude Peer',
          description: 'callee under test',
          instructions: 'be helpful',
          model: 'claude-sonnet-4-6',
        });
        claudeAgent.setRuntimeProvider({
          provide: vi.fn().mockResolvedValue({ getWorkdir: () => '/ws' }),
          getParams: () => ({ runtimeNodeId: 'rt-1' }),
        } as unknown as RuntimeThreadProvider);

        // Real template + real CommunicationToolGroup; only the graph
        // registry is stubbed to resolve the Claude node.
        const claudeNode = {
          type: NodeKind.ClaudeAgent,
          instance: claudeAgent,
          config: { name: 'Claude Peer', description: 'callee under test' },
        };
        const registryStub = {
          filterAgentNodeIds: () => ['claude-node-1'],
          getNode: () => claudeNode,
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
            outputNodeIds: new Set(['claude-node-1']),
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
        ) as unknown as {
          invoke: (
            args: unknown,
            config: unknown,
          ) => Promise<ToolInvokeResult<unknown>>;
        };
        expect(execTool).toBeDefined();

        // Drive the callee: one priced assistant message, then the question
        // ends the callee turn.
        const runDriver = (async () => {
          await vi.waitFor(() => expect(fakeTransport.send).toHaveBeenCalled());
          capturedHandlers!.onSdkMessage({
            type: 'assistant',
            session_id: 'sess-relay-1',
            parent_tool_use_id: null,
            message: {
              id: 'm-relay-1',
              model: 'claude-sonnet-4-6',
              content: [{ type: 'text', text: 'thinking about the schema' }],
              usage: { input_tokens: 100, output_tokens: 50 },
            },
          });
          capturedHandlers!.onQuestionRequest!({
            id: 'q-relay-1',
            questions: [
              {
                question: 'Normalize the schema?',
                options: [{ label: 'Yes', description: '3NF' }],
              },
            ],
          });
          capturedHandlers!.onAborted('sess-relay-1');
        })();

        const parentConfigurable = {
          configurable: {
            thread_id: externalThreadId,
            graph_id: graphId,
            node_id: 'parent-agent-1',
          },
        };
        const result = await execTool.invoke(
          {
            message: 'Design the database schema',
            purpose: 'Schema design',
            agent: 'Claude Peer',
          },
          parentConfigurable,
        );
        await runDriver;

        // The parent receives the question + needsMoreInfo through the relay...
        const relayed = result.output as {
          message: string;
          needsMoreInfo: boolean;
        };
        expect(relayed.needsMoreInfo).toBe(true);
        expect(relayed.message).toContain('Normalize the schema?');
        // ...and the callee's RUN-SCOPED cost as the tool's own usage
        // (100 in @1e-6 + 50 out @2e-6 = 0.0002 USD).
        expect(result.toolRequestUsage).toMatchObject({
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        });
        expect(result.toolRequestUsage?.totalPrice).toBeCloseTo(0.0002, 10);

        // Parent answers → the SAME SDK session resumes with the answer.
        fakeTransport.send.mockClear();
        const answerDriver = (async () => {
          await vi.waitFor(() => expect(fakeTransport.send).toHaveBeenCalled());
          capturedHandlers!.onDone('sess-relay-1');
        })();
        const answerResult = await execTool.invoke(
          {
            message: 'Yes, normalize it',
            purpose: 'Answer the question',
            agent: 'Claude Peer',
          },
          parentConfigurable,
        );
        await answerDriver;

        const startFrame = fakeTransport.send.mock.calls[0]![0] as {
          type: string;
          options: { prompt: string; resume?: string };
        };
        expect(startFrame.type).toBe('start');
        expect(startFrame.options.resume).toBe('sess-relay-1');
        expect(startFrame.options.prompt).toContain('Yes, normalize it');
        expect(
          (answerResult.output as { needsMoreInfo: boolean }).needsMoreInfo,
        ).toBe(false);
      } finally {
        startSpy.mockRestore();
        ensureSpy.mockRestore();
        resumableSpy.mockRestore();
        issueSpy.mockRestore();
        revokeSpy.mockRestore();
        modelInfoSpy.mockRestore();
      }
    },
  );

  it(
    'dispatches a forwarded communication_exec peer call through the real ClaudeToolDispatcher and records the callee cost (Claude caller)',
    { timeout: 60_000 },
    async () => {
      // A Claude CALLER reaches a connected peer by calling communication_exec.
      // The host-side handler for that forwarded tool is the SAME
      // ClaudeToolDispatcher ClaudeAgent.run wires to the bridge's
      // onToolCallRequest (claude-agent.ts builds it from the agent's tools).
      // This drives that dispatcher with the real communication tool + a real
      // Claude peer, proving communication_exec is forwarded (no longer stripped
      // from the Claude session), dispatches to the peer, and the peer's
      // run-scoped spend is recorded as the caller node's tool usage — the fold
      // that feeds aggregatePriorSpendUsd's cross-turn cost seed.
      const bootstrap = app.get(ClaudeBootstrapService);
      const virtualKeys = app.get(LitellmVirtualKeyService);
      const liteLlmClient = app.get(LiteLlmClient);

      const ensureSpy = vi
        .spyOn(bootstrap, 'ensureSessionReady')
        .mockResolvedValue({ bridgePath: '/opt/b.mjs', pluginPaths: [] });
      const resumableSpy = vi
        .spyOn(bootstrap, 'isSessionResumable')
        .mockResolvedValue(false);
      const issueSpy = vi
        .spyOn(virtualKeys, 'issueThreadKey')
        .mockResolvedValue({ key: 'sk-test-vkey' } as never);
      const revokeSpy = vi
        .spyOn(virtualKeys, 'revokeThreadKey')
        .mockResolvedValue(undefined as never);
      const modelInfoSpy = vi
        .spyOn(liteLlmClient, 'getModelInfo')
        .mockResolvedValue({
          model_info: {
            input_cost_per_token: 0.000001,
            output_cost_per_token: 0.000002,
          },
        } as never);

      let capturedHandlers: ClaudeBridgeHandlers | undefined;
      const fakeTransport = {
        send: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        isFinished: vi.fn().mockReturnValue(false),
      };
      const startSpy = vi
        .spyOn(ClaudeBridgeTransport, 'start')
        .mockImplementation(async (params) => {
          capturedHandlers = params.handlers;
          return fakeTransport as unknown as ClaudeBridgeTransport;
        });

      try {
        // Peer (callee) — a real ClaudeAgent reached as a peer.
        const claudePeer = await app.resolve(ClaudeAgent);
        claudePeer.setConfig({
          name: 'Claude Peer',
          description: 'callee under test',
          instructions: 'be helpful',
          model: 'claude-sonnet-4-6',
        });
        claudePeer.setRuntimeProvider({
          provide: vi.fn().mockResolvedValue({ getWorkdir: () => '/ws' }),
          getParams: () => ({ runtimeNodeId: 'rt-1' }),
        } as unknown as RuntimeThreadProvider);

        // Real communication tool wired to the Claude peer.
        const claudeNode = {
          type: NodeKind.ClaudeAgent,
          instance: claudePeer,
          config: { name: 'Claude Peer', description: 'callee under test' },
        };
        const registryStub = {
          filterAgentNodeIds: () => ['claude-node-1'],
          getNode: () => claudeNode,
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
            outputNodeIds: new Set(['claude-node-1']),
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

        // The Claude caller's host-side tool handler. A recordToolUsage spy
        // stands in for the caller's stream mapper.
        const sent: BridgeCommand[] = [];
        const recordToolUsage = vi.fn();
        const dispatcher = new ClaudeToolDispatcher({
          tools: new Map([['communication_exec', execTool]]),
          config: {
            configurable: {
              thread_id: externalThreadId,
              graph_id: graphId,
              node_id: 'claude-caller-1',
              graph_created_by: TEST_USER_ID,
              graph_project_id: projectId,
            } as BaseAgentConfigurable,
          },
          mapper: { recordToolUsage } as unknown as ClaudeStreamMapper,
          logger: mockDeep<DefaultLogger>(),
          signal: new AbortController().signal,
          send: (command) => sent.push(command),
        });

        // Drive the peer to a clean completion: one priced assistant turn + done.
        const runDriver = (async () => {
          await vi.waitFor(() => expect(fakeTransport.send).toHaveBeenCalled());
          capturedHandlers!.onSdkMessage({
            type: 'assistant',
            session_id: 'sess-comm-1',
            parent_tool_use_id: null,
            message: {
              id: 'm-comm-1',
              model: 'claude-sonnet-4-6',
              content: [
                { type: 'text', text: 'Updated auth.config.ts as requested.' },
              ],
              usage: { input_tokens: 100, output_tokens: 50 },
            },
          });
          capturedHandlers!.onDone('sess-comm-1');
        })();

        // The Claude caller's bridge requested communication_exec; the
        // dispatcher routes it to the real tool, which invokes the peer.
        dispatcher.dispatch({
          id: 'tu-comm-int-1',
          toolName: 'communication_exec',
          args: {
            agent: 'Claude Peer',
            message: 'Update auth.config.ts.',
            purpose: 'delegate config update',
          },
        });

        await vi.waitFor(() => expect(sent).toHaveLength(1));
        await runDriver;

        // The dispatcher answered the bridge with a successful tool_call_response
        // carrying the peer's answer — communication_exec is forwarded into the
        // Claude session and dispatched end-to-end.
        const response = sent[0] as {
          type: string;
          id: string;
          result?: string;
          error?: string;
        };
        expect(response.type).toBe('tool_call_response');
        expect(response.id).toBe('tu-comm-int-1');
        expect(response.error).toBeUndefined();
        expect(response.result).toContain('auth.config.ts');

        // The peer's run-scoped spend was recorded as the caller node's tool
        // usage (100 in @1e-6 + 50 out @2e-6 = 0.0002 USD) — the cost fold that
        // feeds the cross-turn seed.
        expect(recordToolUsage).toHaveBeenCalledTimes(1);
        const [recordedName, recordedUsage] = recordToolUsage.mock
          .calls[0]! as [
          string,
          {
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
            totalPrice: number;
          },
        ];
        expect(recordedName).toBe('communication_exec');
        expect(recordedUsage).toMatchObject({
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        });
        expect(recordedUsage.totalPrice).toBeCloseTo(0.0002, 10);
      } finally {
        startSpy.mockRestore();
        ensureSpy.mockRestore();
        resumableSpy.mockRestore();
        issueSpy.mockRestore();
        revokeSpy.mockRestore();
        modelInfoSpy.mockRestore();
      }
    },
  );
});
