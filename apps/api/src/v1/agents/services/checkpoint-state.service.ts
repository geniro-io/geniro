import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import Decimal from 'decimal.js';

import type { RequestTokenUsage } from '../../litellm/litellm.types';
import { MessagesDao } from '../../threads/dao/messages.dao';
import { ThreadsDao } from '../../threads/dao/threads.dao';
import type { ThreadTokenUsage } from '../../threads/dto/threads.dto';
import type { BaseAgentState } from '../agents.types';
import { PgCheckpointSaver } from './pg-checkpoint-saver';

/**
 * Service to query and extract token usage data from LangGraph checkpoints.
 * Provides access to token usage without requiring Redis or ThreadEntity denormalization.
 */
@Injectable()
export class CheckpointStateService {
  constructor(
    private readonly checkpointSaver: PgCheckpointSaver,
    private readonly logger: DefaultLogger,
    private readonly messagesDao: MessagesDao,
    private readonly threadsDao: ThreadsDao,
  ) {}

  /**
   * Get token usage for a thread by reading from its latest checkpoint,
   * then merging per-subagent surrogate buckets from the messages table.
   *
   * **Dual-source policy**
   * - `byNode` (parent buckets): checkpoint tuples are authoritative. The parent's
   *   rolled-up total already includes subagent costs folded in by `ToolExecutorNode`.
   * - `byNode` (surrogate buckets): `MessagesDao.aggregateUsageBySubagentNodeId` is
   *   authoritative for the per-subagent decomposition. Surrogate keys have the form
   *   `'${parent}::sub::${toolCallId}'`.
   *
   * **Reconciliation rule**
   * For every surrogate key `K`, `byNode[K]` is set to the surrogate's full usage AND
   * the parent's bucket has the surrogate's totals subtracted (clamped at 0), so that:
   * - `byNode[parent]` reflects the parent agent's own costs only.
   * - `byNode[surrogate]` reflects the subagent's own costs.
   *
   * **Orphan-surrogate trade-off**
   * When a surrogate exists in messages but its parent node has no checkpoint tuple,
   * the surrogate is inserted into `byNode` unchanged and no synthesized parent entry
   * is created (the `if (parent)` guard is skipped). Callers that sum `byNode`
   * values should not assume the sum equals the top-level `totalPrice` in this case;
   * `ThreadsService.getThreadUsageStatistics` (message-scan path) is the authoritative
   * source for thread-level totals.
   *
   * **Reference**: `.claude/rules/cost-accounting.md` "Cost-by-node invariant" section
   * is the contract this method implements.
   *
   * @param threadId - External thread ID
   * @param checkpointNs - Checkpoint namespace (default: empty string for root threads)
   * @returns Token usage with per-node breakdown, or null if no checkpoint found
   */
  async getThreadTokenUsage(
    threadId: string,
    checkpointNs = '',
  ): Promise<ThreadTokenUsage | null> {
    try {
      // Get checkpoint tuples for this thread and any nested agents (multi-agent graphs).
      // includeWrites=false since we only need state data for token usage
      const tuples = await this.checkpointSaver.getTuples(
        threadId,
        checkpointNs,
        false,
      );

      if (tuples.length === 0) {
        return null;
      }

      // Aggregate token usage across all checkpoints.
      // Use Decimal.js for totalPrice to avoid floating-point rounding errors.
      const byNode = new Map<string, RequestTokenUsage>();
      let inputTokens = 0;
      let cachedInputTokens = 0;
      let outputTokens = 0;
      let reasoningTokens = 0;
      let totalTokens = 0;
      let totalPriceDecimal = new Decimal(0);
      // currentContext is a point-in-time measurement, not additive — take max
      let maxCurrentContext = 0;

      for (const tuple of tuples) {
        const state = tuple.checkpoint
          .channel_values as unknown as BaseAgentState;

        if (!state) {
          continue;
        }

        const usage: RequestTokenUsage = {
          inputTokens: state.inputTokens || 0,
          cachedInputTokens: state.cachedInputTokens || 0,
          outputTokens: state.outputTokens || 0,
          reasoningTokens: state.reasoningTokens || 0,
          totalTokens: state.totalTokens || 0,
          totalPrice: state.totalPrice || 0,
          currentContext: state.currentContext || 0,
        };

        inputTokens += usage.inputTokens;
        cachedInputTokens += usage.cachedInputTokens || 0;
        outputTokens += usage.outputTokens;
        reasoningTokens += usage.reasoningTokens || 0;
        totalTokens += usage.totalTokens;
        totalPriceDecimal = totalPriceDecimal.plus(usage.totalPrice ?? 0);
        maxCurrentContext = Math.max(
          maxCurrentContext,
          usage.currentContext || 0,
        );

        if (tuple.nodeId) {
          byNode.set(tuple.nodeId, usage);
        }
      }

      // Resolve the external thread ID to the internal UUID so the DAO query
      // targets messages.thread_id (UUID column) correctly. If the thread row
      // does not exist (e.g. legacy or test fixtures without a DB row), skip
      // the DAO call — no surrogate rows can exist for a non-existent thread.
      const threadRow = await this.threadsDao.getOne({
        externalThreadId: threadId,
      });
      const subagentBuckets = threadRow
        ? await this.messagesDao.aggregateUsageBySubagentNodeId(threadRow.id)
        : new Map<string, RequestTokenUsage>();
      for (const [surrogate, usage] of subagentBuckets) {
        byNode.set(surrogate, usage);
        const parentNodeId: string = surrogate.split('::sub::')[0] ?? surrogate;
        const parent = byNode.get(parentNodeId);
        if (parent) {
          const next: RequestTokenUsage = {
            inputTokens: Math.max(
              0,
              (parent.inputTokens ?? 0) - (usage.inputTokens ?? 0),
            ),
            cachedInputTokens: Math.max(
              0,
              (parent.cachedInputTokens ?? 0) - (usage.cachedInputTokens ?? 0),
            ),
            outputTokens: Math.max(
              0,
              (parent.outputTokens ?? 0) - (usage.outputTokens ?? 0),
            ),
            reasoningTokens: Math.max(
              0,
              (parent.reasoningTokens ?? 0) - (usage.reasoningTokens ?? 0),
            ),
            totalTokens: Math.max(
              0,
              (parent.totalTokens ?? 0) - (usage.totalTokens ?? 0),
            ),
            totalPrice: Math.max(
              0,
              (parent.totalPrice ?? 0) - (usage.totalPrice ?? 0),
            ),
            currentContext: parent.currentContext,
          };
          if (
            next.totalPrice === 0 &&
            (parent.totalPrice ?? 0) > 0 &&
            (usage.totalPrice ?? 0) >= (parent.totalPrice ?? 0)
          ) {
            this.logger.warn(
              'Subagent total met or exceeded parent bucket; clamped to 0',
              { threadId, parentNodeId, surrogate },
            );
          }
          byNode.set(parentNodeId, next);
        }
      }

      if (totalTokens === 0 && byNode.size === 0) {
        return null;
      }

      return {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningTokens,
        totalTokens,
        totalPrice: totalPriceDecimal.toNumber(),
        currentContext: maxCurrentContext,
        byNode: byNode.size > 0 ? Object.fromEntries(byNode) : undefined,
      };
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error : new Error(String(error)),
        'Failed to get thread token usage from checkpoint',
        { threadId, checkpointNs },
      );
      return null;
    }
  }
}
