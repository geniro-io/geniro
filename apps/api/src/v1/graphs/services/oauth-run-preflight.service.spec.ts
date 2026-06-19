import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationEvent } from '../../notifications/notifications.types';
import { OAuthProvider } from '../../oauth-credentials/oauth-credentials.types';
import { ThreadStatus } from '../../threads/threads.types';
import { collectOAuthNodes } from './oauth-node.utils';
import {
  CREDENTIAL_WAIT_REASON,
  OAuthRunPreflightService,
} from './oauth-run-preflight.service';

vi.mock('./oauth-node.utils', () => ({ collectOAuthNodes: vi.fn() }));

const mockedCollect = vi.mocked(collectOAuthNodes);

describe('OAuthRunPreflightService', () => {
  let graphDao: { getById: ReturnType<typeof vi.fn> };
  let templateRegistry: { getTemplate: ReturnType<typeof vi.fn> };
  let oauthCredentialsService: { refreshIfNeeded: ReturnType<typeof vi.fn> };
  let capabilityLink: { mint: ReturnType<typeof vi.fn> };
  let notifications: { emit: ReturnType<typeof vi.fn> };
  let threadsDao: {
    getOne: ReturnType<typeof vi.fn>;
    updateById: ReturnType<typeof vi.fn>;
  };
  let transitionService: { computeTransition: ReturnType<typeof vi.fn> };
  let logger: { warn: ReturnType<typeof vi.fn> };
  let service: OAuthRunPreflightService;

  const params = {
    graphId: 'graph-1',
    externalThreadId: 'graph-1:thread-1',
    createdBy: 'user-1',
    agentNodeId: 'agent-1',
  };

  const buildService = () =>
    new OAuthRunPreflightService(
      graphDao as never,
      templateRegistry as never,
      oauthCredentialsService as never,
      capabilityLink as never,
      notifications as never,
      threadsDao as never,
      transitionService as never,
      logger as never,
    );

  beforeEach(() => {
    mockedCollect.mockReset();
    graphDao = {
      getById: vi.fn(async () => ({
        projectId: 'proj-1',
        schema: {
          nodes: [{ id: 'mcp-1', template: 'linear-mcp', config: {} }],
        },
      })),
    };
    templateRegistry = { getTemplate: vi.fn(() => ({ schema: {} })) };
    oauthCredentialsService = { refreshIfNeeded: vi.fn() };
    capabilityLink = { mint: vi.fn(async () => 'cap-token') };
    notifications = { emit: vi.fn(async () => undefined) };
    threadsDao = {
      getOne: vi.fn(async () => ({
        id: 'thread-row-1',
        status: ThreadStatus.Running,
        runningStartedAt: new Date(),
        totalRunningMs: 0,
        metadata: {},
      })),
      updateById: vi.fn(async () => 1),
    };
    transitionService = {
      computeTransition: vi.fn(() => ({
        status: ThreadStatus.Waiting,
        runningStartedAt: null,
        totalRunningMs: 0,
      })),
    };
    logger = { warn: vi.fn() };
    service = buildService();
  });

  it('proceeds (false) when the graph has no OAuth nodes', async () => {
    mockedCollect.mockReturnValue([]);

    await expect(service.checkAndPauseIfNeeded(params)).resolves.toBe(false);
    expect(threadsDao.updateById).not.toHaveBeenCalled();
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('proceeds (false) when the graph has no projectId', async () => {
    graphDao.getById.mockResolvedValue({
      projectId: null,
      schema: { nodes: [] },
    });

    await expect(service.checkAndPauseIfNeeded(params)).resolves.toBe(false);
    expect(oauthCredentialsService.refreshIfNeeded).not.toHaveBeenCalled();
  });

  it('proceeds (false) when every OAuth provider is authenticated', async () => {
    mockedCollect.mockReturnValue([{ nodeId: 'mcp-1', provider: 'linear' }]);
    oauthCredentialsService.refreshIfNeeded.mockResolvedValue({
      authenticated: true,
    });

    await expect(service.checkAndPauseIfNeeded(params)).resolves.toBe(false);
    expect(threadsDao.updateById).not.toHaveBeenCalled();
  });

  it('pauses (true) and fans auth_required when a provider is unauthenticated', async () => {
    mockedCollect.mockReturnValue([{ nodeId: 'mcp-1', provider: 'linear' }]);
    oauthCredentialsService.refreshIfNeeded.mockResolvedValue({
      authenticated: false,
    });

    await expect(
      service.checkAndPauseIfNeeded({ ...params, pendingMessageText: 'hi' }),
    ).resolves.toBe(true);

    // Thread -> Waiting with credential wait metadata (incl. the resume prompt).
    expect(transitionService.computeTransition).toHaveBeenCalledWith(
      expect.anything(),
      ThreadStatus.Waiting,
    );
    expect(threadsDao.updateById).toHaveBeenCalledWith(
      'thread-row-1',
      expect.objectContaining({
        status: ThreadStatus.Waiting,
        metadata: expect.objectContaining({
          waitReason: CREDENTIAL_WAIT_REASON,
          waitNodeId: 'agent-1',
          waitCheckPrompt: 'hi',
        }),
      }),
    );

    // Minted a capability link scoped to the run + fanned auth_required.
    expect(capabilityLink.mint).toHaveBeenCalledWith({
      projectId: 'proj-1',
      provider: OAuthProvider.Linear,
      threadId: 'graph-1:thread-1',
      createdBy: 'user-1',
    });
    expect(notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: NotificationEvent.AuthRequired,
        projectId: 'proj-1',
        nodeId: 'mcp-1',
        threadId: 'graph-1:thread-1',
        data: { provider: OAuthProvider.Linear, capabilityToken: 'cap-token' },
      }),
    );
  });

  it('treats a refresh THROW as unauthenticated and pauses', async () => {
    mockedCollect.mockReturnValue([{ nodeId: 'mcp-1', provider: 'linear' }]);
    oauthCredentialsService.refreshIfNeeded.mockRejectedValue(
      new Error('AS down'),
    );

    await expect(service.checkAndPauseIfNeeded(params)).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalled();
    expect(capabilityLink.mint).toHaveBeenCalled();
  });

  it('preserves the prior resume prompt on a re-pause with no new message', async () => {
    mockedCollect.mockReturnValue([{ nodeId: 'mcp-1', provider: 'linear' }]);
    oauthCredentialsService.refreshIfNeeded.mockResolvedValue({
      authenticated: false,
    });
    threadsDao.getOne.mockResolvedValue({
      id: 'thread-row-1',
      status: ThreadStatus.Waiting,
      runningStartedAt: null,
      totalRunningMs: 0,
      metadata: { waitCheckPrompt: 'original message' },
    });

    await service.checkAndPauseIfNeeded(params); // no pendingMessageText

    expect(threadsDao.updateById).toHaveBeenCalledWith(
      'thread-row-1',
      expect.objectContaining({
        metadata: expect.objectContaining({
          waitCheckPrompt: 'original message',
        }),
      }),
    );
  });
});
