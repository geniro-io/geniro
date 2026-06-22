import { Injectable } from '@nestjs/common';

import { GraphDao } from '../../../graphs/dao/graph.dao';
import {
  IAuthRequiredData,
  IAuthRequiredNotification,
  NotificationEvent,
} from '../../../notifications/notifications.types';
import {
  IEnrichedNotification,
  NotificationScope,
} from '../../notification-handlers.types';
import { BaseNotificationHandler } from './base-notification-handler';

export type IAuthRequiredEnrichedNotification =
  IEnrichedNotification<IAuthRequiredData>;

/**
 * Enriches `auth_required` (a paused run awaiting an OAuth credential) and routes
 * it to the PROJECT room — not a graph room. A background/trigger run has no one
 * on its thread page, so the prompt to authenticate must reach the user wherever
 * they are in the project (the editor, a node re-auth surface, a future
 * Connections page). The opaque `capabilityToken` rides in `data`.
 */
@Injectable()
export class AuthRequiredNotificationHandler extends BaseNotificationHandler<IAuthRequiredEnrichedNotification> {
  readonly pattern = NotificationEvent.AuthRequired;

  constructor(private readonly graphDao: GraphDao) {
    super();
  }

  async handle(
    event: IAuthRequiredNotification,
  ): Promise<IAuthRequiredEnrichedNotification[]> {
    // The producer always carries graphId (every run has a graph); without it
    // the owner can't be resolved, so skip rather than guess.
    if (!event.graphId) {
      return [];
    }
    const { ownerId } = await this.getGraphInfo(this.graphDao, event.graphId);

    return [
      {
        type: event.type,
        graphId: event.graphId,
        projectId: event.projectId,
        ownerId,
        nodeId: event.nodeId,
        threadId: event.threadId,
        scope: [NotificationScope.Project],
        data: event.data,
      },
    ];
  }
}
