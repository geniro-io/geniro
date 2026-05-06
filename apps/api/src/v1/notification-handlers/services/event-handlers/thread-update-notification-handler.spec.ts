import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphDao } from '../../../graphs/dao/graph.dao';
import { GraphEntity } from '../../../graphs/entity/graph.entity';
import { GraphStatus } from '../../../graphs/graphs.types';
import {
  IThreadUpdateNotification,
  NotificationEvent,
} from '../../../notifications/notifications.types';
import { ThreadsDao } from '../../../threads/dao/threads.dao';
import { ThreadDto } from '../../../threads/dto/threads.dto';
import { ThreadEntity } from '../../../threads/entity/thread.entity';
import { ThreadsService } from '../../../threads/services/threads.service';
import { ThreadStatus } from '../../../threads/threads.types';
import { NotificationScope } from '../../notification-handlers.types';
import {
  IThreadUpdateEnrichedNotification,
  ThreadUpdateNotificationHandler,
} from './thread-update-notification-handler';

describe('ThreadUpdateNotificationHandler', () => {
  let handler: ThreadUpdateNotificationHandler;
  let threadsDao: ThreadsDao;
  let graphDao: GraphDao;
  let threadsServiceMock: {
    prepareThreadResponse: ReturnType<typeof vi.fn>;
  };
  let threadDtoFactory: (thread: ThreadEntity) => ThreadDto;

  const mockGraphId = '22222222-2222-4222-8aaa-222222222222';
  const mockOwnerId = 'user-123';
  const mockProjectId = 'project-abc';
  const mockThreadId = 'external-thread-123';

  const createMockThreadEntity = (
    overrides: Partial<ThreadEntity> = {},
  ): ThreadEntity =>
    ({
      id: '11111111-1111-4111-8aaa-111111111111',
      graphId: mockGraphId,
      createdBy: mockOwnerId,
      projectId: 'project-abc',
      externalThreadId: mockThreadId,
      metadata: {},
      source: undefined,
      name: 'Thread Name',
      status: ThreadStatus.Running,
      lastRunId: undefined,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z'),
      deletedAt: null,
      ...overrides,
    }) as unknown as ThreadEntity;

  const createMockNotification = (
    overrides: Partial<IThreadUpdateNotification> = {},
  ): IThreadUpdateNotification => ({
    type: NotificationEvent.ThreadUpdate,
    graphId: mockGraphId,
    threadId: mockThreadId,
    data: {},
    ...overrides,
  });

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

    threadDtoFactory = (thread: ThreadEntity): ThreadDto => ({
      id: thread.id,
      graphId: thread.graphId,
      externalThreadId: thread.externalThreadId,
      lastRunId: thread.lastRunId ?? null,
      status: thread.status,
      name: thread.name ?? null,
      source: thread.source ?? null,
      metadata: thread.metadata ?? {},
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
    });

    threadsServiceMock = {
      prepareThreadResponse: vi
        .fn<(entity: ThreadEntity) => Promise<ThreadDto>>()
        .mockImplementation(async (entity: ThreadEntity) =>
          threadDtoFactory(entity),
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadUpdateNotificationHandler,
        {
          provide: ThreadsDao,
          useValue: {
            getOne: vi.fn(),
            updateById: vi.fn(),
          },
        },
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

    handler = module.get<ThreadUpdateNotificationHandler>(
      ThreadUpdateNotificationHandler,
    );
    threadsDao = module.get<ThreadsDao>(ThreadsDao);
    graphDao = module.get<GraphDao>(GraphDao);
  });

  const expectFullThreadPayload = (
    result: IThreadUpdateEnrichedNotification[],
    thread: ThreadEntity,
  ) => {
    expect(threadsServiceMock.prepareThreadResponse).toHaveBeenCalledWith(
      thread,
    );

    const expectedThread = threadDtoFactory(thread);

    expect(result).toEqual([
      {
        type: NotificationEvent.ThreadUpdate,
        graphId: mockGraphId,
        projectId: mockProjectId,
        ownerId: mockOwnerId,
        threadId: mockThreadId,
        internalThreadId: thread.id,
        scope: [NotificationScope.Graph],
        data: expectedThread,
      },
    ]);
  };

  describe('handle', () => {
    it('updates status and emits full thread info', async () => {
      const thread = createMockThreadEntity({ status: ThreadStatus.Running });
      const updatedThread = {
        ...thread,
        status: ThreadStatus.Stopped,
        updatedAt: new Date('2024-01-01T00:00:01Z'),
      } satisfies ThreadEntity;
      const notification = createMockNotification({
        data: { status: ThreadStatus.Stopped },
      });

      const getOneSpy = vi
        .spyOn(threadsDao, 'getOne')
        .mockResolvedValueOnce(thread)
        .mockResolvedValueOnce(updatedThread);
      const updateSpy = vi.spyOn(threadsDao, 'updateById').mockResolvedValue(1);

      const result = await handler.handle(notification);

      expect(graphDao.getOne).toHaveBeenCalledWith({ id: mockGraphId });
      expect(getOneSpy).toHaveBeenNthCalledWith(1, {
        externalThreadId: mockThreadId,
        graphId: mockGraphId,
      });
      expect(updateSpy).toHaveBeenCalledWith(thread.id, {
        status: ThreadStatus.Stopped,
      });
      expect(getOneSpy).toHaveBeenNthCalledWith(2, {
        id: thread.id,
        graphId: mockGraphId,
      });
      expectFullThreadPayload(result, updatedThread);
    });

    it('sets name when thread has no name yet', async () => {
      const thread = createMockThreadEntity({ name: undefined });
      const updatedThread = {
        ...thread,
        name: 'New Name',
        updatedAt: new Date('2024-01-01T00:00:01Z'),
      } satisfies ThreadEntity;
      const notification = createMockNotification({
        data: { name: 'New Name' },
      });

      const getOneSpy = vi
        .spyOn(threadsDao, 'getOne')
        .mockResolvedValueOnce(thread)
        .mockResolvedValueOnce(updatedThread);
      vi.spyOn(threadsDao, 'updateById').mockResolvedValue(1);

      const result = await handler.handle(notification);

      expect(getOneSpy).toHaveBeenNthCalledWith(1, {
        externalThreadId: mockThreadId,
        graphId: mockGraphId,
      });
      expect(threadsDao.updateById).toHaveBeenCalledWith(thread.id, {
        name: 'New Name',
      });
      expect(getOneSpy).toHaveBeenNthCalledWith(2, {
        id: thread.id,
        graphId: mockGraphId,
      });
      expectFullThreadPayload(result, updatedThread);
    });

    it('does not update name when thread already has a name', async () => {
      const thread = createMockThreadEntity({ name: 'Existing Name' });
      const notification = createMockNotification({
        data: { name: 'New Name Attempt' },
      });

      vi.spyOn(threadsDao, 'getOne')
        .mockResolvedValueOnce(thread)
        .mockResolvedValueOnce(thread);
      const updateSpy = vi.spyOn(threadsDao, 'updateById');

      const result = await handler.handle(notification);

      expect(updateSpy).not.toHaveBeenCalled();
      expectFullThreadPayload(result, thread);
    });

    it('emits full thread when no fields provided', async () => {
      const thread = createMockThreadEntity();
      const notification = createMockNotification({ data: {} });

      vi.spyOn(threadsDao, 'getOne')
        .mockResolvedValueOnce(thread)
        .mockResolvedValueOnce(thread);
      const updateSpy = vi.spyOn(threadsDao, 'updateById');

      const result = await handler.handle(notification);

      expect(updateSpy).not.toHaveBeenCalled();
      expectFullThreadPayload(result, thread);
    });

    it('returns empty array when thread not found', async () => {
      const notification = createMockNotification({
        data: { status: ThreadStatus.Stopped },
      });

      vi.spyOn(threadsDao, 'getOne').mockResolvedValue(null);

      const result = await handler.handle(notification);

      expect(result).toEqual([]);
    });

    it('treats missing parentThreadId as missing and uses threadId as external key', async () => {
      const thread = createMockThreadEntity({ status: ThreadStatus.Running });
      const updatedThread = {
        ...thread,
        status: ThreadStatus.Done,
        updatedAt: new Date('2024-01-01T00:00:01Z'),
      } satisfies ThreadEntity;

      const notification = createMockNotification({
        parentThreadId: undefined,
        data: { status: ThreadStatus.Done },
      });

      const getOneSpy = vi
        .spyOn(threadsDao, 'getOne')
        .mockResolvedValueOnce(thread)
        .mockResolvedValueOnce(updatedThread);

      vi.spyOn(threadsDao, 'updateById').mockResolvedValue(1);

      const result = await handler.handle(notification);

      expect(getOneSpy).toHaveBeenNthCalledWith(1, {
        externalThreadId: mockThreadId,
        graphId: mockGraphId,
      });

      expect(result).toHaveLength(1);
    });

    it('updates thread status when thread completes', async () => {
      const thread = createMockThreadEntity({
        status: ThreadStatus.Running,
      });

      const updatedThread = {
        ...thread,
        status: ThreadStatus.Done,
        updatedAt: new Date('2024-01-01T00:00:01Z'),
      } satisfies ThreadEntity;

      const notification = createMockNotification({
        data: { status: ThreadStatus.Done },
      });

      vi.spyOn(threadsDao, 'getOne')
        .mockResolvedValueOnce(thread)
        .mockResolvedValueOnce(updatedThread);

      const updateSpy = vi.spyOn(threadsDao, 'updateById').mockResolvedValue(1);

      await handler.handle(notification);

      // Token usage is no longer flushed to threads table
      // It's stored in checkpoint state only
      expect(updateSpy).toHaveBeenCalledWith(thread.id, {
        status: ThreadStatus.Done,
      });
    });

    it('clears wait metadata when transitioning from Waiting to Done', async () => {
      const waitMetadata = {
        scheduledResumeAt: '2026-04-02T10:00:00.000Z',
        waitReason: 'Waiting for CI',
        waitNodeId: 'node-123',
        waitCheckPrompt: 'Check CI status',
        customField: 'preserved',
      };
      const thread = createMockThreadEntity({
        status: ThreadStatus.Waiting,
        metadata: waitMetadata,
      });
      const updatedThread = {
        ...thread,
        status: ThreadStatus.Done,
        metadata: { customField: 'preserved' },
        updatedAt: new Date('2024-01-01T00:00:01Z'),
      } satisfies ThreadEntity;

      const notification = createMockNotification({
        data: { status: ThreadStatus.Done },
      });

      vi.spyOn(threadsDao, 'getOne')
        .mockResolvedValueOnce(thread)
        .mockResolvedValueOnce(updatedThread);

      const updateSpy = vi.spyOn(threadsDao, 'updateById').mockResolvedValue(1);

      await handler.handle(notification);

      expect(updateSpy).toHaveBeenCalledWith(thread.id, {
        status: ThreadStatus.Done,
        metadata: { customField: 'preserved' },
      });
    });

    it('does not clear metadata when thread is not in Waiting status', async () => {
      const thread = createMockThreadEntity({
        status: ThreadStatus.Running,
        metadata: { someField: 'value' },
      });
      const updatedThread = {
        ...thread,
        status: ThreadStatus.Done,
        updatedAt: new Date('2024-01-01T00:00:01Z'),
      } satisfies ThreadEntity;

      const notification = createMockNotification({
        data: { status: ThreadStatus.Done },
      });

      vi.spyOn(threadsDao, 'getOne')
        .mockResolvedValueOnce(thread)
        .mockResolvedValueOnce(updatedThread);

      const updateSpy = vi.spyOn(threadsDao, 'updateById').mockResolvedValue(1);

      await handler.handle(notification);

      expect(updateSpy).toHaveBeenCalledWith(thread.id, {
        status: ThreadStatus.Done,
      });
    });

    describe('stopReason three-way semantics', () => {
      it('persists stopReason string into metadata.stopReason', async () => {
        const thread = createMockThreadEntity({
          status: ThreadStatus.Running,
          metadata: { existingField: 'keep' },
        });
        const updatedThread = {
          ...thread,
          status: ThreadStatus.Stopped,
          metadata: { existingField: 'keep', stopReason: 'cost_limit' },
          updatedAt: new Date('2024-01-01T00:00:01Z'),
        } satisfies ThreadEntity;

        const notification = createMockNotification({
          data: {
            status: ThreadStatus.Stopped,
            stopReason: 'cost_limit',
          },
        });

        vi.spyOn(threadsDao, 'getOne')
          .mockResolvedValueOnce(thread)
          .mockResolvedValueOnce(updatedThread);
        const updateSpy = vi
          .spyOn(threadsDao, 'updateById')
          .mockResolvedValue(1);

        await handler.handle(notification);

        expect(updateSpy).toHaveBeenCalledWith(thread.id, {
          status: ThreadStatus.Stopped,
          // M4: costLimitHit must be set to true whenever stopReason='cost_limit'
          metadata: {
            existingField: 'keep',
            stopReason: 'cost_limit',
            costLimitHit: true,
          },
        });
      });

      it('leaves metadata.stopReason untouched when stopReason is undefined (key absent)', async () => {
        const thread = createMockThreadEntity({
          status: ThreadStatus.Running,
          metadata: { stopReason: 'prior_reason', other: 'value' },
        });
        const updatedThread = {
          ...thread,
          status: ThreadStatus.Done,
          updatedAt: new Date('2024-01-01T00:00:01Z'),
        } satisfies ThreadEntity;

        const notification = createMockNotification({
          data: { status: ThreadStatus.Done },
        });

        vi.spyOn(threadsDao, 'getOne')
          .mockResolvedValueOnce(thread)
          .mockResolvedValueOnce(updatedThread);
        const updateSpy = vi
          .spyOn(threadsDao, 'updateById')
          .mockResolvedValue(1);

        await handler.handle(notification);

        // Since stopReason key is absent, metadata should not appear in updates
        expect(updateSpy).toHaveBeenCalledWith(thread.id, {
          status: ThreadStatus.Done,
        });
      });

      it('deletes metadata.stopReason when stopReason is explicitly null', async () => {
        const thread = createMockThreadEntity({
          status: ThreadStatus.Running,
          metadata: {
            stopReason: 'cost_limit',
            preservedField: 'keep-me',
          },
        });
        const updatedThread = {
          ...thread,
          status: ThreadStatus.Stopped,
          metadata: { preservedField: 'keep-me' },
          updatedAt: new Date('2024-01-01T00:00:01Z'),
        } satisfies ThreadEntity;

        const notification = createMockNotification({
          data: {
            status: ThreadStatus.Stopped,
            stopReason: null,
          },
        });

        vi.spyOn(threadsDao, 'getOne')
          .mockResolvedValueOnce(thread)
          .mockResolvedValueOnce(updatedThread);
        const updateSpy = vi
          .spyOn(threadsDao, 'updateById')
          .mockResolvedValue(1);

        await handler.handle(notification);

        expect(updateSpy).toHaveBeenCalledWith(thread.id, {
          status: ThreadStatus.Stopped,
          metadata: { preservedField: 'keep-me' },
        });
      });

      it('clears wait keys AND sets stopReason when transitioning Waiting -> Stopped with stopReason=cost_limit', async () => {
        const waitMetadata = {
          scheduledResumeAt: '2026-04-02T10:00:00.000Z',
          waitReason: 'Waiting for CI',
          waitNodeId: 'node-abc',
          waitCheckPrompt: 'Check CI status',
          keepMe: 'preserved',
        };
        const thread = createMockThreadEntity({
          status: ThreadStatus.Waiting,
          metadata: waitMetadata,
        });
        const updatedThread = {
          ...thread,
          status: ThreadStatus.Stopped,
          metadata: { keepMe: 'preserved', stopReason: 'cost_limit' },
          updatedAt: new Date('2024-01-01T00:00:01Z'),
        } satisfies ThreadEntity;

        const notification = createMockNotification({
          data: {
            status: ThreadStatus.Stopped,
            stopReason: 'cost_limit',
          },
        });

        vi.spyOn(threadsDao, 'getOne')
          .mockResolvedValueOnce(thread)
          .mockResolvedValueOnce(updatedThread);
        const updateSpy = vi
          .spyOn(threadsDao, 'updateById')
          .mockResolvedValue(1);

        await handler.handle(notification);

        expect(updateSpy).toHaveBeenCalledWith(thread.id, {
          status: ThreadStatus.Stopped,
          metadata: {
            keepMe: 'preserved',
            stopReason: 'cost_limit',
            // M4: costLimitHit must also be set so resume guard survives a
            // subsequent manual-stop that clears stopReason.
            costLimitHit: true,
          },
        });
      });
    });

    describe('costLimitHit three-way semantics', () => {
      it('clears metadata.costLimitHit when data.costLimitHit === null', async () => {
        const thread = createMockThreadEntity({
          status: ThreadStatus.Running,
          metadata: { costLimitHit: true, preservedField: 'keep-me' },
        });
        const updatedThread = {
          ...thread,
          metadata: { preservedField: 'keep-me' },
          updatedAt: new Date('2024-01-01T00:00:01Z'),
        } satisfies ThreadEntity;

        const notification = createMockNotification({
          data: { costLimitHit: null },
        });

        vi.spyOn(threadsDao, 'getOne')
          .mockResolvedValueOnce(thread)
          .mockResolvedValueOnce(updatedThread);
        const updateSpy = vi
          .spyOn(threadsDao, 'updateById')
          .mockResolvedValue(1);

        await handler.handle(notification);

        expect(updateSpy).toHaveBeenCalledOnce();
        const callArgs = updateSpy.mock.calls[0]![1] as {
          metadata: Record<string, unknown>;
        };
        expect(callArgs.metadata).toBeDefined();
        expect(callArgs.metadata).not.toHaveProperty('costLimitHit');
        expect(callArgs.metadata).toMatchObject({ preservedField: 'keep-me' });
      });

      it('sets metadata.costLimitHit when data.costLimitHit === true', async () => {
        const thread = createMockThreadEntity({
          status: ThreadStatus.Running,
          metadata: { existingField: 'keep' },
        });
        const updatedThread = {
          ...thread,
          metadata: { existingField: 'keep', costLimitHit: true },
          updatedAt: new Date('2024-01-01T00:00:01Z'),
        } satisfies ThreadEntity;

        const notification = createMockNotification({
          data: { costLimitHit: true },
        });

        vi.spyOn(threadsDao, 'getOne')
          .mockResolvedValueOnce(thread)
          .mockResolvedValueOnce(updatedThread);
        const updateSpy = vi
          .spyOn(threadsDao, 'updateById')
          .mockResolvedValue(1);

        await handler.handle(notification);

        expect(updateSpy).toHaveBeenCalledOnce();
        const callArgs = updateSpy.mock.calls[0]![1] as {
          metadata: Record<string, unknown>;
        };
        expect(callArgs.metadata).toBeDefined();
        expect(updateSpy).toHaveBeenCalledWith(thread.id, {
          metadata: { existingField: 'keep', costLimitHit: true },
        });
      });
    });

    describe('stopCostUsd three-way semantics', () => {
      it('persists stopCostUsd number into metadata.stopCostUsd', async () => {
        const thread = createMockThreadEntity({
          status: ThreadStatus.Running,
          metadata: { existingField: 'keep' },
        });
        const updatedThread = {
          ...thread,
          status: ThreadStatus.Stopped,
          metadata: { existingField: 'keep', stopCostUsd: 1.03 },
          updatedAt: new Date('2024-01-01T00:00:01Z'),
        } satisfies ThreadEntity;

        const notification = createMockNotification({
          data: {
            status: ThreadStatus.Stopped,
            stopCostUsd: 1.03,
          },
        });

        vi.spyOn(threadsDao, 'getOne')
          .mockResolvedValueOnce(thread)
          .mockResolvedValueOnce(updatedThread);
        const updateSpy = vi
          .spyOn(threadsDao, 'updateById')
          .mockResolvedValue(1);

        await handler.handle(notification);

        expect(updateSpy).toHaveBeenCalledWith(thread.id, {
          status: ThreadStatus.Stopped,
          metadata: { existingField: 'keep', stopCostUsd: 1.03 },
        });
      });

      it('leaves metadata.stopCostUsd untouched when stopCostUsd is undefined (key absent)', async () => {
        const thread = createMockThreadEntity({
          status: ThreadStatus.Running,
          metadata: { stopCostUsd: 2.5, other: 'value' },
        });
        const updatedThread = {
          ...thread,
          status: ThreadStatus.Done,
          updatedAt: new Date('2024-01-01T00:00:01Z'),
        } satisfies ThreadEntity;

        const notification = createMockNotification({
          data: { status: ThreadStatus.Done },
        });

        vi.spyOn(threadsDao, 'getOne')
          .mockResolvedValueOnce(thread)
          .mockResolvedValueOnce(updatedThread);
        const updateSpy = vi
          .spyOn(threadsDao, 'updateById')
          .mockResolvedValue(1);

        await handler.handle(notification);

        // Since stopCostUsd key is absent, metadata should not appear in updates
        expect(updateSpy).toHaveBeenCalledWith(thread.id, {
          status: ThreadStatus.Done,
        });
      });

      it('deletes metadata.stopCostUsd when stopCostUsd is explicitly null', async () => {
        const thread = createMockThreadEntity({
          status: ThreadStatus.Running,
          metadata: {
            stopCostUsd: 1.03,
            preservedField: 'keep-me',
          },
        });
        const updatedThread = {
          ...thread,
          status: ThreadStatus.Stopped,
          metadata: { preservedField: 'keep-me' },
          updatedAt: new Date('2024-01-01T00:00:01Z'),
        } satisfies ThreadEntity;

        const notification = createMockNotification({
          data: {
            status: ThreadStatus.Stopped,
            stopCostUsd: null,
          },
        });

        vi.spyOn(threadsDao, 'getOne')
          .mockResolvedValueOnce(thread)
          .mockResolvedValueOnce(updatedThread);
        const updateSpy = vi
          .spyOn(threadsDao, 'updateById')
          .mockResolvedValue(1);

        await handler.handle(notification);

        expect(updateSpy).toHaveBeenCalledWith(thread.id, {
          status: ThreadStatus.Stopped,
          metadata: { preservedField: 'keep-me' },
        });
      });
    });
  });
});
