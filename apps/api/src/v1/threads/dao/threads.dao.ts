import { LockMode, raw } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { InternalException } from '@packages/common';
import { BaseDao } from '@packages/mikroorm';

import { ThreadEntity } from '../entity/thread.entity';
import { ThreadStatusTransitionService } from '../services/thread-status-transition.service';
import { ThreadStatus } from '../threads.types';

@Injectable()
export class ThreadsDao extends BaseDao<ThreadEntity> {
  constructor(
    em: EntityManager,
    private readonly transitionService: ThreadStatusTransitionService,
  ) {
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
   * Inserts a new thread row, or updates an existing one on externalThreadId
   * conflict, returning the final hydrated entity. Only accepts status=Running
   * callers — non-Running upserts are rejected with a runtime error to prevent
   * invariant violations (e.g. status=Done row retaining a non-null
   * runningStartedAt without accumulating the delta).
   *
   * Two-step flow (single-source-of-truth).
   *   1. INSERT ... ON CONFLICT DO NOTHING with RETURNING *.
   *      If a row was inserted (no conflict), map and return it immediately.
   *      The INSERT runs outside any explicit transaction (single-statement atomic).
   *   2. Conflict path: opens a transaction on a private em.fork() (mirroring
   *      the graphs.service.ts pattern, which avoids savepoint regressions when
   *      callers are themselves transactional). The SELECT uses PESSIMISTIC_WRITE
   *      (FOR UPDATE) to acquire a DB-level row lock that serializes concurrent
   *      upserts on the same externalThreadId independently of caller transaction
   *      state. Delegates running-timer field computation to
   *      ThreadStatusTransitionService.computeTransition (single source of truth),
   *      then issues UPDATE...RETURNING * (one round trip) and maps the result.
   *
   * Conflict-update contract:
   *   - status, running_started_at, total_running_ms: computed by
   *     computeTransition (idempotent if existing is Running; resume if not).
   *   - last_run_id: overwritten when caller provides it; preserved otherwise.
   *   - source, metadata: insert-only — never overwritten on conflict. Metadata
   *     specifically must NOT be clobbered (effectiveCostLimitUsd lives there).
   */
  async upsertByExternalThreadId(
    data: Pick<
      ThreadEntity,
      'graphId' | 'createdBy' | 'projectId' | 'externalThreadId'
    > & {
      status: typeof ThreadStatus.Running;
    } & Partial<
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
    // Runtime guard: despite the type narrowing above, callers can bypass it
    // with a cast. Reject any non-Running value so we never produce a row that
    // violates the invariant (out-of-Running status with non-null
    // runningStartedAt and no accumulated delta).
    const statusAtRuntime: string = data.status;
    if (statusAtRuntime !== ThreadStatus.Running) {
      throw new InternalException(
        'UPSERT_REQUIRES_RUNNING_STATUS',
        `upsertByExternalThreadId requires status=Running; got "${statusAtRuntime}"`,
      );
    }

    const now = new Date();

    // Step 1: try insert; on conflict, DO NOTHING (returns no row).
    const insertedRaw = await this.em
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

    if (insertedRaw) {
      return this.em.map(ThreadEntity, insertedRaw);
    }

    // Step 2: conflict path — lock the row, compute transition, write back in
    // one UPDATE...RETURNING round trip. Wrapped in a fork+transactional below
    // so the FOR UPDATE lock is held until the UPDATE commits, independent of
    // caller transaction state.
    const runConflictPath = async (
      em: EntityManager,
    ): Promise<ThreadEntity> => {
      const existing = await em.findOne(
        ThreadEntity,
        { externalThreadId: data.externalThreadId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!existing) {
        throw new InternalException(
          'UPSERT_ROW_VANISHED',
          `upsertByExternalThreadId: row vanished between INSERT and SELECT for externalThreadId=${data.externalThreadId}`,
        );
      }

      // Single source of truth: delegate the transition math to computeTransition.
      // resumeClock is the new running_started_at value used WHEN the existing row
      // is non-Running (Done/Stopped/Waiting → Running resume). For idempotent
      // Running → Running, computeTransition preserves existing.runningStartedAt and
      // ignores this argument; the result is the same as the old SQL CASE form
      // but the mechanism is computeTransition's branch, not the raw SQL CASE.
      const resumeClock = data.runningStartedAt ?? now;
      const patch = this.transitionService.computeTransition(
        existing,
        ThreadStatus.Running,
        resumeClock,
      );

      // last_run_id uses COALESCE-equivalent (preserve when caller omits).
      // source + metadata are insert-only — never overwrite on conflict.
      // UPDATE...RETURNING * avoids a separate re-fetch round trip and sidesteps
      // MikroORM's runtime bigint type validator (which fires on em.assign).
      const updatedRaw = await em
        .createQueryBuilder(ThreadEntity)
        .update({
          ...patch,
          ...(data.lastRunId != null ? { lastRunId: data.lastRunId } : {}),
          updatedAt: now,
        })
        .where({ id: existing.id })
        .returning('*')
        .execute<Record<string, unknown> | undefined>('get');

      if (!updatedRaw) {
        throw new InternalException(
          'UPSERT_UPDATE_NO_ROWS',
          `upsertByExternalThreadId: UPDATE returned no rows for externalThreadId=${data.externalThreadId}`,
        );
      }
      return em.map(ThreadEntity, updatedRaw);
    };

    // Fork off the global em into a private EM (no transaction context
    // inherited), then open a fresh transaction on the fork. Mirrors the
    // pattern used in graphs.service.ts:executeTrigger and avoids the savepoint
    // / "Transaction is already committed" issues that arise when nesting
    // transactional() on the global em or when keepTransactionContext leaks
    // stale state across calls. See https://github.com/mikro-orm/mikro-orm/discussions/5309.
    // SELECT FOR UPDATE inside this transaction acquires a DB-level row lock
    // that serializes concurrent upserts at the database, independent of
    // whether the caller is itself transactional.
    return await this.em.fork().transactional(runConflictPath);
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
