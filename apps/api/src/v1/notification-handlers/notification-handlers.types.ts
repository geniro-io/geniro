import { NotificationEvent } from '../notifications/notifications.types';

export enum NotificationScope {
  /** Send notification only to graph room (users who explicitly subscribed) */
  Graph = 'graph',
  /** Send notification only to user room (owner's personal room) */
  User = 'user',
  /**
   * Send notification to the project room (users who subscribed to the project).
   * Used for events that aren't tied to a single open graph page — e.g.
   * `auth_required` for a paused background/trigger run, which must reach the
   * user wherever they are, not only on the run's thread page.
   */
  Project = 'project',
}

export interface IEnrichedNotification<T> {
  type: NotificationEvent;
  data: T;
  // Optional because a Project- or User-scoped notification need not be bound to
  // a single graph or owner — e.g. `credential.acquired` from a cap-link / the
  // Connections page carries no graph context. Graph-scoped events still always
  // populate `graphId`; the gateway guards each room-push on the field it needs.
  graphId?: string;
  projectId: string;
  ownerId?: string;
  nodeId?: string;
  threadId?: string;
  runId?: string;
  scope: NotificationScope[];
}
