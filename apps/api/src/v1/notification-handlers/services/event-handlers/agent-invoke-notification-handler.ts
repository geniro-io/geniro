import { HumanMessage } from '@langchain/core/messages';
import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';

import { extractTextFromResponseContent } from '../../../agents/agents.utils';
import { GraphDao } from '../../../graphs/dao/graph.dao';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import { LlmModelsService } from '../../../litellm/services/llm-models.service';
import {
  IAgentInvokeNotification,
  NotificationEvent,
} from '../../../notifications/notifications.types';
import { NotificationsService } from '../../../notifications/services/notifications.service';
import { ProjectsDao } from '../../../projects/dao/projects.dao';
import { ThreadsDao } from '../../../threads/dao/threads.dao';
import { ThreadNameGeneratorService } from '../../../threads/services/thread-name-generator.service';
import { ThreadsService } from '../../../threads/services/threads.service';
import { ThreadStatus } from '../../../threads/threads.types';
import { BaseNotificationHandler } from './base-notification-handler';

/**
 * Handles AgentInvoke notifications by creating or updating internal threads.
 *
 * NOTE: This handler is a side-effect handler -- it does NOT produce enriched
 * notifications for the WebSocket gateway. Instead, it performs DB operations
 * (thread creation/update) and re-emits new ThreadCreate / ThreadUpdate
 * notifications back into the NotificationsService queue.
 */
@Injectable()
export class AgentInvokeNotificationHandler extends BaseNotificationHandler<never> {
  readonly pattern = NotificationEvent.AgentInvoke;

  constructor(
    private readonly threadDao: ThreadsDao,
    private readonly graphDao: GraphDao,
    private readonly notificationsService: NotificationsService,
    private readonly threadsService: ThreadsService,
    private readonly threadNameGenerator: ThreadNameGeneratorService,
    private readonly llmModelsService: LlmModelsService,
    private readonly logger: DefaultLogger,
    private readonly projectsDao: ProjectsDao,
    private readonly graphRegistry: GraphRegistry,
  ) {
    super();
  }

  async handle(event: IAgentInvokeNotification): Promise<never[]> {
    const {
      threadId,
      graphId,
      parentThreadId,
      source,
      runId,
      threadMetadata,
      effectiveCostLimitUsd,
    } = event;

    const graph = await this.graphDao.getOne({ id: graphId });
    if (!graph) {
      return [];
    }

    const externalThreadKey = parentThreadId ?? threadId;
    const isRootThreadExecution = threadId === externalThreadKey;

    // Seed effectiveCostLimitUsd into the INSERT-path metadata so the client's
    // header can render the limit on a brand-new thread even when this handler
    // wins the race against executeTrigger's eager creation. On CONFLICT the
    // upsert's merge list excludes metadata, so this does not overwrite an
    // already-populated metadata from the eager path or a prior resume.
    const insertMetadata =
      threadMetadata || effectiveCostLimitUsd !== undefined
        ? {
            ...(threadMetadata ?? {}),
            ...(effectiveCostLimitUsd !== undefined
              ? { effectiveCostLimitUsd }
              : {}),
          }
        : undefined;

    // Upsert: INSERT or ON CONFLICT(externalThreadId) UPDATE status/source/lastRunId.
    // This eliminates the race condition between executeTrigger (eager thread creation)
    // and this handler — both can safely write without 23505 unique violations.
    await this.threadDao.upsertByExternalThreadId({
      graphId,
      createdBy: graph.createdBy,
      projectId: graph.projectId,
      externalThreadId: externalThreadKey,
      status: ThreadStatus.Running,
      ...(source ? { source } : {}),
      ...(runId ? { lastRunId: runId } : {}),
      ...(insertMetadata ? { metadata: insertMetadata } : {}),
    });

    // Fetch the full entity after upsert to get all fields (including name, metadata
    // that are not overwritten on conflict).
    const thread = await this.threadDao.getOne({
      externalThreadId: externalThreadKey,
      graphId,
    });

    if (!thread) {
      this.logger.error(
        new Error('Thread missing after upsert'),
        `Thread not found after upsert for externalThreadId=${externalThreadKey}, graphId=${graphId}`,
      );
      return [];
    }

    // A thread without a name was just created (either by this upsert or by the
    // eager path in executeTrigger). Emit ThreadCreate so the frontend picks it up.
    // A thread with a name already existed — emit ThreadUpdate with current state.
    if (!thread.name) {
      await this.notificationsService.emit({
        type: NotificationEvent.ThreadCreate,
        graphId,
        projectId: graph.projectId,
        threadId: externalThreadKey,
        internalThreadId: thread.id,
        data: thread,
      });
    } else {
      const threadDto = await this.threadsService.prepareThreadResponse(thread);
      await this.notificationsService.emit({
        type: NotificationEvent.ThreadUpdate,
        graphId,
        projectId: graph.projectId,
        threadId: externalThreadKey,
        parentThreadId,
        data: threadDto,
      });

      // If the thread previously stopped due to a cost limit, clear the stop
      // fields so the frontend stops showing the cost-limit banner as soon as
      // the user's new run begins. The ThreadUpdateNotificationHandler handles
      // the actual metadata writes when it receives these null values.
      // Only fire for cost-limit stops — user_stop re-runs should leave
      // stopReason intact so the record persists.
      const meta = thread.metadata as
        | Record<string, unknown>
        | null
        | undefined;
      const hadCostLimitState = Boolean(
        meta &&
        (meta.costLimitHit === true ||
          (typeof meta.stopReason === 'string' &&
            meta.stopReason === 'cost_limit')),
      );
      if (hadCostLimitState) {
        await this.notificationsService.emit({
          type: NotificationEvent.ThreadUpdate,
          graphId,
          projectId: graph.projectId,
          threadId: externalThreadKey,
          parentThreadId,
          data: { stopReason: null, stopCostUsd: null, costLimitHit: null },
        });
      }
    }

    // Generate thread name for root thread executions that don't have one yet.
    if (isRootThreadExecution && !thread.name) {
      void this.generateAndEmitThreadName(
        event,
        externalThreadKey,
        graph.createdBy,
        graph,
      ).catch((err: unknown) => {
        const normalizedMessage =
          err instanceof Error ? err.message : String(err);
        this.logger.error(
          err instanceof Error ? err : new Error(normalizedMessage),
          `thread-name-generation.error: ${normalizedMessage}`,
        );
      });
    }

    return [];
  }

  private async generateAndEmitThreadName(
    event: IAgentInvokeNotification,
    externalThreadKey: string,
    userId: string,
    graph: { projectId: string },
  ): Promise<void> {
    const firstHuman = event.data.messages.find(
      (m) => m instanceof HumanMessage,
    );

    if (!firstHuman) {
      return;
    }

    const rawContent = firstHuman.content;
    const userInput = extractTextFromResponseContent(rawContent) ?? '';

    if (!userInput) {
      return;
    }

    // Try compiled graph first (zero DB calls)
    const compiledGraph = this.graphRegistry.get(event.graphId);
    let modelCtx = compiledGraph?.metadata?.llmRequestContext;

    // Fallback: graph not in registry (stopped between event and handler)
    if (!modelCtx) {
      const project = await this.projectsDao.getOne({
        id: graph.projectId,
        createdBy: userId,
      });
      modelCtx = await this.llmModelsService.buildLLMRequestContext(
        userId,
        project?.settings,
      );
    }

    const model = modelCtx?.models?.llmMiniModel;
    const name = await this.threadNameGenerator.generateFromFirstUserMessage(
      userInput,
      model,
    );

    if (!name) {
      return;
    }

    await this.notificationsService.emit({
      type: NotificationEvent.ThreadUpdate,
      graphId: event.graphId,
      nodeId: event.nodeId,
      threadId: externalThreadKey,
      parentThreadId: externalThreadKey,
      data: { name },
    });
  }
}
