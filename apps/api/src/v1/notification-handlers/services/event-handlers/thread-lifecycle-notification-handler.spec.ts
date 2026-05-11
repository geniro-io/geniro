import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphDao } from '../../../graphs/dao/graph.dao';
import { GraphEntity } from '../../../graphs/entity/graph.entity';
import { GraphStatus } from '../../../graphs/graphs.types';
import {
  IThreadCreateNotification,
  IThreadDeleteNotification,
  NotificationEvent,
} from '../../../notifications/notifications.types';
import { ThreadDto } from '../../../threads/dto/threads.dto';
import { ThreadEntity } from '../../../threads/entity/thread.entity';
import { ThreadsService } from '../../../threads/services/threads.service';
import { ThreadStatus } from '../../../threads/threads.types';
import { NotificationScope } from '../../notification-handlers.types';
import { ThreadLifecycleNotificationHandler } from './thread-lifecycle-notification-handler';

const toThreadDto = (entity: ThreadEntity): ThreadDto => ({
  id: entity.id,
  graphId: entity.graphId,
  externalThreadId: entity.externalThreadId,
  lastRunId: entity.lastRunId ?? null,
  createdAt: entity.createdAt.toISOString(),
  updatedAt: entity.updatedAt.toISOString(),
  metadata: entity.metadata ?? {},
  source: entity.source ?? null,
  name: entity.name ?? null,
  status: entity.status,
  runningStartedAt: null,
  totalRunningMs: 0,
});

describe('ThreadLifecycleNotificationHandler', () => {
  let handler: ThreadLifecycleNotificationHandler;
  let graphDao: GraphDao;
  let threadsServiceMock: {
    prepareThreadResponse: ReturnType<typeof vi.fn>;
  };

  const mockGraphId = '22222222-2222-4222-8aaa-222222222222';
  const mockOwnerId = 'user-123';
  const mockThreadId = 'external-thread-123';
  const mockInternalThreadId = '11111111-1111-4111-8aaa-111111111111';

  const createMockThreadEntity = (
    overrides: Partial<ThreadEntity> = {},
  ): ThreadEntity =>
    ({
      id: mockInternalThreadId,
      graphId: mockGraphId,
      createdBy: mockOwnerId,
      projectId: 'project-abc',
      externalThreadId: mockThreadId,
      lastRunId: undefined,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z'),
      deletedAt: null,
      metadata: {},
      source: undefined,
      name: undefined,
      status: ThreadStatus.Running,
      ...overrides,
    }) as unknown as ThreadEntity;

  const mockProjectId = 'project-abc';

  beforeEach(async () => {
    const mockGraph = {
      id: mockGraphId,
      createdBy: mockOwnerId,
      projectId: mockProjectId,
      name: 'Graph',
      description: 'Desc',
      version: '1.0.0',
      targetVersion: '1.0.0',
      schema: { nodes: [], edges: [] },
      status: GraphStatus.Created,
      temporary: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      error: undefined,
    } as unknown as GraphEntity;

    threadsServiceMock = {
      prepareThreadResponse: vi
        .fn<(entity: ThreadEntity) => Promise<ThreadDto>>()
        .mockImplementation(async (entity: ThreadEntity) =>
          toThreadDto(entity),
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadLifecycleNotificationHandler,
        {
          provide: GraphDao,
          useValue: {
            getOne: vi.fn().mockResolvedValue(mockGraph),
          },
        },
        {
          provide: ThreadsService,
          useValue: threadsServiceMock,
        },
      ],
    }).compile();

    handler = module.get<ThreadLifecycleNotificationHandler>(
      ThreadLifecycleNotificationHandler,
    );
    graphDao = module.get<GraphDao>(GraphDao);
  });

  describe('pattern', () => {
    it('should handle ThreadCreate and ThreadDelete events', () => {
      expect(handler.pattern).toEqual([
        NotificationEvent.ThreadCreate,
        NotificationEvent.ThreadDelete,
      ]);
    });
  });

  describe('ThreadCreate', () => {
    it('emits full thread info for newly created thread', async () => {
      const thread = createMockThreadEntity();
      const notification: IThreadCreateNotification = {
        type: NotificationEvent.ThreadCreate,
        graphId: mockGraphId,
        threadId: mockThreadId,
        internalThreadId: mockInternalThreadId,
        data: thread,
      };

      const result = await handler.handle(notification);

      expect(graphDao.getOne).toHaveBeenCalledWith({ id: mockGraphId });
      expect(threadsServiceMock.prepareThreadResponse).toHaveBeenCalledWith(
        thread,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: NotificationEvent.ThreadCreate,
        graphId: mockGraphId,
        projectId: mockProjectId,
        ownerId: mockOwnerId,
        threadId: mockThreadId,
        internalThreadId: mockInternalThreadId,
        scope: [NotificationScope.Graph],
        data: toThreadDto(thread),
      });
    });

    it('includes source when thread has source', async () => {
      const thread = createMockThreadEntity({
        source: 'manual-trigger (trigger)',
      });
      const notification: IThreadCreateNotification = {
        type: NotificationEvent.ThreadCreate,
        graphId: mockGraphId,
        threadId: mockThreadId,
        internalThreadId: mockInternalThreadId,
        data: thread,
      };

      const result = await handler.handle(notification);

      expect(result[0]?.data.source).toBe('manual-trigger (trigger)');
    });

    it('includes name when thread has name', async () => {
      const thread = createMockThreadEntity({ name: 'Thread Name' });
      const notification: IThreadCreateNotification = {
        type: NotificationEvent.ThreadCreate,
        graphId: mockGraphId,
        threadId: mockThreadId,
        internalThreadId: mockInternalThreadId,
        data: thread,
      };

      const result = await handler.handle(notification);

      expect(result[0]?.data.name).toBe('Thread Name');
    });

    it('throws error when graph not found', async () => {
      vi.spyOn(graphDao, 'getOne').mockResolvedValue(null);

      const notification: IThreadCreateNotification = {
        type: NotificationEvent.ThreadCreate,
        graphId: mockGraphId,
        threadId: mockThreadId,
        internalThreadId: mockInternalThreadId,
        data: createMockThreadEntity(),
      };

      await expect(handler.handle(notification)).rejects.toThrow(
        `Graph ${mockGraphId} not found`,
      );
      expect(threadsServiceMock.prepareThreadResponse).not.toHaveBeenCalled();
    });
  });

  describe('ThreadDelete', () => {
    it('emits full thread info for deleted thread', async () => {
      const thread = createMockThreadEntity();
      const notification: IThreadDeleteNotification = {
        type: NotificationEvent.ThreadDelete,
        graphId: mockGraphId,
        threadId: mockThreadId,
        internalThreadId: mockInternalThreadId,
        data: thread,
      };

      const result = await handler.handle(notification);

      expect(graphDao.getOne).toHaveBeenCalledWith({ id: mockGraphId });
      expect(threadsServiceMock.prepareThreadResponse).toHaveBeenCalledWith(
        thread,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: NotificationEvent.ThreadDelete,
        graphId: mockGraphId,
        projectId: mockProjectId,
        ownerId: mockOwnerId,
        threadId: mockThreadId,
        internalThreadId: mockInternalThreadId,
        scope: [NotificationScope.Graph],
        data: toThreadDto(thread),
      });
    });

    it('throws error when graph not found', async () => {
      vi.spyOn(graphDao, 'getOne').mockResolvedValue(null);

      const notification: IThreadDeleteNotification = {
        type: NotificationEvent.ThreadDelete,
        graphId: mockGraphId,
        threadId: mockThreadId,
        internalThreadId: mockInternalThreadId,
        data: createMockThreadEntity(),
      };

      await expect(handler.handle(notification)).rejects.toThrow(
        `Graph ${mockGraphId} not found`,
      );
      expect(threadsServiceMock.prepareThreadResponse).not.toHaveBeenCalled();
    });
  });
});
