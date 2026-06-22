import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IAuthRequiredNotification,
  NotificationEvent,
} from '../../../notifications/notifications.types';
import { OAuthProvider } from '../../../oauth-credentials/oauth-credentials.types';
import { NotificationScope } from '../../notification-handlers.types';
import { AuthRequiredNotificationHandler } from './auth-required-notification-handler';

describe('AuthRequiredNotificationHandler', () => {
  let graphDao: { getOne: ReturnType<typeof vi.fn> };
  let handler: AuthRequiredNotificationHandler;

  const event: IAuthRequiredNotification = {
    type: NotificationEvent.AuthRequired,
    data: { provider: OAuthProvider.Linear, capabilityToken: 'tok' },
    projectId: 'proj-1',
    graphId: 'graph-1',
    nodeId: 'mcp-1',
    threadId: 'graph-1:thread-1',
  };

  beforeEach(() => {
    graphDao = {
      getOne: vi.fn(async () => ({
        createdBy: 'owner-1',
        projectId: 'proj-1',
      })),
    };
    handler = new AuthRequiredNotificationHandler(graphDao as never);
  });

  it('routes auth_required to the PROJECT room (not the graph room)', async () => {
    const out = await handler.handle(event);

    expect(out).toHaveLength(1);
    expect(out[0]?.scope).toEqual([NotificationScope.Project]);
    expect(out[0]).toMatchObject({
      type: NotificationEvent.AuthRequired,
      graphId: 'graph-1',
      projectId: 'proj-1',
      ownerId: 'owner-1',
      nodeId: 'mcp-1',
      threadId: 'graph-1:thread-1',
      data: { provider: OAuthProvider.Linear, capabilityToken: 'tok' },
    });
  });

  it('skips enrichment when no graphId is present (owner unresolvable)', async () => {
    const out = await handler.handle({ ...event, graphId: undefined });
    expect(out).toEqual([]);
    expect(graphDao.getOne).not.toHaveBeenCalled();
  });
});
