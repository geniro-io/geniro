import { AIMessageChunk } from '@langchain/core/messages';
import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { io, Socket } from 'socket.io-client';
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
import { ReasoningEffort } from '../../../v1/agents/agents.types';
import { buildReasoningMessage } from '../../../v1/agents/agents.utils';
import {
  SimpleAgent,
  SimpleAgentSchemaType,
} from '../../../v1/agents/services/agents/simple-agent';
import { GraphThreadState } from '../../../v1/agents/services/graph-thread-state';
import {
  CreateGraphDto,
  ReasoningMessageDto,
} from '../../../v1/graphs/dto/graphs.dto';
import {
  GraphNodeSchemaType,
  GraphNodeStatus,
  GraphSchemaType,
  GraphStatus,
} from '../../../v1/graphs/graphs.types';
import { GraphRegistry } from '../../../v1/graphs/services/graph-registry';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { MessageTransformerService } from '../../../v1/graphs/services/message-transformer.service';
import { IEnrichedNotification } from '../../../v1/notification-handlers/notification-handlers.types';
import {
  IGraphNodeUpdateData,
  Notification,
  NotificationEvent,
} from '../../../v1/notifications/notifications.types';
import { IAgentStateUpdateData } from '../../../v1/notifications/notifications.types';
import { NotificationsService } from '../../../v1/notifications/services/notifications.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { MessagesDao } from '../../../v1/threads/dao/messages.dao';
import {
  ThreadDto,
  ThreadMessageDto,
} from '../../../v1/threads/dto/threads.dto';
import { ThreadEntity } from '../../../v1/threads/entity/thread.entity';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import {
  createMockGraphData,
  waitForCondition,
} from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import type { MockLlmService } from '../mocks/mock-llm/mock-llm.service';
import { createTestModule, getMockLlm, TEST_USER_ID } from '../setup';

// Type aliases for socket notifications (using business logic interfaces)
type MessageNotification = IEnrichedNotification<ThreadMessageDto>;
type NodeUpdateNotification = IEnrichedNotification<IGraphNodeUpdateData>;
type ThreadCreateNotification = IEnrichedNotification<ThreadEntity>;
type ThreadUpdateNotification = IEnrichedNotification<ThreadDto>;
type AgentStateUpdateNotification =
  IEnrichedNotification<IAgentStateUpdateData>;

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Socket Notifications Integration Tests', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let graphRegistry: GraphRegistry;
  let notificationsService: NotificationsService;
  let threadsService: ThreadsService;
  let messagesDao: MessagesDao;
  let messageTransformer: MessageTransformerService;
  let socket: Socket;
  let ioAdapter: IoAdapter;
  let baseUrl: string;
  let mockLlm: MockLlmService;
  const createdGraphIds: string[] = [];
  let baseGraphId: string;
  let commandGraphId: string;
  let testProjectId: string;
  const STOP_TRIGGER_NODE_ID = 'trigger-1';
  const STOP_AGENT_NODE_ID = 'agent-1';
  const STOP_SHELL_NODE_ID = 'shell-1';
  const STOP_RUNTIME_NODE_ID = 'runtime-1';
  const COMMAND_AGENT_INSTRUCTIONS =
    'You are a command runner. When the user message contains `Run this command: <cmd>` or `Execute shell command: <cmd>`, extract `<cmd>` and execute it exactly using the shell tool. Do not run any other commands, inspections, or tests unless the user explicitly requests them. After running the shell tool, describe what happened. If the runtime is not yet started, wait briefly and retry once before reporting the failure.';

  const createCommandGraphData = (): CreateGraphDto => ({
    name: `Command Graph ${Date.now()}`,
    description: 'Graph with shell runtime for destroy-stop scenarios',
    temporary: true,
    schema: {
      nodes: [
        {
          id: STOP_TRIGGER_NODE_ID,
          template: 'manual-trigger',
          config: {},
        },
        {
          id: STOP_AGENT_NODE_ID,
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
          id: STOP_SHELL_NODE_ID,
          template: 'shell-tool',
          config: {},
        },
        {
          id: STOP_RUNTIME_NODE_ID,
          template: 'runtime',
          config: {
            runtimeType: 'Docker',
            image: 'python:3.11-slim',
            env: {},
          },
        },
      ],
      edges: [
        { from: STOP_TRIGGER_NODE_ID, to: STOP_AGENT_NODE_ID },
        { from: STOP_AGENT_NODE_ID, to: STOP_SHELL_NODE_ID },
        { from: STOP_SHELL_NODE_ID, to: STOP_RUNTIME_NODE_ID },
      ],
    },
  });

  beforeAll(async () => {
    app = await createTestModule();

    ioAdapter = new IoAdapter(app);
    app.useWebSocketAdapter(ioAdapter);

    await app.listen(5050, '127.0.0.1');

    graphsService = app.get<GraphsService>(GraphsService);
    graphRegistry = app.get<GraphRegistry>(GraphRegistry);
    notificationsService = app.get<NotificationsService>(NotificationsService);
    threadsService = app.get<ThreadsService>(ThreadsService);
    messagesDao = app.get<MessagesDao>(MessagesDao);
    messageTransformer = app.get<MessageTransformerService>(
      MessageTransformerService,
    );
    mockLlm = getMockLlm(app);
    baseUrl = 'http://localhost:5050';

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;

    const baseGraph = await graphsService.create(
      contextDataStorage,
      createMockGraphData({
        name: `Socket Notifications Base ${Date.now()}`,
      }),
    );
    baseGraphId = baseGraph.id;
    createdGraphIds.push(baseGraphId);

    const commandGraph = await graphsService.create(
      contextDataStorage,
      createCommandGraphData(),
    );
    commandGraphId = commandGraph.id;
    createdGraphIds.push(commandGraphId);
  }, 180_000);

  afterEach(async () => {
    // Disconnect socket
    if (socket && socket.connected) {
      socket.disconnect();
    }

    // Reset graphs to a known non-running state for the next test.
    for (const graphId of createdGraphIds) {
      try {
        await graphsService.destroy(contextDataStorage, graphId);
      } catch (error) {
        console.warn(`afterEach: destroy failed for graph ${graphId}:`, error);
      }
    }
  }, 180_000);

  afterAll(async () => {
    // Cleanup graphs created in beforeAll (and any graphs created during tests)
    for (const graphId of createdGraphIds) {
      try {
        await graphsService.destroy(contextDataStorage, graphId);
      } catch (error) {
        console.warn(`afterAll: destroy failed for graph ${graphId}:`, error);
      }
      try {
        await graphsService.delete(contextDataStorage, graphId);
      } catch (error) {
        console.warn(`afterAll: delete failed for graph ${graphId}:`, error);
      }
    }

    if (testProjectId) {
      try {
        await app.get(ProjectsDao).deleteById(testProjectId);
      } catch {
        // best effort cleanup
      }
    }

    await app.close();
  }, 180_000);

  const uniqueThreadSubId = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ensureGraphRunning = async (graphId: string) => {
    const graph = await graphsService.findById(contextDataStorage, graphId);
    const registryNode = graphRegistry.getNode(graphId, 'agent-1');
    if (graph.status === GraphStatus.Running && registryNode) {
      return;
    }

    // If graph shows Running in DB but registry is empty (e.g. after destroy),
    // we need to stop it first so run() doesn't get GRAPH_ALREADY_RUNNING.
    if (graph.status === GraphStatus.Running) {
      try {
        await graphsService.destroy(contextDataStorage, graphId);
      } catch (error) {
        console.warn(
          `ensureGraphRunning: destroy before re-run failed for graph ${graphId}:`,
          error,
        );
      }
    }

    await graphsService.run(contextDataStorage, graphId);
    await waitForCondition(
      () => graphsService.findById(contextDataStorage, graphId),
      (g) => g.status === GraphStatus.Running,
      { timeout: 30_000, interval: 200 },
    );
  };

  const restartGraph = async (graphId: string) => {
    try {
      await graphsService.destroy(contextDataStorage, graphId);
    } catch (error) {
      console.warn(`restartGraph: destroy failed for graph ${graphId}:`, error);
    }
    await ensureGraphRunning(graphId);
  };

  const createSocketConnection = (userId: string): Socket => {
    return io(baseUrl, {
      auth: {
        'x-dev-jwt-sub': userId,
      },
      transports: ['websocket'],
      reconnection: false,
    });
  };

  const waitForSocketConnection = (socket: Socket): Promise<void> => {
    return new Promise((resolve, reject) => {
      socket.on('socket_connected', () => resolve());
      socket.on('server_error', (error) => reject(error));
      setTimeout(() => reject(new Error('Socket connection timeout')), 10000);
    });
  };

  const extractPendingMessageContent = (
    message: unknown,
  ): string | undefined => {
    if (!message || typeof message !== 'object') {
      return undefined;
    }

    if (typeof (message as { content?: unknown }).content === 'string') {
      return (message as { content?: string }).content;
    }

    const lcKwargs = (
      message as {
        lc_kwargs?: { content?: unknown };
        kwargs?: { content?: unknown };
      }
    ).lc_kwargs;

    if (typeof lcKwargs?.content === 'string') {
      return lcKwargs.content;
    }

    const kwargs = (message as { kwargs?: { content?: unknown } }).kwargs;
    if (typeof kwargs?.content === 'string') {
      return kwargs.content;
    }

    return undefined;
  };

  describe('Connection', () => {
    it('should connect successfully with valid token', async () => {
      socket = createSocketConnection(TEST_USER_ID);
      await waitForSocketConnection(socket);

      expect(socket.connected).toBe(true);
    });

    it('should reject connection without token', async () => {
      socket = createSocketConnection('');

      await expect(waitForSocketConnection(socket)).rejects.toThrow();
    });
  });

  describe('Graph Subscription', () => {
    it('should subscribe to graph updates', { timeout: 90_000 }, async () => {
      socket = createSocketConnection(TEST_USER_ID);
      await waitForSocketConnection(socket);

      const graphId = baseGraphId;

      // Subscribe to graph
      socket.emit('subscribe_graph', { graphId });

      // Set up listener for graph update events
      const notificationPromise = new Promise((resolve, reject) => {
        socket.once('graph.update', (notification) => {
          expect(notification).toHaveProperty('graphId', graphId);
          expect(notification).toHaveProperty('type', 'graph.update');
          resolve(notification);
        });

        socket.once('server_error', (error) => reject(error));
        setTimeout(
          () => reject(new Error('Timeout waiting for notification')),
          60_000,
        );
      });

      // Trigger a graph action that will emit notifications
      await restartGraph(graphId);

      await notificationPromise;
    });

    it('should receive error when subscribing to non-existent graph', async () => {
      socket = createSocketConnection(TEST_USER_ID);
      await waitForSocketConnection(socket);

      const fakeGraphId = '00000000-0000-0000-0000-000000000000';

      const errorPromise = new Promise((resolve, reject) => {
        socket.once('server_error', (error) => {
          expect(error).toHaveProperty('message');
          expect(error.message).toContain('Graph not found');
          resolve(error);
        });

        setTimeout(() => reject(new Error('Timeout waiting for error')), 5000);
      });

      socket.emit('subscribe_graph', { graphId: fakeGraphId });

      await errorPromise;
    });

    it('should unsubscribe from graph updates', async () => {
      socket = createSocketConnection(TEST_USER_ID);
      await waitForSocketConnection(socket);

      const graphId = baseGraphId;

      // Subscribe
      socket.emit('subscribe_graph', { graphId });
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Unsubscribe
      socket.emit('unsubscribe_graph', { graphId });

      // Should not receive errors
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(socket.connected).toBe(true);
    });
  });

  describe('Message Notifications', () => {
    it(
      'should receive message notifications during graph execution',
      { timeout: 90_000 },
      async () => {
        socket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(socket);

        const graphId = baseGraphId;

        // Subscribe to graph
        socket.emit('subscribe_graph', { graphId });
        await new Promise((resolve) => setTimeout(resolve, 500));

        const receivedMessages: unknown[] = [];

        // Set up listener for message events
        const messagePromise = new Promise((resolve, reject) => {
          socket.on('agent.message', (notification) => {
            receivedMessages.push(notification);

            expect(notification).toHaveProperty('graphId', graphId);
            expect(notification).toHaveProperty('type', 'agent.message');
            expect(notification.data).toHaveProperty('message');
            expect(notification.data.message).toHaveProperty('content');
            expect(notification.data.message).toHaveProperty('role');

            // Once we have at least 2 messages (user + AI response), we're done
            if (receivedMessages.length >= 2) {
              resolve(receivedMessages);
            }
          });

          socket.once('server_error', (error) => reject(error));
        });

        // Run the graph
        await restartGraph(graphId);

        // Execute trigger
        await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Hello, this is a test message'],
            async: true,
            threadSubId: uniqueThreadSubId('socket-msg'),
          },
        );

        await messagePromise;

        // Verify we got expected messages (at least 2)
        expect(receivedMessages.length).toBeGreaterThanOrEqual(2);
        const typedMessages = receivedMessages as MessageNotification[];

        // Verify messages have expected structure
        typedMessages.forEach((msg) => {
          expect(msg.graphId).toBe(graphId);
          expect(msg.type).toBe('agent.message');
          expect(msg.data.message).toBeDefined();
          expect(msg.data.message.content).toBeDefined(); // Content can be empty string
          expect(['human', 'ai', 'tool', 'reasoning']).toContain(
            msg.data.message.role,
          );
        });
      },
    );

    it(
      'should not receive duplicate message notifications',
      { timeout: 60000 },
      async () => {
        socket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(socket);

        const graphId = baseGraphId;

        socket.emit('subscribe_graph', { graphId });

        const messageNotifications: unknown[] = [];

        socket.on('agent.message', (notification) => {
          messageNotifications.push(notification);
        });

        await restartGraph(graphId);

        await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Test message for duplicate check'],
            threadSubId: uniqueThreadSubId('socket-dup'),
          },
        );

        // Wait for messages to settle (at least user + AI message expected),
        // then a short grace period to catch any late duplicates.
        await waitForCondition(
          async () => messageNotifications,
          (notifs) => notifs.length >= 2,
          { timeout: 10_000, interval: 100 },
        );
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Check for duplicates by comparing message content and threadId
        const typedNotifications =
          messageNotifications as MessageNotification[];
        const messageKeys = typedNotifications.map(
          (n) =>
            `${n.threadId}:${n.data.message.role}:${n.data.message.content}`,
        );

        const uniqueKeys = new Set(messageKeys);

        // Assert no duplicates
        expect(messageKeys.length).toBe(uniqueKeys.size);
      },
    );

    it(
      'emits a single stop message notification when graph execution is stopped',
      { timeout: 60_000 },
      async () => {
        const graphId = commandGraphId;

        // Keep the agent's first LLM call in flight long enough for the thread
        // to reach Running state before we trigger destroy. Higher specificity
        // than the default `{ hasTools: ['finish'] }` fixture ensures this
        // matches first when the user message contains the trigger phrase.
        mockLlm.onChat(
          { lastUserMessage: 'Run this command', hasTools: ['finish'] },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: { purpose: 'done', message: 'OK', needsMoreInfo: false },
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              totalPrice: 0.0001,
            },
            delayMs: 10_000,
          },
        );

        // Spy on the notifications service so we can count stop messages
        // independently of the WebSocket transport (the agent's `stop()`
        // emits the system message synchronously before the graph node
        // listeners are unsubscribed; capturing it via spy avoids any
        // transport-layer races).
        const stopMessages: { threadId?: string; content: string }[] = [];
        const emitSpy = vi
          .spyOn(notificationsService, 'emit')
          .mockImplementation(async (event: Notification) => {
            if (
              event.type === NotificationEvent.AgentMessage &&
              event.graphId === graphId
            ) {
              const messages = (
                event as unknown as {
                  data?: { messages?: { content?: unknown }[] };
                }
              ).data?.messages;
              if (Array.isArray(messages)) {
                for (const m of messages) {
                  const content =
                    typeof m?.content === 'string' ? m.content : '';
                  if (
                    content.includes(
                      'Graph execution was stopped for agent Test Agent',
                    )
                  ) {
                    stopMessages.push({
                      threadId: (event as unknown as { threadId?: string })
                        .threadId,
                      content,
                    });
                  }
                }
              }
            }
            return undefined;
          });

        try {
          await restartGraph(graphId);

          const execution = await graphsService.executeTrigger(
            contextDataStorage,
            graphId,
            STOP_TRIGGER_NODE_ID,
            {
              messages: ['Run this command: sleep 100 && echo "interrupt me"'],
              async: true,
              threadSubId: uniqueThreadSubId('socket-stop'),
            },
          );

          await waitForCondition(
            () =>
              threadsService.getThreadByExternalId(
                contextDataStorage,
                execution.externalThreadId,
              ),
            (thread) => thread.status === ThreadStatus.Running,
            { timeout: 30_000, interval: 200 },
          );

          // Race guard: thread.status flips to Running after the agent emits
          // its `invoke` event but BEFORE `activeRuns` is populated (the agent
          // does build-graph + checkpoint-load between those two steps). Wait
          // for the registry's agent instance to actually have an active run
          // before destroying — otherwise `agent.stop()` iterates an empty
          // map and no stop message is emitted.
          await waitForCondition(
            () => {
              const node = graphRegistry.getNode<SimpleAgent>(
                graphId,
                STOP_AGENT_NODE_ID,
              );
              const ar = (
                node?.instance as unknown as {
                  activeRuns?: Map<string, unknown>;
                }
              )?.activeRuns;
              return Promise.resolve(ar?.size ?? 0);
            },
            (size) => size > 0,
            { timeout: 5_000, interval: 100 },
          );

          await graphsService.destroy(contextDataStorage, graphId);

          await waitForCondition(
            async () => stopMessages,
            (msgs) => msgs.length >= 1,
            { timeout: 5_000, interval: 100 },
          );

          // Allow any duplicate emits to surface
          await new Promise((resolve) => setTimeout(resolve, 500));

          const uniqueStopKeys = new Set(
            stopMessages.map((m) => `${m.threadId ?? ''}:${m.content}`),
          );

          expect(stopMessages).toHaveLength(1);
          expect(uniqueStopKeys.size).toBe(1);
          expect(stopMessages[0]?.content).toContain(
            'Graph execution was stopped for agent Test Agent',
          );
        } finally {
          emitSpy.mockRestore();
        }
      },
    );
  });

  describe('Graph Revision Notifications', () => {
    let revisionGraphId: string;
    let revisionBaseSchema: GraphSchemaType;
    let revisionCurrentVersion: string;

    beforeAll(async () => {
      const createResult = await graphsService.create(
        contextDataStorage,
        createMockGraphData({
          name: `Socket Revision Graph ${Date.now()}`,
        }),
      );
      revisionGraphId = createResult.id;
      revisionBaseSchema = createResult.schema;
      revisionCurrentVersion = createResult.version;
      createdGraphIds.push(revisionGraphId);
    }, 120_000);

    it(
      'should receive multiple revision notifications',
      { timeout: 120_000 },
      async () => {
        socket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(socket);

        const graphId = revisionGraphId;
        const baseSchema: GraphSchemaType = revisionBaseSchema;
        let currentVersion = revisionCurrentVersion;

        await restartGraph(graphId);

        socket.emit('subscribe_graph', { graphId });
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Track meaningful events: create and applied for each revision
        // Note: 'applying' is too transient to reliably test via socket notifications
        const requiredEvents = [
          'graph.revision.create',
          'graph.revision.applied',
          'graph.revision.create',
          'graph.revision.applied',
        ];

        const eventsPromise = new Promise((resolve, reject) => {
          const events: unknown[] = [];
          const eventTypes: string[] = [];

          const eventListeners = [
            'graph.revision.create',
            'graph.revision.applying',
            'graph.revision.applied',
          ];

          eventListeners.forEach((type) => {
            socket.on(type, (payload) => {
              if (payload.graphId === graphId) {
                events.push({ type, payload });
                eventTypes.push(type);

                // Check if we have all required events (ignoring transient 'applying')
                const requiredReceived = requiredEvents.every(
                  (required) =>
                    eventTypes.filter((t) => t === required).length >=
                    requiredEvents.filter((r) => r === required).length,
                );

                if (requiredReceived) {
                  resolve(events);
                }
              }
            });
          });

          socket.once('server_error', reject);
          setTimeout(
            () =>
              reject(
                new Error(
                  `Timeout waiting for revision events. Received: ${events.length}, Types: ${eventTypes.join(', ')}`,
                ),
              ),
            150_000,
          );
        });

        // First update
        const firstSchema: GraphSchemaType = {
          ...baseSchema,
          nodes: baseSchema.nodes.map((node: GraphNodeSchemaType) =>
            node.id === 'agent-1'
              ? {
                  ...node,
                  config: {
                    ...node.config,
                    instructions: 'First socket revision',
                  },
                }
              : node,
          ),
        };

        const _firstUpdateResult = await graphsService.update(
          contextDataStorage,
          graphId,
          {
            schema: firstSchema,
            currentVersion,
          },
        );

        // Wait for the first revision to be applied — poll the graph version
        // rather than sleeping for a fixed window.
        const updatedGraph = await waitForCondition(
          () => graphsService.findById(contextDataStorage, graphId),
          (g) => g.version !== currentVersion,
          { timeout: 30_000, interval: 200 },
        );
        currentVersion = updatedGraph.version;
        revisionCurrentVersion = updatedGraph.version;
        const secondSchema: GraphSchemaType = {
          ...baseSchema,
          nodes: baseSchema.nodes.map((node) =>
            node.id === 'agent-1'
              ? {
                  ...node,
                  config: {
                    ...node.config,
                    instructions: 'Second socket revision',
                  },
                }
              : node,
          ),
        };

        await graphsService.update(contextDataStorage, graphId, {
          schema: secondSchema,
          currentVersion,
        });

        await eventsPromise;
      },
    );
  });

  describe('Node Status Notifications', () => {
    it(
      'should receive node status updates during graph execution',
      { timeout: 90_000 },
      async () => {
        socket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(socket);

        const graphId = baseGraphId;

        socket.emit('subscribe_graph', { graphId });

        const nodeEvents: unknown[] = [];
        const statusesSeen = new Set<string>();

        const waitForNodeUpdates = new Promise<void>((resolve, reject) => {
          socket.on('graph.node.update', (notification) => {
            if (notification.graphId === graphId) {
              nodeEvents.push(notification);

              if (notification.data?.status) {
                statusesSeen.add(notification.data.status);
              }

              if (statusesSeen.has('running') && statusesSeen.has('idle')) {
                resolve();
              }
            }
          });

          socket.once('server_error', (error) => reject(error));
          setTimeout(() => {
            reject(
              new Error(
                `Timeout waiting for node update notifications. Received ${nodeEvents.length} events, statuses seen: ${[...statusesSeen].join(', ') || 'none'}`,
              ),
            );
          }, 60_000);
        });

        await restartGraph(graphId);

        await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Test message for node status'],
            async: true,
            threadSubId: uniqueThreadSubId('socket-node-status'),
          },
        );

        await waitForNodeUpdates;

        const typedNodeEvents = nodeEvents as NodeUpdateNotification[];
        const runningEvents = typedNodeEvents.filter(
          (e) => e.data.status === 'running',
        );
        const idleEvents = typedNodeEvents.filter(
          (e) => e.data.status === 'idle',
        );

        // Verify we got both state transitions
        expect(runningEvents.length).toBeGreaterThanOrEqual(1);
        expect(idleEvents.length).toBeGreaterThanOrEqual(1);

        // Verify event structure
        expect(runningEvents[0]!.type).toBe('graph.node.update');
        expect(runningEvents[0]!.graphId).toBeTruthy();
        expect(runningEvents[0]!.data.status).toBe('running');
      },
    );

    it(
      'should include pending message metadata in node update notifications',
      { timeout: 60000 },
      async () => {
        socket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(socket);

        const graphId = baseGraphId;

        socket.emit('subscribe_graph', { graphId });

        // Keep the first agent run in-flight long enough to enqueue a second
        // trigger as a pending message. Higher-specificity matcher wins over
        // the default catch-all finish reply.
        mockLlm.onChat(
          { lastUserMessage: 'Initial socket request', hasTools: ['finish'] },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: { purpose: 'done', message: 'OK', needsMoreInfo: false },
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              totalPrice: 0.0001,
            },
            delayMs: 10_000,
          },
        );

        await restartGraph(graphId);

        const threadSubId = uniqueThreadSubId('socket-pending-metadata');
        const firstExecution = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Initial socket request'],
            threadSubId,
            async: true,
          },
        );
        const threadId = firstExecution.externalThreadId;

        await waitForCondition(
          () =>
            graphsService.getCompiledNodes(contextDataStorage, graphId, {
              threadId,
            }),
          (snapshots) =>
            snapshots.some(
              (node) => node.id === 'agent-1' && node.status === 'running',
            ),
          { timeout: 30_000, interval: 200 },
        );

        const metadataNotificationPromise = new Promise<NodeUpdateNotification>(
          (resolve, reject) => {
            function handleMetadata(notification: NodeUpdateNotification) {
              const metadata = notification.data?.additionalNodeMetadata as
                | { pendingMessages?: unknown[] }
                | undefined;

              if (
                notification.graphId === graphId &&
                notification.nodeId === 'agent-1' &&
                Array.isArray(metadata?.pendingMessages) &&
                metadata.pendingMessages.length > 0
              ) {
                clearTimeout(timeout);
                socket.off('graph.node.update', handleMetadata);
                resolve(notification);
              }
            }

            const timeout = setTimeout(() => {
              socket.off('graph.node.update', handleMetadata);
              reject(new Error('Timeout waiting for metadata update'));
            }, 30000);

            socket.on('graph.node.update', handleMetadata);
          },
        );

        await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Follow-up to enqueue pending message'],
            threadSubId,
            async: true,
          },
        );

        const metadataNotification = await metadataNotificationPromise;
        const metadata = metadataNotification.data.additionalNodeMetadata as
          | { pendingMessages?: { content?: string }[] }
          | undefined;

        expect(metadata?.pendingMessages).toBeDefined();

        const pendingMessageContent = extractPendingMessageContent(
          metadata?.pendingMessages?.[0],
        );

        expect(pendingMessageContent).toBe(
          'Follow-up to enqueue pending message',
        );
      },
    );

    it(
      'should receive sequential notifications as pending messages are added and removed',
      { timeout: 90000 },
      async () => {
        const graphId = baseGraphId;

        // Keep the first agent run in-flight long enough to receive two
        // follow-up triggers as pending messages before the run completes.
        mockLlm.onChat(
          { lastUserMessage: 'Start task', hasTools: ['finish'] },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: { purpose: 'done', message: 'OK', needsMoreInfo: false },
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              totalPrice: 0.0001,
            },
            delayMs: 8_000,
          },
        );

        await restartGraph(graphId);

        const socket = createSocketConnection(TEST_USER_ID);
        await new Promise<void>((resolve) =>
          socket.once('connect', () => resolve()),
        );

        socket.emit('subscribe_graph', { graphId });

        const threadSubId = uniqueThreadSubId('sequential-pending-thread');
        const metadataUpdates: {
          pendingCount: number;
          timestamp: number;
        }[] = [];

        // Track all metadata updates
        socket.on(
          'graph.node.update',
          (notification: NodeUpdateNotification) => {
            const metadata = notification.data?.additionalNodeMetadata as
              | { pendingMessages?: unknown[] }
              | undefined;

            if (
              notification.graphId === graphId &&
              notification.nodeId === 'agent-1' &&
              Array.isArray(metadata?.pendingMessages)
            ) {
              metadataUpdates.push({
                pendingCount: metadata.pendingMessages.length,
                timestamp: Date.now(),
              });
            }
          },
        );

        // Start first execution
        const firstExecution = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Start task'],
            threadSubId,
            async: true,
          },
        );

        const threadId = firstExecution.externalThreadId;

        // Wait for running status
        await waitForCondition(
          () =>
            graphsService.getCompiledNodes(contextDataStorage, graphId, {
              threadId,
            }),
          (snapshots) =>
            snapshots.some(
              (node) =>
                node.id === 'agent-1' &&
                node.status === GraphNodeStatus.Running,
            ),
          { timeout: 30_000, interval: 200 },
        );

        // Send multiple follow-ups
        await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Follow-up 1'],
            threadSubId,
            async: true,
          },
        );

        // Wait for the first pending to register
        await waitForCondition(
          async () => metadataUpdates,
          (updates) => updates.some((u) => u.pendingCount > 0),
          { timeout: 5_000, interval: 100 },
        );

        await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Follow-up 2'],
            threadSubId,
            async: true,
          },
        );

        // Wait for execution to complete (pending messages cleared)
        await waitForCondition(
          () =>
            graphsService.getCompiledNodes(contextDataStorage, graphId, {
              threadId,
            }),
          (snapshots) =>
            snapshots.some(
              (node) =>
                node.id === 'agent-1' &&
                (node.status === GraphNodeStatus.Idle ||
                  node.status === GraphNodeStatus.Stopped),
            ),
          { timeout: 30_000, interval: 200 },
        );

        // Wait for the cleared-pending notification (rather than a fixed delay)
        await waitForCondition(
          async () => metadataUpdates,
          (updates) => updates.some((u) => u.pendingCount === 0),
          { timeout: 5_000, interval: 100 },
        );

        socket.disconnect();

        // Verify we received notifications with different pending counts
        expect(metadataUpdates.length).toBeGreaterThan(0);

        // Should have notifications with pending messages
        const withPending = metadataUpdates.filter((u) => u.pendingCount > 0);
        expect(withPending.length).toBeGreaterThan(0);

        // Should have notification(s) with cleared pending messages
        const withoutPending = metadataUpdates.filter(
          (u) => u.pendingCount === 0,
        );
        expect(withoutPending.length).toBeGreaterThan(0);

        // Verify chronological order (at least one increase followed by decrease)
        const hasClearingSequence = metadataUpdates.some((update, index) => {
          if (index === 0) {
            return false;
          }
          const prev = metadataUpdates[index - 1];
          if (!prev) {
            return false;
          }
          return prev.pendingCount > 0 && update.pendingCount === 0;
        });

        expect(hasClearingSequence).toBe(true);
      },
    );
  });

  describe('Reasoning Metadata Notifications', () => {
    it(
      'should emit reasoning metadata updates and clear them when reasoning state resets',
      { timeout: 90000 },
      async () => {
        const graphId = baseGraphId;

        // Keep the agent in an active run while we inject reasoning chunks
        // and verify state. Without this delay the agent finishes before the
        // chunks are processed and the run-finally clears reasoning state.
        mockLlm.onChat(
          {
            lastUserMessage: 'Start reasoning metadata test',
            hasTools: ['finish'],
          },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: { purpose: 'done', message: 'OK', needsMoreInfo: false },
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              totalPrice: 0.0001,
            },
            delayMs: 15_000,
          },
        );

        await restartGraph(graphId);

        const triggerResult = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Start reasoning metadata test'],
            threadSubId: uniqueThreadSubId('reasoning-metadata-thread'),
            async: true,
          },
        );

        const threadId = triggerResult.externalThreadId;
        expect(threadId).toBeDefined();

        const persistedThread = await waitForCondition(
          () =>
            threadsService
              .getThreadByExternalId(contextDataStorage, threadId)
              .catch(() => undefined),
          (thread): thread is ThreadDto => !!thread,
          { timeout: 60000, interval: 250 },
        );

        if (!persistedThread) {
          throw new Error('Thread was not persisted');
        }

        await waitForCondition(
          () =>
            graphsService.getCompiledNodes(contextDataStorage, graphId, {
              threadId,
            }),
          (snapshots) =>
            snapshots.some(
              (node) =>
                node.id === 'agent-1' &&
                node.status === GraphNodeStatus.Running,
            ),
          { timeout: 30_000, interval: 200 },
        );

        const agentNode = graphRegistry.getNode<SimpleAgent>(
          graphId,
          'agent-1',
        );
        if (!agentNode) {
          throw new Error('Agent node agent-1 not found');
        }

        const agentInstance = agentNode.instance;
        const agentInternals = agentInstance as unknown as {
          handleReasoningChunk?: (tid: string, chunk: AIMessageChunk) => void;
          clearReasoningState?: (tid: string) => void;
          graphThreadState?: GraphThreadState;
        };

        const graphThreadStateMaybe = await waitForCondition(
          () => Promise.resolve(agentInternals.graphThreadState),
          (state) => !!state,
          { timeout: 10000, interval: 100 },
        );
        const graphThreadState = graphThreadStateMaybe!;

        const handleReasoningChunk =
          agentInternals.handleReasoningChunk?.bind(agentInstance);

        if (!handleReasoningChunk) {
          throw new Error('handleReasoningChunk is not available on agent');
        }

        const reasoningChunk = {
          id: 'chunk-integration',
          content: '',
          contentBlocks: [
            {
              type: 'reasoning' as const,
              reasoning: 'integration reasoning step',
            },
          ],
          response_metadata: {},
        } as AIMessageChunk;

        const emitSpy = vi.spyOn(notificationsService, 'emit');
        let processedCallIndex = 0;
        const waitForNotification = async (
          predicate: (event: Notification) => boolean,
        ): Promise<Notification> => {
          const timeoutAt = Date.now() + 10000;
          while (Date.now() < timeoutAt) {
            for (
              let i = processedCallIndex;
              i < emitSpy.mock.calls.length;
              i++
            ) {
              const [event] = emitSpy.mock.calls[i] as [Notification];
              if (predicate(event)) {
                processedCallIndex = i + 1;
                return event;
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error('Timeout waiting for notification');
        };

        try {
          handleReasoningChunk(threadId, reasoningChunk);

          const reasoningNotification = await waitForNotification(
            (event) =>
              event.type === NotificationEvent.GraphNodeUpdate &&
              event.graphId === graphId &&
              event.nodeId === 'agent-1' &&
              !!(
                event.data as {
                  additionalNodeMetadata?: Record<string, { id: string }>;
                }
              )?.additionalNodeMetadata?.reasoningChunks,
          );

          const reasoningMetadata =
            (
              reasoningNotification.data as {
                additionalNodeMetadata?: {
                  reasoningChunks?: Record<
                    string,
                    { id: string; content: string }
                  >;
                };
              }
            )?.additionalNodeMetadata ?? {};

          const reasoningChunks =
            reasoningMetadata.reasoningChunks ??
            ({} as Record<string, { id: string; content: string }>);
          const reasoningEntry = reasoningChunks['reasoning:chunk-integration'];
          expect(reasoningEntry).toBeDefined();
          expect(reasoningEntry?.id).toBe('reasoning:chunk-integration');
          expect(reasoningEntry?.content).toBe('integration reasoning step');

          const stateEntry = graphThreadState
            .getByThread(threadId)
            .reasoningChunks.get('reasoning:chunk-integration');
          expect(stateEntry?.id).toBe('reasoning:chunk-integration');

          const clearReasoningState =
            agentInternals.clearReasoningState?.bind(agentInstance);

          if (!clearReasoningState) {
            throw new Error('clearReasoningState is not available on agent');
          }

          clearReasoningState(threadId);

          const clearedNotification = await waitForNotification((event) => {
            if (
              event.type !== NotificationEvent.GraphNodeUpdate ||
              event.graphId !== graphId ||
              event.nodeId !== 'agent-1'
            ) {
              return false;
            }

            const metadata = (
              event.data as {
                additionalNodeMetadata?: Record<string, { id: string }>;
              }
            )?.additionalNodeMetadata;

            return (
              !!metadata &&
              (!metadata.reasoningChunks ||
                Object.keys(metadata.reasoningChunks).length === 0)
            );
          });

          const clearedMetadata =
            (
              clearedNotification.data as {
                additionalNodeMetadata?: {
                  reasoningChunks?: Record<
                    string,
                    { id: string; content: string }
                  >;
                };
              }
            )?.additionalNodeMetadata ?? {};

          expect(clearedMetadata.reasoningChunks).toEqual({});

          const finalStateCount =
            graphThreadState.getByThread(threadId).reasoningChunks.size;
          expect(finalStateCount).toBe(0);

          const reasoningMsg = buildReasoningMessage(
            'integration reasoning step',
            'chunk-integration',
          );
          const reasoningMessageDto =
            messageTransformer.transformMessageToDto(reasoningMsg);

          await messagesDao.create({
            threadId: persistedThread.id,
            externalThreadId: threadId,
            nodeId: 'agent-1',
            message: reasoningMessageDto,
          });

          const storedMessages = await threadsService.getThreadMessages(
            contextDataStorage,
            persistedThread.id,
          );

          const storedReasoning = storedMessages.find(
            (msg) =>
              msg.message.role === 'reasoning' &&
              msg.message.id === 'reasoning:chunk-integration',
          ) as
            | (ThreadMessageDto & { message: ReasoningMessageDto })
            | undefined;

          expect(storedReasoning).toBeDefined();
          expect(storedReasoning?.message.id).toBe(
            'reasoning:chunk-integration',
          );
        } finally {
          emitSpy.mockRestore();
        }
      },
    );

    it(
      'should flush the previous chunk and keep only the new id in working state when chunk ids change',
      { timeout: 90000 },
      async () => {
        const graphId = baseGraphId;

        // Keep the agent run alive while we drive reasoning chunks. Otherwise
        // `activeRuns` may be cleared before the second chunk is processed,
        // and the id-change flush branch (which requires `activeRun`) would
        // be skipped.
        mockLlm.onChat(
          {
            lastUserMessage: 'Start reasoning id merge test',
            hasTools: ['finish'],
          },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: { purpose: 'done', message: 'OK', needsMoreInfo: false },
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              totalPrice: 0.0001,
            },
            delayMs: 15_000,
          },
        );

        await restartGraph(graphId);

        const triggerResult = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Start reasoning id merge test'],
            threadSubId: uniqueThreadSubId('reasoning-id-merge-thread'),
            async: true,
          },
        );

        const threadId = triggerResult.externalThreadId;
        expect(threadId).toBeDefined();

        await waitForCondition(
          () =>
            graphsService.getCompiledNodes(contextDataStorage, graphId, {
              threadId,
            }),
          (snapshots) =>
            snapshots.some(
              (node) =>
                node.id === 'agent-1' &&
                node.status === GraphNodeStatus.Running,
            ),
          { timeout: 30_000, interval: 200 },
        );

        const agentNode = graphRegistry.getNode<SimpleAgent>(
          graphId,
          'agent-1',
        );
        if (!agentNode) {
          throw new Error('Agent node agent-1 not found');
        }

        const agentInstance = agentNode.instance;
        const agentInternals = agentInstance as unknown as {
          handleReasoningChunk?: (tid: string, chunk: AIMessageChunk) => void;
          graphThreadState?: GraphThreadState;
        };

        const handleReasoningChunk =
          agentInternals.handleReasoningChunk?.bind(agentInstance);
        if (!handleReasoningChunk) {
          throw new Error('handleReasoningChunk is not available on agent');
        }

        const emitSpy = vi.spyOn(notificationsService, 'emit');
        let processedCallIndex = 0;
        const waitForNotification = async (
          predicate: (event: Notification) => boolean,
        ): Promise<Notification> => {
          const timeoutAt = Date.now() + 10_000;
          while (Date.now() < timeoutAt) {
            for (
              let i = processedCallIndex;
              i < emitSpy.mock.calls.length;
              i++
            ) {
              const [event] = emitSpy.mock.calls[i] as [Notification];
              if (predicate(event)) {
                processedCallIndex = i + 1;
                return event;
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error('Timeout waiting for notification');
        };

        const firstChunk = {
          id: 'run-first',
          content: '',
          contentBlocks: [
            {
              type: 'reasoning' as const,
              reasoning: 'first reasoning',
            },
          ],
          response_metadata: {},
        } as AIMessageChunk;

        const secondChunk = {
          id: 'run-second',
          content: '',
          contentBlocks: [
            {
              type: 'reasoning' as const,
              reasoning: 'second reasoning',
            },
          ],
          response_metadata: {},
        } as AIMessageChunk;

        try {
          handleReasoningChunk(threadId, firstChunk);
          await waitForNotification(
            (event) =>
              event.type === NotificationEvent.GraphNodeUpdate &&
              event.graphId === graphId &&
              event.nodeId === 'agent-1' &&
              !!(
                event.data as {
                  additionalNodeMetadata?: Record<string, { id: string }>;
                }
              )?.additionalNodeMetadata?.reasoningChunks,
          );

          handleReasoningChunk(threadId, secondChunk);
          const notification = await waitForNotification(
            (event) =>
              event.type === NotificationEvent.GraphNodeUpdate &&
              event.graphId === graphId &&
              event.nodeId === 'agent-1' &&
              !!(
                event.data as {
                  additionalNodeMetadata?: Record<string, { id: string }>;
                }
              )?.additionalNodeMetadata?.reasoningChunks,
          );

          const reasoningChunks =
            (
              notification.data as {
                additionalNodeMetadata?: {
                  reasoningChunks?: Record<
                    string,
                    { id: string; content: string }
                  >;
                };
              }
            )?.additionalNodeMetadata?.reasoningChunks ?? {};

          const keys = Object.keys(reasoningChunks);
          expect(keys).toHaveLength(1);
          expect(keys[0]).toBe('reasoning:run-second');
          expect(reasoningChunks['reasoning:run-second']?.id).toBe(
            'reasoning:run-second',
          );
          // Per commit 3cbcdc9f: when a new reasoning id arrives, the previous
          // chunks are flushed as their own persisted ChatMessages and the
          // working state holds only the new id's content (not a merged blob).
          expect(reasoningChunks['reasoning:run-second']?.content).toContain(
            'second reasoning',
          );
          expect(
            reasoningChunks['reasoning:run-second']?.content,
          ).not.toContain('first reasoning');

          const state = agentInternals.graphThreadState?.getByThread(threadId);
          expect(state?.reasoningChunks.size).toBe(1);
          expect(state?.reasoningChunks.get('reasoning:run-second')?.id).toBe(
            'reasoning:run-second',
          );
        } finally {
          emitSpy.mockRestore();
        }
      },
    );

    it(
      'should include toolCallId, interAgentCommunication, and sourceAgentNodeId in socket payload when agent runs inside a communication runnable',
      { timeout: 90000 },
      async () => {
        const graphId = baseGraphId;

        // Keep the agent run alive while we mutate runnableConfig and inject
        // a reasoning chunk; otherwise the run finishes before we can verify.
        mockLlm.onChat(
          {
            lastUserMessage: 'Start comm-context reasoning test',
            hasTools: ['finish'],
          },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: { purpose: 'done', message: 'OK', needsMoreInfo: false },
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              totalPrice: 0.0001,
            },
            delayMs: 15_000,
          },
        );

        await restartGraph(graphId);

        const triggerResult = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Start comm-context reasoning test'],
            threadSubId: uniqueThreadSubId('reasoning-comm-context-thread'),
            async: true,
          },
        );

        const threadId = triggerResult.externalThreadId;
        expect(threadId).toBeDefined();

        await waitForCondition(
          () =>
            graphsService.getCompiledNodes(contextDataStorage, graphId, {
              threadId,
            }),
          (snapshots) =>
            snapshots.some(
              (node) =>
                node.id === 'agent-1' &&
                node.status === GraphNodeStatus.Running,
            ),
          { timeout: 30_000, interval: 200 },
        );

        const agentNode = graphRegistry.getNode<SimpleAgent>(
          graphId,
          'agent-1',
        );
        if (!agentNode) {
          throw new Error('Agent node agent-1 not found');
        }

        const persistedThread = await waitForCondition(
          () =>
            threadsService
              .getThreadByExternalId(contextDataStorage, threadId)
              .catch(() => undefined),
          (thread): thread is ThreadDto => !!thread,
          { timeout: 60000, interval: 250 },
        );

        if (!persistedThread) {
          throw new Error('Thread was not persisted');
        }

        const agentInstance = agentNode.instance;
        const agentInternals = agentInstance as unknown as {
          handleReasoningChunk?: (tid: string, chunk: AIMessageChunk) => void;
          clearReasoningState?: (
            tid: string,
            options?: {
              persist?: boolean;
              config?: { configurable?: Record<string, unknown> };
            },
          ) => void;
          activeRuns?: Map<
            string,
            {
              threadId: string;
              runnableConfig: {
                configurable: Record<string, unknown>;
              };
            }
          >;
          graphThreadState?: GraphThreadState;
        };

        const graphThreadStateMaybe = await waitForCondition(
          () => Promise.resolve(agentInternals.graphThreadState),
          (state) => !!state,
          { timeout: 10000, interval: 100 },
        );

        if (!graphThreadStateMaybe) {
          throw new Error('graphThreadState not available on agent');
        }

        const handleReasoningChunk =
          agentInternals.handleReasoningChunk?.bind(agentInstance);

        if (!handleReasoningChunk) {
          throw new Error('handleReasoningChunk is not available on agent');
        }

        // Inject communication context into the existing active run for this thread
        // so handleReasoningChunk can read __toolCallId etc. from runnableConfig.configurable
        const existingRun = agentInternals.activeRuns
          ? Array.from(agentInternals.activeRuns.values()).find(
              (r) => r.threadId === threadId,
            )
          : undefined;

        if (!existingRun) {
          throw new Error('No active run found for thread — agent not running');
        }

        existingRun.runnableConfig.configurable.__toolCallId = 'tc-int-1';
        existingRun.runnableConfig.configurable.__interAgentCommunication = true;
        existingRun.runnableConfig.configurable.__sourceAgentNodeId =
          'source-node';

        const emitSpy = vi.spyOn(notificationsService, 'emit');
        let processedCallIndex = 0;
        const waitForNotification = async (
          predicate: (event: Notification) => boolean,
        ): Promise<Notification> => {
          const timeoutAt = Date.now() + 10_000;
          while (Date.now() < timeoutAt) {
            for (
              let i = processedCallIndex;
              i < emitSpy.mock.calls.length;
              i++
            ) {
              const [event] = emitSpy.mock.calls[i] as [Notification];
              if (predicate(event)) {
                processedCallIndex = i + 1;
                return event;
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error('Timeout waiting for notification');
        };

        try {
          const commReasoningChunk = {
            id: 'chunk-comm-context',
            content: '',
            contentBlocks: [
              {
                type: 'reasoning' as const,
                reasoning: 'comm-context reasoning step',
              },
            ],
            response_metadata: {},
          } as AIMessageChunk;

          handleReasoningChunk(threadId, commReasoningChunk);

          const reasoningNotification = await waitForNotification(
            (event) =>
              event.type === NotificationEvent.GraphNodeUpdate &&
              event.graphId === graphId &&
              event.nodeId === 'agent-1' &&
              !!(
                event.data as {
                  additionalNodeMetadata?: Record<string, unknown>;
                }
              )?.additionalNodeMetadata?.reasoningChunks,
          );

          const reasoningChunksPayload =
            (
              reasoningNotification.data as {
                additionalNodeMetadata?: {
                  reasoningChunks?: Record<
                    string,
                    {
                      id: string;
                      content: string;
                      toolCallId?: string;
                      interAgentCommunication?: boolean;
                      sourceAgentNodeId?: string;
                    }
                  >;
                };
              }
            )?.additionalNodeMetadata?.reasoningChunks ?? {};

          const commEntry =
            reasoningChunksPayload['reasoning:chunk-comm-context'];
          expect(commEntry).toBeDefined();
          expect(commEntry?.toolCallId).toBe('tc-int-1');
          expect(commEntry?.interAgentCommunication).toBe(true);
          expect(commEntry?.sourceAgentNodeId).toBe('source-node');

          // Verify that clearReasoningState with persist:true propagates
          // __toolCallId and __interAgentCommunication into the DB message's
          // additional_kwargs via updateMessagesListWithMetadata.
          const clearReasoningState =
            agentInternals.clearReasoningState?.bind(agentInstance);

          if (!clearReasoningState) {
            throw new Error('clearReasoningState is not available on agent');
          }

          clearReasoningState(threadId, {
            persist: true,
            config: {
              configurable: {
                thread_id: threadId,
                node_id: 'agent-1',
                graph_id: graphId,
                __toolCallId: 'tc-int-1',
                __interAgentCommunication: true,
                __sourceAgentNodeId: 'source-node',
              },
            },
          });

          // Poll for the persisted reasoning message rather than sleeping
          // for a fixed window. The message event needs to propagate through
          // the notification handler and reach the DB.
          const storedReasoning = await waitForCondition(
            async () => {
              const msgs = await threadsService.getThreadMessages(
                contextDataStorage,
                persistedThread.id,
              );
              return msgs.find(
                (msg) =>
                  msg.message.role === 'reasoning' &&
                  (msg.message.additionalKwargs as Record<string, unknown>)
                    ?.__toolCallId === 'tc-int-1',
              ) as
                | (ThreadMessageDto & { message: ReasoningMessageDto })
                | undefined;
            },
            (entry) => !!entry,
            { timeout: 5_000, interval: 100 },
          );

          expect(storedReasoning).toBeDefined();
          expect(
            (
              storedReasoning?.message.additionalKwargs as Record<
                string,
                unknown
              >
            )?.__toolCallId,
          ).toBe('tc-int-1');
          expect(
            (
              storedReasoning?.message.additionalKwargs as Record<
                string,
                unknown
              >
            )?.__interAgentCommunication,
          ).toBe(true);
        } finally {
          emitSpy.mockRestore();
        }
      },
    );
  });

  describe('Thread Notifications', () => {
    it(
      'should receive thread.create notification when thread is created',
      { timeout: 40000 },
      async () => {
        socket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(socket);

        const graphId = baseGraphId;

        const threadSubId = uniqueThreadSubId('socket-thread-create');

        const threadCreateEvents: ThreadCreateNotification[] = [];

        socket.on('thread.create', (notification: unknown) => {
          const typed = notification as ThreadCreateNotification;
          if (typed.graphId === graphId) {
            threadCreateEvents.push(typed);
          }
        });

        socket.emit('subscribe_graph', { graphId });
        await new Promise((resolve) => setTimeout(resolve, 500));

        await restartGraph(graphId);

        const execution = await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Test message for thread creation'],
            threadSubId,
          },
        );

        const createdThreadId = execution.externalThreadId;
        expect(createdThreadId).toBeDefined();
        expect(createdThreadId).toBe(`${graphId}:${threadSubId}`);

        await waitForCondition(
          async () =>
            threadCreateEvents.find((e) => e.threadId === createdThreadId),
          (event) => !!event,
          { timeout: 30_000, interval: 250 },
        );

        // Verify thread create events with proper typing
        expect(threadCreateEvents.length).toBeGreaterThanOrEqual(1);
        const typedEvent = threadCreateEvents.find(
          (e) => e.threadId === createdThreadId,
        );
        if (!typedEvent) {
          throw new Error(
            `Expected thread.create event for ${createdThreadId}`,
          );
        }
        expect(typedEvent.type).toBe('thread.create');
        expect(typedEvent.graphId).toBe(graphId);
        expect(typedEvent.threadId).toBe(createdThreadId);
      },
    );

    it(
      'should receive socket notifications for thread state updates',
      { timeout: 40000 },
      async () => {
        socket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(socket);

        const graphId = baseGraphId;

        // Listen for thread update events (name/status updates)
        const threadUpdateEvents: unknown[] = [];
        socket.on('thread.update', (data: unknown) => {
          threadUpdateEvents.push(data);
        });

        // Subscribe to graph updates BEFORE running the graph
        socket.emit('subscribe_graph', { graphId });

        // Small wait to ensure subscription is processed
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Set up promise to wait for thread name update notification
        const waitForThreadNameUpdate = new Promise((resolve, reject) => {
          const checkForThreadNameUpdate = () => {
            const nameUpdateEvent = (
              threadUpdateEvents as {
                data?: { name?: string | null };
                type?: string;
                graphId?: string;
              }[]
            ).find((event) => {
              const name = event.data?.name;
              return typeof name === 'string' && name.length > 0;
            });

            if (nameUpdateEvent) {
              expect(nameUpdateEvent.type).toBe('thread.update');
              expect(nameUpdateEvent.graphId).toBe(graphId);
              const name = nameUpdateEvent.data!.name as string;
              expect(name).toBeDefined();
              expect(name).not.toBe('');
              resolve(undefined);
            }
          };

          // Check periodically for title update
          const intervalId = setInterval(() => {
            checkForThreadNameUpdate();
          }, 1000);

          // Timeout after 30 seconds
          setTimeout(() => {
            clearInterval(intervalId);
            if (threadUpdateEvents.length === 0) {
              reject(
                new Error('Timeout: No thread update notifications received'),
              );
            } else {
              reject(
                new Error(
                  `Timeout: Received ${threadUpdateEvents.length} events but none with thread name`,
                ),
              );
            }
          }, 30000);
        });

        // Run the graph, then execute trigger, then wait for notification
        await restartGraph(graphId);

        // Execute trigger
        await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Test message for socket notifications'],
            threadSubId: uniqueThreadSubId('socket-test-thread'),
          },
        );

        // Wait for the thread name update notification
        await waitForThreadNameUpdate;

        // Verify we received expected thread updates
        expect(threadUpdateEvents.length).toBeGreaterThanOrEqual(1);
        const typedEvents = threadUpdateEvents as ThreadUpdateNotification[];
        const nameUpdateEvent = typedEvents.find(
          (e) => typeof (e.data as { name?: unknown }).name === 'string',
        );
        expect(nameUpdateEvent).toBeDefined();
        expect(
          String((nameUpdateEvent!.data as { name?: string }).name ?? ''),
        ).toBeTruthy();
        expect(nameUpdateEvent!.graphId).toBe(graphId);
      },
    );
  });

  describe('Thread Token Usage in Agent State Update Notifications', () => {
    it(
      'should receive agent.state.update notifications with token usage when messages are processed',
      { timeout: 90_000 },
      async () => {
        socket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(socket);

        const graphId = baseGraphId;

        socket.emit('subscribe_graph', { graphId });
        await new Promise((resolve) => setTimeout(resolve, 500));

        const stateUpdateNotifications: unknown[] = [];

        const stateUpdatePromise = new Promise((resolve, reject) => {
          socket.on('agent.state.update', (notification) => {
            // Only collect notifications with token usage
            if (
              notification.data?.totalTokens !== undefined &&
              notification.data.totalTokens > 0
            ) {
              stateUpdateNotifications.push(notification);

              // Once we receive at least one with token usage, we're done
              if (stateUpdateNotifications.length >= 1) {
                resolve(stateUpdateNotifications);
              }
            }
          });

          socket.once('server_error', (error) => reject(error));

          setTimeout(() => {
            reject(
              new Error(
                `Timeout: Expected agent.state.update notifications with token usage > 0. Received ${stateUpdateNotifications.length} matching notifications.`,
              ),
            );
          }, 60_000);
        });

        await restartGraph(graphId);

        await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Test message for token usage in agent state update'],
            threadSubId: uniqueThreadSubId('socket-token-usage'),
          },
        );

        await stateUpdatePromise;

        expect(stateUpdateNotifications.length).toBeGreaterThanOrEqual(1);

        // Verify structure includes token usage
        const typedNotifications =
          stateUpdateNotifications as AgentStateUpdateNotification[];
        typedNotifications.forEach((notification) => {
          expect(notification.graphId).toBe(graphId);
          expect(notification.type).toBe('agent.state.update');
          expect(notification.data.totalTokens).toBeGreaterThan(0);
          expect(typeof notification.data.totalTokens).toBe('number');
        });
      },
    );

    it(
      'should include all token usage fields in agent.state.update notifications',
      { timeout: 60_000 },
      async () => {
        socket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(socket);

        const graphId = baseGraphId;

        socket.emit('subscribe_graph', { graphId });
        await new Promise((resolve) => setTimeout(resolve, 500));

        const stateUpdatePromise = new Promise<AgentStateUpdateNotification>(
          (resolve, reject) => {
            socket.on('agent.state.update', (notification) => {
              const typed = notification as AgentStateUpdateNotification;
              if (
                typed.graphId === graphId &&
                typed.data?.totalTokens &&
                typed.data.totalTokens > 0
              ) {
                resolve(typed);
              }
            });

            setTimeout(
              () =>
                reject(
                  new Error(
                    'Timeout waiting for agent.state.update with token usage',
                  ),
                ),
              45_000,
            );
          },
        );

        await restartGraph(graphId);

        await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Test message to generate token usage'],
            threadSubId: uniqueThreadSubId('socket-token-usage-fields'),
          },
        );

        const notification = await stateUpdatePromise;

        // Verify token usage fields are present
        expect(notification.data.totalTokens).toBeGreaterThan(0);
        expect(typeof notification.data.totalTokens).toBe('number');

        // Check that at least some token fields are present
        expect(
          notification.data.inputTokens !== undefined ||
            notification.data.outputTokens !== undefined,
        ).toBe(true);
      },
    );
  });

  describe('Multiple Clients', () => {
    it(
      'should allow multiple connections from the same user',
      { timeout: 15000 },
      async () => {
        socket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(socket);

        // Add delay before creating second connection to avoid race conditions
        await new Promise((resolve) => setTimeout(resolve, 100));

        const secondSocket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(secondSocket);

        expect(socket.connected).toBe(true);
        expect(secondSocket.connected).toBe(true);
        expect(socket.id).not.toBe(secondSocket.id);

        secondSocket.disconnect();
      },
    );

    it(
      'should broadcast to all user connections',
      { timeout: 30000 },
      async () => {
        socket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(socket);

        // Add delay before creating second connection to avoid race conditions
        await new Promise((resolve) => setTimeout(resolve, 100));

        const secondSocket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(secondSocket);

        const graphId = baseGraphId;

        // Set up listeners on both sockets
        const firstSocketEvent = new Promise((resolve, reject) => {
          socket.once('graph.update', (notification) => {
            expect(notification).toHaveProperty('graphId', graphId);
            resolve(notification);
          });
          setTimeout(() => reject(new Error('First socket timeout')), 10000);
        });

        const secondSocketEvent = new Promise((resolve, reject) => {
          secondSocket.once('graph.update', (notification) => {
            expect(notification).toHaveProperty('graphId', graphId);
            resolve(notification);
          });
          setTimeout(() => reject(new Error('Second socket timeout')), 10000);
        });

        // Subscribe both sockets and wait for server to process
        socket.emit('subscribe_graph', { graphId });
        secondSocket.emit('subscribe_graph', { graphId });
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Trigger notification
        await restartGraph(graphId);

        // Both sockets should receive the notification
        const events = await Promise.all([firstSocketEvent, secondSocketEvent]);
        expect(events.length).toBe(2);
        expect((events[0] as { graphId: string }).graphId).toBe(
          (events[1] as { graphId: string }).graphId,
        );

        secondSocket.disconnect();
      },
    );

    it(
      'should not receive duplicate notifications with multiple socket connections',
      { timeout: 30000 },
      async () => {
        socket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(socket);

        // Add delay before creating second connection to avoid race conditions
        await new Promise((resolve) => setTimeout(resolve, 100));

        const secondSocket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(secondSocket);

        const graphId = baseGraphId;

        const socket1Messages: { content: string; threadId: string }[] = [];
        const socket2Messages: { content: string; threadId: string }[] = [];

        // Set up message listeners on both sockets
        socket.on('agent.message', (notification) => {
          socket1Messages.push({
            content: notification.data.message.content,
            threadId: notification.threadId,
          });
        });

        secondSocket.on('agent.message', (notification) => {
          socket2Messages.push({
            content: notification.data.message.content,
            threadId: notification.threadId,
          });
        });

        // Subscribe both sockets to the graph
        socket.emit('subscribe_graph', { graphId });
        secondSocket.emit('subscribe_graph', { graphId });

        await new Promise((resolve) => setTimeout(resolve, 500));

        await restartGraph(graphId);

        await graphsService.executeTrigger(
          contextDataStorage,
          graphId,
          'trigger-1',
          {
            messages: ['Test message for multi-socket duplicate check'],
            threadSubId: uniqueThreadSubId('socket-multi-dup'),
          },
        );

        // Wait for messages to settle on both sockets
        await waitForCondition(
          async () => ({
            s1: socket1Messages.length,
            s2: socket2Messages.length,
          }),
          (counts) => counts.s1 >= 2 && counts.s2 >= 2,
          { timeout: 10_000, interval: 100 },
        );
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Both sockets should receive messages - expect at least user + assistant
        expect(socket1Messages.length).toBeGreaterThanOrEqual(2);
        expect(socket2Messages.length).toBeGreaterThanOrEqual(2);

        // Both sockets should receive the same messages (broadcast)
        expect(socket1Messages.length).toBe(socket2Messages.length);

        // Check for duplicates within each socket
        const socket1Keys = socket1Messages.map(
          (m) => `${m.threadId}:${m.content}`,
        );
        const socket2Keys = socket2Messages.map(
          (m) => `${m.threadId}:${m.content}`,
        );

        const socket1Unique = new Set(socket1Keys);
        const socket2Unique = new Set(socket2Keys);

        expect(socket1Keys.length).toBe(socket1Unique.size);
        expect(socket2Keys.length).toBe(socket2Unique.size);

        secondSocket.disconnect();
      },
    );
  });

  describe('Token and Cost Usage Accumulation', () => {
    it(
      'should accumulate token and cost usage across multiple invocations on the same thread',
      { timeout: 120_000 },
      async () => {
        await ensureGraphRunning(baseGraphId);

        socket = createSocketConnection(TEST_USER_ID);
        await waitForSocketConnection(socket);

        socket.emit('subscribe_graph', { graphId: baseGraphId });
        await new Promise((resolve) => setTimeout(resolve, 500));

        const agentStateNotifications: AgentStateUpdateNotification[] = [];
        socket.on('agent.state.update', (notification) => {
          const typed = notification as AgentStateUpdateNotification;
          if (
            typed.data?.totalTokens !== undefined &&
            typed.data.totalTokens > 0 &&
            typed.data.totalPrice !== undefined
          ) {
            agentStateNotifications.push(typed);
          }
        });

        const threadSubId = uniqueThreadSubId('token-cost-test');

        // ========== FIRST INVOCATION ==========
        const firstExecution = await graphsService.executeTrigger(
          contextDataStorage,
          baseGraphId,
          'trigger-1',
          {
            messages: [
              'Please tell me about artificial intelligence and machine learning.',
            ],
            threadSubId,
            async: true,
          },
        );
        const externalThreadId = firstExecution.externalThreadId;

        // Wait for first invocation to emit token/cost state updates
        await waitForCondition(
          async () => agentStateNotifications,
          (notifs) =>
            notifs.some(
              (n) =>
                n.threadId === externalThreadId &&
                typeof n.data.totalTokens === 'number' &&
                n.data.totalTokens > 0 &&
                typeof n.data.totalPrice === 'number',
            ),
          { timeout: 30_000, interval: 200 },
        );

        // Wait for thread to complete
        await waitForCondition(
          () =>
            threadsService
              .getThreadByExternalId(contextDataStorage, externalThreadId)
              .catch(() => undefined),
          (thread) =>
            !!thread &&
            (thread.status === ThreadStatus.Done ||
              thread.status === ThreadStatus.Stopped),
          { timeout: 30_000, interval: 200 },
        );

        // Allow final state updates to arrive
        await new Promise((resolve) => setTimeout(resolve, 300));

        const firstThreadNotifications = agentStateNotifications.filter(
          (n) => n.threadId === externalThreadId,
        );
        const firstMaxTotalTokens = Math.max(
          ...firstThreadNotifications.map((n) => n.data.totalTokens ?? 0),
        );
        const firstMaxTotalPrice = Math.max(
          ...firstThreadNotifications.map((n) => n.data.totalPrice ?? 0),
        );

        expect(firstMaxTotalTokens).toBeGreaterThan(0);
        expect(firstMaxTotalPrice).toBeGreaterThan(0);

        // Clear notifications for second invocation
        agentStateNotifications.length = 0;

        // ========== SECOND INVOCATION (Same Thread) ==========
        await graphsService.executeTrigger(
          contextDataStorage,
          baseGraphId,
          'trigger-1',
          {
            messages: ['hi'],
            threadSubId,
            async: true,
          },
        );

        // Wait for second invocation to have notifications
        await waitForCondition(
          async () => agentStateNotifications,
          (notifs) =>
            notifs.some(
              (n) =>
                n.threadId === externalThreadId &&
                typeof n.data.totalTokens === 'number' &&
                n.data.totalTokens > 0 &&
                typeof n.data.totalPrice === 'number',
            ),
          { timeout: 20_000, interval: 200 },
        );

        // Wait for thread to complete second invocation BEFORE collecting final notification values
        await waitForCondition(
          () =>
            threadsService
              .getThreadByExternalId(contextDataStorage, externalThreadId)
              .catch(() => undefined),
          (thread) =>
            !!thread &&
            (thread.status === ThreadStatus.Done ||
              thread.status === ThreadStatus.Stopped),
          { timeout: 20_000, interval: 200 },
        );

        // Get max values from second invocation notifications (after thread is done)
        await new Promise((resolve) => setTimeout(resolve, 300));
        const secondThreadNotifications = agentStateNotifications.filter(
          (n) => n.threadId === externalThreadId,
        );
        const secondMaxTotalTokens = Math.max(
          ...secondThreadNotifications.map((n) => n.data.totalTokens ?? 0),
        );
        const secondMaxTotalPrice = Math.max(
          ...secondThreadNotifications.map((n) => n.data.totalPrice ?? 0),
        );

        // Second invocation should accumulate totals on the same thread
        expect(secondMaxTotalTokens).toBeGreaterThan(firstMaxTotalTokens);
        expect(secondMaxTotalPrice).toBeGreaterThan(firstMaxTotalPrice);
      },
    );
  });
});
