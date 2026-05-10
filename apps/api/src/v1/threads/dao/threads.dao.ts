import { raw } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { ThreadEntity } from '../entity/thread.entity';
import type { ThreadStatusTransitionService } from '../services/thread-status-transition.service';
import { ThreadStatus } from '../threads.types';

@Injectable()
export class ThreadsDao extends BaseDao<ThreadEntity> {
  constructor(em: EntityManager) {
    super(em, ThreadEntity);
  }

  async countByGraphIds(
    graphIds: string[],
  ): Promise<Map<string, { total: number; running: number }>> {
    const result = new Map<string, { total: number; running: number }>();
    if (graphIds.length === 0) {
      return result;
    }

    const qb = this.em.createQueryBuilder(ThreadEntity, 't');
    const rows = await qb
      .select(['t.graphId', 't.status', raw('count(*) as cnt')])
      .where({ graphId: { $in: graphIds } })
      .groupBy(['t.graphId', 't.status'])
      .execute<{ graphId: string; status: string; cnt: string }[]>();

    for (const row of rows) {
      const count = parseInt(row.cnt, 10);
      const entry = result.get(row.graphId) ?? { total: 0, running: 0 };
      entry.total += count;
      if (row.status === ThreadStatus.Running) {
        entry.running = count;
      }
      result.set(row.graphId, entry);
    }

    return result;
  }

  /**
   * Inserts a thread or updates it on externalThreadId conflict.
   * On conflict, merges: status, lastRunId, updatedAt, runningStartedAt, totalRunningMs.
   * Source is only set on first insert — never overwritten on conflict.
   * Metadata is intentionally excluded from onConflictMergeFields — it is preserved
   * across conflict to avoid clobbering values set by the eager-create path (e.g.
   * effectiveCostLimitUsd). Metadata writes flow through the dedicated updateById path.
   * Returns the upserted row.
   */
  async upsertByExternalThreadId(
    data: Pick<
      ThreadEntity,
      'graphId' | 'createdBy' | 'projectId' | 'externalThreadId' | 'status'
    > &
      Partial<
        Pick<
          ThreadEntity,
          | 'source'
          | 'lastRunId'
          | 'metadata'
          | 'runningStartedAt'
          | 'totalRunningMs'
        >
      >,
  ): Promise<ThreadEntity> {
    return await this.getRepo().upsert(data, {
      onConflictFields: ['externalThreadId'],
      onConflictAction: 'merge',
      onConflictMergeFields: [
        'status',
        'lastRunId',
        'updatedAt',
        'runningStartedAt',
        'totalRunningMs',
      ],
    });
  }

  /**
   * Updates the thread's status and running-time accumulator fields atomically,
   * optionally merging in additional fields in the same DB call.
   * The caller must supply an already-loaded ThreadEntity — this method does NOT re-fetch inside a transaction.
   * Pass additionalFields to collapse a follow-up updateById into a single write
   * (e.g. to persist runtimeDurationMs alongside a status transition).
   */
  async updateStatusWithAccumulator(
    thread: ThreadEntity,
    nextStatus: ThreadStatus,
    transitionService: ThreadStatusTransitionService,
    txEm?: EntityManager,
    additionalFields?: Partial<ThreadEntity>,
  ): Promise<number> {
    const patch = transitionService.computeTransition(thread, nextStatus);
    return await this.updateById(
      thread.id,
      { ...patch, ...additionalFields },
      txEm,
    );
  }

  async touchById(id: string): Promise<void> {
    const entity = await this.getRepo().findOne({ id });
    if (!entity) {
      return;
    }
    entity.updatedAt = new Date();
    await this.em.flush();
  }
}
