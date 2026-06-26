import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { environment } from '../../../environments';
import {
  AgentMemoryEntryMode,
  AppendEntryInput,
  PutEntryInput,
} from '../agent-memory.types';
import { AgentMemoryDao } from '../dao/agent-memory.dao';
import {
  AgentMemoryEntry,
  ListEntriesQuery,
  NamespaceSummary,
  ProjectMemoryIndexEntry,
} from '../dto/agent-memory.dto';
import { AgentMemoryEntryEntity } from '../entity/agent-memory-entry.entity';

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
  ) {}

  // ---- HTTP entry points (REST controller; ctx carries the validated user/project) ----

  async put(
    ctx: AppContextStorage,
    input: PutEntryInput,
  ): Promise<AgentMemoryEntry> {
    return await this.putForProject(
      ctx.checkSub(),
      ctx.checkProjectId(),
      input,
    );
  }

  async append(
    ctx: AppContextStorage,
    input: AppendEntryInput,
  ): Promise<AgentMemoryEntry> {
    return await this.appendForProject(
      ctx.checkSub(),
      ctx.checkProjectId(),
      input,
    );
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
  ): Promise<AgentMemoryEntry> {
    this.assertValue(input.value);

    // Agent tools call this outside an HTTP request, so `this.em` is the shared
    // global EM. A fork gives an isolated connection context so the inner
    // `transactional()` opens a fresh BEGIN, not a SAVEPOINT nested in some
    // unrelated outer tx. Mirrors ThreadStoreService.putForUser.
    let entry!: AgentMemoryEntryEntity;
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
      await this.pruneToCapacity(projectId, input.namespace, txEm);
    });

    return this.toDto(entry);
  }

  async appendForProject(
    userId: string,
    projectId: string,
    input: AppendEntryInput,
  ): Promise<AgentMemoryEntry> {
    this.assertValue(input.value);

    // Full UUID (not a slice) so rapid same-millisecond appends never collide on
    // the `(projectId, namespace, key)` unique index.
    const generatedKey = `${new Date().toISOString()}-${randomUUID()}`;

    let entry!: AgentMemoryEntryEntity;
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
      await this.pruneToCapacity(projectId, input.namespace, txEm);
    });

    return this.toDto(entry);
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
   */
  private async pruneToCapacity(
    projectId: string,
    namespace: string,
    txEm: EntityManager,
  ): Promise<void> {
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
    }
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
