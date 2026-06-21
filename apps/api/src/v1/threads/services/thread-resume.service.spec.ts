import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SimpleAgent } from '../../agents/services/agents/simple-agent';
import {
  CompiledGraph,
  CompiledGraphNode,
  GraphStatus,
  NodeKind,
} from '../../graphs/graphs.types';
import { GraphRegistry } from '../../graphs/services/graph-registry';
import { OAuthRunPreflightService } from '../../graphs/services/oauth-run-preflight.service';
import { NotificationEvent } from '../../notifications/notifications.types';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { ThreadsDao } from '../dao/threads.dao';
import { ThreadEntity } from '../entity/thread.entity';
import { ThreadStatus } from '../threads.types';
import { ThreadResumeService } from './thread-resume.service';
import { ThreadResumeQueueService } from './thread-resume-queue.service';
import { ThreadStatusTransitionService } from './thread-status-transition.service';

const mockQueueService = {
  setCallbacks: vi.fn(),
  scheduleResume: vi.fn().mockResolvedValue(undefined),
  cancelResumeJob: vi.fn().mockResolvedValue(undefined),
  cancelAllForGraph: vi.fn().mockResolvedValue(undefined),
  hasJob: vi.fn().mockResolvedValue(false),
};

const mockThreadsDao = {
  getOne: vi.fn(),
  getById: vi.fn(),
  getAll: vi.fn().mockResolvedValue([]),
  updateById: vi.fn().mockResolvedValue(1),
};

const mockTransitionService = {
  computeTransition: vi.fn(),
};

// Default: no credential pause, so existing resume paths proceed unchanged.
// collectUnauthenticatedProviders defaults to [] (every credential valid), so a
// credential-wait recovery enqueues unless a test overrides it.
const mockOAuthPreflight = {
  checkAndPauseIfNeeded: vi.fn().mockResolvedValue(false),
  collectUnauthenticatedProviders: vi.fn().mockResolvedValue([]),
};

const mockGraphRegistry = {
  get: vi.fn(),
};

const mockNotificationsService = {
  emit: vi.fn().mockResolvedValue(undefined),
};

const mockLogger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

const makeThread = (overrides: Partial<ThreadEntity> = {}): ThreadEntity =>
  ({
    id: 'thread-1',
    graphId: 'graph-1',
    externalThreadId: 'ext-thread-1',
    status: ThreadStatus.Waiting,
    createdBy: 'user-1',
    metadata: {
      scheduledResumeAt: '2024-01-01T00:05:00.000Z',
      waitReason: 'Waiting for deploy',
      waitNodeId: 'node-1',
      waitCheckPrompt: 'Check deployment status',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as unknown as ThreadEntity;

const makeCompiledGraph = (hasNode = true): CompiledGraph => {
  const mockAgent = Object.assign(Object.create(SimpleAgent.prototype), {
    run: vi.fn().mockResolvedValue({ messages: [], threadId: 'ext-thread-1' }),
  });

  const nodes = new Map<string, CompiledGraphNode>();
  if (hasNode) {
    nodes.set('node-1', {
      id: 'node-1',
      type: NodeKind.SimpleAgent,
      template: 'simple-agent',
      config: {},
      instance: mockAgent,
      handle: {
        provide: async () => mockAgent,
        configure: async () => {},
        destroy: async () => {},
      },
    });
  }

  return {
    metadata: {
      graphId: 'graph-1',
      version: '1.0.0',
      graph_created_by: 'user-1',
      graph_project_id: 'project-1',
    },
    status: GraphStatus.Running,
    nodes,
    edges: [],
    destroy: vi.fn(),
    state: {} as CompiledGraph['state'],
  };
};

describe('ThreadResumeService', () => {
  let service: ThreadResumeService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransitionService.computeTransition.mockImplementation(
      (_thread: unknown, nextStatus: ThreadStatus) => ({
        status: nextStatus,
        runningStartedAt: null,
        totalRunningMs: 0,
      }),
    );
    service = new ThreadResumeService(
      mockQueueService as unknown as ThreadResumeQueueService,
      mockThreadsDao as unknown as ThreadsDao,
      mockGraphRegistry as unknown as GraphRegistry,
      mockNotificationsService as unknown as NotificationsService,
      mockLogger as unknown as DefaultLogger,
      mockTransitionService as unknown as ThreadStatusTransitionService,
      mockOAuthPreflight as unknown as OAuthRunPreflightService,
    );
  });

  describe('onModuleInit', () => {
    it('registers callbacks with the queue service', () => {
      service.onModuleInit();

      expect(mockQueueService.setCallbacks).toHaveBeenCalledWith({
        onProcess: expect.any(Function),
        onFailed: expect.any(Function),
      });
    });
  });

  describe('onThreadWaiting', () => {
    it('schedules a resume job for the thread', async () => {
      const thread = makeThread({ status: ThreadStatus.Waiting });
      mockThreadsDao.getOne.mockResolvedValue(thread);

      await service.onThreadWaiting({
        graphId: 'graph-1',
        nodeId: 'node-1',
        threadId: 'ext-thread-1',
        durationSeconds: 300,
        checkPrompt: 'Check deployment status',
        reason: 'Waiting for deploy',
      });

      expect(mockThreadsDao.updateById).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            waitReason: 'Waiting for deploy',
            waitNodeId: 'node-1',
            waitCheckPrompt: 'Check deployment status',
          }),
        }),
      );

      expect(mockNotificationsService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationEvent.ThreadUpdate,
          data: expect.objectContaining({
            status: ThreadStatus.Waiting,
            waitReason: 'Waiting for deploy',
          }),
        }),
      );

      expect(mockQueueService.scheduleResume).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1',
          graphId: 'graph-1',
          nodeId: 'node-1',
          checkPrompt: 'Check deployment status',
        }),
        300_000,
      );
    });

    it('logs warning and returns when thread not found', async () => {
      mockThreadsDao.getOne.mockResolvedValue(null);

      await service.onThreadWaiting({
        graphId: 'graph-1',
        nodeId: 'node-1',
        threadId: 'ext-thread-1',
        durationSeconds: 60,
        checkPrompt: 'Check',
        reason: 'Reason',
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Thread not found for waiting event',
        expect.anything(),
      );
      expect(mockQueueService.scheduleResume).not.toHaveBeenCalled();
    });
  });

  describe('handleResume', () => {
    it('resumes the thread by invoking the agent', async () => {
      const thread = makeThread();
      mockThreadsDao.getById.mockResolvedValue(thread);

      const compiledGraph = makeCompiledGraph();
      mockGraphRegistry.get.mockReturnValue(compiledGraph);

      await service.handleResume({
        threadId: 'thread-1',
        graphId: 'graph-1',
        nodeId: 'node-1',
        externalThreadId: 'ext-thread-1',
        checkPrompt: 'Check deployment status',
        reason: 'Waiting for deploy',
        scheduledAt: '2024-01-01T00:05:00.000Z',
        createdBy: 'user-1',
      });

      // Thread status updated to Running and wait metadata cleared in a single write
      expect(mockTransitionService.computeTransition).toHaveBeenCalledWith(
        thread,
        ThreadStatus.Running,
      );
      expect(mockThreadsDao.updateById).toHaveBeenCalledWith(
        thread.id,
        expect.objectContaining({
          status: ThreadStatus.Running,
          metadata: expect.objectContaining({}),
        }),
      );

      // Agent was invoked
      const agentNode = compiledGraph.nodes.get('node-1');
      const agent = agentNode?.instance as SimpleAgent;
      expect(vi.mocked(agent.run)).toHaveBeenCalledWith(
        'ext-thread-1',
        expect.arrayContaining([
          expect.objectContaining({ content: 'Check deployment status' }),
        ]),
        undefined,
        expect.objectContaining({
          configurable: expect.objectContaining({
            thread_id: 'ext-thread-1',
            graph_id: 'graph-1',
          }),
        }),
      );
    });

    it('re-pauses (returns without running) when the OAuth pre-flight still fails at resume', async () => {
      const thread = makeThread(); // status Waiting
      mockThreadsDao.getById.mockResolvedValue(thread);
      // Credential still missing at resume time -> pre-flight re-pauses.
      mockOAuthPreflight.checkAndPauseIfNeeded.mockResolvedValueOnce(true);

      await service.handleResume({
        threadId: 'thread-1',
        graphId: 'graph-1',
        nodeId: 'node-1',
        externalThreadId: 'ext-thread-1',
        checkPrompt: 'go',
        reason: 'credential',
        scheduledAt: '2024-01-01T00:05:00.000Z',
        createdBy: 'user-1',
      });

      expect(mockOAuthPreflight.checkAndPauseIfNeeded).toHaveBeenCalledWith(
        expect.objectContaining({
          graphId: 'graph-1',
          externalThreadId: 'ext-thread-1',
          agentNodeId: 'node-1',
          createdBy: 'user-1',
        }),
      );
      // Returned early: never looked up the graph, never transitioned to Running.
      expect(mockGraphRegistry.get).not.toHaveBeenCalled();
      expect(mockTransitionService.computeTransition).not.toHaveBeenCalledWith(
        thread,
        ThreadStatus.Running,
      );
    });

    it('throws when graph is not in registry so BullMQ retries', async () => {
      const thread = makeThread();
      mockThreadsDao.getById.mockResolvedValue(thread);
      mockGraphRegistry.get.mockReturnValue(undefined);

      await expect(
        service.handleResume({
          threadId: 'thread-1',
          graphId: 'graph-1',
          nodeId: 'node-1',
          externalThreadId: 'ext-thread-1',
          checkPrompt: 'Check',
          reason: 'Reason',
          scheduledAt: '2024-01-01T00:05:00.000Z',
          createdBy: 'user-1',
        }),
      ).rejects.toThrow('not in registry');
    });

    it('throws when agent node not found in graph so BullMQ retries', async () => {
      const thread = makeThread();
      mockThreadsDao.getById.mockResolvedValue(thread);

      const compiledGraph = makeCompiledGraph(false);
      mockGraphRegistry.get.mockReturnValue(compiledGraph);

      await expect(
        service.handleResume({
          threadId: 'thread-1',
          graphId: 'graph-1',
          nodeId: 'node-1',
          externalThreadId: 'ext-thread-1',
          checkPrompt: 'Check',
          reason: 'Reason',
          scheduledAt: '2024-01-01T00:05:00.000Z',
          createdBy: 'user-1',
        }),
      ).rejects.toThrow('not found in graph');
    });

    it('returns when thread not found', async () => {
      mockThreadsDao.getById.mockResolvedValue(null);

      await service.handleResume({
        threadId: 'thread-1',
        graphId: 'graph-1',
        nodeId: 'node-1',
        externalThreadId: 'ext-thread-1',
        checkPrompt: 'Check',
        reason: 'Reason',
        scheduledAt: '2024-01-01T00:05:00.000Z',
        createdBy: 'user-1',
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Thread not found for resume',
        expect.anything(),
      );
      expect(mockGraphRegistry.get).not.toHaveBeenCalled();
    });
  });

  describe('handleResumeFailed', () => {
    it('updates thread to stopped and emits notification', async () => {
      const thread = makeThread();
      mockThreadsDao.getById.mockResolvedValue(thread);

      const error = new Error('resume failed');
      await service.handleResumeFailed(
        {
          threadId: 'thread-1',
          graphId: 'graph-1',
          nodeId: 'node-1',
          externalThreadId: 'ext-thread-1',
          checkPrompt: 'Check',
          reason: 'Reason',
          scheduledAt: '2024-01-01T00:05:00.000Z',
          createdBy: 'user-1',
        },
        error,
      );

      expect(mockTransitionService.computeTransition).toHaveBeenCalledWith(
        thread,
        ThreadStatus.Stopped,
      );
      expect(mockThreadsDao.updateById).toHaveBeenCalledWith(
        thread.id,
        expect.objectContaining({
          status: ThreadStatus.Stopped,
          metadata: expect.objectContaining({
            resumeError: 'resume failed',
          }),
        }),
      );

      expect(mockNotificationsService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationEvent.ThreadUpdate,
          data: { status: ThreadStatus.Stopped },
        }),
      );
    });

    it('writes metadata via updateById when thread is not found', async () => {
      mockThreadsDao.getById.mockResolvedValue(null);

      const error = new Error('resume failed');
      await service.handleResumeFailed(
        {
          threadId: 'thread-1',
          graphId: 'graph-1',
          nodeId: 'node-1',
          externalThreadId: 'ext-thread-1',
          checkPrompt: 'Check',
          reason: 'Reason',
          scheduledAt: '2024-01-01T00:05:00.000Z',
          createdBy: 'user-1',
        },
        error,
      );

      expect(mockTransitionService.computeTransition).not.toHaveBeenCalled();
      expect(mockThreadsDao.updateById).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            resumeError: 'resume failed',
          }),
        }),
      );
    });
  });

  describe('resumeEarly', () => {
    it('cancels the pending job and triggers immediate resume', async () => {
      const thread = makeThread();
      mockThreadsDao.getById.mockResolvedValue(thread);

      const compiledGraph = makeCompiledGraph();
      mockGraphRegistry.get.mockReturnValue(compiledGraph);

      await service.resumeEarly('thread-1');

      expect(mockQueueService.cancelResumeJob).toHaveBeenCalledWith('thread-1');

      // Agent should have been invoked
      const agentNode = compiledGraph.nodes.get('node-1');
      const agent = agentNode?.instance as SimpleAgent;
      expect(vi.mocked(agent.run)).toHaveBeenCalled();
    });

    it('throws when thread not found', async () => {
      mockThreadsDao.getById.mockResolvedValue(null);

      await expect(service.resumeEarly('thread-1')).rejects.toThrow(
        'Thread not found',
      );
    });

    it('throws when thread is not in waiting state', async () => {
      const thread = makeThread({ status: ThreadStatus.Running });
      mockThreadsDao.getById.mockResolvedValue(thread);

      await expect(service.resumeEarly('thread-1')).rejects.toThrow(
        'Thread is not in waiting state',
      );
    });
  });

  describe('recoverOverdueThreads', () => {
    it('re-schedules resume for overdue waiting thread with no job', async () => {
      const overdueThread = makeThread({
        metadata: {
          scheduledResumeAt: new Date(Date.now() - 120_000).toISOString(),
          waitReason: 'Waiting for deploy',
          waitNodeId: 'node-1',
          waitCheckPrompt: 'Check deployment status',
        },
      });
      mockThreadsDao.getAll.mockResolvedValue([overdueThread]);
      mockQueueService.hasJob.mockResolvedValue(false);

      // Access private method via cast
      await (
        service as unknown as { recoverOverdueThreads: () => Promise<void> }
      ).recoverOverdueThreads();

      expect(mockQueueService.scheduleResume).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1',
          graphId: 'graph-1',
          nodeId: 'node-1',
        }),
        0,
      );
    });

    it('skips threads that still have a BullMQ job', async () => {
      const overdueThread = makeThread({
        metadata: {
          scheduledResumeAt: new Date(Date.now() - 120_000).toISOString(),
          waitReason: 'Waiting',
          waitNodeId: 'node-1',
          waitCheckPrompt: 'Check',
        },
      });
      mockThreadsDao.getAll.mockResolvedValue([overdueThread]);
      mockQueueService.hasJob.mockResolvedValue(true);

      await (
        service as unknown as { recoverOverdueThreads: () => Promise<void> }
      ).recoverOverdueThreads();

      expect(mockQueueService.scheduleResume).not.toHaveBeenCalled();
    });

    it('skips threads within the grace period', async () => {
      const recentThread = makeThread({
        metadata: {
          scheduledResumeAt: new Date(Date.now() - 10_000).toISOString(),
          waitReason: 'Waiting',
          waitNodeId: 'node-1',
          waitCheckPrompt: 'Check',
        },
      });
      mockThreadsDao.getAll.mockResolvedValue([recentThread]);

      await (
        service as unknown as { recoverOverdueThreads: () => Promise<void> }
      ).recoverOverdueThreads();

      expect(mockQueueService.hasJob).not.toHaveBeenCalled();
      expect(mockQueueService.scheduleResume).not.toHaveBeenCalled();
    });

    it('skips a non-credential thread without scheduledResumeAt metadata', async () => {
      // A timer wait clears `scheduledResumeAt` on completion; a thread with no
      // wait metadata at all is neither a timer nor a credential wait — it must
      // not be touched by the watchdog.
      const threadNoMeta = makeThread({ metadata: {} });
      mockThreadsDao.getAll.mockResolvedValue([threadNoMeta]);

      await (
        service as unknown as { recoverOverdueThreads: () => Promise<void> }
      ).recoverOverdueThreads();

      expect(
        mockOAuthPreflight.collectUnauthenticatedProviders,
      ).not.toHaveBeenCalled();
      expect(mockQueueService.scheduleResume).not.toHaveBeenCalled();
    });

    it('recovers a credential-wait thread (no scheduledResumeAt) once the credential is valid', async () => {
      // A credential wait is event-driven (no timer). If its `credential.acquired`
      // resume was missed, this watchdog is the only recovery path — it must
      // re-enqueue the resume the moment the provider's credential is valid.
      const credentialWait = makeThread({
        metadata: {
          waitReason: 'credential',
          waitNodeId: 'node-1',
          waitCheckPrompt: 'go',
        },
      });
      mockThreadsDao.getAll.mockResolvedValue([credentialWait]);
      mockQueueService.hasJob.mockResolvedValue(false);
      mockOAuthPreflight.collectUnauthenticatedProviders.mockResolvedValue([]);

      await (
        service as unknown as { recoverOverdueThreads: () => Promise<void> }
      ).recoverOverdueThreads();

      expect(
        mockOAuthPreflight.collectUnauthenticatedProviders,
      ).toHaveBeenCalledWith({ graphId: 'graph-1', createdBy: 'user-1' });
      expect(mockQueueService.scheduleResume).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1',
          graphId: 'graph-1',
          externalThreadId: 'ext-thread-1',
          nodeId: 'node-1',
          checkPrompt: 'go',
          reason: 'credential',
          createdBy: 'user-1',
        }),
        0,
      );
    });

    it('does NOT recover a credential-wait thread while the credential is still missing', async () => {
      // Re-enqueuing while the credential is still gone would churn a
      // resume → re-pause → re-fan `auth_required` loop every sweep.
      const credentialWait = makeThread({
        metadata: { waitReason: 'credential', waitNodeId: 'node-1' },
      });
      mockThreadsDao.getAll.mockResolvedValue([credentialWait]);
      mockQueueService.hasJob.mockResolvedValue(false);
      mockOAuthPreflight.collectUnauthenticatedProviders.mockResolvedValue([
        { provider: 'linear', nodeId: 'node-1' },
      ]);

      await (
        service as unknown as { recoverOverdueThreads: () => Promise<void> }
      ).recoverOverdueThreads();

      expect(mockQueueService.scheduleResume).not.toHaveBeenCalled();
    });

    it('does NOT recover a credential-wait thread that already has a pending job', async () => {
      const credentialWait = makeThread({
        metadata: { waitReason: 'credential', waitNodeId: 'node-1' },
      });
      mockThreadsDao.getAll.mockResolvedValue([credentialWait]);
      mockQueueService.hasJob.mockResolvedValue(true);

      await (
        service as unknown as { recoverOverdueThreads: () => Promise<void> }
      ).recoverOverdueThreads();

      expect(
        mockOAuthPreflight.collectUnauthenticatedProviders,
      ).not.toHaveBeenCalled();
      expect(mockQueueService.scheduleResume).not.toHaveBeenCalled();
    });

    it('keeps sweeping when one credential-wait throws — a later thread still recovers', async () => {
      // Two credential-wait threads. The FIRST throws inside the provider
      // resolution; the per-thread guard must swallow it so the SECOND (whose
      // credential is now valid) is still re-enqueued. A regression that lets the
      // throw escape recoverCredentialWait would either abort the loop before the
      // second thread or bubble to the outer catch — both leave thread-2 stranded.
      const throwingThread = makeThread({
        id: 'thread-throws',
        externalThreadId: 'ext-throws',
        metadata: { waitReason: 'credential', waitNodeId: 'node-1' },
      });
      const recoverableThread = makeThread({
        id: 'thread-ok',
        externalThreadId: 'ext-ok',
        metadata: {
          waitReason: 'credential',
          waitNodeId: 'node-9',
          waitCheckPrompt: 'resume me',
        },
      });
      mockThreadsDao.getAll.mockResolvedValue([
        throwingThread,
        recoverableThread,
      ]);
      mockQueueService.hasJob.mockResolvedValue(false);
      mockOAuthPreflight.collectUnauthenticatedProviders
        .mockRejectedValueOnce(new Error('AS unreachable'))
        .mockResolvedValueOnce([]);

      await (
        service as unknown as { recoverOverdueThreads: () => Promise<void> }
      ).recoverOverdueThreads();

      // Thread-2 recovered despite thread-1 throwing.
      expect(mockQueueService.scheduleResume).toHaveBeenCalledTimes(1);
      expect(mockQueueService.scheduleResume).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-ok',
          externalThreadId: 'ext-ok',
          nodeId: 'node-9',
          checkPrompt: 'resume me',
          reason: 'credential',
        }),
        0,
      );
      // The first thread's failure was logged, not re-thrown, and produced no
      // false resume enqueue for itself.
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.any(Error),
        'Failed to recover stranded credential-wait thread',
        expect.objectContaining({ threadId: 'thread-throws' }),
      );
    });

    it('does NOT abort the sweep when a credential-wait throws before a timer wait — the timer still re-schedules', async () => {
      // A credential-wait thread that throws must not prevent an OVERDUE TIMER
      // wait later in the same batch from being re-scheduled. This guards the
      // cross-cohort path: the credential branch (no scheduledResumeAt) and the
      // timer branch (overdue scheduledResumeAt) share one loop, and a throw on
      // the former must not strand the latter.
      const throwingCredential = makeThread({
        id: 'thread-cred-throws',
        metadata: { waitReason: 'credential', waitNodeId: 'node-1' },
      });
      const overdueTimer = makeThread({
        id: 'thread-timer',
        externalThreadId: 'ext-timer',
        metadata: {
          scheduledResumeAt: new Date(Date.now() - 120_000).toISOString(),
          waitReason: 'Waiting for deploy',
          waitNodeId: 'node-7',
          waitCheckPrompt: 'check deploy',
        },
      });
      mockThreadsDao.getAll.mockResolvedValue([
        throwingCredential,
        overdueTimer,
      ]);
      mockQueueService.hasJob.mockResolvedValue(false);
      mockOAuthPreflight.collectUnauthenticatedProviders.mockRejectedValue(
        new Error('AS unreachable'),
      );

      await (
        service as unknown as { recoverOverdueThreads: () => Promise<void> }
      ).recoverOverdueThreads();

      expect(mockQueueService.scheduleResume).toHaveBeenCalledTimes(1);
      expect(mockQueueService.scheduleResume).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-timer',
          externalThreadId: 'ext-timer',
          nodeId: 'node-7',
        }),
        0,
      );
    });

    it('logs error and does not throw on failure', async () => {
      mockThreadsDao.getAll.mockRejectedValue(new Error('DB down'));

      await (
        service as unknown as { recoverOverdueThreads: () => Promise<void> }
      ).recoverOverdueThreads();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.any(Error),
        'Failed to check for overdue waiting threads',
      );
    });
  });

  describe('onModuleDestroy', () => {
    it('clears the overdue check interval', () => {
      service.onModuleInit();
      service.onModuleDestroy();
      // No assertion needed — ensures no throw; interval is cleaned up
    });
  });

  describe('cancelWait', () => {
    it('cancels the job and stops the thread', async () => {
      const thread = makeThread();
      mockThreadsDao.getById.mockResolvedValue(thread);

      await service.cancelWait('thread-1');

      expect(mockQueueService.cancelResumeJob).toHaveBeenCalledWith('thread-1');
      expect(mockTransitionService.computeTransition).toHaveBeenCalledWith(
        thread,
        ThreadStatus.Stopped,
      );
      expect(mockThreadsDao.updateById).toHaveBeenCalledWith(
        thread.id,
        expect.objectContaining({
          status: ThreadStatus.Stopped,
          metadata: expect.objectContaining({}),
        }),
      );
      expect(mockNotificationsService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationEvent.ThreadUpdate,
          data: { status: ThreadStatus.Stopped },
        }),
      );
    });

    it('throws when thread not found', async () => {
      mockThreadsDao.getById.mockResolvedValue(null);

      await expect(service.cancelWait('thread-1')).rejects.toThrow(
        'Thread not found',
      );
    });

    it('throws when thread is not in waiting state', async () => {
      const thread = makeThread({ status: ThreadStatus.Done });
      mockThreadsDao.getById.mockResolvedValue(thread);

      await expect(service.cancelWait('thread-1')).rejects.toThrow(
        'Thread is not in waiting state',
      );
    });
  });
});
