import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphDao } from '../../../graphs/dao/graph.dao';
import { GraphNodeStatus, GraphStatus } from '../../../graphs/graphs.types';
import {
  IAgentStateUpdateNotification,
  IGraphNodeUpdateNotification,
  IGraphNotification,
  IThreadStoreUpdateNotification,
  NotificationEvent,
} from '../../../notifications/notifications.types';
import {
  ThreadStoreAction,
  ThreadStoreEntryMode,
} from '../../../thread-store/thread-store.types';
import { NotificationScope } from '../../notification-handlers.types';
import { SimpleEnrichmentHandler } from './simple-enrichment-handler';

describe('SimpleEnrichmentHandler', () => {
  let handler: SimpleEnrichmentHandler;
  let graphDao: GraphDao;

  const mockGraphId = 'graph-123';
  const mockOwnerId = 'user-456';
  const mockProjectId = 'project-abc';

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SimpleEnrichmentHandler,
        {
          provide: GraphDao,
          useValue: {
            getOne: vi.fn().mockResolvedValue({
              id: mockGraphId,
              createdBy: mockOwnerId,
              projectId: mockProjectId,
              status: GraphStatus.Running,
            }),
          },
        },
      ],
    }).compile();

    handler = moduleRef.get(SimpleEnrichmentHandler);
    graphDao = moduleRef.get(GraphDao);
  });

  describe('pattern', () => {
    it('should handle Graph, GraphNodeUpdate, AgentStateUpdate, RuntimeStatus, GraphPreview, and ThreadStoreUpdate events', () => {
      expect(handler.pattern).toEqual([
        NotificationEvent.Graph,
        NotificationEvent.GraphNodeUpdate,
        NotificationEvent.AgentStateUpdate,
        NotificationEvent.RuntimeStatus,
        NotificationEvent.GraphPreview,
        NotificationEvent.ThreadStoreUpdate,
      ]);
    });
  });

  describe('Graph notification', () => {
    it('should enrich graph notification with ownerId and scope', async () => {
      const notification: IGraphNotification = {
        type: NotificationEvent.Graph,
        graphId: mockGraphId,
        data: { status: GraphStatus.Running },
      };

      const result = await handler.handle(notification);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: NotificationEvent.Graph,
        graphId: mockGraphId,
        projectId: mockProjectId,
        ownerId: mockOwnerId,
        nodeId: undefined,
        threadId: undefined,
        runId: undefined,
        scope: [NotificationScope.Graph],
        data: { status: GraphStatus.Running },
      });
    });
  });

  describe('GraphNodeUpdate notification', () => {
    it('should enrich with ownerId and pass through nodeId and threadId', async () => {
      const notification: IGraphNodeUpdateNotification = {
        type: NotificationEvent.GraphNodeUpdate,
        graphId: mockGraphId,
        nodeId: 'node-1',
        threadId: 'thread-1',
        data: { status: GraphNodeStatus.Running },
      };

      const result = await handler.handle(notification);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: NotificationEvent.GraphNodeUpdate,
        graphId: mockGraphId,
        projectId: mockProjectId,
        ownerId: mockOwnerId,
        nodeId: 'node-1',
        threadId: 'thread-1',
        runId: undefined,
        scope: [NotificationScope.Graph],
        data: { status: GraphNodeStatus.Running },
      });
    });
  });

  describe('AgentStateUpdate notification', () => {
    it('should use parentThreadId when available', async () => {
      const notification: IAgentStateUpdateNotification = {
        type: NotificationEvent.AgentStateUpdate,
        graphId: mockGraphId,
        nodeId: 'node-789',
        threadId: 'thread-abc',
        parentThreadId: 'parent-thread-def',
        data: { summary: 'Test summary' },
      };

      const result = await handler.handle(notification);

      expect(result).toHaveLength(1);
      expect(result[0]?.threadId).toBe('parent-thread-def');
    });

    it('should fall back to threadId when parentThreadId is missing', async () => {
      const notification: IAgentStateUpdateNotification = {
        type: NotificationEvent.AgentStateUpdate,
        graphId: mockGraphId,
        nodeId: 'node-789',
        threadId: 'thread-abc',
        parentThreadId: undefined as unknown as string,
        data: { summary: 'Thread summary' },
      };

      const result = await handler.handle(notification);

      expect(result).toHaveLength(1);
      expect(result[0]?.threadId).toBe('thread-abc');
    });

    it('should enrich with ownerId and AgentStateUpdate type', async () => {
      const notification: IAgentStateUpdateNotification = {
        type: NotificationEvent.AgentStateUpdate,
        graphId: mockGraphId,
        nodeId: 'node-789',
        threadId: 'thread-abc',
        parentThreadId: 'parent-thread-def',
        data: { done: true },
      };

      const result = await handler.handle(notification);

      expect(result).toEqual([
        {
          type: NotificationEvent.AgentStateUpdate,
          graphId: mockGraphId,
          projectId: mockProjectId,
          ownerId: mockOwnerId,
          nodeId: 'node-789',
          threadId: 'parent-thread-def',
          runId: undefined,
          scope: [NotificationScope.Graph],
          data: { done: true },
        },
      ]);
    });
  });

  describe('ThreadStoreUpdate notification', () => {
    it('should enrich thread store update notification with ownerId and scope', async () => {
      const notification: IThreadStoreUpdateNotification = {
        type: NotificationEvent.ThreadStoreUpdate,
        graphId: mockGraphId,
        threadId: 'thread-store-1',
        data: {
          externalThreadId: 'ext-thread-abc',
          namespace: 'results',
          key: 'output-1',
          mode: ThreadStoreEntryMode.Kv,
          action: ThreadStoreAction.Put,
          authorAgentId: 'agent-node-1',
        },
      };

      const result = await handler.handle(notification);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: NotificationEvent.ThreadStoreUpdate,
        graphId: mockGraphId,
        projectId: mockProjectId,
        ownerId: mockOwnerId,
        nodeId: undefined,
        threadId: 'thread-store-1',
        runId: undefined,
        scope: [NotificationScope.Graph],
        data: {
          externalThreadId: 'ext-thread-abc',
          namespace: 'results',
          key: 'output-1',
          mode: ThreadStoreEntryMode.Kv,
          action: ThreadStoreAction.Put,
          authorAgentId: 'agent-node-1',
        },
      });
    });

    it('should forward data.externalThreadId verbatim (not data.threadId)', async () => {
      const notification: IThreadStoreUpdateNotification = {
        type: NotificationEvent.ThreadStoreUpdate,
        graphId: mockGraphId,
        threadId: 'thread-store-2',
        data: {
          externalThreadId: 'ext-thread-xyz',
          namespace: 'logs',
          key: 'entry-1',
          mode: ThreadStoreEntryMode.Append,
          action: ThreadStoreAction.Append,
        },
      };

      const result = await handler.handle(notification);

      expect(result).toHaveLength(1);
      expect(result[0]!.data).toHaveProperty(
        'externalThreadId',
        'ext-thread-xyz',
      );
      expect(result[0]!.data).not.toHaveProperty('threadId');
    });

    it('should throw NotFoundException when graph is not found for ThreadStoreUpdate', async () => {
      vi.mocked(graphDao.getOne).mockResolvedValue(null);

      const notification: IThreadStoreUpdateNotification = {
        type: NotificationEvent.ThreadStoreUpdate,
        graphId: mockGraphId,
        threadId: 'thread-store-3',
        data: {
          externalThreadId: 'ext-thread-missing',
          namespace: 'ns',
          key: 'k',
          mode: ThreadStoreEntryMode.Kv,
          action: ThreadStoreAction.Delete,
        },
      };

      await expect(handler.handle(notification)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('error handling', () => {
    it('should throw NotFoundException when graph is not found', async () => {
      vi.mocked(graphDao.getOne).mockResolvedValue(null);

      const notification: IGraphNotification = {
        type: NotificationEvent.Graph,
        graphId: mockGraphId,
        data: { status: GraphStatus.Running },
      };

      await expect(handler.handle(notification)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
