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
    insertIfNotExists: ReturnType<typeof vi.fn>;
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
      insertIfNotExists: vi.fn(async () => ({ id: 'thread-row-new' })),
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

  it('inserts a Waiting row when the thread row does not exist yet (new-thread first run)', async () => {
    // Regression: a brand-new thread's row is created LATE (ensureThreadRow, after
    // invokeAgent), so at pre-flight time getOne returns null. The pre-flight MUST
    // insert the Waiting row up-front instead of no-opping — otherwise the run
    // proceeds without the credential and strands the thread Running, unreachable
    // by the credential-acquired resume + watchdog (both scoped to Waiting).
    mockedCollect.mockReturnValue([{ nodeId: 'mcp-1', provider: 'linear' }]);
    oauthCredentialsService.refreshIfNeeded.mockResolvedValue({
      authenticated: false,
    });
    threadsDao.getOne.mockResolvedValue(null);
    threadsDao.insertIfNotExists.mockResolvedValue({ id: 'thread-row-new' });

    await expect(
      service.checkAndPauseIfNeeded({ ...params, pendingMessageText: 'hi' }),
    ).resolves.toBe(true);

    // Inserted a fresh Waiting row (NOT a transition update) carrying the resume
    // prompt + credential wait metadata, with no timer (runningStartedAt null).
    expect(threadsDao.insertIfNotExists).toHaveBeenCalledWith(
      expect.objectContaining({
        graphId: 'graph-1',
        projectId: 'proj-1',
        createdBy: 'user-1',
        externalThreadId: 'graph-1:thread-1',
        status: ThreadStatus.Waiting,
        runningStartedAt: null,
        metadata: expect.objectContaining({
          waitReason: CREDENTIAL_WAIT_REASON,
          waitNodeId: 'agent-1',
          waitCheckPrompt: 'hi',
        }),
      }),
    );
    expect(threadsDao.updateById).not.toHaveBeenCalled();
    // Still fans auth_required + a ThreadUpdate(Waiting) so the UI suspends.
    expect(notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: NotificationEvent.ThreadUpdate,
        data: expect.objectContaining({ status: ThreadStatus.Waiting }),
      }),
    );
    expect(notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationEvent.AuthRequired }),
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

  describe('collectUnauthenticatedProviders', () => {
    const collectParams = { graphId: 'graph-1', createdBy: 'user-1' };

    it('returns an empty list and mints nothing when every provider is authenticated', async () => {
      mockedCollect.mockReturnValue([{ nodeId: 'mcp-1', provider: 'linear' }]);
      oauthCredentialsService.refreshIfNeeded.mockResolvedValue({
        authenticated: true,
      });

      await expect(
        service.collectUnauthenticatedProviders(collectParams),
      ).resolves.toEqual([]);
      // Read-only: the watchdog's resolver must never mint/pause/fan.
      expect(capabilityLink.mint).not.toHaveBeenCalled();
      expect(threadsDao.updateById).not.toHaveBeenCalled();
      expect(notifications.emit).not.toHaveBeenCalled();
    });

    it('returns the provider when its credential is missing', async () => {
      mockedCollect.mockReturnValue([{ nodeId: 'mcp-1', provider: 'linear' }]);
      oauthCredentialsService.refreshIfNeeded.mockResolvedValue({
        authenticated: false,
      });

      await expect(
        service.collectUnauthenticatedProviders(collectParams),
      ).resolves.toEqual([{ provider: OAuthProvider.Linear, nodeId: 'mcp-1' }]);
    });

    it('treats a refreshIfNeeded THROW as unauthenticated, returning the provider (fail-closed)', async () => {
      // The watchdog acts on the EMPTY-result outcome (re-enqueue a stranded
      // resume). If a transient AS error here collapsed to [] instead of
      // surfacing the provider, the watchdog would falsely recover a thread whose
      // credential is actually still unreachable — churning resume → re-pause.
      mockedCollect.mockReturnValue([{ nodeId: 'mcp-1', provider: 'linear' }]);
      oauthCredentialsService.refreshIfNeeded.mockRejectedValue(
        new Error('AS unreachable'),
      );

      await expect(
        service.collectUnauthenticatedProviders(collectParams),
      ).resolves.toEqual([{ provider: OAuthProvider.Linear, nodeId: 'mcp-1' }]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('returns an empty list for a graph with no OAuth nodes', async () => {
      mockedCollect.mockReturnValue([]);

      await expect(
        service.collectUnauthenticatedProviders(collectParams),
      ).resolves.toEqual([]);
      expect(oauthCredentialsService.refreshIfNeeded).not.toHaveBeenCalled();
    });

    it('returns an empty list for a graph with no projectId', async () => {
      graphDao.getById.mockResolvedValue({
        projectId: null,
        schema: {
          nodes: [{ id: 'mcp-1', template: 'linear-mcp', config: {} }],
        },
      });

      await expect(
        service.collectUnauthenticatedProviders(collectParams),
      ).resolves.toEqual([]);
      expect(oauthCredentialsService.refreshIfNeeded).not.toHaveBeenCalled();
    });

    it('returns an empty list for a deleted/missing graph (getById -> null)', async () => {
      // The watchdog calls this for a credential-wait thread whose graph row may
      // have been deleted. A null graph must resolve to [] (no providers to
      // resolve), never throw — a throw here would abort the per-thread recovery.
      graphDao.getById.mockResolvedValue(null);

      await expect(
        service.collectUnauthenticatedProviders(collectParams),
      ).resolves.toEqual([]);
    });
  });
});
