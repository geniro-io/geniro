import { Injectable } from '@nestjs/common';

import { GraphDao } from '../../../graphs/dao/graph.dao';
import {
  IAgentStateUpdateNotification,
  IGraphNodeUpdateNotification,
  IGraphNotification,
  IGraphPreviewNotification,
  IRuntimeStatusNotification,
  IThreadStoreUpdateNotification,
  NotificationEvent,
} from '../../../notifications/notifications.types';
import {
  IEnrichedNotification,
  NotificationScope,
} from '../../notification-handlers.types';
import { BaseNotificationHandler } from './base-notification-handler';

export type SimpleNotification =
  | IGraphNotification
  | IGraphNodeUpdateNotification
  | IAgentStateUpdateNotification
  | IRuntimeStatusNotification
  | IGraphPreviewNotification
  | IThreadStoreUpdateNotification;

export type SimpleEnrichedNotification = IEnrichedNotification<
  SimpleNotification['data']
>;

@Injectable()
export class SimpleEnrichmentHandler extends BaseNotificationHandler<SimpleEnrichedNotification> {
  readonly pattern = [
    NotificationEvent.Graph,
    NotificationEvent.GraphNodeUpdate,
    NotificationEvent.AgentStateUpdate,
    NotificationEvent.RuntimeStatus,
    NotificationEvent.GraphPreview,
    NotificationEvent.ThreadStoreUpdate,
  ];

  constructor(private readonly graphDao: GraphDao) {
    super();
  }

  async handle(
    event: SimpleNotification,
  ): Promise<SimpleEnrichedNotification[]> {
    const { ownerId, projectId } = await this.getGraphInfo(
      this.graphDao,
      event.graphId,
    );

    return [
      {
        type: event.type,
        graphId: event.graphId,
        projectId,
        ownerId,
        nodeId: event.nodeId,
        threadId: this.resolveThreadId(event),
        runId: event.runId,
        scope: [NotificationScope.Graph],
        data: event.data,
      },
    ];
  }

  /**
   * Resolve the external thread ID for notifications that carry thread
   * context.  AgentStateUpdate prefers parentThreadId over threadId;
   * GraphNodeUpdate passes threadId through as-is.
   */
  private resolveThreadId(event: SimpleNotification): string | undefined {
    if (event.type === NotificationEvent.AgentStateUpdate) {
      return event.parentThreadId ?? event.threadId;
    }
    return event.threadId;
  }
}
