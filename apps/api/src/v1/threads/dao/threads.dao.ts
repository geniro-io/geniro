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
   * Inserts a thread or updates it on externalThreadId conflict, returning the
   * upserted row. Single SQL statement: callers never need a pre-fetch or a
   * post-fetch.
   *
   * Conflict-merge contract:
   *   - status, last_run_id, updated_at: overwritten from the incoming row
   *     (last_run_id via COALESCE — a null EXCLUDED value preserves existing).
   *   - source, metadata: insert-only, preserved on conflict. Metadata
   *     specifically must NOT be clobbered (effectiveCostLimitUsd lives there).
   *   - running_started_at: CASE on the existing row's status. Already-Running
   *     threads keep their clock (idempotent); non-Running → Running takes the
   *     incoming `now` (resume). Encodes the "into-Running" branch of
   *     ThreadStatusTransitionService.computeTransition directly in SQL.
   *   - total_running_ms: always preserved on conflict. The accumulator is
   *     owned exclusively by out-of-Running transitions via
   *     updateStatusWithAccumulator; the upsert path never writes it on
   *     update.
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
    const sql = `INSERT INTO threads (
      created_by, project_id, graph_id, external_thread_id,
      status, last_run_id, source, metadata,
      running_started_at, total_running_ms
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
    ON CONFLICT (external_thread_id) DO UPDATE SET
      status = EXCLUDED.status,
      last_run_id = COALESCE(EXCLUDED.last_run_id, threads.last_run_id),
      updated_at = now(),
      running_started_at = CASE WHEN threads.status = ?
        THEN threads.running_started_at
        ELSE EXCLUDED.running_started_at
      END,
      total_running_ms = threads.total_running_ms
    RETURNING *`;

    const params = [
      data.createdBy,
      data.projectId,
      data.graphId,
      data.externalThreadId,
      data.status,
      data.lastRunId ?? null,
      data.source ?? null,
      data.metadata != null ? JSON.stringify(data.metadata) : null,
      data.runningStartedAt ?? null,
      data.totalRunningMs ?? 0,
      ThreadStatus.Running,
    ];

    const rows = await this.em
      .getConnection()
      .execute<Record<string, unknown>[]>(sql, params);
    const row = rows[0];
    if (!row) {
      throw new Error(
        `upsertByExternalThreadId returned no row for externalThreadId=${data.externalThreadId}`,
      );
    }
    return this.em.map(ThreadEntity, row);
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
