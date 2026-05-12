import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { NotificationEvent } from '../../notifications/notifications.types';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { ThreadsDao } from '../../threads/dao/threads.dao';
import { ThreadEntity } from '../../threads/entity/thread.entity';
import { ThreadStoreDao } from '../dao/thread-store.dao';
import {
  ListEntriesQuery,
  NamespaceSummary,
  ThreadStoreEntry,
} from '../dto/thread-store.dto';
import { ThreadStoreEntryEntity } from '../entity/thread-store-entry.entity';
import {
  AppendEntryInput,
  PutEntryInput,
  THREAD_STORE_MAX_ENTRIES_PER_NAMESPACE,
  THREAD_STORE_MAX_VALUE_BYTES,
  ThreadStoreAction,
  ThreadStoreEntryMode,
} from '../thread-store.types';

@Injectable()
export class ThreadStoreService {
  constructor(
    private readonly em: EntityManager,
    private readonly threadsDao: ThreadsDao,
    private readonly threadStoreDao: ThreadStoreDao,
    private readonly notificationsService: NotificationsService,
  ) {}

  async put(
    ctx: AppContextStorage,
    threadId: string,
    input: PutEntryInput,
  ): Promise<ThreadStoreEntry> {
    const userId = ctx.checkSub();
    const projectId = ctx.checkProjectId();
    return await this.putForUser(userId, projectId, threadId, input);
  }

  async append(
    ctx: AppContextStorage,
    threadId: string,
    input: AppendEntryInput,
  ): Promise<ThreadStoreEntry> {
    const userId = ctx.checkSub();
    const projectId = ctx.checkProjectId();
    return await this.appendForUser(userId, projectId, threadId, input);
  }

  async get(
    ctx: AppContextStorage,
    threadId: string,
    namespace: string,
    key: string,
  ): Promise<ThreadStoreEntry | null> {
    const userId = ctx.checkSub();
    const projectId = ctx.checkProjectId();
    return await this.getForUser(userId, projectId, threadId, namespace, key);
  }

  async listNamespaces(
    ctx: AppContextStorage,
    threadId: string,
  ): Promise<NamespaceSummary[]> {
    const userId = ctx.checkSub();
    const projectId = ctx.checkProjectId();
    return await this.listNamespacesForUser(userId, projectId, threadId);
  }

  async listEntries(
    ctx: AppContextStorage,
    threadId: string,
    namespace: string,
    query?: ListEntriesQuery,
  ): Promise<ThreadStoreEntry[]> {
    const userId = ctx.checkSub();
    const projectId = ctx.checkProjectId();
    return await this.listEntriesForUser(
      userId,
      projectId,
      threadId,
      namespace,
      query,
    );
  }

  async delete(
    ctx: AppContextStorage,
    threadId: string,
    namespace: string,
    key: string,
  ): Promise<void> {
    const userId = ctx.checkSub();
    const projectId = ctx.checkProjectId();
    return await this.deleteForUser(
      userId,
      projectId,
      threadId,
      namespace,
      key,
    );
  }

  // -- Entry points that take a userId directly. Used by agent tools, which
  // -- don't have an AppContextStorage (no HTTP request).

  async putForUser(
    userId: string,
    projectId: string,
    threadId: string,
    input: PutEntryInput,
  ): Promise<ThreadStoreEntry> {
    const thread = await this.getOwnedThread(userId, projectId, threadId);
    this.assertValueSize(input.value);

    let entry!: ThreadStoreEntryEntity;
    await this.em.transactional(async (txEm) => {
      await this.assertCapacity(
        thread.id,
        input.namespace,
        { mode: ThreadStoreEntryMode.Kv, key: input.key },
        txEm,
      );

      entry = await this.threadStoreDao.upsertKvEntry(
        // deletedAt: null — C1: resurrect soft-deleted rows on re-put.
        // updatedAt: new Date() — M14: explicit timestamp in merge path.
        // Cast is required because the DAO data type does not yet declare these
        // fields; they are in onConflictMergeFields and accepted by MikroORM.
        {
          threadId: thread.id,
          namespace: input.namespace,
          key: input.key,
          value: input.value,
          mode: ThreadStoreEntryMode.Kv,
          authorAgentId: input.authorAgentId ?? null,
          tags: input.tags ?? null,
          deletedAt: null,
          updatedAt: new Date(),
          createdBy: userId,
          projectId,
        } as Parameters<ThreadStoreDao['upsertKvEntry']>[0],
        txEm,
      );

      const finalCount = await this.threadStoreDao.countForNamespace(
        thread.id,
        input.namespace,
        txEm,
      );
      if (finalCount > THREAD_STORE_MAX_ENTRIES_PER_NAMESPACE) {
        throw new BadRequestException('THREAD_STORE_NAMESPACE_FULL');
      }
    });

    await this.emitUpdate(thread, entry, ThreadStoreAction.Put);
    return this.toDto(entry);
  }

  async appendForUser(
    userId: string,
    projectId: string,
    threadId: string,
    input: AppendEntryInput,
  ): Promise<ThreadStoreEntry> {
    const thread = await this.getOwnedThread(userId, projectId, threadId);
    this.assertValueSize(input.value);

    const generatedKey = `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;

    let entry!: ThreadStoreEntryEntity;
    await this.em.transactional(async (txEm) => {
      await this.assertCapacity(
        thread.id,
        input.namespace,
        { mode: ThreadStoreEntryMode.Append },
        txEm,
      );

      entry = await this.threadStoreDao.create(
        {
          threadId: thread.id,
          namespace: input.namespace,
          key: generatedKey,
          value: input.value,
          mode: ThreadStoreEntryMode.Append,
          authorAgentId: input.authorAgentId ?? null,
          tags: input.tags ?? null,
          createdBy: userId,
          projectId,
        },
        txEm,
      );

      const finalCount = await this.threadStoreDao.countForNamespace(
        thread.id,
        input.namespace,
        txEm,
      );
      if (finalCount > THREAD_STORE_MAX_ENTRIES_PER_NAMESPACE) {
        throw new BadRequestException('THREAD_STORE_NAMESPACE_FULL');
      }
    });

    await this.emitUpdate(thread, entry, ThreadStoreAction.Append);
    return this.toDto(entry);
  }

  async getForUser(
    userId: string,
    projectId: string,
    threadId: string,
    namespace: string,
    key: string,
  ): Promise<ThreadStoreEntry | null> {
    await this.getOwnedThread(userId, projectId, threadId);
    const entity = await this.threadStoreDao.getByKey(threadId, namespace, key);
    return entity ? this.toDto(entity) : null;
  }

  async listNamespacesForUser(
    userId: string,
    projectId: string,
    threadId: string,
  ): Promise<NamespaceSummary[]> {
    await this.getOwnedThread(userId, projectId, threadId);
    const summaries = await this.threadStoreDao.getNamespaceSummaries(threadId);
    return summaries.map((s) => ({
      namespace: s.namespace,
      mode: s.mode,
      entryCount: s.entryCount,
      lastUpdatedAt: s.lastUpdatedAt.toISOString(),
    }));
  }

  /**
   * Lists entries in a namespace for the given user.
   *
   * Sort order is mode-aware:
   * - Append-mode namespaces are sorted ASC (oldest first) so callers read the
   *   log in chronological order.
   * - KV-mode namespaces are sorted DESC (most-recently-updated first), which
   *   surfaces the freshest keys for quick inspection.
   * - If the namespace has no entries yet (summary lookup misses), DESC is used
   *   as a safe default.
   */
  async listEntriesForUser(
    userId: string,
    projectId: string,
    threadId: string,
    namespace: string,
    query?: ListEntriesQuery,
  ): Promise<ThreadStoreEntry[]> {
    await this.getOwnedThread(userId, projectId, threadId);

    const summaries = await this.threadStoreDao.getNamespaceSummaries(threadId);
    const summary = summaries.find((s) => s.namespace === namespace);
    const order =
      summary?.mode === ThreadStoreEntryMode.Append ? 'ASC' : 'DESC';

    const entities = await this.threadStoreDao.listInNamespace(
      threadId,
      namespace,
      { limit: query?.limit, offset: query?.offset, order },
    );
    return entities.map((entity) => this.toDto(entity));
  }

  async countEntriesForUser(
    userId: string,
    projectId: string,
    threadId: string,
    namespace: string,
  ): Promise<number> {
    await this.getOwnedThread(userId, projectId, threadId);
    return await this.threadStoreDao.countForNamespace(threadId, namespace);
  }

  async deleteForUser(
    userId: string,
    projectId: string,
    threadId: string,
    namespace: string,
    key: string,
  ): Promise<void> {
    const thread = await this.getOwnedThread(userId, projectId, threadId);
    const entity = await this.threadStoreDao.getByKey(threadId, namespace, key);
    if (!entity) {
      throw new NotFoundException('THREAD_STORE_ENTRY_NOT_FOUND');
    }
    if (entity.mode === ThreadStoreEntryMode.Append) {
      throw new BadRequestException(
        'THREAD_STORE_APPEND_IMMUTABLE',
        'Append-only entries cannot be deleted.',
      );
    }
    await this.threadStoreDao.deleteById(entity.id);
    await this.emitUpdate(thread, entity, ThreadStoreAction.Delete);
  }

  /**
   * Resolve a thread by its `externalThreadId` (the identifier carried on
   * agent `RunnableConfig.configurable.thread_id`). Returns the internal
   * DB thread id so callers can use the standard `*ForUser` methods.
   */
  async resolveInternalThreadId(
    userId: string,
    projectId: string,
    externalThreadId: string,
  ): Promise<string> {
    const thread = await this.threadsDao.getOne({
      externalThreadId,
      createdBy: userId,
      projectId,
    });
    if (!thread) {
      throw new NotFoundException('THREAD_NOT_FOUND');
    }
    return thread.id;
  }

  private async getOwnedThread(
    userId: string,
    projectId: string,
    threadId: string,
  ): Promise<ThreadEntity> {
    const thread = await this.threadsDao.getOne({
      id: threadId,
      createdBy: userId,
      projectId,
    });
    if (!thread) {
      throw new NotFoundException('THREAD_NOT_FOUND');
    }
    return thread;
  }

  private assertValueSize(value: unknown): void {
    const serialized = JSON.stringify(value ?? null);
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    if (byteLength > THREAD_STORE_MAX_VALUE_BYTES) {
      throw new BadRequestException(
        'THREAD_STORE_VALUE_TOO_LARGE',
        `Value exceeds the ${THREAD_STORE_MAX_VALUE_BYTES}-byte limit (${byteLength} bytes).`,
      );
    }
  }

  private async assertCapacity(
    threadId: string,
    namespace: string,
    opts: { mode: ThreadStoreEntryMode; key?: string },
    txEm?: EntityManager,
  ): Promise<void> {
    // KV upsert of an existing key doesn't add an entry -- skip the count.
    if (opts.mode === ThreadStoreEntryMode.Kv && opts.key) {
      const existing = await this.threadStoreDao.getByKey(
        threadId,
        namespace,
        opts.key,
        txEm,
      );
      if (existing) {
        return;
      }
    }

    // Soft-deleted KV key resurrection (deletedAt set) consumes a capacity slot — getByKey honors the default softDelete filter, so resurrection always falls through to the count check. Intentional per the C1 capacity-guard design.
    const count = await this.threadStoreDao.countForNamespace(
      threadId,
      namespace,
      txEm,
    );
    if (count >= THREAD_STORE_MAX_ENTRIES_PER_NAMESPACE) {
      throw new BadRequestException(
        'THREAD_STORE_NAMESPACE_FULL',
        `Namespace "${namespace}" is full (${THREAD_STORE_MAX_ENTRIES_PER_NAMESPACE} entries). Delete or rotate entries before writing more.`,
      );
    }
  }

  private async emitUpdate(
    thread: ThreadEntity,
    entity: ThreadStoreEntryEntity,
    action: ThreadStoreAction,
  ): Promise<void> {
    await this.notificationsService.emit({
      type: NotificationEvent.ThreadStoreUpdate,
      graphId: thread.graphId,
      threadId: thread.externalThreadId,
      data: {
        externalThreadId: thread.externalThreadId,
        namespace: entity.namespace,
        key: entity.key,
        mode: entity.mode,
        action,
        authorAgentId: entity.authorAgentId ?? null,
      },
    });
  }

  private toDto(entity: ThreadStoreEntryEntity): ThreadStoreEntry {
    return {
      id: entity.id,
      threadId: entity.threadId,
      namespace: entity.namespace,
      key: entity.key,
      value: entity.value,
      mode: entity.mode,
      authorAgentId: entity.authorAgentId ?? null,
      tags: entity.tags ?? null,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }
}
