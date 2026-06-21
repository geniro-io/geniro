import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import { GraphEntity } from '../../../v1/graphs/entity/graph.entity';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { OAuthRunPreflightService } from '../../../v1/graphs/services/oauth-run-preflight.service';
import { NotificationEvent } from '../../../v1/notifications/notifications.types';
import { NotificationsService } from '../../../v1/notifications/services/notifications.service';
import { OAuthCredentialsDao } from '../../../v1/oauth-credentials/dao/oauth-credentials.dao';
import { OAuthCredentialEntity } from '../../../v1/oauth-credentials/entity/oauth-credential.entity';
import {
  CREDENTIAL_ACQUIRED_EVENT,
  CredentialAcquiredEvent,
} from '../../../v1/oauth-credentials/oauth-credentials.events';
import { OAuthProvider } from '../../../v1/oauth-credentials/oauth-credentials.types';
import { OAuthCredentialsService } from '../../../v1/oauth-credentials/services/oauth-credentials.service';
import { OAuthExchangeService } from '../../../v1/oauth-credentials/services/oauth-exchange.service';
import { SecretEntity } from '../../../v1/secrets/entity/secret.entity';
import { SecretsStoreService } from '../../../v1/secrets-store/services/secrets-store.service';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadEntity } from '../../../v1/threads/entity/thread.entity';
import { ThreadResumeService } from '../../../v1/threads/services/thread-resume.service';
import { ThreadResumeQueueService } from '../../../v1/threads/services/thread-resume-queue.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { createTestProject } from '../helpers/test-context';
import { createTestModule, TEST_USER_ID } from '../setup';

const mockStore = {
  isAvailable: vi.fn(() => true),
  putSecret: vi.fn(async () => undefined),
  getSecret: vi.fn(async () => ''),
  deleteSecret: vi.fn(async () => undefined),
};

const defaultPrepareAuthorization = async (
  _provider: OAuthProvider,
  _redirectUri: string,
  state: string,
): Promise<{
  authorizeUrl: string;
  client: { clientId: string; clientSecret: string | null };
}> => ({
  authorizeUrl: `https://mock.authorize.test/?state=${state}`,
  client: { clientId: 'dcr-client-test', clientSecret: null },
});

// The exchange service is overridden so the suite never reaches the real
// provider over the network. The "deletion-resistant" describe below drives the
// REAL exchange() producer through this mock (NOT a hand-emitted event), so
// removing the load-bearing eventEmitter.emit in exchange() turns it red.
const mockExchange = {
  prepareAuthorization: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
};

describe('OAuth auth_required pause/resume (integration)', () => {
  let app: INestApplication;
  let preflight: OAuthRunPreflightService;
  let resumeService: ThreadResumeService;
  let queueService: ThreadResumeQueueService;
  let notifications: NotificationsService;
  let eventEmitter: EventEmitter2;
  let graphDao: GraphDao;
  let oauthDao: OAuthCredentialsDao;
  let threadsDao: ThreadsDao;
  let credentialsService: OAuthCredentialsService;
  let em: EntityManager;
  let projectId: string;
  let ctx: AppContextStorage;
  const createdGraphIds: string[] = [];

  beforeAll(async () => {
    app = await createTestModule(async (builder) =>
      builder
        .overrideProvider(SecretsStoreService)
        .useValue(mockStore)
        .overrideProvider(OAuthExchangeService)
        .useValue(mockExchange)
        .compile(),
    );
    preflight = app.get(OAuthRunPreflightService);
    resumeService = app.get(ThreadResumeService);
    queueService = app.get(ThreadResumeQueueService);
    notifications = app.get(NotificationsService);
    eventEmitter = app.get(EventEmitter2);
    graphDao = app.get(GraphDao);
    oauthDao = app.get(OAuthCredentialsDao);
    threadsDao = app.get(ThreadsDao);
    credentialsService = app.get(OAuthCredentialsService);
    em = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExchange.prepareAuthorization.mockReset();
    mockExchange.prepareAuthorization.mockImplementation(
      defaultPrepareAuthorization,
    );
    mockExchange.exchangeAuthorizationCode.mockReset();
    const created = await createTestProject(app);
    projectId = created.projectId;
    ctx = created.ctx;
  });

  afterEach(async () => {
    createdGraphIds.splice(0);
    const forked = em.fork();
    await forked.nativeDelete(ThreadEntity, { projectId });
    await forked.nativeDelete(GraphEntity, { projectId });
    await forked.nativeDelete(OAuthCredentialEntity, { projectId });
    await forked.nativeDelete(SecretEntity, { projectId });
  });

  const seedLinearGraph = async (): Promise<string> => {
    const graph = await graphDao.create({
      name: 'Linear MCP graph',
      version: '1.0.0',
      targetVersion: '1.0.0',
      status: GraphStatus.Running,
      createdBy: TEST_USER_ID,
      projectId,
      settings: {},
      temporary: true,
      schema: {
        nodes: [
          {
            id: 'linear-1',
            template: 'linear-mcp',
            config: { token: 'LINEAR_OAUTH_TOKEN' },
          },
        ],
        edges: [],
      },
    });
    createdGraphIds.push(graph.id);
    return graph.id;
  };

  const seedThread = async (
    graphId: string,
    externalThreadId: string,
    status: ThreadStatus,
    metadata: Record<string, unknown> = {},
  ): Promise<string> => {
    const thread = await threadsDao.create({
      graphId,
      projectId,
      externalThreadId,
      createdBy: TEST_USER_ID,
      status,
      metadata,
    });
    return thread.id;
  };

  describe('producer — checkAndPauseIfNeeded', () => {
    it('pauses (Waiting) + fans auth_required when the credential is missing', async () => {
      const graphId = await seedLinearGraph();
      const externalThreadId = `${graphId}:t1`;
      await seedThread(graphId, externalThreadId, ThreadStatus.Running);
      const emitSpy = vi.spyOn(notifications, 'emit');

      const paused = await preflight.checkAndPauseIfNeeded({
        graphId,
        externalThreadId,
        createdBy: TEST_USER_ID,
        agentNodeId: 'agent-1',
        pendingMessageText: 'do the thing',
      });

      expect(paused).toBe(true);

      const thread = await threadsDao.getOne({ graphId, externalThreadId });
      expect(thread?.status).toBe(ThreadStatus.Waiting);
      const meta = thread?.metadata as Record<string, unknown>;
      expect(meta.waitReason).toBe('credential');
      expect(meta.waitNodeId).toBe('agent-1');
      expect(meta.waitCheckPrompt).toBe('do the thing');
      expect(meta.scheduledResumeAt).toBeUndefined();

      const authReq = emitSpy.mock.calls
        .map(([n]) => n)
        .find((n) => n.type === NotificationEvent.AuthRequired);
      expect(authReq).toBeDefined();
      expect(authReq).toMatchObject({
        projectId,
        threadId: externalThreadId,
        nodeId: 'linear-1',
        data: { provider: OAuthProvider.Linear },
      });
      expect(
        (authReq as { data: { capabilityToken: string } }).data.capabilityToken,
      ).toBeTruthy();
    });

    it('CREATES a Waiting row when none exists yet (new-thread first run)', async () => {
      // Regression for the production trigger ordering: a brand-new thread's row
      // is created LATE (ThreadsService.ensureThreadRow, AFTER invokeAgent), so at
      // pre-flight time there is NO row to transition. The pre-flight must INSERT
      // the Waiting row itself. The sibling test above pre-seeds the row via
      // seedThread() — mirroring the bug that masked this: with no row the old
      // pauseThread merely warned "no thread row to pause" and the run proceeded
      // without the credential, stranding the thread Running (never Waiting), so
      // the credential-acquired resume + overdue watchdog could never recover it.
      const graphId = await seedLinearGraph();
      const externalThreadId = `${graphId}:new-thread`;
      // Intentionally NO seedThread() — the row must not exist before pre-flight.
      const emitSpy = vi.spyOn(notifications, 'emit');

      const paused = await preflight.checkAndPauseIfNeeded({
        graphId,
        externalThreadId,
        createdBy: TEST_USER_ID,
        agentNodeId: 'agent-1',
        pendingMessageText: 'list my issues',
      });

      expect(paused).toBe(true);

      // The pre-flight INSERTED a fresh Waiting row (not just warned + no-opped).
      const thread = await threadsDao.getOne({ graphId, externalThreadId });
      expect(thread).toBeTruthy();
      expect(thread?.status).toBe(ThreadStatus.Waiting);
      expect(thread?.projectId).toBe(projectId);
      expect(thread?.createdBy).toBe(TEST_USER_ID);
      const meta = thread?.metadata as Record<string, unknown>;
      expect(meta.waitReason).toBe('credential');
      expect(meta.waitNodeId).toBe('agent-1');
      expect(meta.waitCheckPrompt).toBe('list my issues');
      // Pure credential wait — no timer, so the overdue watchdog won't churn it.
      expect(meta.scheduledResumeAt).toBeUndefined();

      const authReq = emitSpy.mock.calls
        .map(([n]) => n)
        .find((n) => n.type === NotificationEvent.AuthRequired);
      expect(authReq).toBeDefined();
      expect(authReq).toMatchObject({
        projectId,
        threadId: externalThreadId,
        nodeId: 'linear-1',
        data: { provider: OAuthProvider.Linear },
      });
    });

    it('proceeds (false) when a valid credential exists', async () => {
      const graphId = await seedLinearGraph();
      const externalThreadId = `${graphId}:t2`;
      await seedThread(graphId, externalThreadId, ThreadStatus.Running);
      await oauthDao.create({
        provider: OAuthProvider.Linear,
        accountLabel: 'Acme',
        secretName: 'LINEAR_OAUTH_TOKEN',
        scopes: ['read'],
        createdBy: TEST_USER_ID,
        projectId,
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      const paused = await preflight.checkAndPauseIfNeeded({
        graphId,
        externalThreadId,
        createdBy: TEST_USER_ID,
        agentNodeId: 'agent-1',
      });

      expect(paused).toBe(false);
      const thread = await threadsDao.getOne({ graphId, externalThreadId });
      expect(thread?.status).toBe(ThreadStatus.Running);
    });
  });

  describe('resume bridge — credential.acquired @OnEvent', () => {
    it('enqueues a zero-delay resume for a credential-waiting thread', async () => {
      const graphId = await seedLinearGraph();
      const externalThreadId = `${graphId}:r1`;
      const threadRowId = await seedThread(
        graphId,
        externalThreadId,
        ThreadStatus.Waiting,
        {
          waitReason: 'credential',
          waitNodeId: 'agent-1',
          waitCheckPrompt: 'go',
        },
      );
      const scheduleSpy = vi
        .spyOn(queueService, 'scheduleResume')
        .mockResolvedValue(undefined);

      // Fire through the REAL EventEmitter2 bus to exercise the @OnEvent wiring.
      await eventEmitter.emitAsync(CREDENTIAL_ACQUIRED_EVENT, {
        projectId,
        provider: OAuthProvider.Linear,
        threadId: externalThreadId,
      } satisfies CredentialAcquiredEvent);

      expect(scheduleSpy).toHaveBeenCalledTimes(1);
      expect(scheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: threadRowId,
          graphId,
          externalThreadId,
          nodeId: 'agent-1',
          checkPrompt: 'go',
          reason: 'credential',
          createdBy: TEST_USER_ID,
        }),
        0,
      );
    });

    it('does NOT resume when the event carries no threadId', async () => {
      const scheduleSpy = vi
        .spyOn(queueService, 'scheduleResume')
        .mockResolvedValue(undefined);

      await eventEmitter.emitAsync(CREDENTIAL_ACQUIRED_EVENT, {
        projectId,
        provider: OAuthProvider.Linear,
      } satisfies CredentialAcquiredEvent);

      expect(scheduleSpy).not.toHaveBeenCalled();
    });

    it('does NOT resume a thread waiting for a non-credential reason (e.g. a timer)', async () => {
      const graphId = await seedLinearGraph();
      const externalThreadId = `${graphId}:r2`;
      await seedThread(graphId, externalThreadId, ThreadStatus.Waiting, {
        waitReason: 'timer',
        waitNodeId: 'agent-1',
      });
      const scheduleSpy = vi
        .spyOn(queueService, 'scheduleResume')
        .mockResolvedValue(undefined);

      await eventEmitter.emitAsync(CREDENTIAL_ACQUIRED_EVENT, {
        projectId,
        provider: OAuthProvider.Linear,
        threadId: externalThreadId,
      } satisfies CredentialAcquiredEvent);

      expect(scheduleSpy).not.toHaveBeenCalled();
    });

    it('does NOT resume a thread that is no longer Waiting', async () => {
      const graphId = await seedLinearGraph();
      const externalThreadId = `${graphId}:r3`;
      await seedThread(graphId, externalThreadId, ThreadStatus.Running, {
        waitReason: 'credential',
      });
      const scheduleSpy = vi
        .spyOn(queueService, 'scheduleResume')
        .mockResolvedValue(undefined);

      await eventEmitter.emitAsync(CREDENTIAL_ACQUIRED_EVENT, {
        projectId,
        provider: OAuthProvider.Linear,
        threadId: externalThreadId,
      } satisfies CredentialAcquiredEvent);

      expect(scheduleSpy).not.toHaveBeenCalled();
    });
  });

  describe('watchdog backstop — recoverOverdueThreads for credential-waits', () => {
    /**
     * A run paused for an OAuth-MCP credential clears `scheduledResumeAt` (the
     * resume is event-driven via `credential.acquired`, NOT clock-driven), so
     * the thread sits in Waiting with `waitReason === 'credential'` and NO
     * `scheduledResumeAt`. If the event-driven resume never lands — a co-pending
     * thread on the same (project, provider) whose `credential.acquired` carried
     * a different threadId, a Connections-page proactive connect with no
     * threadId, or a BullMQ retry-exhaustion that stopped only the event's own
     * thread — the credential is now valid but this thread is stranded Waiting
     * forever with no recovery path.
     *
     * The watchdog is the only periodic safety net. It MUST re-enqueue a resume
     * for a credential-wait thread once the provider's credential is valid. This
     * test seeds exactly that state (Waiting, waitReason=credential, no
     * scheduledResumeAt) with a valid credential present, drives the watchdog,
     * and asserts the thread is recovered (a resume is enqueued for it).
     */
    it('recovers a stranded credential-wait thread once the credential is valid', async () => {
      const graphId = await seedLinearGraph();
      const externalThreadId = `${graphId}:wd1`;
      const threadRowId = await seedThread(
        graphId,
        externalThreadId,
        ThreadStatus.Waiting,
        {
          waitReason: 'credential',
          waitNodeId: 'agent-1',
          waitCheckPrompt: 'go',
          // No scheduledResumeAt — a credential wait is event-driven, not timed.
        },
      );

      // The credential is now present and valid (far-future expiry), exactly as
      // it would be the instant after the user authenticated from any browser.
      await oauthDao.create({
        provider: OAuthProvider.Linear,
        accountLabel: 'Acme',
        secretName: 'LINEAR_OAUTH_TOKEN',
        scopes: ['read'],
        createdBy: TEST_USER_ID,
        projectId,
        expiresAt: new Date(Date.now() + 3_600_000),
        clientId: 'dcr-client-test',
      });

      const scheduleSpy = vi
        .spyOn(queueService, 'scheduleResume')
        .mockResolvedValue(undefined);

      // Drive the periodic safety net directly (it is otherwise on a 60s timer).
      await (
        resumeService as unknown as {
          recoverOverdueThreads: () => Promise<void>;
        }
      ).recoverOverdueThreads();

      // The stranded credential-wait thread must be re-enqueued for resume —
      // it is the only periodic recovery path once the event-driven resume is
      // missed. RED today: the watchdog does `if (!scheduledResumeAt) continue`
      // and skips every credential wait.
      expect(scheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: threadRowId,
          graphId,
          externalThreadId,
          reason: 'credential',
        }),
        expect.any(Number),
      );
    });

    /**
     * The companion to the recovery case above, exercised through the REAL
     * preflight (no credential row seeded -> `refreshIfNeeded` reports
     * unauthenticated). A credential-wait thread whose credential is STILL
     * missing must be left untouched — re-enqueuing it would churn a
     * resume -> re-pause -> re-fan `auth_required` loop minting a fresh
     * capability link every 60s sweep. The unit spec pins this with a mocked
     * resolver; this pins it end-to-end against the real `collectUnauthenticated
     * Providers` + DB so a regression in the real resolver is caught.
     */
    it('does NOT recover a credential-wait thread while the credential is still missing', async () => {
      const graphId = await seedLinearGraph();
      const externalThreadId = `${graphId}:wd2`;
      await seedThread(graphId, externalThreadId, ThreadStatus.Waiting, {
        waitReason: 'credential',
        waitNodeId: 'agent-1',
        waitCheckPrompt: 'go',
        // No scheduledResumeAt; and crucially no OAuth credential row seeded —
        // the provider is genuinely unauthenticated at sweep time.
      });

      const scheduleSpy = vi
        .spyOn(queueService, 'scheduleResume')
        .mockResolvedValue(undefined);

      await (
        resumeService as unknown as {
          recoverOverdueThreads: () => Promise<void>;
        }
      ).recoverOverdueThreads();

      // Still-missing credential -> the watchdog leaves the thread stranded
      // (no resume enqueued), avoiding the re-pause churn loop.
      expect(scheduleSpy).not.toHaveBeenCalled();
      const thread = await threadsDao.getOne({ graphId, externalThreadId });
      expect(thread?.status).toBe(ThreadStatus.Waiting);
    });
  });

  describe('resume bridge — driven by the REAL exchange() producer (deletion-resistant)', () => {
    /**
     * The `credential.acquired @OnEvent` tests above hand-emit the event, so
     * deleting the load-bearing `eventEmitter.emit(CREDENTIAL_ACQUIRED_EVENT)` in
     * `OAuthCredentialsService.exchange()` keeps them green. This test instead
     * drives a real `exchange()` end-to-end: start() stashes the pending-state
     * carrying the paused thread's id, exchange() persists the token and emits
     * the bridge event, and the @OnEvent resume handler enqueues the resume —
     * exactly the production path. Deleting the emit makes THIS go red.
     */
    it('a completed exchange() resumes the paused credential-wait thread', async () => {
      const graphId = await seedLinearGraph();
      const externalThreadId = `${graphId}:x1`;
      const threadRowId = await seedThread(
        graphId,
        externalThreadId,
        ThreadStatus.Waiting,
        {
          waitReason: 'credential',
          waitNodeId: 'agent-1',
          waitCheckPrompt: 'go',
        },
      );

      mockExchange.exchangeAuthorizationCode.mockResolvedValue({
        accessToken: 'lin_oauth_token_f3',
        scopes: ['read'],
        expiresAt: null,
        accountLabel: 'Acme',
      });
      const scheduleSpy = vi
        .spyOn(queueService, 'scheduleResume')
        .mockResolvedValue(undefined);

      // start() persists the pending-state carrying this thread's id, so the real
      // exchange() emits `credential.acquired` with `threadId` set (no hand-emit).
      const { authorizeUrl } = await credentialsService.start(
        ctx,
        OAuthProvider.Linear,
        { threadId: externalThreadId },
      );
      const state = new URL(authorizeUrl).searchParams.get('state') as string;

      await credentialsService.exchange(ctx, {
        provider: OAuthProvider.Linear,
        code: 'code-f3',
        state,
      });

      // The EventEmitter2 bridge is fire-and-forget, so the @OnEvent handler runs
      // on a later tick — poll for the enqueue. Deleting the emit → never fires.
      await vi.waitFor(
        () => {
          expect(scheduleSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              threadId: threadRowId,
              graphId,
              externalThreadId,
              reason: 'credential',
            }),
            0,
          );
        },
        { timeout: 5000, interval: 50 },
      );
    });
  });
});
