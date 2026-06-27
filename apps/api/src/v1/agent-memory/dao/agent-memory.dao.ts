import { raw } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import type {
  NamespaceSummaryRow,
  ProjectMemoryIndexRow,
} from '../agent-memory.types';
import { AgentMemoryEntryMode } from '../agent-memory.types';
import { AgentMemoryEntryEntity } from '../entity/agent-memory-entry.entity';

@Injectable()
export class AgentMemoryDao extends BaseDao<AgentMemoryEntryEntity> {
  constructor(em: EntityManager) {
    super(em, AgentMemoryEntryEntity);
  }

  async countForNamespace(
    projectId: string,
    namespace: string,
    txEm?: EntityManager,
  ): Promise<number> {
    return await this.count({ projectId, namespace }, txEm);
  }

  async countForProject(
    projectId: string,
    txEm?: EntityManager,
  ): Promise<number> {
    return await this.count({ projectId }, txEm);
  }

  /**
   * Upsert a KV entry. On `(projectId, namespace, key)` conflict (full unique
   * index), replaces `value`, `title`, `authorAgentId`, `tags`, `updatedAt`, and
   * clears `deletedAt` (soft-delete resurrection). Never changes `mode`.
   *
   * Uses MikroORM's native `em.upsert()` against the full unique index, which
   * emits a plain `ON CONFLICT (col, ...) DO UPDATE` PostgreSQL accepts without a
   * partial-index WHERE clause.
   */
  async upsertKvEntry(
    data: {
      projectId: string;
      namespace: string;
      key: string;
      value: unknown;
      mode: AgentMemoryEntryEntity['mode'];
      title?: string | null;
      authorAgentId?: string | null;
      tags?: string[] | null;
      deletedAt?: Date | null;
      updatedAt?: Date;
      createdBy: string;
    },
    txEm?: EntityManager,
  ): Promise<AgentMemoryEntryEntity> {
    const em = txEm ?? this.em;
    return await this.getRepo(em).upsert(
      {
        projectId: data.projectId,
        namespace: data.namespace,
        key: data.key,
        value: data.value,
        mode: data.mode,
        title: data.title ?? null,
        authorAgentId: data.authorAgentId ?? null,
        tags: data.tags ?? null,
        // Explicit timestamps so the conflict-merge branch sets them to the
        // caller's values (deletedAt: null resurrects a soft-deleted row;
        // updatedAt reflects current wall-clock time).
        deletedAt: data.deletedAt ?? null,
        updatedAt: data.updatedAt ?? new Date(),
        createdBy: data.createdBy,
      },
      {
        onConflictFields: ['projectId', 'namespace', 'key'],
        onConflictAction: 'merge',
        onConflictMergeFields: [
          'value',
          'title',
          'authorAgentId',
          'tags',
          'updatedAt',
          'deletedAt',
        ],
      },
    );
  }

  async getByKey(
    projectId: string,
    namespace: string,
    key: string,
    txEm?: EntityManager,
  ): Promise<AgentMemoryEntryEntity | null> {
    return await this.getOne({ projectId, namespace, key }, undefined, txEm);
  }

  /**
   * Batch-fetch active rows for a project by `(namespace, key)` pairs in a single
   * query — used to hydrate semantic-search hits without an N+1 `getByKey` loop.
   * The result order is unspecified (the caller re-orders by relevance); a pair
   * with no live row is simply absent (the soft-delete filter drops it), which is
   * how orphan vectors are silently dropped from search results.
   */
  async getByKeys(
    projectId: string,
    refs: { namespace: string; key: string }[],
  ): Promise<AgentMemoryEntryEntity[]> {
    if (refs.length === 0) {
      return [];
    }
    return await this.getAll({
      projectId,
      $or: refs.map((ref) => ({ namespace: ref.namespace, key: ref.key })),
    });
  }

  /**
   * The mode of a namespace. A namespace's mode is established by convention
   * (save → kv, append → append) and is not constrained at the DB level, so a
   * single-row projection answers it far more cheaply than
   * {@link getNamespaceSummaries} (a full-project `GROUP BY`). A hypothetically
   * mixed-mode namespace yields an arbitrary row's mode — exactly as the prior
   * `getNamespaceSummaries().find()` path it replaces. Returns `null` for an
   * empty/unknown namespace.
   */
  async getNamespaceMode(
    projectId: string,
    namespace: string,
  ): Promise<AgentMemoryEntryMode | null> {
    const row = await this.getOne(
      { projectId, namespace },
      { fields: ['mode'] },
    );
    return row?.mode ?? null;
  }

  async getNamespaceSummaries(
    projectId: string,
  ): Promise<NamespaceSummaryRow[]> {
    const rows = await this.em
      .createQueryBuilder(AgentMemoryEntryEntity, 'e')
      .select([
        'e.namespace',
        'e.mode',
        raw('count(*) as cnt'),
        raw('max(e.updated_at) as last_updated_at'),
      ])
      .where({ projectId, deletedAt: null })
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
      mode: row.mode as AgentMemoryEntryMode,
      entryCount: parseInt(row.cnt, 10),
      lastUpdatedAt:
        row.last_updated_at instanceof Date
          ? row.last_updated_at
          : new Date(row.last_updated_at),
    }));
  }

  async listInNamespace(
    projectId: string,
    namespace: string,
    options?: {
      limit?: number;
      offset?: number;
      orderColumn?: 'createdAt' | 'updatedAt';
      order?: 'ASC' | 'DESC';
    },
  ): Promise<AgentMemoryEntryEntity[]> {
    const {
      orderColumn = 'updatedAt',
      order = 'DESC',
      limit,
      offset,
    } = options ?? {};
    const orderBy =
      orderColumn === 'createdAt' ? { createdAt: order } : { updatedAt: order };
    return await this.getAll(
      { projectId, namespace },
      { orderBy, limit, offset },
    );
  }

  /**
   * The live project memory index: namespace/key/title/tags/mode for every active
   * entry, newest first. Bodies are intentionally excluded — this is the map an
   * agent reads via `memory_list` to decide what to fetch in full.
   */
  async getProjectIndex(
    projectId: string,
    limit?: number,
  ): Promise<ProjectMemoryIndexRow[]> {
    const rows = await this.getAll(
      { projectId },
      {
        fields: ['namespace', 'key', 'title', 'mode', 'tags', 'updatedAt'],
        orderBy: { updatedAt: 'DESC' },
        ...(limit ? { limit } : {}),
      },
    );
    return rows.map((row) => ({
      namespace: row.namespace,
      key: row.key,
      title: row.title ?? null,
      mode: row.mode,
      tags: row.tags ?? null,
      updatedAt: row.updatedAt,
    }));
  }

  /**
   * Oldest active entries matching the scope — used by prune. Ordered
   * `updatedAt ASC` with a `createdAt, id` tiebreaker so the victim set is
   * deterministic even when many rows (e.g. burst appends) share an `updatedAt`,
   * and the freshest just-written entry is never selected.
   */
  async findOldest(
    where: { projectId: string; namespace?: string },
    count: number,
    txEm?: EntityManager,
  ): Promise<AgentMemoryEntryEntity[]> {
    if (count <= 0) {
      return [];
    }
    return await this.getAll(
      where,
      {
        orderBy: { updatedAt: 'ASC', createdAt: 'ASC', id: 'ASC' },
        limit: count,
      },
      txEm,
    );
  }
}
