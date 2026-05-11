import { HumanMessage } from '@langchain/core/messages';
import { Test, TestingModule } from '@nestjs/testing';
import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphDao } from '../../../graphs/dao/graph.dao';
import { GraphEntity } from '../../../graphs/entity/graph.entity';
import { GraphStatus } from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import { LlmModelsService } from '../../../litellm/services/llm-models.service';
import {
  IAgentInvokeNotification,
  NotificationEvent,
} from '../../../notifications/notifications.types';
import { NotificationsService } from '../../../notifications/services/notifications.service';
import { ProjectsDao } from '../../../projects/dao/projects.dao';
import { ThreadEntity } from '../../../threads/entity/thread.entity';
import { ThreadNameGeneratorService } from '../../../threads/services/thread-name-generator.service';
import { ThreadsService } from '../../../threads/services/threads.service';
import { ThreadStatus } from '../../../threads/threads.types';
import { AgentInvokeNotificationHandler } from './agent-invoke-notification-handler';

describe('AgentInvokeNotificationHandler', () => {
  let handler: AgentInvokeNotificationHandler;
  let graphDao: GraphDao;
  let notificationsService: NotificationsService;
  let threadsServiceMock: {
    prepareThreadResponse: ReturnType<typeof vi.fn>;
    upsertRunningThread: ReturnType<typeof vi.fn>;
  };
  let threadNameGenerator: {
    generateFromFirstUserMessage: ReturnType<typeof vi.fn>;
  };
  let logger: { error: ReturnType<typeof vi.fn> };

  const mockUserId = 'user-123';
  const mockGraphId = 'graph-456';
  const mockProjectId = 'project-abc';
  const mockNodeId = 'node-789';
  const mockThreadId = 'thread-abc';
  const mockParentThreadId = 'parent-thread-def';

  const createMockGraphEntity = (
    overrides: Partial<GraphEntity> = {},
  ): GraphEntity => ({
    id: mockGraphId,
    name: 'Test Graph',
    description: 'A test graph',
    version: '1.0.0',
    targetVersion: '1.0.0',
    schema: {
      nodes: [],
      edges: [],
    },
    settings: {},
    status: GraphStatus.Running,
    createdBy: mockUserId,
    projectId: mockProjectId,
    temporary: false,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  });

  const createMockThreadEntity = (
    overrides: Partial<ThreadEntity> = {},
  ): ThreadEntity => ({
    id: 'thread-internal-123',
    graphId: mockGraphId,
    createdBy: mockUserId,
    projectId: mockProjectId,
    externalThreadId: mockThreadId,
    metadata: {},
    lastRunId: undefined,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    deletedAt: null,
    status: ThreadStatus.Running,
    runningStartedAt: null,
    totalRunningMs: 0,
    ...overrides,
  });

  const createMockNotification = (
    overrides: Partial<IAgentInvokeNotification> = {},
  ): IAgentInvokeNotification => ({
    type: NotificationEvent.AgentInvoke,
    graphId: mockGraphId,
    nodeId: mockNodeId,
    threadId: mockThreadId,
    parentThreadId: 'parent-thread-123',
    runId: undefined,
    data: {
      messages: [new HumanMessage('Test message')],
    },
    ...overrides,
  });

  const buildThreadResponseDto = (thread: ThreadEntity) => ({
    id: thread.id,
    graphId: thread.graphId,
    externalThreadId: thread.externalThreadId,
    lastRunId: thread.lastRunId ?? null,
    status: thread.status,
    name: thread.name ?? null,
    source: thread.source ?? null,
    metadata: thread.metadata ?? {},
    createdAt: new Date(thread.createdAt).toISOString(),
    updatedAt: new Date(thread.updatedAt).toISOString(),
  });

  beforeEach(async () => {
    threadsServiceMock = {
      prepareThreadResponse: vi.fn(async (thread: ThreadEntity) =>
        buildThreadResponseDto(thread),
      ),
      upsertRunningThread: vi.fn(),
    };

    threadNameGenerator = {
      generateFromFirstUserMessage: vi.fn().mockResolvedValue(undefined),
    };

    logger = {
      error: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentInvokeNotificationHandler,
        {
          provide: GraphDao,
          useValue: {
            getOne: vi.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            emit: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ThreadsService,
          useValue: threadsServiceMock,
        },
        {
          provide: ThreadNameGeneratorService,
          useValue: threadNameGenerator,
        },
        {
          provide: LlmModelsService,
          useValue: {
            buildLLMRequestContext: vi
              .fn()
              .mockResolvedValue({ models: undefined }),
          },
        },
        {
          provide: ProjectsDao,
          useValue: {
            getOne: vi.fn().mockResolvedValue(null),
          },
        },
        {
          provide: DefaultLogger,
          useValue: logger,
        },
        {
          provide: GraphRegistry,
          useValue: {
            get: vi.fn().mockReturnValue({
              metadata: {
                graphId: mockGraphId,
                version: '1.0.0',
                graph_created_by: mockUserId,
                graph_project_id: mockProjectId,
                llmRequestContext: { models: undefined },
              },
            }),
          },
        },
      ],
    }).compile();

    handler = module.get<AgentInvokeNotificationHandler>(
      AgentInvokeNotificationHandler,
    );
    graphDao = module.get<GraphDao>(GraphDao);
    notificationsService =
      module.get<NotificationsService>(NotificationsService);
  });

  describe('handle', () => {
    it('emits ThreadCreate when the upserted thread has no name', async () => {
      const mockGraph = createMockGraphEntity();
      const notification = createMockNotification({
        runId: '11111111-1111-4111-8aaa-111111111111',
      });
      const upsertedThread = createMockThreadEntity({
        externalThreadId: 'parent-thread-123',
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(upsertedThread);

      const result = await handler.handle(notification);

      expect(graphDao.getOne).toHaveBeenCalledWith({ id: mockGraphId });
      expect(threadsServiceMock.upsertRunningThread).toHaveBeenCalledOnce();
      expect(threadsServiceMock.upsertRunningThread).toHaveBeenCalledWith(
        expect.objectContaining({
          graphId: mockGraphId,
          createdBy: mockUserId,
          projectId: mockProjectId,
          externalThreadId: 'parent-thread-123',
          status: ThreadStatus.Running,
          lastRunId: '11111111-1111-4111-8aaa-111111111111',
          totalRunningMs: 0,
        }),
      );
      expect(notificationsService.emit).toHaveBeenCalledWith({
        type: NotificationEvent.ThreadCreate,
        graphId: mockGraphId,
        projectId: mockProjectId,
        threadId: 'parent-thread-123',
        internalThreadId: upsertedThread.id,
        data: upsertedThread,
      });
      expect(result).toEqual([]);
    });

    it('generates and emits a thread name for root-thread executions (async, non-blocking)', async () => {
      const mockGraph = createMockGraphEntity();
      const upsertedThread = createMockThreadEntity({
        externalThreadId: 'parent-thread-123',
      });

      const notification = createMockNotification({
        threadId: 'parent-thread-123',
        parentThreadId: 'parent-thread-123',
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(upsertedThread);
      threadNameGenerator.generateFromFirstUserMessage.mockResolvedValue(
        'Thread Name',
      );

      await handler.handle(notification);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(notificationsService.emit).toHaveBeenCalledWith({
        type: NotificationEvent.ThreadCreate,
        graphId: mockGraphId,
        projectId: mockProjectId,
        threadId: 'parent-thread-123',
        internalThreadId: upsertedThread.id,
        data: upsertedThread,
      });

      expect(notificationsService.emit).toHaveBeenCalledWith({
        type: NotificationEvent.ThreadUpdate,
        graphId: mockGraphId,
        nodeId: mockNodeId,
        threadId: 'parent-thread-123',
        parentThreadId: 'parent-thread-123',
        data: { name: 'Thread Name' },
      });
    });

    it('uses parentThreadId as the externalThreadId key when provided', async () => {
      const mockGraph = createMockGraphEntity();
      const notification = createMockNotification({
        parentThreadId: mockParentThreadId,
        runId: '22222222-2222-4222-8aaa-222222222222',
      });
      const upsertedThread = createMockThreadEntity({
        externalThreadId: mockParentThreadId,
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(upsertedThread);

      await handler.handle(notification);

      expect(threadsServiceMock.upsertRunningThread).toHaveBeenCalledWith(
        expect.objectContaining({
          graphId: mockGraphId,
          createdBy: mockUserId,
          projectId: mockProjectId,
          externalThreadId: mockParentThreadId,
          status: ThreadStatus.Running,
          lastRunId: '22222222-2222-4222-8aaa-222222222222',
          totalRunningMs: 0,
        }),
      );
      expect(notificationsService.emit).toHaveBeenCalledWith({
        type: NotificationEvent.ThreadCreate,
        graphId: mockGraphId,
        projectId: mockProjectId,
        threadId: mockParentThreadId,
        internalThreadId: upsertedThread.id,
        data: upsertedThread,
      });
    });

    it('emits ThreadUpdate when the upserted thread already has a name', async () => {
      const mockGraph = createMockGraphEntity();
      const existingThread = createMockThreadEntity({
        name: 'Existing Thread Name',
        externalThreadId: 'parent-thread-123',
        status: ThreadStatus.Running,
        runningStartedAt: new Date('2024-01-01T10:00:00Z'),
        totalRunningMs: 5000,
      });
      const notification = createMockNotification({
        runId: '33333333-3333-4333-8aaa-333333333333',
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(existingThread);

      const expectedThreadDto = buildThreadResponseDto(existingThread);

      await handler.handle(notification);

      expect(threadsServiceMock.prepareThreadResponse).toHaveBeenCalledWith(
        existingThread,
      );
      expect(notificationsService.emit).toHaveBeenCalledWith({
        type: NotificationEvent.ThreadUpdate,
        graphId: mockGraphId,
        projectId: mockProjectId,
        threadId: 'parent-thread-123',
        parentThreadId: 'parent-thread-123',
        data: expectedThreadDto,
      });
    });

    it('emits a second ThreadUpdate clearing stop fields when the upserted thread had cost-limit stop state', async () => {
      const mockGraph = createMockGraphEntity();
      const existingThread = createMockThreadEntity({
        name: 'Existing Thread Name',
        externalThreadId: 'parent-thread-123',
        metadata: {
          stopReason: 'cost_limit',
          stopCostUsd: 0.3,
          costLimitHit: true,
        },
      });
      const notification = createMockNotification({
        runId: '55555555-5555-4555-8aaa-555555555555',
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(existingThread);

      const expectedThreadDto = buildThreadResponseDto(existingThread);

      await handler.handle(notification);

      expect(notificationsService.emit).toHaveBeenCalledTimes(2);
      expect(notificationsService.emit).toHaveBeenNthCalledWith(1, {
        type: NotificationEvent.ThreadUpdate,
        graphId: mockGraphId,
        projectId: mockProjectId,
        threadId: 'parent-thread-123',
        parentThreadId: 'parent-thread-123',
        data: expectedThreadDto,
      });
      expect(notificationsService.emit).toHaveBeenNthCalledWith(2, {
        type: NotificationEvent.ThreadUpdate,
        graphId: mockGraphId,
        projectId: mockProjectId,
        threadId: 'parent-thread-123',
        parentThreadId: 'parent-thread-123',
        data: { stopReason: null, stopCostUsd: null, costLimitHit: null },
      });
    });

    it('does NOT emit a second ThreadUpdate when stopReason is user_stop (non-cost-limit)', async () => {
      const mockGraph = createMockGraphEntity();
      const existingThread = createMockThreadEntity({
        name: 'Existing Thread Name',
        externalThreadId: 'parent-thread-123',
        metadata: { stopReason: 'user_stop' },
      });
      const notification = createMockNotification({
        runId: '77777777-7777-4777-8aaa-777777777777',
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(existingThread);

      await handler.handle(notification);

      expect(notificationsService.emit).toHaveBeenCalledTimes(1);
    });

    it('does NOT emit a second ThreadUpdate when the upserted thread has no stop state in metadata', async () => {
      const mockGraph = createMockGraphEntity();
      const existingThread = createMockThreadEntity({
        name: 'Existing Thread Name',
        externalThreadId: 'parent-thread-123',
        metadata: {},
      });
      const notification = createMockNotification({
        runId: '66666666-6666-4666-8aaa-666666666666',
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(existingThread);

      await handler.handle(notification);

      expect(notificationsService.emit).toHaveBeenCalledTimes(1);
    });

    it('skips upsert when the graph is not found', async () => {
      const notification = createMockNotification();

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(null);

      const result = await handler.handle(notification);

      expect(graphDao.getOne).toHaveBeenCalledWith({ id: mockGraphId });
      expect(threadsServiceMock.upsertRunningThread).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('passes the source field through to the upsert payload', async () => {
      const mockGraph = createMockGraphEntity();
      const source = 'manual-trigger (trigger)';
      const notification = createMockNotification({ source });
      const upsertedThread = createMockThreadEntity({
        externalThreadId: 'parent-thread-123',
        source,
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(upsertedThread);

      await handler.handle(notification);

      expect(threadsServiceMock.upsertRunningThread).toHaveBeenCalledWith(
        expect.objectContaining({
          source,
          status: ThreadStatus.Running,
          totalRunningMs: 0,
        }),
      );
    });

    it('passes notification metadata through to the upsert payload', async () => {
      const mockGraph = createMockGraphEntity();
      const threadMetadata = { env: 'production', version: 2 };
      const notification = createMockNotification({ threadMetadata });
      const upsertedThread = createMockThreadEntity({
        metadata: threadMetadata,
        externalThreadId: 'parent-thread-123',
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(upsertedThread);

      await handler.handle(notification);

      expect(threadsServiceMock.upsertRunningThread).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: threadMetadata,
          status: ThreadStatus.Running,
          totalRunningMs: 0,
        }),
      );
    });

    it('omits metadata from the upsert payload when not provided', async () => {
      const mockGraph = createMockGraphEntity();
      const notification = createMockNotification();
      const upsertedThread = createMockThreadEntity({
        externalThreadId: 'parent-thread-123',
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(upsertedThread);

      await handler.handle(notification);

      const call = threadsServiceMock.upsertRunningThread.mock.calls[0]![0]!;
      expect(call).not.toHaveProperty('metadata');
    });

    it('does NOT generate a thread name when the upserted thread already has one', async () => {
      const mockGraph = createMockGraphEntity();
      const existingThread = createMockThreadEntity({
        name: 'Existing Thread Name',
        externalThreadId: mockThreadId,
        status: ThreadStatus.Running,
        runningStartedAt: new Date('2024-01-01T10:00:00Z'),
        totalRunningMs: 5000,
      });
      const notification = createMockNotification({
        threadId: mockThreadId,
        parentThreadId: mockThreadId,
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(existingThread);

      await handler.handle(notification);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        threadNameGenerator.generateFromFirstUserMessage,
      ).not.toHaveBeenCalled();
    });

    it('does NOT generate a thread name for non-root executions', async () => {
      const mockGraph = createMockGraphEntity();
      const notification = createMockNotification({
        threadId: 'child-thread-abc',
        parentThreadId: mockParentThreadId,
      });
      const upsertedThread = createMockThreadEntity({
        externalThreadId: mockParentThreadId,
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(upsertedThread);

      await handler.handle(notification);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        threadNameGenerator.generateFromFirstUserMessage,
      ).not.toHaveBeenCalled();
    });

    it('extracts text from multimodal content arrays and passes it to generateFromFirstUserMessage', async () => {
      const mockGraph = createMockGraphEntity();
      const upsertedThread = createMockThreadEntity({
        externalThreadId: mockThreadId,
      });
      const notification = createMockNotification({
        threadId: mockThreadId,
        parentThreadId: mockThreadId,
        data: {
          messages: [
            new HumanMessage({
              content: [{ type: 'text', text: 'Hello world' }],
            }),
          ],
        },
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(upsertedThread);
      threadNameGenerator.generateFromFirstUserMessage.mockResolvedValue(
        'Hello world',
      );

      await handler.handle(notification);
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        threadNameGenerator.generateFromFirstUserMessage,
      ).toHaveBeenCalledWith('Hello world', undefined);
    });

    it('passes plain-string content unchanged to generateFromFirstUserMessage', async () => {
      const mockGraph = createMockGraphEntity();
      const upsertedThread = createMockThreadEntity({
        externalThreadId: mockThreadId,
      });
      const notification = createMockNotification({
        threadId: mockThreadId,
        parentThreadId: mockThreadId,
        data: {
          messages: [new HumanMessage('Hello world')],
        },
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(upsertedThread);
      threadNameGenerator.generateFromFirstUserMessage.mockResolvedValue(
        'Hello world',
      );

      await handler.handle(notification);
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        threadNameGenerator.generateFromFirstUserMessage,
      ).toHaveBeenCalledWith('Hello world', undefined);
    });

    it('does not call generateFromFirstUserMessage when the structured content array is empty', async () => {
      const mockGraph = createMockGraphEntity();
      const upsertedThread = createMockThreadEntity({
        externalThreadId: mockThreadId,
      });
      const notification = createMockNotification({
        threadId: mockThreadId,
        parentThreadId: mockThreadId,
        data: {
          messages: [new HumanMessage({ content: [] })],
        },
      });

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(upsertedThread);

      await handler.handle(notification);
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        threadNameGenerator.generateFromFirstUserMessage,
      ).not.toHaveBeenCalled();
    });

    // Timer-payload contract: handler always passes runningStartedAt=now and
    // totalRunningMs=0. The "preserve existing on Running→Running" / "reset on
    // resume" semantic is encoded in ThreadsService.upsertRunningThread and
    // verified by the integration test for upsert-by-external-thread-id.
    it('always passes runningStartedAt=now and totalRunningMs=0 to the upsert', async () => {
      const mockGraph = createMockGraphEntity();
      const upsertedThread = createMockThreadEntity({
        externalThreadId: 'parent-thread-123',
      });
      const notification = createMockNotification();

      vi.spyOn(graphDao, 'getOne').mockResolvedValue(mockGraph);
      threadsServiceMock.upsertRunningThread.mockResolvedValue(upsertedThread);

      const before = new Date();
      await handler.handle(notification);
      const after = new Date();

      const call = threadsServiceMock.upsertRunningThread.mock.calls[0]![0]!;

      expect(call.status).toBe(ThreadStatus.Running);
      expect(call.totalRunningMs).toBe(0);
      expect(call.runningStartedAt).toBeInstanceOf(Date);
      expect((call.runningStartedAt as Date).getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
      expect((call.runningStartedAt as Date).getTime()).toBeLessThanOrEqual(
        after.getTime(),
      );
    });
  });

  describe('pattern', () => {
    it('should have correct notification pattern', () => {
      expect(handler.pattern).toBe(NotificationEvent.AgentInvoke);
    });
  });
});
