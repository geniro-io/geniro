import type { EntityManager } from '@mikro-orm/postgresql';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@packages/common';
import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { ThreadsDao } from '../../threads/dao/threads.dao';
import { ThreadStoreDao } from '../dao/thread-store.dao';
import { ThreadStoreEntryEntity } from '../entity/thread-store-entry.entity';
import {
  THREAD_STORE_MAX_ENTRIES_PER_NAMESPACE,
  ThreadStoreAction,
  ThreadStoreEntryMode,
} from '../thread-store.types';
import { ThreadStoreService } from './thread-store.service';

type MockedDao = {
  [K in keyof ThreadStoreDao]: ReturnType<typeof vi.fn>;
};

type MockedThreadsDao = {
  getOne: ReturnType<typeof vi.fn>;
};

const USER_ID = 'user-123';
const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = 'thread-1';
const EXTERNAL_THREAD_ID = 'graph-1:thread-1';

const buildCtx = () =>
  new AppContextStorage({ sub: USER_ID }, {
    headers: { 'x-project-id': PROJECT_ID },
  } as unknown as FastifyRequest);

const buildThread = () => ({
  id: THREAD_ID,
  externalThreadId: EXTERNAL_THREAD_ID,
  graphId: 'graph-1',
  createdBy: USER_ID,
  projectId: PROJECT_ID,
});

const buildEntry = (
  overrides: Partial<ThreadStoreEntryEntity> = {},
): ThreadStoreEntryEntity =>
  ({
    id: 'entry-1',
    threadId: THREAD_ID,
    namespace: 'plan',
    key: 'root',
    value: { ok: true },
    mode: ThreadStoreEntryMode.Kv,
    authorAgentId: 'agent-1',
    tags: null,
    createdAt: new Date('2026-04-19T10:00:00Z'),
    updatedAt: new Date('2026-04-19T10:00:00Z'),
    ...overrides,
  }) as unknown as ThreadStoreEntryEntity;

describe('ThreadStoreService', () => {
  let service: ThreadStoreService;
  let dao: MockedDao;
  let threadsDao: MockedThreadsDao;
  let em: {
    transactional: ReturnType<typeof vi.fn>;
    fork: ReturnType<typeof vi.fn>;
  };
  let notifications: { emit: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    dao = {
      countForNamespace: vi.fn(),
      upsertKvEntry: vi.fn(),
      getByKey: vi.fn(),
      getNamespaceSummaries: vi.fn(),
      listInNamespace: vi.fn(),
      create: vi.fn(),
      deleteById: vi.fn(),
    } as unknown as MockedDao;
    // Default getNamespaceSummaries to empty so tests that don't care don't blow up
    (dao.getNamespaceSummaries as ReturnType<typeof vi.fn>).mockResolvedValue(
      [],
    );
    threadsDao = { getOne: vi.fn() };
    // em.transactional executes the callback immediately with the same em mock.
    // em.fork returns the same em — production code uses .fork() to detach
    // from the request-scoped EM (see ThreadStoreService put/append).
    em = {
      transactional: vi
        .fn()
        .mockImplementation(async (cb: (txEm: unknown) => Promise<unknown>) => {
          return await cb(undefined);
        }),
      fork: vi.fn(),
    };
    em.fork.mockReturnValue(em);
    notifications = { emit: vi.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadStoreService,
        { provide: ThreadStoreDao, useValue: dao },
        { provide: ThreadsDao, useValue: threadsDao },
        {
          provide: 'EntityManager',
          useValue: em as unknown as EntityManager,
        },
        { provide: NotificationsService, useValue: notifications },
      ],
    })
      .overrideProvider(ThreadStoreService)
      .useFactory({
        factory: () =>
          new ThreadStoreService(
            em as unknown as EntityManager,
            threadsDao as unknown as ThreadsDao,
            dao as unknown as ThreadStoreDao,
            notifications as unknown as NotificationsService,
          ),
      })
      .compile();

    service = module.get(ThreadStoreService);
  });

  it('put: persists a KV entry and emits a notification', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getByKey.mockResolvedValue(null);
    dao.countForNamespace.mockResolvedValue(3);
    dao.upsertKvEntry.mockResolvedValue(buildEntry());

    const result = await service.put(buildCtx(), THREAD_ID, {
      namespace: 'plan',
      key: 'root',
      value: { ok: true },
      authorAgentId: 'agent-1',
    });

    expect(result.key).toBe('root');
    expect(result.mode).toBe(ThreadStoreEntryMode.Kv);
    expect(dao.upsertKvEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: THREAD_ID,
        namespace: 'plan',
        key: 'root',
        mode: ThreadStoreEntryMode.Kv,
        createdBy: USER_ID,
        projectId: PROJECT_ID,
      }),
      undefined,
    );
    expect(notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'thread.store.update',
        threadId: EXTERNAL_THREAD_ID,
        data: expect.objectContaining({ action: 'put', namespace: 'plan' }),
      }),
    );
  });

  it('put: throws NotFoundException when the thread is not owned by the caller', async () => {
    threadsDao.getOne.mockResolvedValue(null);

    await expect(
      service.put(buildCtx(), THREAD_ID, {
        namespace: 'plan',
        key: 'root',
        value: 'x',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('put: rejects values over the 32 KB limit', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    const huge = 'x'.repeat(40_000);

    await expect(
      service.put(buildCtx(), THREAD_ID, {
        namespace: 'plan',
        key: 'root',
        value: huge,
      }),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
    });
  });

  it('put: rejects when the namespace is at capacity for a new key', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getByKey.mockResolvedValue(null);
    dao.countForNamespace.mockResolvedValue(
      THREAD_STORE_MAX_ENTRIES_PER_NAMESPACE,
    );

    await expect(
      service.put(buildCtx(), THREAD_ID, {
        namespace: 'plan',
        key: 'new',
        value: 'x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('put: allows overwriting an existing key even at capacity', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getByKey.mockResolvedValue(buildEntry({ key: 'root' }));
    dao.countForNamespace.mockResolvedValue(
      THREAD_STORE_MAX_ENTRIES_PER_NAMESPACE,
    );
    dao.upsertKvEntry.mockResolvedValue(buildEntry({ key: 'root' }));

    const result = await service.put(buildCtx(), THREAD_ID, {
      namespace: 'plan',
      key: 'root',
      value: 'updated',
    });

    expect(result.key).toBe('root');
    expect(dao.upsertKvEntry).toHaveBeenCalled();
  });

  it('append: uses append mode and auto-generated key', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.countForNamespace.mockResolvedValue(0);
    dao.create.mockResolvedValue(
      buildEntry({ mode: ThreadStoreEntryMode.Append, key: 'auto-key-1' }),
    );

    await service.append(buildCtx(), THREAD_ID, {
      namespace: 'learnings',
      value: 'never run npm ci on this box',
    });

    expect(dao.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: ThreadStoreEntryMode.Append,
        namespace: 'learnings',
      }),
      undefined,
    );
  });

  it('delete: refuses to delete append entries', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getByKey.mockResolvedValue(
      buildEntry({ mode: ThreadStoreEntryMode.Append }),
    );

    await expect(
      service.delete(buildCtx(), THREAD_ID, 'reports', 'some-key'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(dao.deleteById).not.toHaveBeenCalled();
  });

  it('delete: removes a KV entry and emits a notification', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getByKey.mockResolvedValue(buildEntry());

    await service.delete(buildCtx(), THREAD_ID, 'plan', 'root');

    expect(dao.deleteById).toHaveBeenCalledWith('entry-1');
    expect(notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'delete' }),
      }),
    );
  });

  it('resolveInternalThreadId: maps external thread id to internal id for the caller', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());

    const id = await service.resolveInternalThreadId(
      USER_ID,
      PROJECT_ID,
      EXTERNAL_THREAD_ID,
    );

    expect(id).toBe(THREAD_ID);
    expect(threadsDao.getOne).toHaveBeenCalledWith(
      expect.objectContaining({
        externalThreadId: EXTERNAL_THREAD_ID,
        createdBy: USER_ID,
        projectId: PROJECT_ID,
      }),
    );
  });

  // -- getForUser --

  it('getForUser: returns mapped DTO when thread and entry exist', async () => {
    const entry = buildEntry({ key: 'root', namespace: 'plan' });
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getByKey.mockResolvedValue(entry);

    const result = await service.getForUser(
      USER_ID,
      PROJECT_ID,
      THREAD_ID,
      'plan',
      'root',
    );

    expect(result).not.toBeNull();
    expect(result?.key).toBe('root');
    expect(result?.namespace).toBe('plan');
    expect(dao.getByKey).toHaveBeenCalledWith(THREAD_ID, 'plan', 'root');
  });

  it('getForUser: returns null when the entry is missing', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getByKey.mockResolvedValue(null);

    const result = await service.getForUser(
      USER_ID,
      PROJECT_ID,
      THREAD_ID,
      'plan',
      'missing-key',
    );

    expect(result).toBeNull();
  });

  it('getForUser: throws NotFoundException when thread ownership check fails', async () => {
    threadsDao.getOne.mockResolvedValue(null);

    await expect(
      service.getForUser(USER_ID, PROJECT_ID, THREAD_ID, 'plan', 'root'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getForUser: passes projectId to the ownership check', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getByKey.mockResolvedValue(null);

    await service.getForUser(USER_ID, 'proj-1', THREAD_ID, 'plan', 'root');

    expect(threadsDao.getOne).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1' }),
    );
  });

  // -- listNamespacesForUser --

  it('listNamespacesForUser: returns mapped namespace summaries', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getNamespaceSummaries.mockResolvedValue([
      {
        namespace: 'plan',
        entryCount: 3,
        lastUpdatedAt: new Date('2026-04-19T12:00:00Z'),
      },
    ]);

    const result = await service.listNamespacesForUser(
      USER_ID,
      PROJECT_ID,
      THREAD_ID,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      namespace: 'plan',
      entryCount: 3,
      lastUpdatedAt: '2026-04-19T12:00:00.000Z',
    });
  });

  it('listNamespacesForUser: throws NotFoundException when ownership check fails', async () => {
    threadsDao.getOne.mockResolvedValue(null);

    await expect(
      service.listNamespacesForUser(USER_ID, PROJECT_ID, THREAD_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // -- listEntriesForUser --

  it('listEntriesForUser: returns mapped entries', async () => {
    const entry = buildEntry({ key: 'root', namespace: 'plan' });
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.listInNamespace.mockResolvedValue([entry]);

    const result = await service.listEntriesForUser(
      USER_ID,
      PROJECT_ID,
      THREAD_ID,
      'plan',
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe('root');
    expect(dao.listInNamespace).toHaveBeenCalledWith(
      THREAD_ID,
      'plan',
      expect.any(Object),
    );
  });

  it('listEntriesForUser: throws NotFoundException when ownership check fails', async () => {
    threadsDao.getOne.mockResolvedValue(null);

    await expect(
      service.listEntriesForUser(USER_ID, PROJECT_ID, THREAD_ID, 'plan'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listEntriesForUser: forwards limit and offset options to the DAO', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.listInNamespace.mockResolvedValue([]);

    await service.listEntriesForUser(USER_ID, PROJECT_ID, THREAD_ID, 'plan', {
      limit: 5,
      offset: 10,
    });

    expect(dao.listInNamespace).toHaveBeenCalledWith(
      THREAD_ID,
      'plan',
      expect.objectContaining({ limit: 5, offset: 10 }),
    );
  });

  it('listEntriesForUser: uses ASC order for append-mode namespaces', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getNamespaceSummaries.mockResolvedValue([
      {
        namespace: 'learnings',
        mode: ThreadStoreEntryMode.Append,
        entryCount: 2,
        lastUpdatedAt: new Date('2026-04-19T12:00:00Z'),
      },
    ]);
    dao.listInNamespace.mockResolvedValue([]);

    await service.listEntriesForUser(
      USER_ID,
      PROJECT_ID,
      THREAD_ID,
      'learnings',
    );

    expect(dao.listInNamespace).toHaveBeenCalledWith(
      THREAD_ID,
      'learnings',
      expect.objectContaining({ order: 'ASC' }),
    );
  });

  it('listEntriesForUser: uses DESC order for kv-mode namespaces', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getNamespaceSummaries.mockResolvedValue([
      {
        namespace: 'plan',
        mode: ThreadStoreEntryMode.Kv,
        entryCount: 1,
        lastUpdatedAt: new Date('2026-04-19T12:00:00Z'),
      },
    ]);
    dao.listInNamespace.mockResolvedValue([]);

    await service.listEntriesForUser(USER_ID, PROJECT_ID, THREAD_ID, 'plan');

    expect(dao.listInNamespace).toHaveBeenCalledWith(
      THREAD_ID,
      'plan',
      expect.objectContaining({ order: 'DESC' }),
    );
  });

  it('listEntriesForUser: defaults to DESC when namespace summary is missing', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getNamespaceSummaries.mockResolvedValue([]);
    dao.listInNamespace.mockResolvedValue([]);

    await service.listEntriesForUser(
      USER_ID,
      PROJECT_ID,
      THREAD_ID,
      'nonexistent',
    );

    expect(dao.listInNamespace).toHaveBeenCalledWith(
      THREAD_ID,
      'nonexistent',
      expect.objectContaining({ order: 'DESC' }),
    );
  });

  // -- putForUser --

  it('putForUser: invokes em.transactional exactly once', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getByKey.mockResolvedValue(null);
    dao.countForNamespace.mockResolvedValue(3);
    dao.upsertKvEntry.mockResolvedValue(buildEntry());

    await service.putForUser(USER_ID, PROJECT_ID, THREAD_ID, {
      namespace: 'plan',
      key: 'root',
      value: { ok: true },
    });

    expect(em.transactional).toHaveBeenCalledTimes(1);
  });

  it('putForUser: throws BadRequestException when post-insert recount exceeds the limit', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getByKey.mockResolvedValue(null);
    // First call (pre-insert assertCapacity): below limit
    // Second call (post-insert recount inside tx): above limit
    dao.countForNamespace
      .mockResolvedValueOnce(THREAD_STORE_MAX_ENTRIES_PER_NAMESPACE - 1)
      .mockResolvedValueOnce(THREAD_STORE_MAX_ENTRIES_PER_NAMESPACE + 1);
    dao.upsertKvEntry.mockResolvedValue(buildEntry());

    await expect(
      service.putForUser(USER_ID, PROJECT_ID, THREAD_ID, {
        namespace: 'plan',
        key: 'new-key',
        value: 'v',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // -- countEntriesForUser --

  it('countEntriesForUser: returns count from DAO for the given namespace', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.countForNamespace.mockResolvedValue(7);

    const count = await service.countEntriesForUser(
      USER_ID,
      PROJECT_ID,
      THREAD_ID,
      'plan',
    );

    expect(count).toBe(7);
    expect(dao.countForNamespace).toHaveBeenCalledWith(THREAD_ID, 'plan');
  });

  it('countEntriesForUser: throws NotFoundException when thread ownership check fails', async () => {
    threadsDao.getOne.mockResolvedValue(null);

    await expect(
      service.countEntriesForUser(USER_ID, PROJECT_ID, THREAD_ID, 'plan'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('countEntriesForUser: passes projectId to the ownership check', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.countForNamespace.mockResolvedValue(0);

    await service.countEntriesForUser(USER_ID, 'proj-42', THREAD_ID, 'ns');

    expect(threadsDao.getOne).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-42' }),
    );
  });

  // -- emitUpdate (ThreadStoreAction enum) --

  it('emitUpdate: emits ThreadStoreAction enum value (not raw string) for put', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getByKey.mockResolvedValue(null);
    dao.countForNamespace.mockResolvedValue(0);
    dao.upsertKvEntry.mockResolvedValue(buildEntry());

    await service.putForUser(USER_ID, PROJECT_ID, THREAD_ID, {
      namespace: 'plan',
      key: 'root',
      value: 'x',
    });

    expect(notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: ThreadStoreAction.Put }),
      }),
    );
  });

  it('emitUpdate: emits ThreadStoreAction.Delete for delete operations', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getByKey.mockResolvedValue(buildEntry());

    await service.delete(buildCtx(), THREAD_ID, 'plan', 'root');

    expect(notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: ThreadStoreAction.Delete }),
      }),
    );
  });

  // -- emitUpdate --

  it('emitUpdate: notification payload contains externalThreadId (not internal id)', async () => {
    threadsDao.getOne.mockResolvedValue(buildThread());
    dao.getByKey.mockResolvedValue(null);
    dao.countForNamespace.mockResolvedValue(0);
    dao.upsertKvEntry.mockResolvedValue(buildEntry());

    await service.putForUser(USER_ID, PROJECT_ID, THREAD_ID, {
      namespace: 'plan',
      key: 'root',
      value: 'x',
    });

    expect(notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalThreadId: EXTERNAL_THREAD_ID,
        }),
      }),
    );
  });
});
