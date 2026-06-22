import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import type { FastifyRequest } from 'fastify';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { TemplateRegistry } from '../../graph-templates/services/template-registry';
import { NotificationEvent } from '../../notifications/notifications.types';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { OAuthProvider } from '../../oauth-credentials/oauth-credentials.types';
import { OAuthCapabilityLinkService } from '../../oauth-credentials/services/oauth-capability-link.service';
import { OAuthCredentialsService } from '../../oauth-credentials/services/oauth-credentials.service';
import { ThreadsDao } from '../../threads/dao/threads.dao';
import { ThreadStatusTransitionService } from '../../threads/services/thread-status-transition.service';
import { ThreadStatus } from '../../threads/threads.types';
import { clearWaitMetadata } from '../../threads/threads.utils';
import { GraphDao } from '../dao/graph.dao';
import { collectOAuthNodes } from './oauth-node.utils';

/** `waitReason` marker distinguishing a credential pause from a timer wait. */
export const CREDENTIAL_WAIT_REASON = 'credential';

/**
 * Run-start OAuth pre-flight for the background / trigger / resume cohort.
 *
 * The M3.2 interactive-deploy gate (`GraphsService.assertOAuthCredentialsValid`)
 * THROWS at `graphs.service.run()` (compile/deploy) — but that path is BYPASSED
 * by background (`run_in_background`), external-trigger, and resume runs, which
 * is the exact cohort M3.3 targets. This service is the sibling pre-flight at
 * the agent-run / trigger boundary those runs DO flow through: when a needed
 * OAuth-MCP credential is missing/expired (and not refreshable), it PAUSES the
 * run (thread -> `Waiting`) and fans out `auth_required` with a single-use
 * capability link, instead of letting the run fail at first tool use. A
 * server-side `credential.acquired` resume (ThreadResumeService) then picks the
 * run back up once the user authenticates from any browser.
 */
@Injectable()
export class OAuthRunPreflightService {
  constructor(
    private readonly graphDao: GraphDao,
    private readonly templateRegistry: TemplateRegistry,
    private readonly oauthCredentialsService: OAuthCredentialsService,
    private readonly capabilityLink: OAuthCapabilityLinkService,
    private readonly notifications: NotificationsService,
    private readonly threadsDao: ThreadsDao,
    private readonly transitionService: ThreadStatusTransitionService,
    private readonly logger: DefaultLogger,
  ) {}

  /**
   * Returns true when the run was PAUSED (the caller must NOT invoke the agent);
   * false when every needed credential is valid (proceed). `agentNodeId` is the
   * node to resume once the credential is acquired — it is persisted as the
   * thread's `waitNodeId` so the resume executor can re-locate the agent.
   */
  async checkAndPauseIfNeeded(params: {
    graphId: string;
    externalThreadId: string;
    createdBy: string;
    agentNodeId: string;
    /**
     * The original run message text, stashed as the resume prompt so the run
     * processes it once the credential is acquired (the agent never ran, so it
     * isn't checkpointed). Omit on a resume re-pause — the existing stashed
     * prompt is preserved.
     */
    pendingMessageText?: string;
  }): Promise<boolean> {
    const { graphId, externalThreadId, createdBy, agentNodeId } = params;

    const graph = await this.graphDao.getById(graphId);
    if (!graph?.projectId || !graph.schema?.nodes) {
      return false;
    }
    const projectId = graph.projectId;

    const unauthenticated = await this.resolveUnauthenticatedForGraph(
      graph,
      createdBy,
    );
    if (unauthenticated.length === 0) {
      return false;
    }

    await this.pauseThread(
      graphId,
      projectId,
      createdBy,
      externalThreadId,
      agentNodeId,
      params.pendingMessageText,
    );

    // One `auth_required` per still-unauthenticated provider, each with its own
    // single-use capability link. With "resume the event's threadId only", a
    // multi-provider graph resolves iteratively: authenticating one provider
    // resumes the run, which re-pre-flights and re-pauses for the next.
    for (const { provider, nodeId } of unauthenticated) {
      const capabilityToken = await this.capabilityLink.mint({
        projectId,
        provider,
        threadId: externalThreadId,
        createdBy,
      });
      await this.notifications.emit({
        type: NotificationEvent.AuthRequired,
        data: { provider, capabilityToken },
        projectId,
        graphId,
        nodeId,
        threadId: externalThreadId,
      });
    }

    return true;
  }

  /**
   * Read-only: the OAuth-MCP providers on `graphId` whose credential is missing
   * or expired (and not refreshable) for `createdBy`. An EMPTY result means every
   * needed credential is valid right now. No side effects — the single source of
   * truth shared by two consumers that act on OPPOSITE outcomes:
   * `checkAndPauseIfNeeded` pauses + fans `auth_required` on a NON-empty result,
   * and the resume watchdog (`ThreadResumeService.recoverOverdueThreads`)
   * re-enqueues a stranded credential-wait on an EMPTY result. Keeping the
   * provider-resolution in one place stops the two paths from drifting.
   */
  async collectUnauthenticatedProviders(params: {
    graphId: string;
    createdBy: string;
  }): Promise<{ provider: OAuthProvider; nodeId: string }[]> {
    const graph = await this.graphDao.getById(params.graphId);
    return await this.resolveUnauthenticatedForGraph(graph, params.createdBy);
  }

  private async resolveUnauthenticatedForGraph(
    graph: Awaited<ReturnType<GraphDao['getById']>>,
    createdBy: string,
  ): Promise<{ provider: OAuthProvider; nodeId: string }[]> {
    if (!graph?.projectId || !graph.schema?.nodes) {
      return [];
    }
    const projectId = graph.projectId;

    const oauthNodes = collectOAuthNodes(
      graph.schema.nodes,
      (templateId) => this.templateRegistry.getTemplate(templateId)?.schema,
    );
    if (oauthNodes.length === 0) {
      return [];
    }

    // A background run carries no HTTP context; build a synthetic one with the
    // run's project + initiator so the credential service resolves the
    // per-project token exactly as an interactive request would (the established
    // system-caller pattern, mirrors GraphRestorationService).
    const ctx = new AppContextStorage({ sub: createdBy }, {
      headers: { 'x-project-id': projectId },
    } as unknown as FastifyRequest);

    const knownProviders = new Set<string>(Object.values(OAuthProvider));
    // First OAuth node per provider — points the UI at a concrete node needing
    // re-auth; providers are deduped across nodes.
    const nodeByProvider = new Map<OAuthProvider, string>();
    for (const ref of oauthNodes) {
      if (knownProviders.has(ref.provider)) {
        const provider = ref.provider as OAuthProvider;
        if (!nodeByProvider.has(provider)) {
          nodeByProvider.set(provider, ref.nodeId);
        }
      }
    }

    const unauthenticated: { provider: OAuthProvider; nodeId: string }[] = [];
    for (const [provider, nodeId] of nodeByProvider) {
      let authenticated = false;
      try {
        // refreshIfNeeded rotates a near/past-expiry token first (M3.1); a THROW
        // (network blip, revoked/rotated refresh, AS error) is treated as "needs
        // re-auth" so the run pauses cleanly rather than failing opaquely.
        const status = await this.oauthCredentialsService.refreshIfNeeded(
          ctx,
          provider,
        );
        authenticated = status.authenticated;
      } catch (err) {
        this.logger.warn(
          'OAuth run-start pre-flight refresh failed; treating provider as unauthenticated',
          {
            provider,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
      if (!authenticated) {
        unauthenticated.push({ provider, nodeId });
      }
    }

    return unauthenticated;
  }

  private async pauseThread(
    graphId: string,
    projectId: string,
    createdBy: string,
    externalThreadId: string,
    agentNodeId: string,
    pendingMessageText: string | undefined,
  ): Promise<void> {
    const thread = await this.threadsDao.getOne({ graphId, externalThreadId });

    if (!thread) {
      // First run of a brand-new thread: its row is created LATE (ensureThreadRow,
      // AFTER invokeAgent), so at pre-flight time there is nothing to transition.
      // Without this, pauseThread would no-op and the run would proceed without
      // the credential, then strand the thread `Running` — never `Waiting` — so
      // the credential-acquired resume + overdue watchdog (both scoped to
      // `Waiting`) could never recover it. Insert the `Waiting` row up-front
      // (atomic onConflict-ignore); the later insert-only `ensureThreadRow` finds
      // it and won't clobber it, and the resume re-runs it with the stashed prompt.
      const waitCheckPrompt =
        pendingMessageText && pendingMessageText.length > 0
          ? pendingMessageText
          : undefined;
      const inserted = await this.threadsDao.insertIfNotExists({
        graphId,
        projectId,
        createdBy,
        externalThreadId,
        status: ThreadStatus.Waiting,
        runningStartedAt: null,
        totalRunningMs: 0,
        metadata: {
          waitReason: CREDENTIAL_WAIT_REASON,
          waitNodeId: agentNodeId,
          waitCheckPrompt,
        },
      });
      if (inserted) {
        await this.emitWaitingUpdate(graphId, externalThreadId);
        return;
      }
      // Lost the insert race to a concurrent path that created the row first —
      // fall through to the transition path below by re-reading it.
    }

    const row =
      thread ?? (await this.threadsDao.getOne({ graphId, externalThreadId }));
    if (!row) {
      this.logger.warn('OAuth run-start pre-flight: no thread row to pause', {
        graphId,
        externalThreadId,
      });
      return;
    }

    const prevMetadata = (row.metadata ?? {}) as Record<string, unknown>;
    // Empty pending text (e.g. a multimodal trigger message whose content isn't a
    // string) must NOT overwrite a prior prompt — fall back to the stashed one so
    // a resume re-pause preserves the original message.
    const waitCheckPrompt =
      pendingMessageText && pendingMessageText.length > 0
        ? pendingMessageText
        : (prevMetadata.waitCheckPrompt as string | undefined);

    const patch = this.transitionService.computeTransition(
      row,
      ThreadStatus.Waiting,
    );
    // Start from a wait-metadata-CLEARED base so a thread that was waiting on a
    // TIMER (wait_for) and now re-pauses for a credential does not retain its
    // stale `scheduledResumeAt` — which the overdue watchdog would otherwise
    // treat as due and re-resume in a loop. A pure credential wait has no timer;
    // the resume is driven by the `credential.acquired` event, not a clock.
    await this.threadsDao.updateById(row.id, {
      ...patch,
      metadata: {
        ...(clearWaitMetadata(row.metadata) ?? {}),
        waitReason: CREDENTIAL_WAIT_REASON,
        waitNodeId: agentNodeId,
        waitCheckPrompt,
      },
    });

    await this.emitWaitingUpdate(graphId, externalThreadId);
  }

  private async emitWaitingUpdate(
    graphId: string,
    externalThreadId: string,
  ): Promise<void> {
    await this.notifications.emit({
      type: NotificationEvent.ThreadUpdate,
      graphId,
      threadId: externalThreadId,
      data: {
        status: ThreadStatus.Waiting,
        waitReason: CREDENTIAL_WAIT_REASON,
      },
    });
  }
}
