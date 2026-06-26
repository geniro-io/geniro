import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { environment } from '../../../environments';
import type { RequestTokenUsage } from '../../litellm/litellm.types';
import {
  AgentMemoryEntryMode,
  AppendEntryInput,
  PutEntryInput,
} from '../agent-memory.types';
import { AgentMemoryDao } from '../dao/agent-memory.dao';
import {
  AgentMemoryEntry,
  AgentMemoryWriteResult,
  ListEntriesQuery,
  NamespaceSummary,
  ProjectMemoryIndexEntry,
} from '../dto/agent-memory.dto';
import { AgentMemoryEntryEntity } from '../entity/agent-memory-entry.entity';
import { AgentMemoryVectorService } from './agent-memory-vector.service';

/**
 * Durable, project-scoped agent memory. Every agent that runs in a project shares
 * one memory pool (a "shared brain"): reads are scoped by `projectId` only — never
 * by `createdBy` or `authorAgentId` — so any agent can recall and overwrite any
 * entry. `authorAgentId` is stamped for provenance, not access control. The project
 * boundary (the validated `projectId`) IS the trust boundary.
 */
@Injectable()
export class AgentMemoryService {
  private readonly logger = new Logger(AgentMemoryService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly agentMemoryDao: AgentMemoryDao,
    private readonly vectorService: AgentMemoryVectorService,
  ) {}

  // ---- HTTP entry points (REST controller; ctx carries the validated user/project) ----

  async put(
    ctx: AppContextStorage,
    input: PutEntryInput,
  ): Promise<AgentMemoryEntry> {
    const { entry } = await this.putForProject(
      ctx.checkSub(),
      ctx.checkProjectId(),
      input,
    );
    return entry;
  }

  async append(
    ctx: AppContextStorage,
    input: AppendEntryInput,
  ): Promise<AgentMemoryEntry> {
    const { entry } = await this.appendForProject(
      ctx.checkSub(),
      ctx.checkProjectId(),
      input,
    );
    return entry;
  }

  /** Semantic memory search from the Project Memory UI (project from ctx header). */
  async searchEntries(
    ctx: AppContextStorage,
    query: string,
    limit: number,
  ): Promise<AgentMemoryEntry[]> {
    const { entries } = await this.searchForProject(
      ctx.checkProjectId(),
      query,
      limit,
    );
    return entries;
  }

  async get(
    ctx: AppContextStorage,
    namespace: string,
    key: string,
  ): Promise<AgentMemoryEntry | null> {
    return await this.getForProject(ctx.checkProjectId(), namespace, key);
  }

  async listNamespaces(ctx: AppContextStorage): Promise<NamespaceSummary[]> {
    return await this.listNamespacesForProject(ctx.checkProjectId());
  }

  async listEntries(
    ctx: AppContextStorage,
    namespace: string,
    query?: ListEntriesQuery,
  ): Promise<AgentMemoryEntry[]> {
    return await this.listEntriesForProject(
      ctx.checkProjectId(),
      namespace,
      query,
    );
  }

  async getIndex(
    ctx: AppContextStorage,
    limit?: number,
  ): Promise<ProjectMemoryIndexEntry[]> {
    return await this.getIndexForProject(ctx.checkProjectId(), limit);
  }

  async delete(
    ctx: AppContextStorage,
    namespace: string,
    key: string,
  ): Promise<void> {
    return await this.deleteForProject(ctx.checkProjectId(), namespace, key);
  }

  // ---- Project entry points. Used by agent tools, which have a projectId and an
  // ---- author agent id (from the run config) but no AppContextStorage. ----

  async putForProject(
    userId: string,
    projectId: string,
    input: PutEntryInput,
  ): Promise<AgentMemoryWriteResult> {
    this.assertValue(input.value);

    // Agent tools call this outside an HTTP request, so `this.em` is the shared
    // global EM. A fork gives an isolated connection context so the inner
    // `transactional()` opens a fresh BEGIN, not a SAVEPOINT nested in some
    // unrelated outer tx. Mirrors ThreadStoreService.putForUser.
    let entry!: AgentMemoryEntryEntity;
    let victims: AgentMemoryEntryEntity[] = [];
    await this.em.fork().transactional(async (txEm) => {
      entry = await this.agentMemoryDao.upsertKvEntry(
        {
          projectId,
          namespace: input.namespace,
          key: input.key,
          value: input.value,
          mode: AgentMemoryEntryMode.Kv,
          title: input.title ?? null,
          authorAgentId: input.authorAgentId ?? null,
          tags: input.tags ?? null,
          deletedAt: null,
          updatedAt: new Date(),
          createdBy: userId,
        },
        txEm,
      );
      victims = await this.pruneToCapacity(projectId, input.namespace, txEm);
    });

    const embedUsage = await this.embedAndReconcileVectors(entry, victims);
    return { entry: this.toDto(entry), embedUsage };
  }

  async appendForProject(
    userId: string,
    projectId: string,
    input: AppendEntryInput,
  ): Promise<AgentMemoryWriteResult> {
    this.assertValue(input.value);

    // Full UUID (not a slice) so rapid same-millisecond appends never collide on
    // the `(projectId, namespace, key)` unique index.
    const generatedKey = `${new Date().toISOString()}-${randomUUID()}`;

    let entry!: AgentMemoryEntryEntity;
    let victims: AgentMemoryEntryEntity[] = [];
    await this.em.fork().transactional(async (txEm) => {
      entry = await this.agentMemoryDao.create(
        {
          projectId,
          namespace: input.namespace,
          key: generatedKey,
          value: input.value,
          mode: AgentMemoryEntryMode.Append,
          title: input.title ?? null,
          authorAgentId: input.authorAgentId ?? null,
          tags: input.tags ?? null,
          createdBy: userId,
        },
        txEm,
      );
      victims = await this.pruneToCapacity(projectId, input.namespace, txEm);
    });

    const embedUsage = await this.embedAndReconcileVectors(entry, victims);
    return { entry: this.toDto(entry), embedUsage };
  }

  /**
   * After a write commits, embed the new row's value into the vector store
   * (best-effort, returning the embed usage for cost attribution) and drop the
   * vectors of any rows pruned in the same write. Both steps run AFTER the
   * transaction so an embed/Qdrant failure can never roll back the persisted
   * row — the Postgres row is the source of truth, the vector is a derived index.
   */
  private async embedAndReconcileVectors(
    entry: AgentMemoryEntryEntity,
    victims: AgentMemoryEntryEntity[],
  ): Promise<RequestTokenUsage | undefined> {
    const embedUsage = await this.vectorService.embedEntry({
      projectId: entry.projectId,
      namespace: entry.namespace,
      key: entry.key,
      title: entry.title ?? null,
      value: entry.value,
    });

    if (victims.length > 0) {
      await this.vectorService.deleteEntries(
        victims.map((victim) => ({
          projectId: victim.projectId,
          namespace: victim.namespace,
          key: victim.key,
        })),
      );
    }

    return embedUsage;
  }

  /** Semantic search hydrated to full entries; drops vectors whose row is gone. */
  async searchForProject(
    projectId: string,
    query: string,
    limit: number,
  ): Promise<{ entries: AgentMemoryEntry[]; usage?: RequestTokenUsage }> {
    const { matches, usage } = await this.vectorService.search(
      projectId,
      query,
      limit,
    );
    if (matches.length === 0) {
      return { entries: [], usage };
    }

    // One batched read instead of an N+1 getByKey loop. A vector can outlive its
    // row (a failed best-effort delete, a race), so absent rows are dropped —
    // search never returns a (namespace, key) that memory_get would 404 on.
    const rows = await this.agentMemoryDao.getByKeys(
      projectId,
      matches.map((match) => ({ namespace: match.namespace, key: match.key })),
    );
    const rowByKey = new Map(
      rows.map((row) => [JSON.stringify([row.namespace, row.key]), row]),
    );

    // Re-order the hydrated rows back into the vector store's relevance order.
    const entries: AgentMemoryEntry[] = [];
    for (const match of matches) {
      const row = rowByKey.get(JSON.stringify([match.namespace, match.key]));
      if (row) {
        entries.push(this.toDto(row));
      }
    }

    return { entries, usage };
  }

  async getForProject(
    projectId: string,
    namespace: string,
    key: string,
  ): Promise<AgentMemoryEntry | null> {
    const entity = await this.agentMemoryDao.getByKey(
      projectId,
      namespace,
      key,
    );
    return entity ? this.toDto(entity) : null;
  }

  async listNamespacesForProject(
    projectId: string,
  ): Promise<NamespaceSummary[]> {
    const summaries =
      await this.agentMemoryDao.getNamespaceSummaries(projectId);
    return summaries.map((s) => ({
      namespace: s.namespace,
      mode: s.mode,
      entryCount: s.entryCount,
      lastUpdatedAt: s.lastUpdatedAt.toISOString(),
    }));
  }

  async listEntriesForProject(
    projectId: string,
    namespace: string,
    query?: ListEntriesQuery,
  ): Promise<AgentMemoryEntry[]> {
    const mode = await this.agentMemoryDao.getNamespaceMode(
      projectId,
      namespace,
    );
    // Append logs read oldest-first by createdAt (chronological). KV reads
    // newest-first by updatedAt so an overwritten entry floats to the top — the
    // same ordering the live index (getProjectIndex) uses, keeping the two read
    // surfaces consistent.
    const isAppend = mode === AgentMemoryEntryMode.Append;

    const entities = await this.agentMemoryDao.listInNamespace(
      projectId,
      namespace,
      {
        limit: query?.limit,
        offset: query?.offset,
        orderColumn: isAppend ? 'createdAt' : 'updatedAt',
        order: isAppend ? 'ASC' : 'DESC',
      },
    );
    return entities.map((entity) => this.toDto(entity));
  }

  /** The live project memory index (titles/keys/tags, no bodies) — what `memory_list` returns. */
  async getIndexForProject(
    projectId: string,
    limit?: number,
  ): Promise<ProjectMemoryIndexEntry[]> {
    const rows = await this.agentMemoryDao.getProjectIndex(projectId, limit);
    return rows.map((row) => ({
      namespace: row.namespace,
      key: row.key,
      title: row.title ?? null,
      mode: row.mode,
      tags: row.tags ?? null,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async deleteForProject(
    projectId: string,
    namespace: string,
    key: string,
  ): Promise<void> {
    const entity = await this.agentMemoryDao.getByKey(
      projectId,
      namespace,
      key,
    );
    if (!entity) {
      throw new NotFoundException('AGENT_MEMORY_ENTRY_NOT_FOUND');
    }
    if (entity.mode === AgentMemoryEntryMode.Append) {
      throw new BadRequestException(
        'AGENT_MEMORY_APPEND_IMMUTABLE',
        'Append-only entries cannot be deleted.',
      );
    }
    await this.agentMemoryDao.deleteById(entity.id);
    await this.vectorService.deleteEntry({ projectId, namespace, key });
  }

  private assertValue(value: unknown): void {
    // The `value` jsonb column is NOT nullable. Reject null/undefined cleanly
    // (a memory needs content) rather than letting the DB throw a 500-class
    // not-null violation. Non-null falsy values (0, false, '') are valid.
    if (value === null || value === undefined) {
      throw new BadRequestException(
        'AGENT_MEMORY_VALUE_REQUIRED',
        'A memory value is required.',
      );
    }
    const serialized = JSON.stringify(value);
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    if (byteLength > environment.agentMemoryMaxValueBytes) {
      throw new BadRequestException(
        'AGENT_MEMORY_VALUE_TOO_LARGE',
        `Value exceeds the ${environment.agentMemoryMaxValueBytes}-byte limit (${byteLength} bytes).`,
      );
    }
  }

  /**
   * Keep a durable store bounded by pruning the OLDEST entries once a namespace
   * or the project exceeds its cap. Victims are ordered `updatedAt ASC` with a
   * `createdAt, id` tiebreaker so the ordering is deterministic even when many
   * append rows share an `updatedAt`; the just-written entry has the freshest
   * timestamp and so is never selected. Append entries CAN be pruned here (unlike
   * user delete, which refuses them) — capacity maintenance is system-level.
   * Every prune is logged: pruning silently could drop a still-relevant memory.
   * Returns the pruned rows so the caller can drop their vectors after commit.
   */
  private async pruneToCapacity(
    projectId: string,
    namespace: string,
    txEm: EntityManager,
  ): Promise<AgentMemoryEntryEntity[]> {
    const pruned: AgentMemoryEntryEntity[] = [];

    const nsCount = await this.agentMemoryDao.countForNamespace(
      projectId,
      namespace,
      txEm,
    );
    if (nsCount > environment.agentMemoryMaxEntriesPerNamespace) {
      const victims = await this.agentMemoryDao.findOldest(
        { projectId, namespace },
        nsCount - environment.agentMemoryMaxEntriesPerNamespace,
        txEm,
      );
      await this.pruneEntries(projectId, victims, 'namespace', txEm);
      pruned.push(...victims);
    }

    const projectCount = await this.agentMemoryDao.countForProject(
      projectId,
      txEm,
    );
    if (projectCount > environment.agentMemoryMaxEntriesPerProject) {
      const victims = await this.agentMemoryDao.findOldest(
        { projectId },
        projectCount - environment.agentMemoryMaxEntriesPerProject,
        txEm,
      );
      await this.pruneEntries(projectId, victims, 'project', txEm);
      pruned.push(...victims);
    }

    return pruned;
  }

  private async pruneEntries(
    projectId: string,
    victims: AgentMemoryEntryEntity[],
    scope: 'namespace' | 'project',
    txEm: EntityManager,
  ): Promise<void> {
    for (const victim of victims) {
      await this.agentMemoryDao.hardDeleteById(victim.id, txEm);
      this.logger.warn(
        `Pruned oldest agent-memory entry to stay under the ${scope} cap`,
        {
          projectId,
          namespace: victim.namespace,
          key: victim.key,
          mode: victim.mode,
        },
      );
    }
  }

  private toDto(entity: AgentMemoryEntryEntity): AgentMemoryEntry {
    return {
      id: entity.id,
      projectId: entity.projectId,
      namespace: entity.namespace,
      key: entity.key,
      title: entity.title ?? null,
      value: entity.value,
      mode: entity.mode,
      authorAgentId: entity.authorAgentId ?? null,
      tags: entity.tags ?? null,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }
}
