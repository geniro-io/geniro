import { Injectable } from '@nestjs/common';

import {
  ICredentialAcquiredData,
  ICredentialAcquiredNotification,
  NotificationEvent,
} from '../../../notifications/notifications.types';
import {
  IEnrichedNotification,
  NotificationScope,
} from '../../notification-handlers.types';
import { BaseNotificationHandler } from './base-notification-handler';

export type ICredentialAcquiredEnrichedNotification =
  IEnrichedNotification<ICredentialAcquiredData>;

/**
 * Enriches `credential.acquired` (a completed OAuth exchange) and routes it to
 * the PROJECT room — the same project-scoped fan-out as `auth_required`. A
 * credential may be acquired from ANY browser (the cap-link flow on a phone, or
 * the project Connections page) with no open graph page, so the live-refresh
 * signal must reach the project — not a graph room. Project routing needs only
 * `projectId` (the gateway reads it directly), so unlike the graph-routed
 * handlers this performs no graph lookup, and a credential acquired without a
 * `graphId` (cap-link / Connections page) still fans out. Without this handler
 * the event has no enricher and is dropped before any socket room.
 */
@Injectable()
export class CredentialAcquiredNotificationHandler extends BaseNotificationHandler<ICredentialAcquiredEnrichedNotification> {
  readonly pattern = NotificationEvent.CredentialAcquired;

  async handle(
    event: ICredentialAcquiredNotification,
  ): Promise<ICredentialAcquiredEnrichedNotification[]> {
    return [
      {
        type: event.type,
        graphId: event.graphId,
        projectId: event.projectId,
        nodeId: event.nodeId,
        threadId: event.threadId,
        scope: [NotificationScope.Project],
        data: event.data,
      },
    ];
  }
}
