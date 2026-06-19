import { Test, TestingModule } from '@nestjs/testing';
import { DefaultLogger } from '@packages/common';
import { AuthContextDataBuilder } from '@packages/http-server';
import { Socket } from 'socket.io';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep, MockProxy } from 'vitest-mock-extended';

import { GraphDao } from '../../graphs/dao/graph.dao';
import { GraphStatus } from '../../graphs/graphs.types';
import { ProjectsDao } from '../../projects/dao/projects.dao';
import {
  IEnrichedNotification,
  NotificationScope,
} from '../notification-handlers.types';
import { NotificationHandler } from '../services/notification-handler.service';
import { SocketGateway } from './socket.gateway';

describe('SocketGateway', () => {
  let gateway: SocketGateway;
  let eventsHandler: MockProxy<NotificationHandler>;
  let authContextDataBuilder: MockProxy<AuthContextDataBuilder>;
  let graphDao: MockProxy<GraphDao>;
  let projectsDao: MockProxy<ProjectsDao>;
  let logger: MockProxy<DefaultLogger>;

  const mockUserId = 'user-123';
  const mockGraphId = 'graph-456';
  const mockProjectId = 'project-abc';
  const mockToken = 'valid-token';

  beforeEach(async () => {
    eventsHandler = mockDeep<NotificationHandler>();
    authContextDataBuilder = mockDeep<AuthContextDataBuilder>();
    graphDao = mockDeep<GraphDao>();
    projectsDao = mockDeep<ProjectsDao>();
    logger = mockDeep<DefaultLogger>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SocketGateway,
        {
          provide: NotificationHandler,
          useValue: eventsHandler,
        },
        {
          provide: AuthContextDataBuilder,
          useValue: authContextDataBuilder,
        },
        {
          provide: GraphDao,
          useValue: graphDao,
        },
        {
          provide: ProjectsDao,
          useValue: projectsDao,
        },
        {
          provide: DefaultLogger,
          useValue: logger,
        },
      ],
    }).compile();

    gateway = module.get<SocketGateway>(SocketGateway);
  });

  describe('afterInit', () => {
    it('should initialize the gateway and register enriched notification callback', () => {
      gateway.afterInit();

      expect(eventsHandler.onEnrichedNotification).toHaveBeenCalledWith(
        expect.any(Function),
      );
    });

    it('should broadcast enriched notifications only to graph room', () => {
      // Mock the WebSocket server
      const mockServer = {
        emit: vi.fn(),
        to: vi.fn().mockReturnThis(),
      };
      (gateway as unknown as { ws: unknown }).ws = mockServer;

      // First initialize the gateway to set up the subscription
      gateway.afterInit();

      const mockEnrichedNotification: IEnrichedNotification<unknown> = {
        type: 'graph.update' as any,
        graphId: mockGraphId,
        projectId: mockProjectId,
        ownerId: mockUserId,
        data: { status: GraphStatus.Running },
        scope: [NotificationScope.Graph],
      };

      // Get the event handler callback and call it
      const eventHandlerCallback =
        eventsHandler.onEnrichedNotification.mock.calls[0]![0];
      eventHandlerCallback(mockEnrichedNotification);

      // Verify that the gateway broadcasts only to graph room (as single-item array)
      expect(mockServer.to).toHaveBeenCalledWith([`graph:${mockGraphId}`]);
    });

    it('should broadcast AgentStateUpdate notifications only to graph room', () => {
      // Mock the WebSocket server
      const mockServer = {
        emit: vi.fn(),
        to: vi.fn().mockReturnThis(),
      };
      (gateway as unknown as { ws: unknown }).ws = mockServer;

      // First initialize the gateway to set up the subscription
      gateway.afterInit();

      const mockAgentStateUpdateNotification: IEnrichedNotification<unknown> = {
        type: 'agent.state.update' as any,
        graphId: mockGraphId,
        projectId: mockProjectId,
        ownerId: mockUserId,
        data: {
          summary: 'Test summary',
          done: false,
        },
        nodeId: 'agent-1',
        threadId: 'thread-123',
        scope: [NotificationScope.Graph],
      };

      // Get the event handler callback and call it
      const eventHandlerCallback =
        eventsHandler.onEnrichedNotification.mock.calls[0]![0];
      eventHandlerCallback(mockAgentStateUpdateNotification);

      // Verify that the gateway broadcasts only to graph room (as single-item array)
      expect(mockServer.to).toHaveBeenCalledWith([`graph:${mockGraphId}`]);

      // Verify the event type is passed correctly
      expect(mockServer.emit).toHaveBeenCalledWith(
        'agent.state.update',
        mockAgentStateUpdateNotification,
      );
    });

    it('should broadcast ThreadUpdate notifications only to graph room', () => {
      const mockServer = {
        emit: vi.fn(),
        to: vi.fn().mockReturnThis(),
      };
      (gateway as unknown as { ws: unknown }).ws = mockServer;

      gateway.afterInit();

      const mockThreadUpdateNotification: IEnrichedNotification<unknown> = {
        type: 'thread.update' as any,
        graphId: mockGraphId,
        projectId: mockProjectId,
        ownerId: mockUserId,
        data: {
          status: 'stopped',
        },
        threadId: 'thread-123',
        scope: [NotificationScope.Graph],
      };

      const eventHandlerCallback =
        eventsHandler.onEnrichedNotification.mock.calls[0]![0];
      eventHandlerCallback(mockThreadUpdateNotification);

      expect(mockServer.to).toHaveBeenCalledWith([`graph:${mockGraphId}`]);
      expect(mockServer.emit).toHaveBeenCalledWith(
        'thread.update',
        mockThreadUpdateNotification,
      );
    });

    it('should catch and log broadcast errors without propagating', () => {
      const mockServer = {
        emit: vi.fn(),
        to: vi.fn().mockImplementation(() => {
          throw new Error('Socket.IO internal error');
        }),
      };
      (gateway as unknown as { ws: unknown }).ws = mockServer;

      gateway.afterInit();

      const mockNotification: IEnrichedNotification<unknown> = {
        type: 'graph.update' as any,
        graphId: mockGraphId,
        projectId: mockProjectId,
        ownerId: mockUserId,
        data: { status: GraphStatus.Running },
        scope: [NotificationScope.Graph],
      };

      const eventHandlerCallback =
        eventsHandler.onEnrichedNotification.mock.calls[0]![0];

      expect(() => eventHandlerCallback(mockNotification)).not.toThrow();
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(Error),
        expect.stringContaining('Failed to broadcast'),
      );
    });

    it('should deduplicate when broadcasting to both graph and user rooms', () => {
      const mockServer = {
        emit: vi.fn(),
        to: vi.fn().mockReturnThis(),
      };
      (gateway as unknown as { ws: unknown }).ws = mockServer;

      gateway.afterInit();

      const mockDualScopeNotification: IEnrichedNotification<unknown> = {
        type: 'graph.revision.create' as any,
        graphId: mockGraphId,
        projectId: mockProjectId,
        ownerId: mockUserId,
        data: { revisionId: 'rev-1' },
        scope: [NotificationScope.Graph, NotificationScope.User],
      };

      const eventHandlerCallback =
        eventsHandler.onEnrichedNotification.mock.calls[0]![0];
      eventHandlerCallback(mockDualScopeNotification);

      // Verify a single .to() call with both rooms (Socket.IO deduplicates)
      expect(mockServer.to).toHaveBeenCalledTimes(1);
      expect(mockServer.to).toHaveBeenCalledWith([
        `graph:${mockGraphId}`,
        `user:${mockUserId}`,
      ]);
      expect(mockServer.emit).toHaveBeenCalledTimes(1);
      expect(mockServer.emit).toHaveBeenCalledWith(
        'graph.revision.create',
        mockDualScopeNotification,
      );
    });
  });

  describe('handleConnection', () => {
    let mockClient: Socket;

    beforeEach(() => {
      mockClient = {
        handshake: {
          auth: {
            token: mockToken,
            'x-dev-jwt-sub': mockUserId,
          },
        },
        id: 'socket-123',
        data: {},
        emit: vi.fn(),
        disconnect: vi.fn(),
        join: vi.fn(),
      } as unknown as Socket;
    });

    it('should authenticate and connect a client successfully', async () => {
      authContextDataBuilder.buildContextData.mockResolvedValue({
        sub: mockUserId,
      });

      await gateway.handleConnection(mockClient);

      expect(authContextDataBuilder.buildContextData).toHaveBeenCalledWith(
        mockToken,
        mockClient.handshake.auth,
      );
      expect(mockClient.data.userId).toBe(mockUserId);
      expect(mockClient.join).toHaveBeenCalledWith(`user:${mockUserId}`);
    });

    it('should reject connection without token', async () => {
      mockClient.handshake.auth = {};

      await gateway.handleConnection(mockClient);

      expect(mockClient.emit).toHaveBeenCalledWith('server_error', {
        message: 'Unauthorized',
      });
      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
    });

    it('should reject connection with invalid token', async () => {
      authContextDataBuilder.buildContextData.mockResolvedValue({});

      await gateway.handleConnection(mockClient);

      expect(authContextDataBuilder.buildContextData).toHaveBeenCalledWith(
        mockToken,
        mockClient.handshake.auth,
      );
      expect(mockClient.emit).toHaveBeenCalledWith('server_error', {
        message: 'Unauthorized',
      });
      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
    });

    it('should handle authentication errors', async () => {
      const error = new Error('Token verification failed');
      authContextDataBuilder.buildContextData.mockRejectedValue(error);

      await gateway.handleConnection(mockClient);

      expect(authContextDataBuilder.buildContextData).toHaveBeenCalledWith(
        mockToken,
        mockClient.handshake.auth,
      );
      expect(logger.error).toHaveBeenCalled();
      expect(mockClient.emit).toHaveBeenCalledWith('server_error', {
        message: error.message,
      });
      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('broadcast methods', () => {
    let mockServer: Record<string, unknown>;

    beforeEach(() => {
      mockServer = {
        emit: vi.fn(),
        to: vi.fn().mockReturnThis(),
      };
      (gateway as unknown as { ws: unknown }).ws = mockServer;
    });

    it('should broadcast to all clients', () => {
      const event = 'test_event';
      const payload = { data: 'test' };

      gateway.broadcast(event, payload);

      expect(mockServer.emit).toHaveBeenCalledWith(event, payload);
    });

    it('should broadcast to specific room', () => {
      const event = 'test_event';
      const payload = { data: 'test' };
      const room = 'custom-room';

      gateway.broadcastToRoom(room, event, payload);

      expect(mockServer.to).toHaveBeenCalledWith(room);
      expect(mockServer.emit).toHaveBeenCalledWith(event, payload);
    });

    it('should broadcast to multiple rooms at once', () => {
      const event = 'test_event';
      const payload = { data: 'test' };
      const rooms = ['room-1', 'room-2'];

      gateway.broadcastToRooms(rooms, event, payload);

      expect(mockServer.to).toHaveBeenCalledWith(rooms);
      expect(mockServer.emit).toHaveBeenCalledWith(event, payload);
    });
  });

  describe('thread subscription', () => {
    let mockClient: Socket;

    beforeEach(() => {
      mockClient = {
        handshake: {
          auth: {
            token: mockToken,
            'x-dev-jwt-sub': mockUserId,
          },
        },
        id: 'socket-123',
        data: { userId: mockUserId },
        emit: vi.fn(),
        disconnect: vi.fn(),
        join: vi.fn(),
        leave: vi.fn(),
      } as unknown as Socket;
    });

    it('should allow subscribing to thread updates via graph subscription', async () => {
      // Mock graph exists
      graphDao.getOne.mockResolvedValue({
        id: mockGraphId,
        createdBy: mockUserId,
        projectId: mockProjectId,
        name: 'Test Graph',
        description: 'Test Description',
        version: '1.0.0',
        targetVersion: '1.0.0',
        temporary: false,
        schema: {} as any,
        settings: {},
        status: GraphStatus.Running as any,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });

      const result = await gateway.handleSubscribeGraph(mockClient, {
        graphId: mockGraphId,
      });

      expect(graphDao.getOne).toHaveBeenCalledWith({
        id: mockGraphId,
        createdBy: mockUserId,
      });
      expect(mockClient.join).toHaveBeenCalledWith(`graph:${mockGraphId}`);
      expect(result).toEqual({ success: true });
    });

    it('should return error acknowledgment when user is not authenticated', async () => {
      mockClient.data = {};

      const result = await gateway.handleSubscribeGraph(mockClient, {
        graphId: mockGraphId,
      });

      expect(result).toEqual({
        success: false,
        error: 'Unauthorized',
      });
      expect(mockClient.emit).toHaveBeenCalledWith('server_error', {
        message: 'Unauthorized',
      });
      expect(logger.warn).toHaveBeenCalledWith(
        'Subscribe graph rejected: userId not yet set (transient reconnect race)',
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should return error acknowledgment when graphId is missing', async () => {
      const result = await gateway.handleSubscribeGraph(
        mockClient,
        {} as { graphId: string },
      );

      expect(result).toEqual({
        success: false,
        error: 'Graph ID is required',
      });
      expect(mockClient.emit).toHaveBeenCalledWith('server_error', {
        message: 'Graph ID is required',
      });
    });

    it('should return error acknowledgment when graph is not found', async () => {
      graphDao.getOne.mockResolvedValue(null);

      const result = await gateway.handleSubscribeGraph(mockClient, {
        graphId: mockGraphId,
      });

      expect(result).toEqual({
        success: false,
        error: '[GRAPH_NOT_FOUND] An exception has occurred',
      });
      expect(mockClient.emit).toHaveBeenCalledWith('server_error', {
        message: '[GRAPH_NOT_FOUND] An exception has occurred',
      });
    });

    it('subscribe_project joins the project room when the user owns the project', async () => {
      projectsDao.getOne.mockResolvedValue({
        id: mockProjectId,
        createdBy: mockUserId,
      } as never);

      const result = await gateway.handleSubscribeProject(mockClient, {
        projectId: mockProjectId,
      });

      expect(projectsDao.getOne).toHaveBeenCalledWith({
        id: mockProjectId,
        createdBy: mockUserId,
      });
      expect(mockClient.join).toHaveBeenCalledWith(`project:${mockProjectId}`);
      expect(result).toEqual({ success: true });
    });

    it('subscribe_project REJECTS a non-owner and does NOT join the room', async () => {
      // Non-owner: the ownership filter ({id, createdBy}) finds no row.
      projectsDao.getOne.mockResolvedValue(null);

      const result = await gateway.handleSubscribeProject(mockClient, {
        projectId: mockProjectId,
      });

      expect(result).toEqual({
        success: false,
        error: '[PROJECT_NOT_FOUND] An exception has occurred',
      });
      expect(mockClient.join).not.toHaveBeenCalled();
      expect(mockClient.emit).toHaveBeenCalledWith('server_error', {
        message: '[PROJECT_NOT_FOUND] An exception has occurred',
      });
    });

    it('routes a Project-scoped notification (auth_required) to the project room', () => {
      const mockServer = {
        emit: vi.fn(),
        to: vi.fn().mockReturnThis(),
      };
      (gateway as unknown as { ws: unknown }).ws = mockServer;
      gateway.afterInit();

      const authRequired: IEnrichedNotification<unknown> = {
        type: 'auth.required' as any,
        graphId: mockGraphId,
        projectId: mockProjectId,
        ownerId: mockUserId,
        data: { provider: 'linear', capabilityToken: 'tok' },
        nodeId: 'mcp-1',
        threadId: 'thread-1',
        scope: [NotificationScope.Project],
      };

      const eventHandlerCallback =
        eventsHandler.onEnrichedNotification.mock.calls[0]![0];
      eventHandlerCallback(authRequired);

      // Project-scoped → routed ONLY to the project room (not a graph room).
      expect(mockServer.to).toHaveBeenCalledWith([`project:${mockProjectId}`]);
      expect(mockServer.emit).toHaveBeenCalledWith(
        'auth.required',
        authRequired,
      );
    });

    it('should handle thread state updates through graph room', () => {
      // Mock the WebSocket server
      const mockServer = {
        emit: vi.fn(),
        to: vi.fn().mockReturnThis(),
      };
      (gateway as unknown as { ws: unknown }).ws = mockServer;

      // Initialize the gateway
      gateway.afterInit();

      // Simulate a thread state update notification
      const threadStateUpdate: IEnrichedNotification<unknown> = {
        type: 'agent.state.update' as any,
        graphId: mockGraphId,
        projectId: mockProjectId,
        ownerId: mockUserId,
        data: {
          summary: 'Updated summary',
          done: true,
        },
        nodeId: 'agent-1',
        threadId: 'thread-123',
        scope: [NotificationScope.Graph],
      };

      // Get the event handler callback and call it
      const eventHandlerCallback =
        eventsHandler.onEnrichedNotification.mock.calls[0]![0];
      eventHandlerCallback(threadStateUpdate);

      // Verify that the gateway broadcasts only to the graph room (as single-item array)
      expect(mockServer.to).toHaveBeenCalledWith([`graph:${mockGraphId}`]);
      expect(mockServer.emit).toHaveBeenCalledWith(
        'agent.state.update',
        threadStateUpdate,
      );
    });
  });
});
