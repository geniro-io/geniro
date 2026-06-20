import { describe, expect, it } from 'vitest';

import {
  ICredentialAcquiredNotification,
  NotificationEvent,
} from '../../../notifications/notifications.types';
import { OAuthProvider } from '../../../oauth-credentials/oauth-credentials.types';
import { NotificationScope } from '../../notification-handlers.types';
import { CredentialAcquiredNotificationHandler } from './credential-acquired-notification-handler';

describe('CredentialAcquiredNotificationHandler', () => {
  const handler = new CredentialAcquiredNotificationHandler();

  const event: ICredentialAcquiredNotification = {
    type: NotificationEvent.CredentialAcquired,
    data: { provider: OAuthProvider.Linear, accountLabel: 'Acme' },
    projectId: 'proj-1',
    graphId: 'graph-1',
    nodeId: 'mcp-1',
    threadId: 'graph-1:thread-1',
  };

  it('routes credential.acquired to the PROJECT room', async () => {
    const out = await handler.handle(event);

    expect(out).toHaveLength(1);
    expect(out[0]?.scope).toEqual([NotificationScope.Project]);
    expect(out[0]).toMatchObject({
      type: NotificationEvent.CredentialAcquired,
      projectId: 'proj-1',
      graphId: 'graph-1',
      nodeId: 'mcp-1',
      threadId: 'graph-1:thread-1',
      data: { provider: OAuthProvider.Linear, accountLabel: 'Acme' },
    });
  });

  it('still fans out to the project room when no graphId is present (cap-link / Connections page)', async () => {
    // The cap-link redemption + the Connections-page connect carry no graph
    // context. Project routing needs only projectId, so the event must still be
    // enriched (not dropped like the graph-routed handlers).
    const out = await handler.handle({
      ...event,
      graphId: undefined,
      nodeId: undefined,
    });

    expect(out).toHaveLength(1);
    expect(out[0]?.scope).toEqual([NotificationScope.Project]);
    expect(out[0]?.projectId).toBe('proj-1');
    expect(out[0]?.graphId).toBeUndefined();
  });
});
