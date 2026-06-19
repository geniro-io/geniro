import { HumanMessage } from '@langchain/core/messages';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DefaultLogger } from '@packages/common';

import { isRunnableAgent } from '../../agents/agents.utils';
import { GraphRegistry } from '../../graphs/services/graph-registry';
import {
  CREDENTIAL_WAIT_REASON,
  OAuthRunPreflightService,
} from '../../graphs/services/oauth-run-preflight.service';
import { NotificationEvent } from '../../notifications/notifications.types';
import { NotificationsService } from '../../notifications/services/notifications.service';
import type { CredentialAcquiredEvent } from '../../oauth-credentials/oauth-credentials.events';
import { CREDENTIAL_ACQUIRED_EVENT } from '../../oauth-credentials/oauth-credentials.events';
import { ThreadsDao } from '../dao/threads.dao';
import type { ThreadWaitingEvent } from '../threads.types';
import { THREAD_WAITING_EVENT, ThreadStatus } from '../threads.types';
import { clearWaitMetadata } from '../threads.utils';
import {
  ThreadResumeJobData,
  ThreadResumeQueueService,
} from './thread-resume-queue.service';
import { ThreadStatusTransitionService } from './thread-status-transition.service';

/** How often to check for overdue waiting threads (ms). */
const OVERDUE_CHECK_INTERVAL_MS = 60_000;

/** Grace period before treating a waiting thread as overdue (ms). */
const OVERDUE_GRACE_MS = 30_000;

@Injectable()
export class ThreadResumeService implements OnModuleInit, OnModuleDestroy {
  private overdueCheckHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly queueService: ThreadResumeQueueService,
    private readonly threadsDao: ThreadsDao,
    private readonly graphRegistry: GraphRegistry,
    private readonly notificationsService: NotificationsService,
    private readonly logger: DefaultLogger,
    private readonly transitionService: ThreadStatusTransitionService,
    private readonly oauthPreflight: OAuthRunPreflightService,
  ) {}

  onModuleInit(): void {
    this.queueService.setCallbacks({
      onProcess: (data) => this.handleResume(data),
      onFailed: (data, error) => this.handleResumeFailed(data, error),
    });

    this.overdueCheckHandle = setInterval(
      () => void this.recoverOverdueThreads(),
      OVERDUE_CHECK_INTERVAL_MS,
    );
  }

  onModuleDestroy(): void {
    if (this.overdueCheckHandle) {
      clearInterval(this.overdueCheckHandle);
      this.overdueCheckHandle = null;
    }
  }

  @OnEvent(THREAD_WAITING_EVENT)
  async onThreadWaiting(event: ThreadWaitingEvent): Promise<void> {
    const thread = await this.threadsDao.getOne({
      graphId: event.graphId,
      externalThreadId: event.threadId,
    });

    if (!thread) {
      this.logger.warn('Thread not found for waiting event', {
        graphId: event.graphId,
        externalThreadId: event.threadId,
      });
      return;
    }

    const scheduledAt = new Date(
      Date.now() + event.durationSeconds * 1000,
    ).toISOString();

    await this.threadsDao.updateById(thread.id, {
      metadata: {
        ...thread.metadata,
        scheduledResumeAt: scheduledAt,
        waitReason: event.reason,
        waitNodeId: event.nodeId,
        waitCheckPrompt: event.checkPrompt,
      },
    });

    await this.notificationsService.emit({
      type: NotificationEvent.ThreadUpdate,
      graphId: event.graphId,
      threadId: thread.externalThreadId,
      data: {
        status: ThreadStatus.Waiting,
        scheduledResumeAt: scheduledAt,
        waitReason: event.reason,
      },
    });

    await this.queueService.scheduleResume(
      {
        threadId: thread.id,
        graphId: event.graphId,
        nodeId: event.nodeId,
        externalThreadId: thread.externalThreadId,
        checkPrompt: event.checkPrompt,
        reason: event.reason,
        scheduledAt,
        createdBy: thread.createdBy,
      },
      event.durationSeconds * 1000,
    );

    this.logger.debug('Scheduled thread resume', {
      threadId: thread.id,
      graphId: event.graphId,
      durationSeconds: event.durationSeconds,
    });
  }

  /**
   * Resume a run that paused awaiting an OAuth credential, the moment the user
   * authenticates from any browser. Bridged from `credential.acquired` (the
   * EventEmitter2 emit in `OAuthCredentialsService.exchange()` — the
   * NotificationsService bus it ALSO emits on is disjoint from `@OnEvent`).
   *
   * Multi-pod-safe: it ENQUEUES a zero-delay BullMQ resume keyed by the thread,
   * NOT an in-process `agent.run` — on EKS the pod that handles this event is
   * usually NOT the thread's owner pod, and the queue routes the resume to
   * whichever pod holds the graph. The actual run happens in `handleResume`,
   * which re-pre-flights the credential (so a race where the token is already
   * gone again re-pauses cleanly).
   */
  @OnEvent(CREDENTIAL_ACQUIRED_EVENT)
  async onCredentialAcquired(event: CredentialAcquiredEvent): Promise<void> {
    // No resume target — a plain in-editor auth, nothing to resume.
    if (!event.threadId) {
      return;
    }

    // The producer (`OAuthCredentialsService.exchange`) bridges this with a
    // fire-and-forget `eventEmitter.emit`, so a throw here would surface only as
    // an unhandled rejection and silently lose the resume. Catch + log instead;
    // the exchange itself has already succeeded.
    try {
      const thread = await this.threadsDao.getOne({
        externalThreadId: event.threadId,
      });
      if (!thread || thread.status !== ThreadStatus.Waiting) {
        return;
      }

      const metadata = thread.metadata as Record<string, unknown> | undefined;
      // Only resume threads paused FOR a credential — a timer (wait_for) thread
      // in the same project must not be yanked early by an unrelated auth.
      if (metadata?.waitReason !== CREDENTIAL_WAIT_REASON) {
        return;
      }

      await this.queueService.scheduleResume(
        {
          threadId: thread.id,
          graphId: thread.graphId,
          nodeId: (metadata?.waitNodeId as string) ?? '',
          externalThreadId: thread.externalThreadId,
          checkPrompt: (metadata?.waitCheckPrompt as string) ?? '',
          reason: CREDENTIAL_WAIT_REASON,
          scheduledAt: new Date().toISOString(),
          createdBy: thread.createdBy,
        },
        0, // Zero delay — resume now; the BullMQ hop is for multi-pod routing.
      );

      this.logger.debug('Enqueued credential-acquired resume', {
        threadId: thread.id,
        graphId: thread.graphId,
        provider: event.provider,
      });
    } catch (err) {
      this.logger.error(
        err instanceof Error ? err : new Error(String(err)),
        'Failed to enqueue credential-acquired resume',
        { externalThreadId: event.threadId, provider: event.provider },
      );
    }
  }

  async handleResume(data: ThreadResumeJobData): Promise<void> {
    const thread = await this.threadsDao.getById(data.threadId);
    if (!thread) {
      this.logger.warn('Thread not found for resume', {
        threadId: data.threadId,
      });
      return;
    }

    if (thread.status !== ThreadStatus.Waiting) {
      this.logger.debug('Thread no longer in waiting state, skipping resume', {
        threadId: data.threadId,
        currentStatus: thread.status,
      });
      return;
    }

    // Re-run the OAuth pre-flight before resuming: a credential.acquired resume
    // should only proceed if the credential is actually valid now, and a timer
    // (wait_for) resume of an OAuth graph must not run with an expired token.
    // If a needed credential is still missing, the pre-flight re-pauses the
    // thread (Waiting) and re-fans `auth_required` — so this resume is a no-op
    // and the run waits for the next credential.acquired.
    const paused = await this.oauthPreflight.checkAndPauseIfNeeded({
      graphId: data.graphId,
      externalThreadId: data.externalThreadId,
      createdBy: data.createdBy,
      agentNodeId: data.nodeId,
    });
    if (paused) {
      return;
    }

    const compiledGraph = this.graphRegistry.get(data.graphId);
    if (!compiledGraph) {
      // Throw so BullMQ retries — the graph may not be in the in-memory
      // registry yet (e.g. after a hot-reload). If all retries exhaust,
      // handleResumeFailed will stop the thread and notify the frontend.
      throw new Error(
        `Graph "${data.graphId}" not in registry, cannot resume thread "${data.threadId}"`,
      );
    }

    const agentNode = compiledGraph.nodes.get(data.nodeId);
    if (!agentNode) {
      throw new Error(
        `Agent node "${data.nodeId}" not found in graph "${data.graphId}", cannot resume thread "${data.threadId}"`,
      );
    }

    if (!isRunnableAgent(agentNode.instance)) {
      throw new Error(
        `Node "${data.nodeId}" is not a runnable agent, cannot resume thread "${data.threadId}"`,
      );
    }
    const agent = agentNode.instance;

    const patch = this.transitionService.computeTransition(
      thread,
      ThreadStatus.Running,
    );
    await this.threadsDao.updateById(thread.id, {
      ...patch,
      metadata: clearWaitMetadata(thread.metadata),
    });

    await this.notificationsService.emit({
      type: NotificationEvent.ThreadUpdate,
      graphId: data.graphId,
      threadId: data.externalThreadId,
      data: {
        status: ThreadStatus.Running,
        scheduledResumeAt: undefined,
        waitReason: undefined,
      },
    });

    const resumeMessage = new HumanMessage(data.checkPrompt);

    await agent.run(data.externalThreadId, [resumeMessage], undefined, {
      configurable: {
        thread_id: data.externalThreadId,
        graph_id: data.graphId,
        node_id: data.nodeId,
        thread_created_by: data.createdBy,
      },
    });
  }

  /**
   * Periodic safety net: finds threads stuck in Waiting with an overdue
   * scheduledResumeAt and no BullMQ job, then re-schedules the resume.
   * Catches jobs lost during hot-reloads or other transient failures.
   */
  private async recoverOverdueThreads(): Promise<void> {
    try {
      const waitingThreads = await this.threadsDao.getAll({
        status: ThreadStatus.Waiting,
      });

      const now = Date.now();

      for (const thread of waitingThreads) {
        const metadata = thread.metadata as Record<string, unknown> | undefined;
        const scheduledAt = metadata?.scheduledResumeAt as string | undefined;
        if (!scheduledAt) {
          continue;
        }

        const scheduledMs = new Date(scheduledAt).getTime();
        if (now - scheduledMs < OVERDUE_GRACE_MS) {
          continue;
        }

        const hasJob = await this.queueService.hasJob(thread.id);
        if (hasJob) {
          continue;
        }

        this.logger.warn(
          'Recovering overdue waiting thread — re-scheduling resume',
          {
            threadId: thread.id,
            graphId: thread.graphId,
            scheduledResumeAt: scheduledAt,
            overdueMs: now - scheduledMs,
          },
        );

        await this.queueService.scheduleResume(
          {
            threadId: thread.id,
            graphId: thread.graphId,
            nodeId: (metadata?.waitNodeId as string) ?? '',
            externalThreadId: thread.externalThreadId,
            checkPrompt: (metadata?.waitCheckPrompt as string) ?? '',
            reason: (metadata?.waitReason as string) ?? '',
            scheduledAt,
            createdBy: thread.createdBy,
          },
          0, // Fire immediately — already overdue
        );
      }
    } catch (err) {
      this.logger.error(
        err instanceof Error ? err : new Error(String(err)),
        'Failed to check for overdue waiting threads',
      );
    }
  }

  async handleResumeFailed(
    data: ThreadResumeJobData,
    error: Error,
  ): Promise<void> {
    this.logger.error(error, 'Thread resume failed after all retries', {
      threadId: data.threadId,
      graphId: data.graphId,
    });

    const thread = await this.threadsDao.getById(data.threadId);

    const metadata = {
      ...clearWaitMetadata(thread?.metadata),
      resumeError: error.message,
    };

    if (thread) {
      const patch = this.transitionService.computeTransition(
        thread,
        ThreadStatus.Stopped,
      );
      await this.threadsDao.updateById(thread.id, { ...patch, metadata });
    } else {
      await this.threadsDao.updateById(data.threadId, { metadata });
    }

    await this.notificationsService.emit({
      type: NotificationEvent.ThreadUpdate,
      graphId: data.graphId,
      threadId: data.externalThreadId,
      data: {
        status: ThreadStatus.Stopped,
      },
    });
  }

  /**
   * Cancel the pending resume job and immediately trigger a resume.
   */
  async resumeEarly(threadId: string, message?: string): Promise<void> {
    const thread = await this.threadsDao.getById(threadId);
    if (!thread) {
      throw new Error('Thread not found');
    }

    if (thread.status !== ThreadStatus.Waiting) {
      throw new Error('Thread is not in waiting state');
    }

    const metadata = thread.metadata as Record<string, unknown> | undefined;

    await this.queueService.cancelResumeJob(threadId);

    await this.handleResume({
      threadId: thread.id,
      graphId: thread.graphId,
      nodeId: (metadata?.waitNodeId as string) ?? '',
      externalThreadId: thread.externalThreadId,
      checkPrompt: message ?? (metadata?.waitCheckPrompt as string) ?? '',
      reason: (metadata?.waitReason as string) ?? '',
      scheduledAt: (metadata?.scheduledResumeAt as string) ?? '',
      createdBy: thread.createdBy,
    });
  }

  /**
   * Cancel the pending resume job and stop the thread.
   */
  async cancelWait(threadId: string): Promise<void> {
    const thread = await this.threadsDao.getById(threadId);
    if (!thread) {
      throw new Error('Thread not found');
    }

    if (thread.status !== ThreadStatus.Waiting) {
      throw new Error('Thread is not in waiting state');
    }

    await this.queueService.cancelResumeJob(threadId);

    const patch = this.transitionService.computeTransition(
      thread,
      ThreadStatus.Stopped,
    );
    await this.threadsDao.updateById(thread.id, {
      ...patch,
      metadata: clearWaitMetadata(thread.metadata),
    });

    await this.notificationsService.emit({
      type: NotificationEvent.ThreadUpdate,
      graphId: thread.graphId,
      threadId: thread.externalThreadId,
      data: {
        status: ThreadStatus.Stopped,
      },
    });
  }
}
