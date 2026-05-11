import { raw } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { ThreadEntity } from '../entity/thread.entity';
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
   * Attempts to insert a new thread row keyed on externalThreadId. Returns the
   * hydrated entity on success, or null when the row already exists (caller
   * handles the conflict path — typically by locking the existing row and
   * applying a transition patch via update). Runs as a single atomic SQL
   * statement; safe to call outside a transaction.
   */
  async insertIfNotExists(
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
    txEm?: EntityManager,
  ): Promise<ThreadEntity | null> {
    const em = txEm ?? this.em;
    const now = new Date();
    const insertedRaw = await em
      .createQueryBuilder(ThreadEntity)
      .insert({
        createdBy: data.createdBy,
        projectId: data.projectId,
        graphId: data.graphId,
        externalThreadId: data.externalThreadId,
        status: data.status,
        lastRunId: data.lastRunId ?? undefined,
        source: data.source ?? undefined,
        metadata: data.metadata ?? undefined,
        runningStartedAt: data.runningStartedAt ?? null,
        totalRunningMs: data.totalRunningMs ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflict('externalThreadId')
      .ignore()
      .returning('*')
      .execute<Record<string, unknown> | undefined>('get');

    return insertedRaw ? em.map(ThreadEntity, insertedRaw) : null;
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
