import { OnModuleDestroy } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  DefaultLogger,
  NotFoundException,
  UnauthorizedException,
  ValidationException,
} from '@packages/common';
import { AuthContextDataBuilder } from '@packages/http-server';
import { isPlainObject } from 'lodash';
import { Server, Socket } from 'socket.io';
import type { UnknownRecord } from 'type-fest';

import { environment } from '../../../environments';
import { GraphDao } from '../../graphs/dao/graph.dao';
import { ProjectsDao } from '../../projects/dao/projects.dao';
import {
  IEnrichedNotification,
  NotificationScope,
} from '../notification-handlers.types';
import { NotificationHandler } from '../services/notification-handler.service';

@WebSocketGateway({
  cors: {
    origin: (() => {
      const env = process.env.CORS_ALLOWED_ORIGINS?.trim();
      if (!env) {
        return false;
      }
      if (env === '*') {
        return '*';
      }
      return env
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
    })(),
    credentials: true,
  },
})
export class SocketGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
{
  @WebSocketServer()
  private ws!: Server;

  constructor(
    private readonly eventsHandler: NotificationHandler,
    private readonly authContextDataBuilder: AuthContextDataBuilder,
    private readonly graphDao: GraphDao,
    private readonly projectsDao: ProjectsDao,
    private readonly logger: DefaultLogger,
  ) {}

  public getUserRoomName(userId: string): string {
    return `user:${userId}`;
  }

  public getGraphRoomName(graphId: string): string {
    return `graph:${graphId}`;
  }

  public getProjectRoomName(projectId: string): string {
    return `project:${projectId}`;
  }

  private emitError(err: Error, client: Socket, disconnect = false): void {
    client.emit('server_error', { message: err.message });
    if (disconnect) {
      client.disconnect(true);
    }
  }

  afterInit() {
    // Subscribe to events handler for enriched notifications
    this.eventsHandler.onEnrichedNotification(
      (event: IEnrichedNotification<unknown>) => {
        const { graphId, projectId, ownerId, type, scope } = event;

        // Collect target rooms based on scope, then broadcast once.
        // Using a single .to(rooms) call ensures Socket.IO deduplicates
        // sockets that belong to multiple target rooms.
        const rooms: string[] = [];
        for (const scopeItem of scope) {
          switch (scopeItem) {
            case NotificationScope.Graph:
              rooms.push(this.getGraphRoomName(graphId));
              break;
            case NotificationScope.User:
              rooms.push(this.getUserRoomName(ownerId));
              break;
            case NotificationScope.Project:
              if (projectId) {
                rooms.push(this.getProjectRoomName(projectId));
              }
              break;
          }
        }

        if (rooms.length > 0) {
          try {
            this.broadcastToRooms(rooms, type, event);
          } catch (error) {
            this.logger.error(
              error as Error,
              `Failed to broadcast ${type} to rooms ${rooms.join(', ')}`,
            );
          }
        }
      },
    );
  }

  async handleConnection(client: Socket) {
    try {
      const auth = client.handshake.auth as unknown;
      const authRecord: UnknownRecord = isPlainObject(auth)
        ? (auth as UnknownRecord)
        : {};
      const tokenRaw = authRecord.token;
      const token =
        typeof tokenRaw === 'string' && tokenRaw.length > 0
          ? tokenRaw
          : undefined;

      // Get auth data from the socket handshake for dev mode authentication
      const isDev = environment.env !== 'production';
      const authData: Record<string, string> = {};
      for (const [key, value] of Object.entries(authRecord)) {
        if (!isDev && key.startsWith('x-dev-jwt-')) {
          continue;
        }
        if (typeof value === 'string') {
          authData[key] = value;
        }
      }

      const contextData = await this.authContextDataBuilder.buildContextData(
        token,
        authData,
      );

      if (!contextData?.sub) {
        throw new UnauthorizedException();
      }

      const userId = contextData.sub;

      // Store user ID in socket data for later use
      (client.data as Record<string, unknown>).userId = userId;

      // Automatically join user's personal room
      const userRoom = this.getUserRoomName(userId);
      await client.join(userRoom);
      client.emit('socket_connected');
    } catch (err) {
      this.logger.error(<Error>err, 'Socket connection error');
      this.emitError(<Error>err, client, true);
    }
  }

  handleDisconnect(client: Socket) {
    const userId = (client.data as Record<string, unknown>).userId;
    this.logger.debug('WebSocket client disconnected', { userId });
  }

  public broadcast<T>(event: string, payload: T) {
    this.ws.emit(event, payload);
  }

  public broadcastToRoom<T>(room: string, event: string, payload: T) {
    this.ws.to(room).emit(event, payload);
  }

  public broadcastToRooms<T>(rooms: string[], event: string, payload: T) {
    this.ws.to(rooms).emit(event, payload);
  }

  @SubscribeMessage('subscribe_graph')
  async handleSubscribeGraph(
    client: Socket,
    payload: { graphId: string },
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const userIdRaw = (client.data as Record<string, unknown>).userId;
      const userId = typeof userIdRaw === 'string' ? userIdRaw : undefined;

      if (!userId) {
        throw new UnauthorizedException();
      }

      if (!payload?.graphId) {
        throw new ValidationException(
          'VALIDATION_ERROR',
          'Graph ID is required',
        );
      }

      // Check if graph exists and user is the owner
      const graph = await this.graphDao.getOne({
        id: payload.graphId,
        createdBy: userId,
      });

      if (!graph) {
        throw new NotFoundException('GRAPH_NOT_FOUND');
      }

      // Join graph room
      const graphRoom = this.getGraphRoomName(payload.graphId);
      await client.join(graphRoom);

      return { success: true };
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        this.logger.warn(
          'Subscribe graph rejected: userId not yet set (transient reconnect race)',
        );
      } else {
        this.logger.error(err as Error, 'Subscribe graph error');
      }
      this.emitError(err as Error, client);

      return { success: false, error: (err as Error).message };
    }
  }

  @SubscribeMessage('unsubscribe_graph')
  async handleUnsubscribeGraph(
    client: Socket,
    payload: { graphId: string },
  ): Promise<void> {
    if (!payload?.graphId || typeof payload.graphId !== 'string') {
      return;
    }

    try {
      const graphRoom = this.getGraphRoomName(payload.graphId);
      await client.leave(graphRoom);
    } catch (err) {
      this.logger.error(err as Error, 'Unsubscribe graph error');
      this.emitError(err as Error, client);
    }
  }

  @SubscribeMessage('subscribe_project')
  async handleSubscribeProject(
    client: Socket,
    payload: { projectId: string },
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const userIdRaw = (client.data as Record<string, unknown>).userId;
      const userId = typeof userIdRaw === 'string' ? userIdRaw : undefined;

      if (!userId) {
        throw new UnauthorizedException();
      }

      if (!payload?.projectId) {
        throw new ValidationException(
          'VALIDATION_ERROR',
          'Project ID is required',
        );
      }

      // Gate on project ownership (the project's `createdBy`), mirroring
      // subscribe_graph's owner check — a user may only join a project room for
      // a project they own.
      const project = await this.projectsDao.getOne({
        id: payload.projectId,
        createdBy: userId,
      });

      if (!project) {
        throw new NotFoundException('PROJECT_NOT_FOUND');
      }

      const projectRoom = this.getProjectRoomName(payload.projectId);
      await client.join(projectRoom);

      return { success: true };
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        this.logger.warn(
          'Subscribe project rejected: userId not yet set (transient reconnect race)',
        );
      } else {
        this.logger.error(err as Error, 'Subscribe project error');
      }
      this.emitError(err as Error, client);

      return { success: false, error: (err as Error).message };
    }
  }

  @SubscribeMessage('unsubscribe_project')
  async handleUnsubscribeProject(
    client: Socket,
    payload: { projectId: string },
  ): Promise<void> {
    if (!payload?.projectId || typeof payload.projectId !== 'string') {
      return;
    }

    try {
      const projectRoom = this.getProjectRoomName(payload.projectId);
      await client.leave(projectRoom);
    } catch (err) {
      this.logger.error(err as Error, 'Unsubscribe project error');
      this.emitError(err as Error, client);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Closing WebSocket server gracefully');

    // Disconnect all connected clients
    const sockets = await this.ws.fetchSockets();
    this.logger.debug(`Disconnecting ${sockets.length} WebSocket clients`);

    for (const socket of sockets) {
      socket.disconnect(true);
    }

    // Close the Socket.IO server and release the port
    await new Promise<void>((resolve) => {
      this.ws.close(() => {
        this.logger.log('WebSocket server closed');
        resolve();
      });
    });
  }
}
