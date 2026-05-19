import { raw } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { ThreadStoreEntryEntity } from '../entity/thread-store-entry.entity';
import type { NamespaceSummaryRow } from '../thread-store.types';
import { ThreadStoreEntryMode } from '../thread-store.types';

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
   * Upsert a KV entry. On `(threadId, namespace, key)` conflict (full unique
   * index), replaces `value`, `authorAgentId`, `tags`, `updatedAt`, and clears
   * `deletedAt` (soft-delete resurrection). Never changes `mode`.
   *
   * Uses MikroORM's native `em.upsert()` against the full unique index on
   * `(thread_id, namespace, key)`. The full index (no WHERE predicate) lets
   * MikroORM emit a plain `ON CONFLICT (col, ...) DO UPDATE` that PostgreSQL
   * accepts without a partial-index WHERE clause.
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
      deletedAt?: Date | null;
      updatedAt?: Date;
      createdBy: string;
      projectId: string;
    },
    txEm?: EntityManager,
  ): Promise<ThreadStoreEntryEntity> {
    const em = txEm ?? this.em;
    return await this.getRepo(em).upsert(
      {
        threadId: data.threadId,
        namespace: data.namespace,
        key: data.key,
        value: data.value,
        mode: data.mode,
        authorAgentId: data.authorAgentId ?? null,
        tags: data.tags ?? null,
        // Explicit timestamps are required so the conflict-merge branch sets them
        // to the values the caller provides (deletedAt: null clears soft-delete on
        // resurrection; updatedAt reflects the current wall-clock time).
        deletedAt: data.deletedAt ?? null,
        updatedAt: data.updatedAt ?? new Date(),
        createdBy: data.createdBy,
        projectId: data.projectId,
      },
      {
        onConflictFields: ['threadId', 'namespace', 'key'],
        onConflictAction: 'merge',
        onConflictMergeFields: [
          'value',
          'authorAgentId',
          'tags',
          'updatedAt',
          'deletedAt',
        ],
      },
    );
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
