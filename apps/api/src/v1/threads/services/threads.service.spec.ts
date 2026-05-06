import { StreamableFile } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { CheckpointStateService } from '../../agents/services/checkpoint-state.service';
import { GraphDao } from '../../graphs/dao/graph.dao';
import { MessageRole } from '../../graphs/graphs.types';
import { GraphsService } from '../../graphs/services/graphs.service';
import { NotificationEvent } from '../../notifications/notifications.types';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { MessagesDao } from '../dao/messages.dao';
import { ThreadsDao } from '../dao/threads.dao';
import { GetMessagesQueryDto, GetThreadsQueryDto } from '../dto/threads.dto';
import { MessageEntity } from '../entity/message.entity';
import { ThreadEntity } from '../entity/thread.entity';
import { ThreadStatus } from '../threads.types';
import { ThreadResumeService } from './thread-resume.service';
import { ThreadsService } from './threads.service';

describe('ThreadsService', () => {
  let service: ThreadsService;
  let threadsDao: ThreadsDao;
  let messagesDao: MessagesDao;
  let notificationsService: NotificationsService;
  let checkpointStateService: CheckpointStateService;
  let graphDao: GraphDao;
  let graphsService: GraphsService;
  let threadResumeService: ThreadResumeService;

  const mockUserId = 'user-123';
  const mockGraphId = 'graph-456';
  const mockThreadId = 'thread-789';

  const mockCtx = {
    checkSub: vi.fn().mockReturnValue(mockUserId),
  } as unknown as AppContextStorage;

  const createMockThreadEntity = (
    overrides: Partial<ThreadEntity> = {},
  ): ThreadEntity =>
    ({
      id: mockThreadId,
      graphId: mockGraphId,
      createdBy: mockUserId,
      projectId: 'project-abc',
      externalThreadId: 'external-thread-123',
      metadata: { nodeId: 'node-1' },
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z'),
      deletedAt: null,
      status: ThreadStatus.Running,
      ...overrides,
    }) as unknown as ThreadEntity;

  const createMockMessageEntity = (
    overrides: Partial<MessageEntity> = {},
  ): MessageEntity => ({
    id: 'message-123',
    threadId: mockThreadId,
    externalThreadId: 'external-thread-123',
    nodeId: 'node-1',
    message: {
      role: MessageRole.Human,
      content: 'Test message',
    },
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  });

  const mockLogger = {
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadsService,
        {
          provide: DefaultLogger,
          useValue: mockLogger,
        },
        {
          provide: CheckpointStateService,
          useValue: {
            getThreadTokenUsage: vi.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ThreadsDao,
          useValue: {
            getAll: vi.fn(),
            getOne: vi.fn(),
            getById: vi.fn(),
            create: vi.fn(),
            updateById: vi.fn(),
            deleteById: vi.fn(),
          },
        },
        {
          provide: MessagesDao,
          useValue: {
            getAll: vi.fn(),
            getOne: vi.fn(),
            create: vi.fn(),
            hardDelete: vi.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            emit: vi.fn(),
          },
        },
        {
          provide: GraphsService,
          useValue: {
            stopThreadExecution: vi.fn(),
          },
        },
        {
          provide: GraphDao,
          useValue: {
            getAgentsByGraphIds: vi.fn().mockResolvedValue(new Map()),
            getSchemaAndMetadata: vi.fn().mockResolvedValue(new Map()),
            getAll: vi.fn().mockResolvedValue([]),
          },
        },
        {
          provide: ThreadResumeService,
          useValue: {
            resumeEarly: vi.fn(),
            cancelWait: vi.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ThreadsService>(ThreadsService);
    threadsDao = module.get<ThreadsDao>(ThreadsDao);
    messagesDao = module.get<MessagesDao>(MessagesDao);
    notificationsService =
      module.get<NotificationsService>(NotificationsService);
    checkpointStateService = module.get<CheckpointStateService>(
      CheckpointStateService,
    );
    graphDao = module.get<GraphDao>(GraphDao);
    graphsService = module.get<GraphsService>(GraphsService);
    threadResumeService = module.get<ThreadResumeService>(ThreadResumeService);
  });

  describe('getThreads', () => {
    it('should return threads for the authenticated user', async () => {
      const mockThreads = [
        createMockThreadEntity(),
        createMockThreadEntity({ id: 'thread-2' }),
      ];

      vi.spyOn(threadsDao, 'getAll').mockResolvedValue(mockThreads);

      const query: GetThreadsQueryDto = {
        graphId: mockGraphId,
        limit: 50,
        offset: 0,
      };

      const result = await service.getThreads(mockCtx, query);

      expect(mockCtx.checkSub).toHaveBeenCalled();
      expect(threadsDao.getAll).toHaveBeenCalledWith(
        {
          createdBy: mockUserId,
          graphId: mockGraphId,
        },
        { orderBy: { updatedAt: 'DESC' }, limit: 50, offset: 0 },
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: mockThreadId,
        graphId: mockGraphId,
        externalThreadId: 'external-thread-123',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        status: ThreadStatus.Running,
      });
    });

    it('should pass statuses filter to DAO when provided', async () => {
      const mockThreads = [
        createMockThreadEntity({ status: ThreadStatus.Done }),
      ];

      vi.spyOn(threadsDao, 'getAll').mockResolvedValue(mockThreads);

      const query: GetThreadsQueryDto = {
        graphId: mockGraphId,
        statuses: [ThreadStatus.Done],
        limit: 50,
        offset: 0,
      };

      await service.getThreads(mockCtx, query);

      expect(threadsDao.getAll).toHaveBeenCalledWith(
        {
          createdBy: mockUserId,
          graphId: mockGraphId,
          status: { $in: [ThreadStatus.Done] },
        },
        { orderBy: { updatedAt: 'DESC' }, limit: 50, offset: 0 },
      );
    });

    it('should return threads across all graphs when graphId is omitted', async () => {
      const mockThreads = [
        createMockThreadEntity(),
        createMockThreadEntity({ id: 'thread-2', graphId: 'graph-789' }),
      ];

      vi.spyOn(threadsDao, 'getAll').mockResolvedValue(mockThreads);

      const query: GetThreadsQueryDto = {
        limit: 25,
        offset: 5,
      };

      const result = await service.getThreads(mockCtx, query);

      expect(mockCtx.checkSub).toHaveBeenCalled();
      expect(threadsDao.getAll).toHaveBeenCalledWith(
        {
          createdBy: mockUserId,
        },
        { orderBy: { updatedAt: 'DESC' }, limit: 25, offset: 5 },
      );
      expect(result).toHaveLength(2);
    });

    it('should include agents when getAgentsByGraphIds returns populated map', async () => {
      const mockThreads = [createMockThreadEntity()];
      vi.spyOn(threadsDao, 'getAll').mockResolvedValue(mockThreads);

      const expectedAgents = [
        { nodeId: 'agent-1', name: 'Test Agent', description: 'A test agent' },
      ];
      vi.mocked(graphDao.getAgentsByGraphIds).mockResolvedValue(
        new Map([[mockGraphId, expectedAgents]]),
      );

      const query: GetThreadsQueryDto = {
        graphId: mockGraphId,
        limit: 50,
        offset: 0,
      };

      const result = await service.getThreads(mockCtx, query);

      expect(result).toHaveLength(1);
      expect(result[0]!.agents).toEqual(expectedAgents);
    });

    it('should set agents to null when graph has no entry in agents map', async () => {
      const mockThreads = [createMockThreadEntity()];
      vi.spyOn(threadsDao, 'getAll').mockResolvedValue(mockThreads);

      vi.mocked(graphDao.getAgentsByGraphIds).mockResolvedValue(new Map());

      const query: GetThreadsQueryDto = {
        graphId: mockGraphId,
        limit: 50,
        offset: 0,
      };

      const result = await service.getThreads(mockCtx, query);

      expect(result).toHaveLength(1);
      expect(result[0]!.agents).toBeNull();
    });
  });

  describe('getThreadById', () => {
    it('should return a specific thread by ID', async () => {
      const mockThread = createMockThreadEntity();

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);

      const result = await service.getThreadById(mockCtx, mockThreadId);

      expect(mockCtx.checkSub).toHaveBeenCalled();
      expect(threadsDao.getOne).toHaveBeenCalledWith({
        id: mockThreadId,
        createdBy: mockUserId,
      });
      expect(result).toMatchObject({
        id: mockThreadId,
        graphId: mockGraphId,
        externalThreadId: 'external-thread-123',
        status: ThreadStatus.Running,
      });
    });

    it('should throw error if thread not found or belongs to different user', async () => {
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(null);

      await expect(
        service.getThreadById(mockCtx, mockThreadId),
      ).rejects.toThrow('[THREAD_NOT_FOUND] An exception has occurred');
    });
  });

  describe('getThreadByExternalId', () => {
    it('should return a thread by external ID', async () => {
      const mockThread = createMockThreadEntity();
      const externalThreadId = 'external-thread-123';

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);

      const result = await service.getThreadByExternalId(
        mockCtx,
        externalThreadId,
      );

      expect(mockCtx.checkSub).toHaveBeenCalled();
      expect(threadsDao.getOne).toHaveBeenCalledWith({
        externalThreadId,
        createdBy: mockUserId,
      });
      expect(result).toMatchObject({
        id: mockThreadId,
        graphId: mockGraphId,
        externalThreadId: 'external-thread-123',
        status: ThreadStatus.Running,
      });
    });

    it('should throw error if thread not found or belongs to different user', async () => {
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(null);

      await expect(
        service.getThreadByExternalId(mockCtx, 'non-existent-external-id'),
      ).rejects.toThrow('[THREAD_NOT_FOUND] An exception has occurred');
    });

    it('should handle null metadata correctly', async () => {
      const mockThread = createMockThreadEntity({ metadata: undefined });
      const externalThreadId = 'external-thread-123';

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);

      const result = await service.getThreadByExternalId(
        mockCtx,
        externalThreadId,
      );

      expect(result.metadata).toEqual({});
    });
  });

  describe('prepareThreadsResponse — stopReason & effectiveCostLimitUsd', () => {
    it('returns stopReason as null when metadata is absent', async () => {
      const mockThread = createMockThreadEntity({ metadata: undefined });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);

      const result = await service.getThreadById(mockCtx, mockThreadId);

      expect(result.stopReason).toBeNull();
    });

    it('returns stopReason as null when metadata has no stopReason key', async () => {
      const mockThread = createMockThreadEntity({
        metadata: { otherKey: 'value' },
      });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);

      const result = await service.getThreadById(mockCtx, mockThreadId);

      expect(result.stopReason).toBeNull();
    });

    it('returns stopReason as "cost_limit" when metadata carries it', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Stopped,
        metadata: { stopReason: 'cost_limit' },
      });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);

      const result = await service.getThreadById(mockCtx, mockThreadId);

      expect(result.stopReason).toBe('cost_limit');
    });

    it('reflects the metadata-stored value in effectiveCostLimitUsd', async () => {
      const mockThread = createMockThreadEntity({
        metadata: { effectiveCostLimitUsd: 5.25 },
      });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);

      const result = await service.getThreadById(mockCtx, mockThreadId);

      expect(result.effectiveCostLimitUsd).toBe(5.25);
    });

    it('returns effectiveCostLimitUsd as null when metadata has no entry', async () => {
      const mockThread = createMockThreadEntity({
        metadata: { otherKey: 'value' },
      });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);

      const result = await service.getThreadById(mockCtx, mockThreadId);

      expect(result.effectiveCostLimitUsd).toBeNull();
    });

    it('returns effectiveCostLimitUsd as null when metadata stores null', async () => {
      const mockThread = createMockThreadEntity({
        metadata: { effectiveCostLimitUsd: null },
      });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);

      const result = await service.getThreadById(mockCtx, mockThreadId);

      expect(result.effectiveCostLimitUsd).toBeNull();
    });

    it('reads each thread limit from its own metadata in list responses', async () => {
      const mockThreads = [
        createMockThreadEntity({
          id: 'thread-a',
          metadata: { effectiveCostLimitUsd: 1 },
        }),
        createMockThreadEntity({
          id: 'thread-b',
          metadata: { effectiveCostLimitUsd: 1 },
        }),
        createMockThreadEntity({
          id: 'thread-c',
          graphId: 'graph-other',
          metadata: { effectiveCostLimitUsd: 2 },
        }),
      ];

      vi.spyOn(threadsDao, 'getAll').mockResolvedValue(mockThreads);

      const query: GetThreadsQueryDto = { limit: 50, offset: 0 };

      const result = await service.getThreads(mockCtx, query);

      expect(result[0]!.effectiveCostLimitUsd).toBe(1);
      expect(result[1]!.effectiveCostLimitUsd).toBe(1);
      expect(result[2]!.effectiveCostLimitUsd).toBe(2);
    });

    it('returns stopReason=null when entity.status === Running even if metadata.stopReason is set', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Running,
        metadata: { stopReason: 'cost_limit' },
      });

      vi.mocked(graphDao.getAgentsByGraphIds).mockResolvedValue(new Map());

      const result = await service.prepareThreadsResponse([mockThread]);

      expect(result[0]!.stopReason).toBeNull();
    });

    it('returns metadata.stopReason when entity.status === Stopped', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Stopped,
        metadata: { stopReason: 'cost_limit' },
      });

      vi.mocked(graphDao.getAgentsByGraphIds).mockResolvedValue(new Map());

      const result = await service.prepareThreadsResponse([mockThread]);

      expect(result[0]!.stopReason).toBe('cost_limit');
    });
  });

  describe('token usage aggregation', () => {
    it('does not include tokenUsage in thread response for running threads', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Running,
        externalThreadId: 'external-thread-123',
      });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);

      const result = await service.getThreadById(mockCtx, mockThreadId);

      // tokenUsage is no longer included in thread response
      // Use GET /threads/:threadId/usage-statistics instead
      expect(result).not.toHaveProperty('tokenUsage');
    });

    it('no longer includes token usage in thread response', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Stopped,
        externalThreadId: 'external-thread-123',
      });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);

      const result = await service.getThreadById(mockCtx, mockThreadId);

      expect(result).not.toHaveProperty('tokenUsage');
    });
  });

  describe('getThreadMessages', () => {
    it('should return messages for a specific thread', async () => {
      const mockThread = createMockThreadEntity();
      const mockMessages = [
        createMockMessageEntity(),
        createMockMessageEntity({
          id: 'message-2',
          message: { role: MessageRole.AI, content: 'Response' },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);

      const query: GetMessagesQueryDto = {
        limit: 100,
        offset: 0,
      };

      const result = await service.getThreadMessages(
        mockCtx,
        mockThreadId,
        query,
      );

      expect(mockCtx.checkSub).toHaveBeenCalled();
      expect(threadsDao.getOne).toHaveBeenCalledWith({
        id: mockThreadId,
        createdBy: mockUserId,
      });
      expect(messagesDao.getAll).toHaveBeenCalledWith(
        {
          threadId: mockThreadId,
        },
        { orderBy: { createdAt: 'DESC' }, limit: 100, offset: 0 },
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 'message-123',
        threadId: mockThreadId,
        message: { role: MessageRole.Human, content: 'Test message' },
      });
    });

    it('should filter messages by nodeId if provided', async () => {
      const mockThread = createMockThreadEntity();
      const mockMessages = [createMockMessageEntity()];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);

      const query: GetMessagesQueryDto = {
        nodeId: 'node-1',
        limit: 100,
        offset: 0,
      };

      await service.getThreadMessages(mockCtx, mockThreadId, query);

      expect(messagesDao.getAll).toHaveBeenCalledWith(
        {
          threadId: mockThreadId,
          nodeId: 'node-1',
        },
        { orderBy: { createdAt: 'DESC' }, limit: 100, offset: 0 },
      );
    });

    it('should throw error if thread not found', async () => {
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(null);

      const query: GetMessagesQueryDto = {
        limit: 100,
        offset: 0,
      };

      await expect(
        service.getThreadMessages(mockCtx, mockThreadId, query),
      ).rejects.toThrow('[THREAD_NOT_FOUND] An exception has occurred');
    });
  });

  describe('deleteThread', () => {
    it('should delete a thread and its messages', async () => {
      const mockThread = createMockThreadEntity();

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'hardDelete').mockResolvedValue(undefined);
      vi.spyOn(threadsDao, 'deleteById').mockResolvedValue(undefined);

      await service.deleteThread(mockCtx, mockThreadId);

      expect(mockCtx.checkSub).toHaveBeenCalled();
      expect(threadsDao.getOne).toHaveBeenCalledWith({
        id: mockThreadId,
        createdBy: mockUserId,
      });
      expect(messagesDao.hardDelete).toHaveBeenCalledWith({
        threadId: mockThreadId,
      });
      expect(notificationsService.emit).toHaveBeenCalledWith({
        type: NotificationEvent.ThreadDelete,
        graphId: mockGraphId,
        threadId: mockThread.externalThreadId,
        internalThreadId: mockThread.id,
        data: mockThread,
      });
      expect(threadsDao.deleteById).toHaveBeenCalledWith(mockThreadId);
    });

    it('should throw error if thread not found or belongs to different user', async () => {
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(null);

      await expect(service.deleteThread(mockCtx, mockThreadId)).rejects.toThrow(
        '[THREAD_NOT_FOUND] An exception has occurred',
      );

      expect(mockCtx.checkSub).toHaveBeenCalled();
      expect(threadsDao.getOne).toHaveBeenCalledWith({
        id: mockThreadId,
        createdBy: mockUserId,
      });
      expect(messagesDao.hardDelete).not.toHaveBeenCalled();
      expect(notificationsService.emit).not.toHaveBeenCalled();
      expect(threadsDao.deleteById).not.toHaveBeenCalled();
    });
  });

  describe('setMetadata', () => {
    it('should update thread metadata and return updated thread', async () => {
      const mockThread = createMockThreadEntity();
      const updatedThread = createMockThreadEntity({
        metadata: { key: 'value', count: 42 },
      });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(threadsDao, 'updateById').mockResolvedValue(undefined as never);
      vi.spyOn(threadsDao, 'getById').mockResolvedValue(updatedThread);

      const result = await service.setMetadata(mockCtx, mockThreadId, {
        metadata: { key: 'value', count: 42 },
      });

      expect(mockCtx.checkSub).toHaveBeenCalled();
      expect(threadsDao.getOne).toHaveBeenCalledWith({
        id: mockThreadId,
        createdBy: mockUserId,
      });
      expect(threadsDao.updateById).toHaveBeenCalledWith(mockThreadId, {
        metadata: { key: 'value', count: 42 },
      });
      expect(result.metadata).toEqual({ key: 'value', count: 42 });
    });

    it('should throw error if thread not found', async () => {
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(null);

      await expect(
        service.setMetadata(mockCtx, mockThreadId, {
          metadata: { key: 'value' },
        }),
      ).rejects.toThrow('[THREAD_NOT_FOUND] An exception has occurred');

      expect(threadsDao.updateById).not.toHaveBeenCalled();
    });

    it('should allow setting empty metadata', async () => {
      const mockThread = createMockThreadEntity();
      const updatedThread = createMockThreadEntity({ metadata: {} });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(threadsDao, 'updateById').mockResolvedValue(undefined as never);
      vi.spyOn(threadsDao, 'getById').mockResolvedValue(updatedThread);

      const result = await service.setMetadata(mockCtx, mockThreadId, {
        metadata: {},
      });

      expect(threadsDao.updateById).toHaveBeenCalledWith(mockThreadId, {
        metadata: {},
      });
      expect(result.metadata).toEqual({});
    });
  });

  describe('setMetadataByExternalId', () => {
    it('should update thread metadata by external ID and return updated thread', async () => {
      const externalThreadId = 'external-thread-123';
      const mockThread = createMockThreadEntity({ externalThreadId });
      const updatedThread = createMockThreadEntity({
        externalThreadId,
        metadata: { env: 'production', version: 2 },
      });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(threadsDao, 'updateById').mockResolvedValue(undefined as never);
      vi.spyOn(threadsDao, 'getById').mockResolvedValue(updatedThread);

      const result = await service.setMetadataByExternalId(
        mockCtx,
        externalThreadId,
        {
          metadata: { env: 'production', version: 2 },
        },
      );

      expect(mockCtx.checkSub).toHaveBeenCalled();
      expect(threadsDao.getOne).toHaveBeenCalledWith({
        externalThreadId,
        createdBy: mockUserId,
      });
      expect(threadsDao.updateById).toHaveBeenCalledWith(mockThreadId, {
        metadata: { env: 'production', version: 2 },
      });
      expect(result.metadata).toEqual({ env: 'production', version: 2 });
    });

    it('should throw error if thread not found by external ID', async () => {
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(null);

      await expect(
        service.setMetadataByExternalId(mockCtx, 'non-existent-external-id', {
          metadata: { key: 'value' },
        }),
      ).rejects.toThrow('[THREAD_NOT_FOUND] An exception has occurred');

      expect(threadsDao.updateById).not.toHaveBeenCalled();
    });
  });

  describe('getThreadUsageStatistics', () => {
    it('should return usage statistics from checkpoint for completed thread', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      // Checkpoint data should only include requestTokenUsage (from LLM requests)
      // Tool messages don't have requestTokenUsage, so they're not in the checkpoint
      const mockTokenUsageFromCheckpoint = {
        inputTokens: 75, // 10 + 15 + 50 (human + ai calling + ai processing)
        outputTokens: 75, // 20 + 25 + 30 (human + ai calling + ai processing)
        totalTokens: 150, // 30 + 40 + 80 (human + ai calling + ai processing)
        totalPrice: 0.007, // 0.001 + 0.002 + 0.004 (human + ai calling + ai processing)
        byNode: {
          'node-1': {
            inputTokens: 25, // 10 + 15 (human + ai calling in node-1)
            outputTokens: 45, // 20 + 25 (human + ai calling in node-1)
            totalTokens: 70, // 30 + 40 (human + ai calling in node-1)
            totalPrice: 0.003, // 0.001 + 0.002 (human + ai calling in node-1)
          },
          'node-2': {
            inputTokens: 50, // ai processing in node-2
            outputTokens: 30,
            totalTokens: 80,
            totalPrice: 0.004,
          },
        },
      };

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-1',
          nodeId: 'node-1',
          role: MessageRole.Human,
          name: undefined,
          requestTokenUsage: undefined, // Human messages don't have requestTokenUsage
        }),
        createMockMessageEntity({
          id: 'msg-2',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: ['search', 'shell'],
          requestTokenUsage: {
            inputTokens: 15,
            outputTokens: 25,
            totalTokens: 40,
            totalPrice: 0.002,
          },
        }),
        createMockMessageEntity({
          id: 'msg-3',
          nodeId: 'node-2',
          role: MessageRole.Tool,
          name: 'search',
          requestTokenUsage: undefined, // Tool messages don't have requestTokenUsage
          message: {
            role: MessageRole.Tool,
            name: 'search',
            toolCallId: 'call_search_123',
            content: { result: 'search result' },
            additionalKwargs: {
              __tokenUsage: {
                totalTokens: 15,
                totalPrice: 0.0005,
              },
            },
          },
        }),
        createMockMessageEntity({
          id: 'msg-4',
          nodeId: 'node-2',
          role: MessageRole.Tool,
          name: 'shell',
          requestTokenUsage: undefined, // Tool messages don't have requestTokenUsage
          message: {
            role: MessageRole.Tool,
            name: 'shell',
            toolCallId: 'call_shell_456',
            content: { exitCode: 0, stdout: 'shell output', stderr: '' },
            additionalKwargs: {
              __tokenUsage: {
                totalTokens: 10,
                totalPrice: 0.0003,
              },
            },
          },
        }),
        // NEW: AI message processing tool results (no tool_calls)
        createMockMessageEntity({
          id: 'msg-5',
          nodeId: 'node-2',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: [], // No tool calls - this is processing tool results
          answeredToolCallNames: ['search', 'shell'],
          requestTokenUsage: {
            inputTokens: 50,
            outputTokens: 30,
            totalTokens: 80,
            totalPrice: 0.004,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);

      // Mock checkpoint service to return token usage
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        mockTokenUsageFromCheckpoint,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      expect(mockCtx.checkSub).toHaveBeenCalled();
      expect(threadsDao.getOne).toHaveBeenCalledWith({
        id: mockThreadId,
        createdBy: mockUserId,
      });
      expect(messagesDao.getAll).toHaveBeenCalledWith(
        { threadId: mockThreadId },
        {
          orderBy: { createdAt: 'ASC' },
          fields: [
            'id',
            'nodeId',
            'role',
            'name',
            'requestTokenUsage',
            'toolCallNames',
            'answeredToolCallNames',
            'additionalKwargs',
            'toolCallIds',
            'toolTokenUsage',
          ],
        },
      );

      // Check total (message-scan is single authoritative source per Change A policy).
      // Only AI messages with requestTokenUsage contribute (msg-2 + msg-5).
      // Human message (msg-1) has no requestTokenUsage — not accumulated.
      // Checkpoint values (inputTokens: 75, totalPrice: 0.007) are NOT used for totals.
      expect(result.total).toMatchObject({
        inputTokens: 65, // 15 + 50 (ai calling + ai processing)
        outputTokens: 55, // 25 + 30 (ai calling + ai processing)
        totalTokens: 120, // 40 + 80 (ai calling + ai processing)
        totalPrice: 0.006, // 0.002 + 0.004 (ai calling + ai processing)
      });

      // Check byNode — message-scan is authoritative (overwrites checkpoint seed).
      // Only AI messages with requestTokenUsage contribute: msg-2 (node-1) + msg-5 (node-2).
      // Human msg-1 has no requestTokenUsage so it does not feed byNode.
      expect(result.byNode['node-1']).toMatchObject({
        inputTokens: 15, // ai calling (msg-2)
        outputTokens: 25, // ai calling (msg-2)
        totalTokens: 40, // ai calling (msg-2)
      });
      expect(result.byNode['node-1']!.totalPrice).toBeCloseTo(0.002, 4);
      expect(result.byNode['node-2']).toMatchObject({
        inputTokens: 50, // ai processing (msg-5)
        outputTokens: 30,
        totalTokens: 80,
      });
      expect(result.byNode['node-2']!.totalPrice).toBeCloseTo(0.004, 4);

      // Check byTool — callCount from toolCallNames, usage from AI messages
      // msg-2 calls search+shell (callCount 1 each, 40 tokens each)
      // msg-5 answers search+shell (no callCount, 80 tokens attributed to each)
      expect(result.byTool).toHaveLength(2);
      expect(result.byTool[0]).toMatchObject({
        toolName: 'search',
        totalTokens: 120, // 40 (calling) + 80 (answering)
        callCount: 1,
      });
      expect(result.byTool[0]!.totalPrice).toBeCloseTo(0.006, 4);
      expect(result.byTool[1]).toMatchObject({
        toolName: 'shell',
        totalTokens: 120, // 40 (calling) + 80 (answering)
        callCount: 1,
      });
      expect(result.byTool[1]!.totalPrice).toBeCloseTo(0.006, 4);

      // Check total requests (only AI messages with requestTokenUsage)
      expect(result.requests).toBe(2); // ai calling + ai processing

      // Check toolsAggregate (all tool-related LLM requests)
      // msg-2 (AI calling tools, 40 tokens) + msg-5 (AI answering tools, 80 tokens)
      expect(result.toolsAggregate).toMatchObject({
        inputTokens: 65, // 15 + 50
        outputTokens: 55, // 25 + 30
        totalTokens: 120, // 40 + 80
        requestCount: 2,
      });
      expect(result.toolsAggregate.totalPrice).toBeCloseTo(0.006, 4);

      // Check userMessageCount
      expect(result.userMessageCount).toBe(1);
    });

    it('should aggregate multiple calls to same tool', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      const mockTokenUsageFromCheckpoint = {
        inputTokens: 37, // 5 + 7 + 10 + 15 (two calls, two processing)
        outputTokens: 74, // 10 + 14 + 20 + 30 (two calls, two processing)
        totalTokens: 111, // 15 + 21 + 30 + 45 (two calls, two processing)
        totalPrice: 0.008, // 0.001 + 0.002 + 0.002 + 0.003 (two calls, two processing)
        byNode: {
          'node-1': {
            inputTokens: 37,
            outputTokens: 74,
            totalTokens: 111,
            totalPrice: 0.008,
          },
        },
      };

      const mockMessages = [
        // First: AI calling search
        createMockMessageEntity({
          id: 'msg-1',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: ['search'],
          requestTokenUsage: {
            inputTokens: 5,
            outputTokens: 10,
            totalTokens: 15,
            totalPrice: 0.001,
          },
        }),
        // Tool result
        createMockMessageEntity({
          id: 'msg-2',
          nodeId: 'node-1',
          role: MessageRole.Tool,
          name: 'search',
          requestTokenUsage: undefined,
        }),
        // AI processing first tool result
        createMockMessageEntity({
          id: 'msg-3',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: [], // No tool calls - processing result
          answeredToolCallNames: ['search'],
          requestTokenUsage: {
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
            totalPrice: 0.002,
          },
        }),
        // Second: AI calling search again
        createMockMessageEntity({
          id: 'msg-4',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: ['search'],
          requestTokenUsage: {
            inputTokens: 7,
            outputTokens: 14,
            totalTokens: 21,
            totalPrice: 0.002,
          },
        }),
        // Tool result
        createMockMessageEntity({
          id: 'msg-5',
          nodeId: 'node-1',
          role: MessageRole.Tool,
          name: 'search',
          requestTokenUsage: undefined,
        }),
        // AI processing second tool result
        createMockMessageEntity({
          id: 'msg-6',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: [], // No tool calls - processing result
          answeredToolCallNames: ['search'],
          requestTokenUsage: {
            inputTokens: 15,
            outputTokens: 30,
            totalTokens: 45,
            totalPrice: 0.003,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);

      // Mock checkpoint service to return token usage
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        mockTokenUsageFromCheckpoint,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // byTool should aggregate all tool-related usage (calling + answering)
      expect(result.byTool).toHaveLength(1);
      expect(result.byTool[0]).toMatchObject({
        toolName: 'search',
        totalTokens: 111, // 15 + 30 + 21 + 45 (two calls + two answers)
        totalPrice: 0.008, // 0.001 + 0.002 + 0.002 + 0.003
        callCount: 2, // Two AI messages with toolCallNames=['search']
      });
    });

    it('should throw error if thread not found', async () => {
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(null);

      await expect(
        service.getThreadUsageStatistics(mockCtx, mockThreadId),
      ).rejects.toThrow('[THREAD_NOT_FOUND] An exception has occurred');

      expect(mockCtx.checkSub).toHaveBeenCalled();
      expect(threadsDao.getOne).toHaveBeenCalledWith({
        id: mockThreadId,
        createdBy: mockUserId,
      });
      expect(messagesDao.getAll).not.toHaveBeenCalled();
    });

    it('should nest subagent internal tool calls under parent tool as subCalls', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      const mockTokenUsageFromCheckpoint = {
        inputTokens: 100,
        outputTokens: 80,
        totalTokens: 180,
        totalPrice: 0.01,
        byNode: {
          'node-1': {
            inputTokens: 100,
            outputTokens: 80,
            totalTokens: 180,
            totalPrice: 0.01,
          },
        },
      };

      const parentToolCallId = 'call_867775e4';

      const mockMessages = [
        // 1. Parent AI message that calls subagents_run_task
        createMockMessageEntity({
          id: 'msg-parent-ai',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: ['subagents_run_task'],
          toolCallIds: [parentToolCallId],
          additionalKwargs: {},
          requestTokenUsage: {
            inputTokens: 60,
            outputTokens: 40,
            totalTokens: 100,
            totalPrice: 0.005,
          },
        }),
        // 2. Subagent internal AI message that calls files_write_file (__hideForLlm)
        createMockMessageEntity({
          id: 'msg-subagent-ai-1',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: ['files_write_file'],
          requestTokenUsage: undefined, // Stripped for __hideForLlm
          additionalKwargs: {
            __hideForLlm: true,
            __toolCallId: parentToolCallId,
            __requestUsage: {
              inputTokens: 2000,
              outputTokens: 1563,
              totalTokens: 3563,
              totalPrice: 0,
            },
          },
        }),
        // 3. Subagent internal tool result (files_write_file)
        createMockMessageEntity({
          id: 'msg-subagent-tool',
          nodeId: 'node-1',
          role: MessageRole.Tool,
          name: 'files_write_file',
          requestTokenUsage: undefined,
          additionalKwargs: {
            __hideForLlm: true,
            __toolCallId: parentToolCallId,
          },
        }),
        // 4. Subagent internal AI final response (no tool calls) (__hideForLlm)
        createMockMessageEntity({
          id: 'msg-subagent-ai-2',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: [], // No tool calls - final response
          requestTokenUsage: undefined, // Stripped for __hideForLlm
          additionalKwargs: {
            __hideForLlm: true,
            __toolCallId: parentToolCallId,
            __requestUsage: {
              inputTokens: 2000,
              outputTokens: 1518,
              totalTokens: 3518,
              totalPrice: 0,
            },
          },
        }),
        // 5. Tool result for subagents_run_task (with own toolTokenUsage)
        createMockMessageEntity({
          id: 'msg-tool-result',
          nodeId: 'node-1',
          role: MessageRole.Tool,
          name: 'subagents_run_task',
          requestTokenUsage: undefined, // Tool messages don't have requestTokenUsage
          toolTokenUsage: {
            inputTokens: 4000,
            outputTokens: 3081,
            totalTokens: 7081,
            totalPrice: 0,
          },
          additionalKwargs: {},
        }),
        // 6. AI message processing the tool result (answeredToolCallNames)
        createMockMessageEntity({
          id: 'msg-answer-ai',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: [],
          answeredToolCallNames: ['subagents_run_task'],
          requestTokenUsage: {
            inputTokens: 40,
            outputTokens: 40,
            totalTokens: 80,
            totalPrice: 0.005,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);

      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        mockTokenUsageFromCheckpoint,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // subagents_run_task should appear in byTool with subCalls
      const subagentEntry = result.byTool.find(
        (t) => t.toolName === 'subagents_run_task',
      );
      expect(subagentEntry).toBeDefined();
      expect(subagentEntry!.callCount).toBe(1);
      // totalTokens = 100 (calling) + 80 (answering) = 180
      expect(subagentEntry!.totalTokens).toBe(180);

      // toolTokens/toolPrice from tool result message
      expect(subagentEntry!.toolTokens).toBe(7081);
      expect(subagentEntry!.toolPrice).toBe(0);

      // subCalls should contain files_write_file and (llm_response)
      expect(subagentEntry!.subCalls).toBeDefined();
      expect(subagentEntry!.subCalls).toHaveLength(2);

      const writeFileSubCall = subagentEntry!.subCalls!.find(
        (sc) => sc.toolName === 'files_write_file',
      );
      expect(writeFileSubCall).toBeDefined();
      expect(writeFileSubCall!.callCount).toBe(1);
      expect(writeFileSubCall!.totalTokens).toBe(3563);
      expect(writeFileSubCall!.totalPrice).toBe(0);

      const llmResponseSubCall = subagentEntry!.subCalls!.find(
        (sc) => sc.toolName === '(llm_response)',
      );
      expect(llmResponseSubCall).toBeDefined();
      expect(llmResponseSubCall!.callCount).toBe(1);
      expect(llmResponseSubCall!.totalTokens).toBe(3518);
      expect(llmResponseSubCall!.totalPrice).toBe(0);

      // files_write_file should NOT appear at top level
      const topLevelWriteFile = result.byTool.find(
        (t) => t.toolName === 'files_write_file',
      );
      expect(topLevelWriteFile).toBeUndefined();

      // (llm_response) should NOT appear at top level
      const topLevelLlmResponse = result.byTool.find(
        (t) => t.toolName === '(llm_response)',
      );
      expect(topLevelLlmResponse).toBeUndefined();

      // toolsAggregate should include only LLM request tokens (not toolTokenUsage, which
      // is an aggregate of already-counted subagent internal calls — adding it would double-count).
      // msg-parent-ai (100) + subagent-ai-1 (3563) + subagent-ai-2 (3518) + msg-answer-ai (80)
      expect(result.toolsAggregate.totalTokens).toBe(7261);
      expect(result.toolsAggregate.inputTokens).toBe(4100);
      expect(result.toolsAggregate.outputTokens).toBe(3161);
      // requestCount = only LLM requests
      // msg-parent-ai + subagent-ai-1 + subagent-ai-2 + msg-answer-ai = 4
      expect(result.toolsAggregate.requestCount).toBe(4);
    });

    it('should log warning and still count requests for subagent messages with unresolved parentToolCallId', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      const mockTokenUsageFromCheckpoint = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        totalPrice: 0.01,
        byNode: {
          'node-1': {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            totalPrice: 0.01,
          },
        },
      };

      // Subagent internal AI message with __toolCallId pointing to unknown parent
      const unknownParentToolCallId = 'call_unknown_parent';
      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-orphan-subagent',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: undefined,
          additionalKwargs: {
            __hideForLlm: true,
            __toolCallId: unknownParentToolCallId,
            __requestUsage: {
              inputTokens: 2000,
              outputTokens: 500,
              totalTokens: 2500,
              totalPrice: 0,
            },
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        mockTokenUsageFromCheckpoint,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Should log a warning about unresolved parentToolCallId
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('parent tool not found'),
        expect.objectContaining({
          messageId: 'msg-orphan-subagent',
          parentToolCallId: unknownParentToolCallId,
        }),
      );

      // Subagent LLM call should still be counted in totalRequests and toolsAggregate
      expect(result.requests).toBe(1);
      expect(result.toolsAggregate.requestCount).toBe(1);
      expect(result.toolsAggregate.totalTokens).toBe(2500);

      // But should NOT appear in byTool (no parent to attribute to)
      expect(result.byTool).toHaveLength(0);
    });

    it('should use message-based total when it exceeds checkpoint total (in-progress subagent)', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Running,
        externalThreadId: 'external-thread-123',
      });

      // Checkpoint only has the parent AI message cost — subagent hasn't finished yet
      const mockTokenUsageFromCheckpoint = {
        inputTokens: 60,
        outputTokens: 40,
        totalTokens: 100,
        totalPrice: 0.005,
        byNode: {
          'node-1': {
            inputTokens: 60,
            outputTokens: 40,
            totalTokens: 100,
            totalPrice: 0.005,
          },
        },
      };

      const parentToolCallId = 'call_inprogress_123';

      const mockMessages = [
        // 1. Parent AI message that calls subagents_run_task
        createMockMessageEntity({
          id: 'msg-parent-ai',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: ['subagents_run_task'],
          toolCallIds: [parentToolCallId],
          additionalKwargs: {},
          requestTokenUsage: {
            inputTokens: 60,
            outputTokens: 40,
            totalTokens: 100,
            totalPrice: 0.005,
          },
        }),
        // 2. Subagent internal AI message (streamed in real-time, subagent still running)
        createMockMessageEntity({
          id: 'msg-subagent-ai-1',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: ['files_read'],
          requestTokenUsage: undefined,
          additionalKwargs: {
            __hideForLlm: true,
            __toolCallId: parentToolCallId,
            __requestUsage: {
              inputTokens: 3000,
              outputTokens: 2000,
              totalTokens: 5000,
              totalPrice: 0.003,
            },
          },
        }),
        // 3. Subagent internal AI message (another LLM call, subagent still running)
        createMockMessageEntity({
          id: 'msg-subagent-ai-2',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: [],
          requestTokenUsage: undefined,
          additionalKwargs: {
            __hideForLlm: true,
            __toolCallId: parentToolCallId,
            __requestUsage: {
              inputTokens: 4000,
              outputTokens: 1500,
              totalTokens: 5500,
              totalPrice: 0.004,
            },
          },
        }),
        // No tool result yet — subagent is still running
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        mockTokenUsageFromCheckpoint,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Message-based total: parent(60+40+100+0.005) + sub1(3000+2000+5000+0.003) + sub2(4000+1500+5500+0.004)
      // = {7060, 3540, 10600, 0.012}
      // Checkpoint total: {60, 40, 100, 0.005}
      // Running status → message-based source wins (single-source policy; no Math.max)
      expect(result.total.inputTokens).toBe(7060);
      expect(result.total.outputTokens).toBe(3540);
      expect(result.total.totalTokens).toBe(10600);
      expect(result.total.totalPrice).toBeCloseTo(0.012, 4);

      // Subagent internal messages should still be counted in toolsAggregate
      expect(result.toolsAggregate.totalTokens).toBe(10600);
      expect(result.toolsAggregate.requestCount).toBe(3);
    });

    it('should handle optional token usage fields correctly from checkpoint', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      const mockTokenUsage = {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        cachedInputTokens: 5,
        reasoningTokens: 3,
        totalPrice: 0.002,
        currentContext: 100,
        byNode: {
          'node-1': {
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
            cachedInputTokens: 5,
            reasoningTokens: 3,
            totalPrice: 0.002,
            currentContext: 100,
          },
        },
      };

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-1',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
            cachedInputTokens: 5,
            reasoningTokens: 3,
            totalPrice: 0.002,
            currentContext: 100,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);

      // Mock checkpoint service to return token usage
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        mockTokenUsage,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      expect(result.total).toMatchObject({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        cachedInputTokens: 5,
        reasoningTokens: 3,
        totalPrice: 0.002,
        currentContext: 100,
      });
    });

    it('3.1 — Running: message-scan source wins; currentContext still from checkpoint', async () => {
      // status=Running + checkpoint totalUsage lower than messageTotalUsage
      // → returns messageTotalUsage fields (NOT Math.max); currentContext from checkpoint
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Running,
        externalThreadId: 'external-thread-123',
      });

      const mockTokenUsageFromCheckpoint = {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        totalPrice: 0.001,
        currentContext: 4000,
        byNode: {},
      };

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-running-1',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 500,
            outputTokens: 300,
            totalTokens: 800,
            totalPrice: 0.05,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        mockTokenUsageFromCheckpoint,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Message-scan values must win — single-source policy, not Math.max
      expect(result.total.inputTokens).toBe(500);
      expect(result.total.outputTokens).toBe(300);
      expect(result.total.totalTokens).toBe(800);
      expect(result.total.totalPrice).toBeCloseTo(0.05, 4);

      // currentContext always comes from checkpoint (message-scan has no authoritative context window)
      expect(result.total.currentContext).toBe(4000);
    });

    it('3.2 — Done: message-scan wins for additive fields; currentContext still from checkpoint (single-source policy)', async () => {
      // Change A: message-scan is the authoritative source for ALL additive fields
      // (input/output/cached/reasoning/totalTokens + totalPrice) regardless of
      // thread.status. Checkpoint remains authoritative ONLY for currentContext
      // (a point-in-time context-window reading, not reconstructable from messages).
      // This replaces the pre-Change-A behavior where checkpoint won verbatim on Done.
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      // Checkpoint is populated but DISAGREES with message-scan on additive fields.
      // Under Change A, only currentContext (2000) wins from checkpoint; the rest
      // is overridden by the message-scan aggregate below.
      const mockTokenUsageFromCheckpoint = {
        inputTokens: 100,
        outputTokens: 80,
        totalTokens: 180,
        totalPrice: 0.01,
        currentContext: 2000,
        byNode: {
          'node-1': {
            inputTokens: 100,
            outputTokens: 80,
            totalTokens: 180,
            totalPrice: 0.01,
          },
        },
      };

      // Message-scan aggregate — this is now the source of truth for additive fields.
      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-done-1',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 9999,
            outputTokens: 9999,
            totalTokens: 19998,
            totalPrice: 9.99,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        mockTokenUsageFromCheckpoint,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Message-scan wins for additive fields; checkpoint is authoritative only for currentContext
      expect(result.total.inputTokens).toBe(9999);
      expect(result.total.outputTokens).toBe(9999);
      expect(result.total.totalTokens).toBe(19998);
      expect(result.total.totalPrice).toBeCloseTo(9.99, 4);
      // currentContext still comes from checkpoint
      expect(result.total.currentContext).toBe(2000);
    });

    it('3.3 — Stopped: message-scan wins for additive fields; currentContext still from checkpoint (single-source policy)', async () => {
      // Change A: message-scan is authoritative for ALL additive fields regardless of
      // thread.status. Mirrors 3.2 but with ThreadStatus.Stopped to guard against
      // accidental specialization of the non-running branch (e.g. status === Done only).
      // Checkpoint remains authoritative ONLY for currentContext.
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Stopped,
        externalThreadId: 'external-thread-123',
      });

      // Checkpoint is populated but DISAGREES with message-scan on additive fields.
      // Under Change A, only currentContext (2000) wins from checkpoint.
      const mockTokenUsageFromCheckpoint = {
        inputTokens: 100,
        outputTokens: 80,
        totalTokens: 180,
        totalPrice: 0.01,
        currentContext: 2000,
        byNode: {
          'node-1': {
            inputTokens: 100,
            outputTokens: 80,
            totalTokens: 180,
            totalPrice: 0.01,
          },
        },
      };

      // Message-scan aggregate — this is now the source of truth for additive fields.
      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-stopped-1',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 9999,
            outputTokens: 9999,
            totalTokens: 19998,
            totalPrice: 9.99,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        mockTokenUsageFromCheckpoint,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Message-scan wins for additive fields; checkpoint is authoritative only for currentContext
      expect(result.total.inputTokens).toBe(9999);
      expect(result.total.outputTokens).toBe(9999);
      expect(result.total.totalTokens).toBe(19998);
      expect(result.total.totalPrice).toBeCloseTo(9.99, 4);
      // currentContext still comes from checkpoint
      expect(result.total.currentContext).toBe(2000);
    });

    it('matrix row 1 — all priced, running: message-scan sum returned', async () => {
      // All 3 messages have known pricing. Thread is Running.
      // Asserts: totalPrice = sum of message prices.
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Running,
        externalThreadId: 'external-thread-123',
      });

      const mockTokenUsageFromCheckpoint = {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        totalPrice: 0.0001,
        currentContext: 500,
        byNode: {},
      };

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-row1-1',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            totalPrice: 0.01,
          },
        }),
        createMockMessageEntity({
          id: 'msg-row1-2',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 200,
            outputTokens: 100,
            totalTokens: 300,
            totalPrice: 0.02,
          },
        }),
        createMockMessageEntity({
          id: 'msg-row1-3',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 400,
            outputTokens: 200,
            totalTokens: 600,
            totalPrice: 0.04,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        mockTokenUsageFromCheckpoint,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      expect(result.total.totalPrice).toBeCloseTo(0.07, 4);
      // B-MED-4: currentContext is authoritative from checkpoint for Running threads
      expect(result.total.currentContext).toBe(500);
    });

    it('matrix row 2 — all priced, done: message-scan wins for additive fields; currentContext from checkpoint', async () => {
      // Thread is Done. Checkpoint has DIFFERENT values than message-scan.
      // Asserts: totalPrice = message-scan sum (NOT checkpoint); currentContext from checkpoint.
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      const mockTokenUsageFromCheckpoint = {
        inputTokens: 50,
        outputTokens: 30,
        totalTokens: 80,
        totalPrice: 0.005,
        currentContext: 3500,
        byNode: {},
      };

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-row2-1',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 300,
            outputTokens: 150,
            totalTokens: 450,
            totalPrice: 0.03,
          },
        }),
        createMockMessageEntity({
          id: 'msg-row2-2',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 400,
            outputTokens: 200,
            totalTokens: 600,
            totalPrice: 0.05,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        mockTokenUsageFromCheckpoint,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Message-scan sum is 0.08 — NOT checkpoint 0.005
      expect(result.total.totalPrice).toBeCloseTo(0.08, 4);
      // currentContext comes from checkpoint, not messages
      expect(result.total.currentContext).toBe(3500);
    });

    it('matrix row 5 — checkpoint empty, messages populated (499192e0 repro): message-scan used as fallback', async () => {
      // Reproduces the live bug on thread 499192e0 where checkpointStateService returns
      // null but the thread has messages with usage data. Pre-fix: returned {totalPrice:0,
      // totalTokens:0}. Post-fix: returns message-scan aggregate.
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      // Checkpoint is absent — this is the 499192e0 scenario
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-row5-1',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 1500,
            totalPrice: 0.1021,
          },
        }),
        createMockMessageEntity({
          id: 'msg-row5-2',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 2000,
            outputTokens: 1000,
            totalTokens: 3000,
            totalPrice: 0.2,
          },
        }),
        createMockMessageEntity({
          id: 'msg-row5-3',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 500,
            outputTokens: 250,
            totalTokens: 750,
            totalPrice: 0.1,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Message-scan sum: 0.1021 + 0.2 + 0.1 = 0.4021
      expect(result.total.totalPrice).toBeCloseTo(0.4021, 4);
      expect(result.total.totalTokens).toBeGreaterThan(0);
    });

    it('B-HIGH-2: messages-only path populates reasoningTokens when checkpoint returns null', async () => {
      // Deletion test: removing `messageTotalUsage.reasoningTokens += usage.reasoningTokens || 0`
      // at the accumulateUsage call site must break this test.
      // Checkpoint is null (e.g. multi-agent topology with no root checkpoint).
      // Messages carry reasoningTokens — the message-scan path must accumulate them.
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-bhigh2-1',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            totalPrice: 0.01,
            reasoningTokens: 50,
          },
        }),
        createMockMessageEntity({
          id: 'msg-bhigh2-2',
          nodeId: 'node-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 200,
            outputTokens: 80,
            totalTokens: 280,
            totalPrice: 0.02,
            reasoningTokens: 50,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Each message contributes 50 reasoningTokens; sum = 100
      expect(result.total.reasoningTokens).toBe(100);
    });

    it('populates byNode from message-scan when checkpoint byNode is empty', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      // Checkpoint returns no byNode — message-scan must populate it
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          totalPrice: 0,
        },
      );

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-supervisor-1',
          nodeId: 'supervisor',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            totalPrice: 0.01,
          },
        }),
        createMockMessageEntity({
          id: 'msg-researcher-1',
          nodeId: 'researcher',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 200,
            outputTokens: 80,
            totalTokens: 280,
            totalPrice: 0.02,
          },
        }),
        createMockMessageEntity({
          id: 'msg-supervisor-2',
          nodeId: 'supervisor',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 50,
            outputTokens: 30,
            totalTokens: 80,
            totalPrice: 0.005,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // byNode must be populated from message-scan (not empty)
      expect(result.byNode).toHaveProperty('supervisor');
      expect(result.byNode).toHaveProperty('researcher');

      // supervisor: msg-supervisor-1 + msg-supervisor-2
      expect(result.byNode['supervisor']).toMatchObject({
        inputTokens: 150, // 100 + 50
        outputTokens: 80, // 50 + 30
        totalTokens: 230, // 150 + 80
      });
      expect(result.byNode['supervisor']!.totalPrice).toBeCloseTo(0.015, 6);

      // researcher: msg-researcher-1 only
      expect(result.byNode['researcher']).toMatchObject({
        inputTokens: 200,
        outputTokens: 80,
        totalTokens: 280,
      });
      expect(result.byNode['researcher']!.totalPrice).toBeCloseTo(0.02, 6);

      // sum of byNode prices == total price
      const byNodePriceSum =
        (result.byNode['supervisor']!.totalPrice ?? 0) +
        (result.byNode['researcher']!.totalPrice ?? 0);
      expect(byNodePriceSum).toBeCloseTo(result.total.totalPrice ?? 0, 6);
    });

    it('attributes subagent internal messages to byNode under messageEntity.nodeId', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Running,
        externalThreadId: 'external-thread-123',
      });

      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const parentToolCallId = 'call_subagent_abc';

      const mockMessages = [
        // Parent AI message that spawns the subagent
        createMockMessageEntity({
          id: 'msg-parent',
          nodeId: 'supervisor_node',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: ['run_subagent'],
          toolCallIds: [parentToolCallId],
          additionalKwargs: {},
          requestTokenUsage: {
            inputTokens: 50,
            outputTokens: 20,
            totalTokens: 70,
            totalPrice: 0.005,
          },
        }),
        // Subagent internal AI message — should be attributed to 'subagent_node'
        createMockMessageEntity({
          id: 'msg-subagent-internal',
          nodeId: 'subagent_node',
          role: MessageRole.AI,
          name: undefined,
          toolCallNames: ['some_tool'],
          requestTokenUsage: undefined,
          additionalKwargs: {
            __hideForLlm: true,
            __toolCallId: parentToolCallId,
            __requestUsage: {
              inputTokens: 10,
              outputTokens: 20,
              totalTokens: 30,
              totalPrice: 0.001,
            },
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Subagent internal message attributed to 'subagent_node' in byNode
      expect(result.byNode).toHaveProperty('subagent_node');
      expect(result.byNode['subagent_node']).toMatchObject({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      });
      expect(result.byNode['subagent_node']!.totalPrice).toBeCloseTo(0.001, 6);

      // Parent message attributed to 'supervisor_node'
      expect(result.byNode).toHaveProperty('supervisor_node');
      expect(result.byNode['supervisor_node']).toMatchObject({
        inputTokens: 50,
        outputTokens: 20,
        totalTokens: 70,
      });
    });

    it('skips messages with null or undefined nodeId when populating byNode', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const mockMessages = [
        // Message with null nodeId — must not create a byNode entry
        createMockMessageEntity({
          id: 'msg-null-node',
          nodeId: null as unknown as string,
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            totalPrice: 0.01,
          },
        }),
        // Message with undefined nodeId — must not create a byNode entry
        createMockMessageEntity({
          id: 'msg-undef-node',
          nodeId: undefined as unknown as string,
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 200,
            outputTokens: 100,
            totalTokens: 300,
            totalPrice: 0.02,
          },
        }),
        // Valid message — should appear in byNode
        createMockMessageEntity({
          id: 'msg-valid-node',
          nodeId: 'supervisor',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 300,
            outputTokens: 150,
            totalTokens: 450,
            totalPrice: 0.03,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // No spurious keys from null/undefined nodeId
      const byNodeKeys = Object.keys(result.byNode);
      expect(byNodeKeys).not.toContain('');
      expect(byNodeKeys).not.toContain('null');
      expect(byNodeKeys).not.toContain('undefined');

      // Valid nodeId present and correct
      expect(result.byNode).toHaveProperty('supervisor');
      expect(result.byNode['supervisor']).toMatchObject({
        inputTokens: 300,
        outputTokens: 150,
        totalTokens: 450,
      });
      expect(typeof result.byNode['supervisor']!.totalPrice).toBe('number');
      expect(Number.isFinite(result.byNode['supervisor']!.totalPrice)).toBe(
        true,
      );
      expect(result.byNode['supervisor']!.totalPrice).toBeCloseTo(0.03, 6);
    });

    it('produces non-empty byNode from messages regardless of thread.status (Running vs Done)', async () => {
      const sharedMessages = [
        createMockMessageEntity({
          id: 'msg-node-a-1',
          nodeId: 'node_alpha',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            totalPrice: 0.01,
          },
        }),
        createMockMessageEntity({
          id: 'msg-node-b-1',
          nodeId: 'node_beta',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 200,
            outputTokens: 100,
            totalTokens: 300,
            totalPrice: 0.02,
          },
        }),
      ];

      const checkpointEmpty = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalPrice: 0,
      };

      // Run with Running status
      const runningThread = createMockThreadEntity({
        status: ThreadStatus.Running,
        externalThreadId: 'external-thread-123',
      });
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(runningThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(sharedMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        checkpointEmpty,
      );

      const runningResult = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Run with Done status
      const doneThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(doneThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(sharedMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        checkpointEmpty,
      );

      const doneResult = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Both results must have same byNode keys
      expect(Object.keys(runningResult.byNode).sort()).toEqual(
        Object.keys(doneResult.byNode).sort(),
      );

      // Both must have node_alpha and node_beta
      for (const result of [runningResult, doneResult]) {
        expect(result.byNode).toHaveProperty('node_alpha');
        expect(result.byNode).toHaveProperty('node_beta');
        expect(result.byNode['node_alpha']).toMatchObject({
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        });
        expect(result.byNode['node_alpha']!.totalPrice).toBeCloseTo(0.01, 6);
        expect(result.byNode['node_beta']).toMatchObject({
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 300,
        });
        expect(result.byNode['node_beta']!.totalPrice).toBeCloseTo(0.02, 6);
      }

      // Values must be identical between Running and Done
      expect(runningResult.byNode['node_alpha']).toEqual(
        doneResult.byNode['node_alpha'],
      );
      expect(runningResult.byNode['node_beta']).toEqual(
        doneResult.byNode['node_beta'],
      );
    });

    it('Bug A.1 — checkpoint null + messages populated: currentContext from messages', async () => {
      // Multi-agent topology: checkpoint returns null (no root checkpoint written).
      // Messages carry currentContext. Result must use messages as source.
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-bugA1-1',
          nodeId: 'node-alpha',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            totalPrice: 0.01,
            currentContext: 42_000,
          },
        }),
        createMockMessageEntity({
          id: 'msg-bugA1-2',
          nodeId: 'node-beta',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 200,
            outputTokens: 80,
            totalTokens: 280,
            totalPrice: 0.02,
            currentContext: 38_000,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);
      // Checkpoint returns null — multi-agent topology with no root checkpoint
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Math.max(0, 42_000) = 42_000 (messages win when checkpoint is null)
      expect(result.total.currentContext).toBe(42_000);
      // byNode should have entries for both nodes
      expect(Object.keys(result.byNode).length).toBeGreaterThanOrEqual(2);
    });

    it('Bug A.2 — checkpoint populated regression guard: checkpoint wins via Math.max', async () => {
      // Checkpoint has higher currentContext than messages; checkpoint must win.
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      const mockTokenUsageFromCheckpoint = {
        inputTokens: 100,
        outputTokens: 80,
        totalTokens: 180,
        totalPrice: 0.01,
        currentContext: 50_000,
        byNode: {
          'agent-1': {
            inputTokens: 100,
            outputTokens: 80,
            totalTokens: 180,
            totalPrice: 0.01,
            currentContext: 50_000,
          },
        },
      };

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-bugA2-1',
          nodeId: 'agent-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 100,
            outputTokens: 80,
            totalTokens: 180,
            totalPrice: 0.01,
            currentContext: 30_000,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        mockTokenUsageFromCheckpoint,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Math.max(50_000, 30_000) = 50_000 — checkpoint wins for total
      expect(result.total.currentContext).toBe(50_000);
    });

    it('Bug A.3 — both populated, messages higher: Math.max picks messages', async () => {
      // Checkpoint has lower currentContext than messages; messages must win.
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      const mockTokenUsageFromCheckpoint = {
        inputTokens: 100,
        outputTokens: 80,
        totalTokens: 180,
        totalPrice: 0.01,
        currentContext: 30_000,
        byNode: {
          'agent-1': {
            inputTokens: 100,
            outputTokens: 80,
            totalTokens: 180,
            totalPrice: 0.01,
            currentContext: 30_000,
          },
        },
      };

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-bugA3-1',
          nodeId: 'agent-1',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 100,
            outputTokens: 80,
            totalTokens: 180,
            totalPrice: 0.01,
            currentContext: 42_000,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        mockTokenUsageFromCheckpoint,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Math.max(30_000, 42_000) = 42_000 — messages win
      expect(result.total.currentContext).toBe(42_000);
    });

    it('Bug A: empty thread (no messages) + null checkpoint → currentContext stays 0, byNode stays empty', async () => {
      // New thread with no messages and no checkpoint yet written.
      // accumulateUsage never runs; messageTotalUsage stays at its zero seed.
      // Math.max(0 [checkpoint], 0 [messages]) = 0 — must NOT be seeded from an unrelated source.
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Running,
        externalThreadId: 'external-thread-123',
      });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue([]);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Empty thread: all totals must be zero (not NaN, not a stale value from elsewhere)
      expect(result.total.currentContext).toBe(0);
      expect(result.total.inputTokens).toBe(0);
      expect(result.total.outputTokens).toBe(0);
      expect(result.total.totalPrice).toBe(0);
      // byNode must be empty — no messages to scan
      expect(Object.keys(result.byNode).length).toBe(0);
    });

    it('Bug A: message with undefined currentContext + null checkpoint → accumulates to 0, not NaN', async () => {
      // A message entity where requestTokenUsage omits the currentContext field entirely.
      // Without the `?? 0` guard in accumulateUsage, Math.max(0, undefined) === NaN,
      // which then propagates to the final result and breaks downstream consumers.
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-bugA-undef-1',
          nodeId: 'node-alpha',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 150,
            outputTokens: 60,
            totalTokens: 210,
            totalPrice: 0.015,
            // currentContext intentionally absent — tests the `?? 0` guard
          } as unknown as MessageEntity['requestTokenUsage'],
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // The `?? 0` guard converts undefined → 0 before Math.max, so result is 0 (not NaN)
      expect(result.total.currentContext).toBe(0);
      expect(Number.isFinite(result.total.currentContext)).toBe(true);
      // The rest of the usage fields should be accumulated normally from the message
      expect(result.total.inputTokens).toBe(150);
    });

    it('Bug A adversarial: message with NaN currentContext poisons the accumulator via Math.max', async () => {
      // Unlike undefined (caught by `?? 0`), NaN passes through nullish coalescing:
      // `NaN ?? 0 === NaN`. So Math.max(0, NaN) === NaN, poisoning messageTotalUsage.currentContext.
      // The reconciliation Math.max(totalUsage.currentContext ?? 0, NaN) then returns NaN,
      // breaking downstream consumers (e.g. serialisation, rendering, thresholds).
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-nan-1',
          nodeId: 'node-alpha',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            totalPrice: 0.01,
            currentContext: NaN,
          } as unknown as MessageEntity['requestTokenUsage'],
        }),
        createMockMessageEntity({
          id: 'msg-nan-2',
          nodeId: 'node-beta',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 200,
            outputTokens: 80,
            totalTokens: 280,
            totalPrice: 0.02,
            currentContext: 50_000,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // NaN poisons Math.max in accumulateUsage; the fix requires an isFinite guard.
      // Without the fix, result.total.currentContext === NaN (not a finite number).
      expect(Number.isFinite(result.total.currentContext)).toBe(true);
      // msg-1 has NaN → toFinite(NaN) = 0; msg-2 has 50_000 → Math.max(0, 50_000) = 50_000
      expect(result.total.currentContext).toBe(50_000);
      // Additive fields must not be corrupted by the NaN
      expect(result.total.inputTokens).toBe(300);
    });

    it('Bug A adversarial: all-NaN currentContext + null checkpoint → result must remain finite', async () => {
      // Worst case: every message has NaN currentContext and checkpoint is null.
      // Accumulator starts at 0; first Math.max(0, NaN) = NaN; result propagates NaN to output.
      // Downstream code that computes `currentContext > threshold` breaks silently.
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Running,
        externalThreadId: 'external-thread-123',
      });

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-allnan-1',
          nodeId: 'node-gamma',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 50,
            outputTokens: 25,
            totalTokens: 75,
            totalPrice: 0.005,
            currentContext: NaN,
          } as unknown as MessageEntity['requestTokenUsage'],
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // Must not return NaN — the accumulator must clamp NaN to a finite value.
      expect(Number.isFinite(result.total.currentContext)).toBe(true);
      // Additive fields must accumulate correctly regardless of NaN context
      expect(result.total.inputTokens).toBe(50);
      expect(result.total.totalTokens).toBe(75);
    });

    it('B-MED-1: accumulateByNode normalises NaN currentContext via toFinite (sibling-consistent with accumulateUsage)', async () => {
      // Deletion test: removing the toFinite + Math.max change in Step 7 (threads.service.ts)
      // must break this test, reverting to the bare ?? 0 which does not handle NaN.
      // Two messages share the same nodeId='node-x':
      //   msg-1: currentContext = NaN  → toFinite(NaN) = 0
      //   msg-2: currentContext = 100  → toFinite(100) = 100
      //   Math.max(0, 100) = 100       → byNode['node-x'].currentContext === 100
      // Without toFinite: NaN ?? 0 = NaN (nullish coalescing does not catch NaN),
      // and NaN propagates into byNode['node-x'].currentContext, breaking downstream display.
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
        externalThreadId: 'external-thread-123',
      });

      const mockMessages = [
        createMockMessageEntity({
          id: 'msg-bmed1-1',
          nodeId: 'node-x',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            totalPrice: 0.01,
            currentContext: NaN,
          } as unknown as MessageEntity['requestTokenUsage'],
        }),
        createMockMessageEntity({
          id: 'msg-bmed1-2',
          nodeId: 'node-x',
          role: MessageRole.AI,
          name: undefined,
          requestTokenUsage: {
            inputTokens: 200,
            outputTokens: 80,
            totalTokens: 280,
            totalPrice: 0.02,
            currentContext: 100,
          },
        }),
      ];

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue(mockMessages);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const result = await service.getThreadUsageStatistics(
        mockCtx,
        mockThreadId,
      );

      // toFinite(NaN)=0, toFinite(100)=100; Math.max(0, 100)=100 — not NaN, not 0
      expect(result.byNode['node-x']).toBeDefined();
      expect(result.byNode['node-x']!.currentContext).toBe(100);
      expect(Number.isFinite(result.byNode['node-x']!.currentContext)).toBe(
        true,
      );
    });
  });

  describe('stopThread', () => {
    it('should stop thread via agent event chain when stopThreadExecution returns true', async () => {
      const thread = createMockThreadEntity({ status: ThreadStatus.Running });

      vi.mocked(threadsDao.getOne).mockResolvedValue(thread);
      vi.mocked(graphsService.stopThreadExecution).mockResolvedValue(true);

      const result = await service.stopThread(mockCtx, mockThreadId);

      expect(graphsService.stopThreadExecution).toHaveBeenCalledWith(
        thread.graphId,
        thread.externalThreadId,
        'Graph execution was stopped',
      );
      // When stopped via event chain, no direct DB update or notification emit
      expect(threadsDao.updateById).not.toHaveBeenCalled();
      expect(notificationsService.emit).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        id: mockThreadId,
        status: ThreadStatus.Running,
      });
    });

    it('should fall back to direct DB update when stopThreadExecution returns false', async () => {
      const thread = createMockThreadEntity({ status: ThreadStatus.Running });
      const updatedThread = createMockThreadEntity({
        status: ThreadStatus.Stopped,
      });

      vi.mocked(threadsDao.getOne).mockResolvedValue(thread);
      vi.mocked(graphsService.stopThreadExecution).mockResolvedValue(false);
      vi.mocked(threadsDao.updateById).mockResolvedValue(undefined as never);
      vi.mocked(threadsDao.getById).mockResolvedValue(updatedThread);

      const result = await service.stopThread(mockCtx, mockThreadId);

      // The direct-DB fallback also clears stale cost-limit metadata so a
      // manual stop after an auto-stop doesn't leave a stale stopReason.
      expect(threadsDao.updateById).toHaveBeenCalledWith(mockThreadId, {
        status: ThreadStatus.Stopped,
        metadata: expect.any(Object),
      });
      expect(notificationsService.emit).toHaveBeenCalledWith({
        type: NotificationEvent.ThreadUpdate,
        graphId: thread.graphId,
        threadId: thread.externalThreadId,
        data: {
          status: ThreadStatus.Stopped,
          stopReason: null,
          stopCostUsd: null,
          costLimitHit: null,
        },
      });
      expect(result).toMatchObject({
        id: mockThreadId,
        status: ThreadStatus.Stopped,
      });
    });

    it('should fall back to direct DB update when stopThreadExecution throws', async () => {
      const thread = createMockThreadEntity({ status: ThreadStatus.Running });
      const updatedThread = createMockThreadEntity({
        status: ThreadStatus.Stopped,
      });

      vi.mocked(threadsDao.getOne).mockResolvedValue(thread);
      vi.mocked(graphsService.stopThreadExecution).mockRejectedValue(
        new Error('Graph runtime error'),
      );
      vi.mocked(threadsDao.updateById).mockResolvedValue(undefined as never);
      vi.mocked(threadsDao.getById).mockResolvedValue(updatedThread);

      const result = await service.stopThread(mockCtx, mockThreadId);

      expect(threadsDao.updateById).toHaveBeenCalledWith(mockThreadId, {
        status: ThreadStatus.Stopped,
        metadata: expect.any(Object),
      });
      expect(notificationsService.emit).toHaveBeenCalledWith({
        type: NotificationEvent.ThreadUpdate,
        graphId: thread.graphId,
        threadId: thread.externalThreadId,
        data: {
          status: ThreadStatus.Stopped,
          stopReason: null,
          stopCostUsd: null,
          costLimitHit: null,
        },
      });
      expect(result).toMatchObject({
        id: mockThreadId,
        status: ThreadStatus.Stopped,
      });
    });

    it('should return early if thread is not running', async () => {
      const thread = createMockThreadEntity({ status: ThreadStatus.Done });

      vi.mocked(threadsDao.getOne).mockResolvedValue(thread);

      const result = await service.stopThread(mockCtx, mockThreadId);

      expect(graphsService.stopThreadExecution).not.toHaveBeenCalled();
      expect(threadsDao.updateById).not.toHaveBeenCalled();
      expect(notificationsService.emit).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        id: mockThreadId,
        status: ThreadStatus.Done,
      });
    });

    it('should throw NotFoundException when thread not found', async () => {
      vi.mocked(threadsDao.getOne).mockResolvedValue(null);

      await expect(service.stopThread(mockCtx, mockThreadId)).rejects.toThrow(
        '[THREAD_NOT_FOUND] An exception has occurred',
      );

      expect(graphsService.stopThreadExecution).not.toHaveBeenCalled();
    });
  });

  describe('streamThreadExport', () => {
    function collectStream(
      stream: import('stream').PassThrough,
    ): Promise<string> {
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () =>
          resolve(Buffer.concat(chunks).toString('utf-8')),
        );
        stream.on('error', reject);
      });
    }

    const mockGraphRow = {
      id: mockGraphId,
      name: 'Test Graph',
      description: 'A test graph',
    };

    const mockGraphSchema = {
      schema: {
        nodes: [
          { id: 'node-1', template: 'simple-agent', config: {} },
          { id: 'node-2', template: 'manual-trigger', config: {} },
        ],
        edges: [{ from: 'node-2', to: 'node-1' }],
      },
      metadata: {},
      agents: [],
    };

    it('happy path — stopped thread produces valid JSON export', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
      });
      const mockMessages = [
        createMockMessageEntity({ id: 'msg-1' }),
        createMockMessageEntity({ id: 'msg-2' }),
        createMockMessageEntity({ id: 'msg-3' }),
      ];

      // getThreadUsageStatistics internally calls threadsDao.getOne — must mock it
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll')
        .mockResolvedValueOnce(mockMessages) // usage stats call
        .mockResolvedValueOnce(mockMessages) // first export page
        .mockResolvedValueOnce([]); // second page (end)
      vi.spyOn(graphDao, 'getSchemaAndMetadata').mockResolvedValue(
        new Map([[mockGraphId, mockGraphSchema]]),
      );
      vi.spyOn(graphDao, 'getAll').mockResolvedValue([mockGraphRow as never]);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const stream = new (await import('stream')).PassThrough();
      const outputPromise = collectStream(stream);
      await (service as any).streamThreadExport(mockCtx, mockThread, stream);
      const output = await outputPromise;

      const parsed = JSON.parse(output);
      expect(parsed.version).toBe('1');
      expect(parsed.isRunning).toBe(false);
      expect(parsed.messages).toHaveLength(3);
      expect(parsed.graph).not.toBeNull();
      expect(parsed.graph.id).toBe(mockGraphId);
      expect(parsed.usageStatistics).toMatchObject({
        requests: expect.any(Number),
        total: expect.objectContaining({ totalTokens: expect.any(Number) }),
      });
      expect(parsed.exportedAt).toBeDefined();
      expect(parsed.thread).toMatchObject({ id: mockThreadId });
    });

    it('sets isRunning: true for a running thread', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Running,
      });

      // getThreadUsageStatistics internally calls threadsDao.getOne — must mock it
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue([]);
      vi.spyOn(graphDao, 'getSchemaAndMetadata').mockResolvedValue(new Map());
      vi.spyOn(graphDao, 'getAll').mockResolvedValue([]);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const stream = new (await import('stream')).PassThrough();
      const outputPromise = collectStream(stream);
      await (service as any).streamThreadExport(mockCtx, mockThread, stream);
      const output = await outputPromise;

      const parsed = JSON.parse(output);
      expect(parsed.isRunning).toBe(true);
    });

    it('sets graph: null when graph has been deleted', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
      });

      // getThreadUsageStatistics internally calls threadsDao.getOne — must mock it
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue([]);
      vi.spyOn(graphDao, 'getSchemaAndMetadata').mockResolvedValue(new Map());
      vi.spyOn(graphDao, 'getAll').mockResolvedValue([]);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const stream = new (await import('stream')).PassThrough();
      const outputPromise = collectStream(stream);
      await (service as any).streamThreadExport(mockCtx, mockThread, stream);
      const output = await outputPromise;

      const parsed = JSON.parse(output);
      expect(parsed.graph).toBeNull();
    });

    it('paginates messages — fetches multiple pages until exhausted (700 messages)', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
      });

      const page1 = Array.from({ length: 500 }, (_, i) =>
        createMockMessageEntity({ id: `msg-${i}` }),
      );
      const page2 = Array.from({ length: 200 }, (_, i) =>
        createMockMessageEntity({ id: `msg-${500 + i}` }),
      );

      // getThreadUsageStatistics internally calls threadsDao.getOne — must mock it
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      // getAll is called by: getThreadUsageStatistics (projection call), then pagination.
      // page2 has 200 items < PAGE_SIZE (500), so pagination stops after page2 (no 3rd fetch).
      vi.spyOn(messagesDao, 'getAll')
        .mockResolvedValueOnce([]) // usage statistics messages fetch
        .mockResolvedValueOnce(page1) // export page 1 (500 messages → full page, continue)
        .mockResolvedValueOnce(page2); // export page 2 (200 messages < PAGE_SIZE → stop)
      vi.spyOn(graphDao, 'getSchemaAndMetadata').mockResolvedValue(new Map());
      vi.spyOn(graphDao, 'getAll').mockResolvedValue([]);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const stream = new (await import('stream')).PassThrough();
      const outputPromise = collectStream(stream);
      await (service as any).streamThreadExport(mockCtx, mockThread, stream);
      const output = await outputPromise;

      const parsed = JSON.parse(output);
      expect(parsed.messages).toHaveLength(700);
      // Called 3 times total: 1 for usage stats + 2 for pagination (page2 < PAGE_SIZE → no 3rd page)
      expect(messagesDao.getAll).toHaveBeenCalledTimes(3);
    });

    it('scrubs secret-like keys from node configs in the graph snapshot', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
      });

      const schemaWithSecrets = {
        schema: {
          nodes: [
            {
              id: 'node-1',
              template: 'simple-agent',
              config: {
                name: 'My Agent',
                apiKey: 'sk-secret',
                githubToken: 'ghp_abc',
                systemPrompt: 'You are helpful',
              },
            },
          ],
          edges: [],
        },
        metadata: {},
        agents: [],
      };

      // getThreadUsageStatistics internally calls threadsDao.getOne — must mock it
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue([]);
      vi.spyOn(graphDao, 'getSchemaAndMetadata').mockResolvedValue(
        new Map([[mockGraphId, schemaWithSecrets]]),
      );
      vi.spyOn(graphDao, 'getAll').mockResolvedValue([mockGraphRow as never]);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const stream = new (await import('stream')).PassThrough();
      const outputPromise = collectStream(stream);
      await (service as any).streamThreadExport(mockCtx, mockThread, stream);
      const output = await outputPromise;

      const parsed = JSON.parse(output);
      const nodeConfig = parsed.graph.nodes[0].config;

      expect(nodeConfig).not.toHaveProperty('apiKey');
      expect(nodeConfig).not.toHaveProperty('githubToken');
      expect(nodeConfig).toMatchObject({
        name: 'My Agent',
        systemPrompt: 'You are helpful',
      });
    });
  });

  describe('getThreadExportFile', () => {
    it('throws NotFoundException when thread not found', async () => {
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(null);

      await expect(
        service.getThreadExportFile(mockCtx, mockThreadId),
      ).rejects.toThrow('[THREAD_NOT_FOUND] An exception has occurred');
    });

    it('throws NotFoundException for another user thread (wrong createdBy filter)', async () => {
      // DAO returns null when createdBy filter does not match
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(null);

      const otherCtx = {
        checkSub: vi.fn().mockReturnValue('other-user-id'),
      } as unknown as AppContextStorage;

      await expect(
        service.getThreadExportFile(otherCtx, mockThreadId),
      ).rejects.toThrow('[THREAD_NOT_FOUND] An exception has occurred');

      expect(threadsDao.getOne).toHaveBeenCalledWith({
        id: mockThreadId,
        createdBy: 'other-user-id',
      });
    });

    it('returns a StreamableFile for a valid thread', async () => {
      const mockThread = createMockThreadEntity({ status: ThreadStatus.Done });
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(messagesDao, 'getAll').mockResolvedValue([]);
      vi.spyOn(graphDao, 'getSchemaAndMetadata').mockResolvedValue(new Map());
      vi.spyOn(graphDao, 'getAll').mockResolvedValue([]);
      vi.spyOn(checkpointStateService, 'getThreadTokenUsage').mockResolvedValue(
        null,
      );

      const result = await service.getThreadExportFile(mockCtx, mockThreadId);
      expect(result).toBeInstanceOf(StreamableFile);
      expect(result.getHeaders()).toMatchObject({
        type: 'application/json',
        disposition: expect.stringMatching(
          /^attachment; filename="thread-export-\d{4}-\d{2}-\d{2}\.json"$/,
        ),
      });
    });
  });

  describe('resumeThread', () => {
    it('should throw NotFoundException when thread not found', async () => {
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(null);

      await expect(
        service.resumeThread(mockCtx, mockThreadId, {}),
      ).rejects.toThrow('[THREAD_NOT_FOUND] An exception has occurred');
    });

    it('should throw BadRequestException when thread is not waiting', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Running,
      });
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);

      await expect(
        service.resumeThread(mockCtx, mockThreadId, {}),
      ).rejects.toThrow('Thread is not in waiting state');
    });

    it('should call resumeEarly and return updated thread', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Waiting,
      });
      const updatedThread = createMockThreadEntity({
        status: ThreadStatus.Running,
      });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(threadsDao, 'getById').mockResolvedValue(updatedThread);
      vi.spyOn(threadResumeService, 'resumeEarly').mockResolvedValue(undefined);

      const result = await service.resumeThread(mockCtx, mockThreadId, {});

      expect(threadResumeService.resumeEarly).toHaveBeenCalledWith(
        mockThreadId,
        undefined,
      );
      expect(result.id).toBe(mockThreadId);
    });

    it('should pass optional message to resumeEarly', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Waiting,
      });
      const updatedThread = createMockThreadEntity({
        status: ThreadStatus.Running,
      });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(threadsDao, 'getById').mockResolvedValue(updatedThread);
      vi.spyOn(threadResumeService, 'resumeEarly').mockResolvedValue(undefined);

      await service.resumeThread(mockCtx, mockThreadId, {
        message: 'Custom resume message',
      });

      expect(threadResumeService.resumeEarly).toHaveBeenCalledWith(
        mockThreadId,
        'Custom resume message',
      );
    });

    it('should not allow resuming another user thread', async () => {
      const otherCtx = {
        checkSub: vi.fn().mockReturnValue('other-user-id'),
      } as unknown as AppContextStorage;

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(null);

      await expect(
        service.resumeThread(otherCtx, mockThreadId, {}),
      ).rejects.toThrow('[THREAD_NOT_FOUND] An exception has occurred');
    });
  });

  describe('cancelWait', () => {
    it('should throw NotFoundException when thread not found', async () => {
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(null);

      await expect(service.cancelWait(mockCtx, mockThreadId)).rejects.toThrow(
        '[THREAD_NOT_FOUND] An exception has occurred',
      );
    });

    it('should throw BadRequestException when thread is not waiting', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Done,
      });
      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);

      await expect(service.cancelWait(mockCtx, mockThreadId)).rejects.toThrow(
        'Thread is not in waiting state',
      );
    });

    it('should call cancelWait and return updated thread', async () => {
      const mockThread = createMockThreadEntity({
        status: ThreadStatus.Waiting,
      });
      const updatedThread = createMockThreadEntity({
        status: ThreadStatus.Stopped,
      });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(mockThread);
      vi.spyOn(threadsDao, 'getById').mockResolvedValue(updatedThread);
      vi.spyOn(threadResumeService, 'cancelWait').mockResolvedValue(undefined);

      const result = await service.cancelWait(mockCtx, mockThreadId);

      expect(threadResumeService.cancelWait).toHaveBeenCalledWith(mockThreadId);
      expect(result.id).toBe(mockThreadId);
    });

    it('should not allow cancelling another user thread', async () => {
      const otherCtx = {
        checkSub: vi.fn().mockReturnValue('other-user-id'),
      } as unknown as AppContextStorage;

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(null);

      await expect(service.cancelWait(otherCtx, mockThreadId)).rejects.toThrow(
        '[THREAD_NOT_FOUND] An exception has occurred',
      );
    });
  });
});
