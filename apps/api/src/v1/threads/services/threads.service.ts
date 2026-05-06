import { Injectable, StreamableFile } from '@nestjs/common';
import {
  BadRequestException,
  DefaultLogger,
  NotFoundException,
} from '@packages/common';
import Decimal from 'decimal.js';
import { JsonStreamStringify } from 'json-stream-stringify';
import { PassThrough, Readable } from 'stream';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { CheckpointStateService } from '../../agents/services/checkpoint-state.service';
import { GraphDao } from '../../graphs/dao/graph.dao';
import { MessageRole } from '../../graphs/graphs.types';
import { GraphsService } from '../../graphs/services/graphs.service';
import type { RequestTokenUsage } from '../../litellm/litellm.types';
import { NotificationEvent } from '../../notifications/notifications.types';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { MessagesDao } from '../dao/messages.dao';
import { ThreadsDao } from '../dao/threads.dao';
import {
  GetMessagesQueryDto,
  GetThreadsQueryDto,
  ResumeThreadDto,
  SetThreadMetadataDto,
  ThreadDto,
  ThreadMessageDto,
  ThreadUsageStatisticsDto,
  UsageStatisticsAggregate,
  UsageStatisticsByTool,
} from '../dto/threads.dto';
import { MessageEntity } from '../entity/message.entity';
import { ThreadEntity } from '../entity/thread.entity';
import { ThreadStatus } from '../threads.types';
import { ThreadResumeService } from './thread-resume.service';

@Injectable()
export class ThreadsService {
  constructor(
    private readonly threadDao: ThreadsDao,
    private readonly messagesDao: MessagesDao,
    private readonly notificationsService: NotificationsService,
    private readonly graphsService: GraphsService,
    private readonly logger: DefaultLogger,
    private readonly checkpointStateService: CheckpointStateService,
    private readonly graphDao: GraphDao,
    private readonly threadResumeService: ThreadResumeService,
  ) {}

  async getThreads(
    ctx: AppContextStorage,
    query: GetThreadsQueryDto,
  ): Promise<ThreadDto[]> {
    const userId = ctx.checkSub();

    const { limit, offset, statuses, ...filter } = query;
    const threads = await this.threadDao.getAll(
      {
        createdBy: userId,
        ...filter,
        ...(statuses ? { status: { $in: statuses } } : {}),
      },
      { orderBy: { updatedAt: 'DESC' }, limit, offset },
    );

    return await this.prepareThreadsResponse(threads);
  }

  async getThreadById(
    ctx: AppContextStorage,
    threadId: string,
  ): Promise<ThreadDto> {
    const userId = ctx.checkSub();

    const thread = await this.threadDao.getOne({
      id: threadId,
      createdBy: userId,
    });

    if (!thread) {
      throw new NotFoundException('THREAD_NOT_FOUND');
    }

    return (await this.prepareThreadsResponse([thread]))[0]!;
  }

  async getThreadByExternalId(
    ctx: AppContextStorage,
    externalThreadId: string,
  ): Promise<ThreadDto> {
    const userId = ctx.checkSub();

    const thread = await this.threadDao.getOne({
      externalThreadId,
      createdBy: userId,
    });

    if (!thread) {
      throw new NotFoundException('THREAD_NOT_FOUND');
    }

    return (await this.prepareThreadsResponse([thread]))[0]!;
  }

  async getThreadMessages(
    ctx: AppContextStorage,
    threadId: string,
    query?: GetMessagesQueryDto,
  ): Promise<ThreadMessageDto[]> {
    const userId = ctx.checkSub();

    const thread = await this.threadDao.getOne({
      id: threadId,
      createdBy: userId,
    });

    if (!thread) {
      throw new NotFoundException('THREAD_NOT_FOUND');
    }

    const { limit, offset, ...filter } = query ?? {};
    const messages = await this.messagesDao.getAll(
      { threadId, ...filter },
      { orderBy: { createdAt: 'DESC' }, limit, offset },
    );

    return messages.map((msg) => this.prepareMessageResponse(msg));
  }

  async deleteThread(ctx: AppContextStorage, threadId: string): Promise<void> {
    const userId = ctx.checkSub();

    const thread = await this.threadDao.getOne({
      id: threadId,
      createdBy: userId,
    });

    if (!thread) {
      throw new NotFoundException('THREAD_NOT_FOUND');
    }

    await this.messagesDao.hardDelete({ threadId });

    // Emit thread delete notification before removing the thread record
    await this.notificationsService.emit({
      type: NotificationEvent.ThreadDelete,
      graphId: thread.graphId,
      threadId: thread.externalThreadId,
      internalThreadId: thread.id,
      data: thread,
    });

    await this.threadDao.deleteById(threadId);
  }

  async stopThread(
    ctx: AppContextStorage,
    threadId: string,
  ): Promise<ThreadDto> {
    const userId = ctx.checkSub();

    const thread = await this.threadDao.getOne({
      id: threadId,
      createdBy: userId,
    });

    if (!thread) {
      throw new NotFoundException('THREAD_NOT_FOUND');
    }

    if (thread.status !== ThreadStatus.Running) {
      return (await this.prepareThreadsResponse([thread]))[0]!;
    }

    // Try to stop the active agent run via the graph registry event chain.
    // If the agent is actively running, GraphStateManager will emit ThreadUpdate with Stopped
    // when the agent run terminates due to abort — no direct DB update needed.
    let stoppedViaEventChain = false;
    try {
      stoppedViaEventChain = await this.graphsService.stopThreadExecution(
        thread.graphId,
        thread.externalThreadId,
        'Graph execution was stopped',
      );
    } catch {
      // Fall through to direct DB update
    }

    if (!stoppedViaEventChain) {
      // Graph not in registry or no active agent run — update DB directly.
      // Clear any stale cost-limit metadata: a manual stop is intentional,
      // so the resume guard (which keys off `costLimitHit` / `stopReason`)
      // should not later block the user from re-running the thread.
      const meta = (thread.metadata ?? {}) as Record<string, unknown>;
      const nextMeta = { ...meta };
      delete nextMeta.stopReason;
      delete nextMeta.stopCostUsd;
      delete nextMeta.costLimitHit;

      await this.threadDao.updateById(thread.id, {
        status: ThreadStatus.Stopped,
        metadata: nextMeta,
      });
      const responseThread =
        (await this.threadDao.getById(thread.id)) ?? thread;

      await this.notificationsService.emit({
        type: NotificationEvent.ThreadUpdate,
        graphId: thread.graphId,
        threadId: thread.externalThreadId,
        data: {
          status: ThreadStatus.Stopped,
          stopReason: null,
          stopCostUsd: null,
          costLimitHit: null,
        },
      });

      return (await this.prepareThreadsResponse([responseThread]))[0]!;
    }

    return (await this.prepareThreadsResponse([thread]))[0]!;
  }

  async stopThreadByExternalId(
    ctx: AppContextStorage,
    externalThreadId: string,
  ): Promise<ThreadDto> {
    const userId = ctx.checkSub();

    const thread = await this.threadDao.getOne({
      externalThreadId,
      createdBy: userId,
    });

    if (!thread) {
      throw new NotFoundException('THREAD_NOT_FOUND');
    }

    return this.stopThread(ctx, thread.id);
  }

  async resumeThread(
    ctx: AppContextStorage,
    threadId: string,
    dto: ResumeThreadDto,
  ): Promise<ThreadDto> {
    const thread = await this.getOwnedWaitingThread(ctx, threadId);
    await this.threadResumeService.resumeEarly(threadId, dto.message);
    const updated = (await this.threadDao.getById(threadId)) ?? thread;
    return (await this.prepareThreadsResponse([updated]))[0]!;
  }

  async cancelWait(
    ctx: AppContextStorage,
    threadId: string,
  ): Promise<ThreadDto> {
    const thread = await this.getOwnedWaitingThread(ctx, threadId);
    await this.threadResumeService.cancelWait(threadId);
    const updated = (await this.threadDao.getById(threadId)) ?? thread;
    return (await this.prepareThreadsResponse([updated]))[0]!;
  }

  private async getOwnedWaitingThread(
    ctx: AppContextStorage,
    threadId: string,
  ): Promise<ThreadEntity> {
    const userId = ctx.checkSub();
    const thread = await this.threadDao.getOne({
      id: threadId,
      createdBy: userId,
    });

    if (!thread) {
      throw new NotFoundException('THREAD_NOT_FOUND');
    }

    if (thread.status !== ThreadStatus.Waiting) {
      throw new BadRequestException(
        'THREAD_NOT_WAITING',
        'Thread is not in waiting state',
      );
    }

    return thread;
  }

  async setMetadata(
    ctx: AppContextStorage,
    threadId: string,
    dto: SetThreadMetadataDto,
  ): Promise<ThreadDto> {
    const userId = ctx.checkSub();

    const thread = await this.threadDao.getOne({
      id: threadId,
      createdBy: userId,
    });

    if (!thread) {
      throw new NotFoundException('THREAD_NOT_FOUND');
    }

    await this.threadDao.updateById(threadId, {
      metadata: dto.metadata,
    });
    const updated = (await this.threadDao.getById(threadId)) ?? thread;

    return (await this.prepareThreadsResponse([updated]))[0]!;
  }

  async setMetadataByExternalId(
    ctx: AppContextStorage,
    externalThreadId: string,
    dto: SetThreadMetadataDto,
  ): Promise<ThreadDto> {
    const userId = ctx.checkSub();

    const thread = await this.threadDao.getOne({
      externalThreadId,
      createdBy: userId,
    });

    if (!thread) {
      throw new NotFoundException('THREAD_NOT_FOUND');
    }

    await this.threadDao.updateById(thread.id, {
      metadata: dto.metadata,
    });
    const updated = (await this.threadDao.getById(thread.id)) ?? thread;

    return (await this.prepareThreadsResponse([updated]))[0]!;
  }

  public async prepareThreadsResponse(
    entities: ThreadEntity[],
  ): Promise<ThreadDto[]> {
    if (entities.length === 0) {
      return [];
    }
    const graphIds = [...new Set(entities.map((e) => e.graphId))];
    const agentsByGraphId = await this.graphDao.getAgentsByGraphIds(graphIds);

    return entities.map((entity) => {
      const { deletedAt: _deletedAt, ...entityWithoutExcludedFields } = entity;
      const metadata = entity.metadata as
        | {
            stopReason?: string;
            effectiveCostLimitUsd?: number | null;
          }
        | undefined;
      const stopReason =
        entity.status === ThreadStatus.Running
          ? null
          : (metadata?.stopReason ?? null);
      const effectiveCostLimitUsd =
        typeof metadata?.effectiveCostLimitUsd === 'number'
          ? metadata.effectiveCostLimitUsd
          : null;
      return {
        ...entityWithoutExcludedFields,
        createdAt: new Date(entity.createdAt).toISOString(),
        updatedAt: new Date(entity.updatedAt).toISOString(),
        metadata: entity.metadata || {},
        agents: agentsByGraphId.get(entity.graphId) ?? null,
        stopReason,
        effectiveCostLimitUsd,
      };
    });
  }

  public async prepareThreadResponse(entity: ThreadEntity): Promise<ThreadDto> {
    return (await this.prepareThreadsResponse([entity]))[0]!;
  }

  public prepareMessageResponse(entity: MessageEntity): ThreadMessageDto {
    return {
      ...entity,
      createdAt: new Date(entity.createdAt).toISOString(),
      updatedAt: new Date(entity.updatedAt).toISOString(),
      requestTokenUsage: entity.requestTokenUsage ?? null,
      toolTokenUsage: entity.toolTokenUsage ?? null,
    };
  }

  async getThreadUsageStatistics(
    ctx: AppContextStorage,
    threadId: string,
  ): Promise<ThreadUsageStatisticsDto> {
    const userId = ctx.checkSub();

    const thread = await this.threadDao.getOne({
      id: threadId,
      createdBy: userId,
    });

    if (!thread) {
      throw new NotFoundException('THREAD_NOT_FOUND');
    }

    // totalUsage holds checkpoint state (authoritative for currentContext only).
    // All additive fields are overwritten by the message-scan block below.
    let totalUsage: RequestTokenUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      totalPrice: 0,
      currentContext: 0,
    };
    let byNodeUsage = new Map<string, RequestTokenUsage>();
    const byNodePriceDecimal = new Map<string, Decimal>();
    const nodeIdsSeenInMessages = new Set<string>();
    const byToolUsage = new Map<
      string,
      {
        totalTokens: number;
        totalPrice: number;
        callCount: number;
      }
    >();

    const toolsAggregate: UsageStatisticsAggregate = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    };

    const threadUsage = await this.checkpointStateService.getThreadTokenUsage(
      thread.externalThreadId,
    );

    if (threadUsage) {
      // Only currentContext is used from checkpoint state (see single-source policy below).
      totalUsage = {
        inputTokens: threadUsage.inputTokens ?? 0,
        cachedInputTokens: threadUsage.cachedInputTokens ?? 0,
        outputTokens: threadUsage.outputTokens ?? 0,
        reasoningTokens: threadUsage.reasoningTokens ?? 0,
        totalTokens: threadUsage.totalTokens ?? 0,
        totalPrice: threadUsage.totalPrice ?? 0,
        currentContext: threadUsage.currentContext ?? 0,
      };

      if (threadUsage.byNode) {
        byNodeUsage = new Map(
          Object.entries(threadUsage.byNode) as [string, RequestTokenUsage][],
        );
        for (const [nodeId, nodeUsage] of byNodeUsage) {
          byNodePriceDecimal.set(
            nodeId,
            new Decimal(nodeUsage.totalPrice ?? 0),
          );
        }
      }
    }

    // Format usage statistics from stored token usage data.
    // Use denormalized columns instead of full message JSONB for performance.
    const messages =
      (await this.messagesDao.getAll(
        { threadId: thread.id },
        {
          orderBy: { createdAt: 'ASC' },
          fields: [
            'id',
            'nodeId',
            'role',
            'name',
            'requestTokenUsage',
            'toolCallNames',
            'answeredToolCallNames',
            'additionalKwargs',
            'toolCallIds',
            'toolTokenUsage',
          ] as never,
        },
      )) ?? [];

    // Use Decimal.js for price aggregation to avoid floating-point errors
    let toolsPriceDecimal = new Decimal(0);
    let totalRequests = 0;
    let userMessageCount = 0;
    const modelsUsedSet = new Set<string>();

    // Guard against NaN values that bypass the `?? 0` null-coalescing operator.
    // NaN is neither null nor undefined, so `NaN ?? 0` returns NaN. Math.max(x, NaN)
    // propagates NaN, poisoning the accumulator. This helper normalises all non-finite
    // numbers (NaN, Infinity, -Infinity) and null/undefined to 0.
    const toFinite = (n: number | null | undefined): number =>
      typeof n === 'number' && Number.isFinite(n) ? n : 0;

    // Accumulate message-based total to capture in-progress subagent costs.
    // Checkpoint-based totalUsage only includes subagent costs after the subagent completes
    // (ToolExecutorNode folds subagent usage into parent state on return).
    // Message-based total includes real-time costs from streamed subagent internal messages.
    const messageTotalUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      currentContext: 0,
      totalPriceDecimal: new Decimal(0),
    };

    /** Add a single LLM request's usage to the message-based total accumulator. */
    const accumulateUsage = (usage: RequestTokenUsage): void => {
      messageTotalUsage.inputTokens += usage.inputTokens;
      messageTotalUsage.cachedInputTokens += usage.cachedInputTokens || 0;
      messageTotalUsage.outputTokens += usage.outputTokens;
      messageTotalUsage.reasoningTokens += usage.reasoningTokens || 0;
      messageTotalUsage.totalTokens += usage.totalTokens;
      messageTotalUsage.totalPriceDecimal =
        messageTotalUsage.totalPriceDecimal.plus(usage.totalPrice ?? 0);
      messageTotalUsage.currentContext = Math.max(
        messageTotalUsage.currentContext,
        toFinite(usage.currentContext),
      );
    };

    /**
     * Add a single LLM request's usage to the per-node accumulator.
     * Mirrors `accumulateUsage` but keyed by nodeId. Integer fields go
     * into `byNodeUsage` directly; price uses `Decimal` via
     * `byNodePriceDecimal` for precision, resolved to a number at return
     * time to avoid floating-point drift across many subagent rows.
     */
    const accumulateByNode = (
      nodeId: string | null | undefined,
      usage: RequestTokenUsage,
    ): void => {
      if (!nodeId) {
        return;
      }
      // On first message-scan hit for this nodeId, discard the checkpoint
      // seed (message-scan is authoritative per single-source policy).
      if (!nodeIdsSeenInMessages.has(nodeId)) {
        nodeIdsSeenInMessages.add(nodeId);
        byNodeUsage.delete(nodeId);
        byNodePriceDecimal.delete(nodeId);
      }
      const prev = byNodeUsage.get(nodeId);
      byNodeUsage.set(nodeId, {
        inputTokens: (prev?.inputTokens ?? 0) + usage.inputTokens,
        cachedInputTokens:
          (prev?.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
        outputTokens: (prev?.outputTokens ?? 0) + usage.outputTokens,
        reasoningTokens:
          (prev?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
        totalTokens: (prev?.totalTokens ?? 0) + usage.totalTokens,
        totalPrice: prev?.totalPrice ?? 0,
        // Mirrors accumulateUsage (lines ~509-512): toFinite + Math.max protect against
        // NaN poisoning of per-node currentContext. The ?? 0 reconciliation is replaced
        // with explicit toFinite normalization so legacy NaN values don't propagate.
        currentContext: Math.max(
          toFinite(usage.currentContext),
          toFinite(prev?.currentContext),
        ),
      });
      const prevPriceDecimal = byNodePriceDecimal.get(nodeId) ?? new Decimal(0);
      byNodePriceDecimal.set(
        nodeId,
        prevPriceDecimal.plus(usage.totalPrice ?? 0),
      );
    };

    // Map: toolCallId -> parentToolName (for linking subagent internal messages)
    const toolCallIdToToolName = new Map<string, string>();

    // Map: parentToolName -> childToolName -> { callCount, totalTokens, priceDecimal }
    const subCallsByParent = new Map<
      string,
      Map<
        string,
        {
          callCount: number;
          totalTokens: number;
          priceDecimal: Decimal;
        }
      >
    >();

    // Map: toolName -> { toolTokens, priceDecimal } (from tool result messages)
    const toolOwnUsage = new Map<
      string,
      { toolTokens: number; priceDecimal: Decimal }
    >();

    for (const messageEntity of messages) {
      const requestUsage = messageEntity.requestTokenUsage;
      const isAiMessage = messageEntity.role === MessageRole.AI;
      const isToolMessage = messageEntity.role === MessageRole.Tool;
      const isHumanMessage = messageEntity.role === MessageRole.Human;

      const additionalKwargs = messageEntity.additionalKwargs;
      const isSubagentInternal = additionalKwargs?.__hideForLlm === true;

      // Collect model name for the "models used" summary
      if (isAiMessage) {
        const model = additionalKwargs?.__model as string | undefined;
        if (model) {
          modelsUsedSet.add(model);
        }
      }

      // Count user messages
      if (isHumanMessage) {
        userMessageCount++;
      }

      // Build toolCallId -> toolName mapping from non-subagent AI messages
      // Uses denormalized toolCallIds + toolCallNames columns (parallel arrays)
      if (isAiMessage && !isSubagentInternal) {
        const ids = messageEntity.toolCallIds;
        const names = messageEntity.toolCallNames;
        if (Array.isArray(ids) && Array.isArray(names)) {
          for (let i = 0; i < ids.length && i < names.length; i++) {
            if (ids[i] && names[i]) {
              toolCallIdToToolName.set(ids[i]!, names[i]!);
            }
          }
        }
      }

      // Handle subagent internal AI messages: route to subCalls instead of top-level
      if (isAiMessage && isSubagentInternal) {
        const parentToolCallId = additionalKwargs?.__toolCallId as
          | string
          | undefined;
        const parentToolName = parentToolCallId
          ? toolCallIdToToolName.get(parentToolCallId)
          : undefined;

        // Read token usage from the dedicated column (preferred) or fall back
        // to additionalKwargs.__requestUsage for messages persisted before the
        // column was populated for subagent internals.
        const embeddedUsage =
          messageEntity.requestTokenUsage ??
          (additionalKwargs?.__requestUsage as RequestTokenUsage | undefined);

        if (parentToolName) {
          const embeddedTokens = embeddedUsage?.totalTokens || 0;
          const embeddedPrice = embeddedUsage?.totalPrice ?? 0;

          // Determine child tool name(s) or use (llm_response) for no-tool responses
          const childToolNames =
            Array.isArray(messageEntity.toolCallNames) &&
            messageEntity.toolCallNames.length > 0
              ? messageEntity.toolCallNames
              : ['(llm_response)'];

          if (!subCallsByParent.has(parentToolName)) {
            subCallsByParent.set(parentToolName, new Map());
          }
          const parentSubCalls = subCallsByParent.get(parentToolName)!;

          for (const childToolName of childToolNames) {
            const current = parentSubCalls.get(childToolName);
            parentSubCalls.set(childToolName, {
              callCount: (current?.callCount || 0) + 1,
              totalTokens: (current?.totalTokens || 0) + embeddedTokens,
              priceDecimal: (current?.priceDecimal || new Decimal(0)).plus(
                embeddedPrice,
              ),
            });
          }
        } else if (parentToolCallId) {
          this.logger.warn(
            'Subagent message has __toolCallId but parent tool not found in toolCallIdToToolName map',
            { messageId: messageEntity.id, parentToolCallId },
          );
        }

        // Count subagent internal LLM calls in totalRequests and toolsAggregate
        if (embeddedUsage) {
          totalRequests++;

          // Attribute subagent LLM cost to toolsAggregate
          toolsPriceDecimal = toolsPriceDecimal.plus(
            embeddedUsage.totalPrice ?? 0,
          );
          toolsAggregate.inputTokens += embeddedUsage.inputTokens;
          toolsAggregate.outputTokens += embeddedUsage.outputTokens;
          toolsAggregate.totalTokens += embeddedUsage.totalTokens;
          toolsAggregate.requestCount++;

          // Accumulate into message-based total (captures in-progress subagent costs)
          accumulateUsage(embeddedUsage);
          accumulateByNode(messageEntity.nodeId, embeddedUsage);
        }

        // Subagent internal messages don't contribute to top-level byTool
        continue;
      }

      // Count tool calls from non-subagent AI messages.
      if (
        isAiMessage &&
        Array.isArray(messageEntity.toolCallNames) &&
        messageEntity.toolCallNames.length > 0
      ) {
        for (const toolName of messageEntity.toolCallNames) {
          const current = byToolUsage.get(toolName);
          byToolUsage.set(toolName, {
            totalTokens: current?.totalTokens || 0,
            totalPrice: current?.totalPrice ?? 0,
            callCount: (current?.callCount || 0) + 1,
          });
        }
      }

      // Attribute token usage to tools.
      // Only count AI messages — tool messages may carry duplicated parent usage
      // in legacy data (before the notification handler fix).
      //
      // NOTE: When an AI message calls multiple tools (e.g. ['search', 'shell']),
      // the full LLM request cost is attributed to EACH tool in byTool.
      // This means byTool totals may exceed toolsAggregate — this is intentional:
      // byTool.totalTokens = "tokens from LLM requests involving this tool",
      // not "tokens exclusively consumed by this tool".
      if (isAiMessage && requestUsage) {
        totalRequests++;

        // Accumulate into message-based total
        accumulateUsage(requestUsage);
        accumulateByNode(messageEntity.nodeId, requestUsage);

        let attributeToTools: string[] | undefined;

        if (
          Array.isArray(messageEntity.toolCallNames) &&
          messageEntity.toolCallNames.length > 0
        ) {
          attributeToTools = messageEntity.toolCallNames;
        } else if (
          Array.isArray(messageEntity.answeredToolCallNames) &&
          messageEntity.answeredToolCallNames.length > 0
        ) {
          attributeToTools = messageEntity.answeredToolCallNames;
        }

        if (attributeToTools && attributeToTools.length > 0) {
          toolsPriceDecimal = toolsPriceDecimal.plus(
            requestUsage.totalPrice ?? 0,
          );

          toolsAggregate.inputTokens += requestUsage.inputTokens;
          toolsAggregate.outputTokens += requestUsage.outputTokens;
          toolsAggregate.totalTokens += requestUsage.totalTokens;
          toolsAggregate.requestCount++;

          for (const toolName of attributeToTools) {
            const current = byToolUsage.get(toolName);
            const addedPrice = requestUsage.totalPrice ?? 0;
            byToolUsage.set(toolName, {
              totalTokens:
                (current?.totalTokens || 0) + requestUsage.totalTokens,
              totalPrice: (current?.totalPrice ?? 0) + addedPrice,
              callCount: current?.callCount || 0,
            });
          }
        }
      }

      // Track tool's own execution cost (e.g. subagent aggregate tokens) for per-tool display.
      // Do NOT add to toolsAggregate — toolTokenUsage is an aggregate of subagent internal
      // LLM calls which are already counted individually from embeddedUsage above.
      // Adding it here would double-count those tokens.
      if (isToolMessage && messageEntity.name && messageEntity.toolTokenUsage) {
        const toolUsage = messageEntity.toolTokenUsage;
        const existing = toolOwnUsage.get(messageEntity.name);
        toolOwnUsage.set(messageEntity.name, {
          toolTokens: (existing?.toolTokens || 0) + toolUsage.totalTokens,
          priceDecimal: (existing?.priceDecimal || new Decimal(0)).plus(
            toolUsage.totalPrice ?? 0,
          ),
        });
      }
    }

    toolsAggregate.totalPrice = toolsPriceDecimal.toNumber();

    // Finalize per-node prices from Decimal map to preserve precision
    // across many rows (same pattern as toolsPriceDecimal above).
    for (const [nodeId, priceDecimal] of byNodePriceDecimal) {
      const entry = byNodeUsage.get(nodeId);
      if (entry) {
        entry.totalPrice = priceDecimal.toNumber();
      }
    }

    /**
     * Single-source policy for thread total usage.
     *
     * Message-scan is authoritative for ALL additive fields (inputTokens,
     * outputTokens, cachedInputTokens, reasoningTokens, totalTokens,
     * totalPrice) regardless of thread.status — both for the top-level
     * `total` AND for `byNode` (per-node projection of the same additive
     * fields, keyed by messages.node_id). Each messages.request_token_usage
     * row is one recorded LLM call with Decimal-precision price; summing
     * them is the most-truthful possible aggregation.
     *
     * Checkpoint state.totalPrice is a derived running total that sometimes
     * lags or is never written — e.g. LangGraph checkpoints where
     * invoke-llm-node never incremented the accumulator for a model path,
     * or where subagent costs were not folded into the parent checkpoint.
     * Checkpoint byNode has the same lag (and is often empty for
     * subagent/multi-persona graphs whose tuples lack nodeId), so it is
     * seeded as a fallback only — message-scan entries overwrite it for
     * any nodeId that appears in messages.
     *
     * `currentContext`: checkpoint authoritative WHEN populated; messages
     * authoritative WHEN checkpoint returns null (multi-agent topologies that
     * don't write the empty-NS root checkpoint); reconciled via
     * `Math.max(totalUsage.currentContext ?? 0, messageTotalUsage.currentContext)`
     * — preserves the higher value, never regresses.
     */
    totalUsage = {
      inputTokens: messageTotalUsage.inputTokens,
      cachedInputTokens: messageTotalUsage.cachedInputTokens,
      outputTokens: messageTotalUsage.outputTokens,
      reasoningTokens: messageTotalUsage.reasoningTokens,
      totalTokens: messageTotalUsage.totalTokens,
      totalPrice: messageTotalUsage.totalPriceDecimal.toNumber(),
      currentContext: Math.max(
        toFinite(totalUsage.currentContext),
        messageTotalUsage.currentContext,
      ),
    };

    // Build final byTool array with subCalls and toolTokens/toolPrice
    const byTool: UsageStatisticsByTool[] = Array.from(
      byToolUsage.entries(),
    ).map(([toolName, usage]) => {
      const entry: UsageStatisticsByTool = {
        toolName,
        ...usage,
      };

      // Attach tool's own execution cost (e.g. subagent aggregate tokens)
      const ownUsage = toolOwnUsage.get(toolName);
      if (ownUsage) {
        entry.toolTokens = ownUsage.toolTokens;
        entry.toolPrice = ownUsage.priceDecimal.toNumber();
      }

      // Attach subCalls from subagent internal messages
      const subCalls = subCallsByParent.get(toolName);
      if (subCalls && subCalls.size > 0) {
        entry.subCalls = Array.from(subCalls.entries()).map(
          ([childToolName, { priceDecimal, ...childUsage }]) => ({
            toolName: childToolName,
            ...childUsage,
            totalPrice: priceDecimal.toNumber(),
          }),
        );
      }

      return entry;
    });

    return {
      total: totalUsage,
      requests: totalRequests,
      byNode: Object.fromEntries(byNodeUsage),
      byTool,
      toolsAggregate,
      userMessageCount,
      modelsUsed: Array.from(modelsUsedSet).sort(),
    };
  }

  async getThreadExportFile(
    ctx: AppContextStorage,
    threadId: string,
  ): Promise<StreamableFile> {
    const userId = ctx.checkSub();
    const thread = await this.threadDao.getOne({
      id: threadId,
      createdBy: userId,
    });
    if (!thread) {
      throw new NotFoundException('THREAD_NOT_FOUND');
    }

    const stream = new PassThrough();
    this.streamThreadExport(ctx, thread, stream).catch((err: unknown) => {
      stream.destroy(err instanceof Error ? err : new Error(String(err)));
    });

    const date = new Date().toISOString().slice(0, 10);
    return new StreamableFile(stream, {
      type: 'application/json',
      disposition: `attachment; filename="thread-export-${date}.json"`,
    });
  }

  private async streamThreadExport(
    ctx: AppContextStorage,
    thread: ThreadEntity,
    outputStream: PassThrough,
  ): Promise<void> {
    const [usageStatistics, graphDataMap, graphRows] = await Promise.all([
      this.getThreadUsageStatistics(ctx, thread.id),
      this.graphDao.getSchemaAndMetadata([thread.graphId]),
      this.graphDao.getAll({ id: { $in: [thread.graphId] } }, { limit: 1 }),
    ]);

    const graphData = graphDataMap.get(thread.graphId) ?? null;
    const graphRow = graphRows[0] ?? null;
    const graphSnapshot =
      graphData && graphRow
        ? {
            id: thread.graphId,
            name: graphRow.name,
            description: graphRow.description ?? null,
            nodes: graphData.schema.nodes.map((node) => ({
              ...node,
              config: node.config
                ? Object.fromEntries(
                    Object.entries(
                      node.config as Record<string, unknown>,
                    ).filter(
                      ([k]) =>
                        !/token|key|secret|password|credential|pat/i.test(k),
                    ),
                  )
                : node.config,
            })),
            edges: graphData.schema.edges ?? [],
          }
        : null;

    const [threadDto] = await this.prepareThreadsResponse([thread]);

    const messagesDao = this.messagesDao;
    const prepareMessageResponse = this.prepareMessageResponse.bind(this);

    async function* streamMessages() {
      const PAGE_SIZE = 500;
      let offset = 0;
      while (true) {
        const page = await messagesDao.getAll(
          { threadId: thread.id },
          { limit: PAGE_SIZE, offset, orderBy: { createdAt: 'ASC' } },
        );
        for (const msg of page) {
          yield prepareMessageResponse(msg);
        }
        if (page.length < PAGE_SIZE) {
          break;
        }
        offset += PAGE_SIZE;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    const exportPayload = {
      version: '1',
      exportedAt: new Date().toISOString(),
      isRunning: thread.status === ThreadStatus.Running,
      thread: threadDto,
      graph: graphSnapshot,
      usageStatistics,
      // Readable.from converts the async generator to an object-mode Readable stream,
      // which json-stream-stringify serializes as a JSON array lazily.
      messages: Readable.from(streamMessages(), { objectMode: true }),
    };

    await new Promise<void>((resolve, reject) => {
      const jsonStream = new JsonStreamStringify(exportPayload);
      jsonStream.pipe(outputStream, { end: true });
      jsonStream.on('error', reject);
      outputStream.on('finish', resolve);
      outputStream.on('error', reject);
    });
  }
}
