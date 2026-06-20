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
  let em: EntityManager;
  let projectId: string;
  const createdGraphIds: string[] = [];

  beforeAll(async () => {
    app = await createTestModule(async (builder) =>
      builder
        .overrideProvider(SecretsStoreService)
        .useValue(mockStore)
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
    em = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    projectId = (await createTestProject(app)).projectId;
  });

  afterEach(async () => {
    createdGraphIds.splice(0);
    const forked = em.fork();
    await forked.nativeDelete(ThreadEntity, { projectId });
    await forked.nativeDelete(GraphEntity, { projectId });
    await forked.nativeDelete(OAuthCredentialEntity, { projectId });
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
  });
});
