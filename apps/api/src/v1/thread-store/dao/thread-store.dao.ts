import { raw } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { ThreadStoreEntryEntity } from '../entity/thread-store-entry.entity';
import type { NamespaceSummaryRow } from '../thread-store.types';
import { ThreadStoreEntryMode } from '../thread-store.types';
import { toPostgresArrayLiteral } from '../thread-store.utils';

@Injectable()
export class ThreadStoreDao extends BaseDao<ThreadStoreEntryEntity> {
  constructor(em: EntityManager) {
    super(em, ThreadStoreEntryEntity);
  }

  async countForNamespace(
    threadId: string,
    namespace: string,
    txEm?: EntityManager,
  ): Promise<number> {
    return await this.count({ threadId, namespace }, txEm);
  }

  /**
   * Upsert a KV entry. On `(threadId, namespace, key)` conflict (respecting the
   * partial unique index `WHERE deleted_at IS NULL`), replaces `value`,
   * `authorAgentId`, `tags`, `updatedAt`, and clears `deletedAt` (soft-delete
   * resurrection). Never changes `mode`.
   *
   * Uses raw SQL because MikroORM 7.0.6 `upsert()` with `onConflictFields`
   * generates `ON CONFLICT (col, ...) DO UPDATE ...` without a WHERE predicate on
   * the conflict target, which PostgreSQL refuses when only a partial unique index
   * exists for that column list. `onConflictWhere` in MikroORM's UpsertOptions
   * appends a WHERE to the outer INSERT (not the conflict target), so it does not
   * resolve the mismatch. Raw SQL with the explicit partial-index predicate is the
   * only MikroORM-equivalent solution here.
   */
  async upsertKvEntry(
    data: {
      threadId: string;
      namespace: string;
      key: string;
      value: unknown;
      mode: ThreadStoreEntryEntity['mode'];
      authorAgentId?: string | null;
      tags?: string[] | null;
      createdBy: string;
      projectId: string;
    },
    txEm?: EntityManager,
  ): Promise<ThreadStoreEntryEntity> {
    const em = txEm ?? this.em;
    await em.getConnection().execute(
      `INSERT INTO "thread_store_entries"
         ("id", "thread_id", "namespace", "key", "value", "mode",
          "author_agent_id", "tags", "created_by", "project_id",
          "created_at", "updated_at", "deleted_at")
       VALUES
         (gen_random_uuid(), ?, ?, ?, ?::jsonb, ?, ?, ?::text[], ?, ?, now(), now(), NULL)
       ON CONFLICT ("thread_id", "namespace", "key") WHERE "deleted_at" IS NULL
       DO UPDATE SET
         "value"           = EXCLUDED.value,
         "author_agent_id" = EXCLUDED.author_agent_id,
         "tags"            = EXCLUDED.tags,
         "updated_at"      = now(),
         "deleted_at"      = NULL`,
      [
        data.threadId,
        data.namespace,
        data.key,
        JSON.stringify(data.value ?? null),
        data.mode,
        data.authorAgentId ?? null,
        toPostgresArrayLiteral(data.tags),
        data.createdBy,
        data.projectId,
      ],
    );

    // refresh: true forces a re-read from DB instead of serving the identity-map
    // cache, so the caller always gets the authoritative post-upsert state.
    // filters: { softDelete: false } is required because the upsert may have
    // cleared deleted_at on a previously soft-deleted row; without this the
    // default softDelete filter could momentarily exclude the row.
    const entry = await em.findOneOrFail(
      ThreadStoreEntryEntity,
      { threadId: data.threadId, namespace: data.namespace, key: data.key },
      { filters: { softDelete: false }, refresh: true },
    );
    return entry;
  }

  async getByKey(
    threadId: string,
    namespace: string,
    key: string,
    txEm?: EntityManager,
  ): Promise<ThreadStoreEntryEntity | null> {
    return await this.getOne({ threadId, namespace, key }, undefined, txEm);
  }

  async getNamespaceSummaries(
    threadId: string,
  ): Promise<NamespaceSummaryRow[]> {
    const rows = await this.em
      .createQueryBuilder(ThreadStoreEntryEntity, 'e')
      .select([
        'e.namespace',
        'e.mode',
        raw('count(*) as cnt'),
        raw('max(e.updated_at) as last_updated_at'),
      ])
      .where({ threadId, deletedAt: null })
      .groupBy(['e.namespace', 'e.mode'])
      .orderBy({ namespace: 'ASC' })
      .execute<
        {
          namespace: string;
          mode: string;
          cnt: string;
          last_updated_at: Date | string;
        }[]
      >();

    return rows.map((row) => ({
      namespace: row.namespace,
      mode: row.mode as ThreadStoreEntryMode,
      entryCount: parseInt(row.cnt, 10),
      lastUpdatedAt:
        row.last_updated_at instanceof Date
          ? row.last_updated_at
          : new Date(row.last_updated_at),
    }));
  }

  async listInNamespace(
    threadId: string,
    namespace: string,
    options?: { limit?: number; offset?: number; order?: 'ASC' | 'DESC' },
  ): Promise<ThreadStoreEntryEntity[]> {
    const { order = 'DESC', ...restOptions } = options ?? {};
    return await this.getAll(
      { threadId, namespace },
      { orderBy: { createdAt: order }, ...restOptions },
    );
  }
}
