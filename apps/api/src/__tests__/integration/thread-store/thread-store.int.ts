import { randomUUID } from 'node:crypto';

import { MikroORM } from '@mikro-orm/postgresql';
import { INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { GraphEntity } from '../../../v1/graphs/entity/graph.entity';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { ThreadStoreDao } from '../../../v1/thread-store/dao/thread-store.dao';
import { ThreadStoreService } from '../../../v1/thread-store/services/thread-store.service';
import {
  THREAD_STORE_MAX_ENTRIES_PER_NAMESPACE,
  THREAD_STORE_MAX_VALUE_BYTES,
  ThreadStoreEntryMode,
} from '../../../v1/thread-store/thread-store.types';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { buildTestContext, createTestProject } from '../helpers/test-context';
import { createTestModule } from '../setup';

let contextDataStorage: AppContextStorage;

describe('ThreadStoreService (integration)', () => {
  let app: INestApplication;
  let threadStoreService: ThreadStoreService;
  let threadStoreDao: ThreadStoreDao;
  let threadsDao: ThreadsDao;
  let mikroOrm: MikroORM;
  let testProjectId: string;
  const createdThreadIds: string[] = [];
  const createdGraphIds: string[] = [];

  beforeAll(async () => {
    app = await createTestModule();
    threadStoreService = app.get(ThreadStoreService);
    threadStoreDao = app.get(ThreadStoreDao);
    threadsDao = app.get(ThreadsDao);
    mikroOrm = app.get(MikroORM);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;
  }, 120_000);

  afterEach(async () => {
    for (const id of createdThreadIds) {
      // Hard-delete to drop thread-store entries via cascade.
      await threadsDao.hardDeleteById(id);
    }
    createdThreadIds.length = 0;

    if (createdGraphIds.length > 0) {
      const em = mikroOrm.em.fork();
      await em.nativeDelete(GraphEntity, { id: { $in: createdGraphIds } });
      createdGraphIds.length = 0;
    }
  });

  afterAll(async () => {
    if (testProjectId) {
      try {
        await app.get(ProjectsDao).deleteById(testProjectId);
      } catch {
        // best effort cleanup
      }
    }

    await app?.close();
  });

  const createTestThread = async () => {
    const em = mikroOrm.em.fork();
    const userId = contextDataStorage.checkSub();

    // A minimal graph record so the thread has a graphId to point at.
    const graphId = randomUUID();
    await em.getConnection().execute(
      `insert into "graphs" ("id", "created_by", "project_id", "name", "status", "schema", "version", "target_version", "created_at", "updated_at")
       values (?, ?, ?, ?, ?, ?::jsonb, ?, ?, now(), now())`,
      [
        graphId,
        userId,
        testProjectId,
        `Thread Store Test Graph ${Date.now()}`,
        GraphStatus.Created,
        JSON.stringify({ nodes: [], edges: [] }),
        '1.0.0',
        '1.0.0',
      ],
    );
    createdGraphIds.push(graphId);

    const externalThreadId = `${graphId}:${Date.now()}`;
    const thread = await threadsDao.create({
      graphId,
      createdBy: userId,
      projectId: testProjectId,
      externalThreadId,
      status: ThreadStatus.Running,
    });

    createdThreadIds.push(thread.id);
    return thread;
  };

  it(
    'round-trip: put, append, get, list, delete across parent + subagent perspective',
    { timeout: 60_000 },
    async () => {
      const thread = await createTestThread();

      // Root agent writes a KV plan.
      const plan = await threadStoreService.put(contextDataStorage, thread.id, {
        namespace: 'plan',
        key: 'root',
        value: { goal: 'refactor auth', steps: ['audit', 'rename'] },
        authorAgentId: 'root',
        tags: ['plan'],
      });
      expect(plan.mode).toBe(ThreadStoreEntryMode.Kv);

      // Subagent appends a learning via `*ForUser` entry point (simulating
      // a tool invocation where ctx isn't available).
      const userId = contextDataStorage.checkSub();
      const learning = await threadStoreService.appendForUser(
        userId,
        testProjectId,
        thread.id,
        {
          namespace: 'learnings',
          value: 'auth middleware also runs on WebSocket upgrades',
          authorAgentId: 'system:explorer',
          tags: ['auth'],
        },
      );
      expect(learning.mode).toBe(ThreadStoreEntryMode.Append);
      expect(learning.authorAgentId).toBe('system:explorer');

      // Resolving external -> internal thread id works for subagents.
      const resolvedInternalId =
        await threadStoreService.resolveInternalThreadId(
          userId,
          testProjectId,
          thread.externalThreadId,
        );
      expect(resolvedInternalId).toBe(thread.id);

      // Parent can read the subagent's learning via get.
      const fetchedLearning = await threadStoreService.get(
        contextDataStorage,
        thread.id,
        'learnings',
        learning.key,
      );
      expect(fetchedLearning?.value).toBe(
        'auth middleware also runs on WebSocket upgrades',
      );

      // Namespaces summary reflects both writes.
      const summaries = await threadStoreService.listNamespaces(
        contextDataStorage,
        thread.id,
      );
      const names = summaries.map((s) => s.namespace).sort();
      expect(names).toEqual(['learnings', 'plan']);

      // List entries in the plan namespace returns the single KV entry.
      const planEntries = await threadStoreService.listEntries(
        contextDataStorage,
        thread.id,
        'plan',
      );
      expect(planEntries).toHaveLength(1);
      expect(planEntries[0]!.key).toBe('root');

      // Deleting a KV entry works.
      await threadStoreService.delete(
        contextDataStorage,
        thread.id,
        'plan',
        'root',
      );
      const afterDelete = await threadStoreService.get(
        contextDataStorage,
        thread.id,
        'plan',
        'root',
      );
      expect(afterDelete).toBeNull();

      // Append entries remain.
      const learnings = await threadStoreService.listEntries(
        contextDataStorage,
        thread.id,
        'learnings',
      );
      expect(learnings).toHaveLength(1);
    },
  );

  it(
    'rejects deletion of append-only entries',
    { timeout: 30_000 },
    async () => {
      const thread = await createTestThread();
      const appended = await threadStoreService.append(
        contextDataStorage,
        thread.id,
        {
          namespace: 'reports',
          value: 'first report',
        },
      );

      await expect(
        threadStoreService.delete(
          contextDataStorage,
          thread.id,
          'reports',
          appended.key,
        ),
      ).rejects.toMatchObject({ code: 'THREAD_STORE_APPEND_IMMUTABLE' });

      // Entry is still there.
      const still = await threadStoreService.get(
        contextDataStorage,
        thread.id,
        'reports',
        appended.key,
      );
      expect(still).not.toBeNull();
    },
  );

  it('isolates stores across threads', { timeout: 30_000 }, async () => {
    const threadA = await createTestThread();
    const threadB = await createTestThread();

    await threadStoreService.put(contextDataStorage, threadA.id, {
      namespace: 'plan',
      key: 'root',
      value: 'thread-a-plan',
    });

    const crossRead = await threadStoreService.get(
      contextDataStorage,
      threadB.id,
      'plan',
      'root',
    );
    expect(crossRead).toBeNull();
  });

  it(
    'surfaces entries via direct DAO lookup',
    { timeout: 10_000 },
    async () => {
      const thread = await createTestThread();
      await threadStoreService.put(contextDataStorage, thread.id, {
        namespace: 'todo',
        key: 'write-docs',
        value: { status: 'pending' },
      });

      const entry = await threadStoreDao.getByKey(
        thread.id,
        'todo',
        'write-docs',
      );
      expect(entry).not.toBeNull();
      expect(entry!.mode).toBe(ThreadStoreEntryMode.Kv);
    },
  );

  it(
    'rejects appends past THREAD_STORE_MAX_ENTRIES_PER_NAMESPACE',
    { timeout: 120_000 },
    async () => {
      const thread = await createTestThread();
      const userId = contextDataStorage.checkSub();

      // Fill the namespace to the maximum limit using append (auto-generated keys).
      for (let i = 0; i < THREAD_STORE_MAX_ENTRIES_PER_NAMESPACE; i++) {
        await threadStoreService.appendForUser(
          userId,
          testProjectId,
          thread.id,
          {
            namespace: 'bulk',
            value: `entry-${i}`,
          },
        );
      }

      // One more append must be rejected.
      await expect(
        threadStoreService.appendForUser(userId, testProjectId, thread.id, {
          namespace: 'bulk',
          value: 'one-too-many',
        }),
      ).rejects.toMatchObject({ code: 'THREAD_STORE_NAMESPACE_FULL' });
    },
  );

  it(
    'accepts a 32,768-byte value (boundary) and rejects 32,769-byte (boundary+1)',
    { timeout: 30_000 },
    async () => {
      const thread = await createTestThread();

      // assertValueSize serializes the value via JSON.stringify, adding 2 bytes
      // of quote overhead for a plain string. To hit exactly THREAD_STORE_MAX_VALUE_BYTES
      // serialized bytes, the raw string must be (THREAD_STORE_MAX_VALUE_BYTES - 2) chars.
      const SERIALIZED_OVERHEAD = 2; // JSON.stringify(string) wraps in double-quotes
      const vAtBoundary = 'x'.repeat(
        THREAD_STORE_MAX_VALUE_BYTES - SERIALIZED_OVERHEAD,
      );
      const vOverBoundary = 'x'.repeat(
        THREAD_STORE_MAX_VALUE_BYTES - SERIALIZED_OVERHEAD + 1,
      );

      // Boundary value (serializes to exactly THREAD_STORE_MAX_VALUE_BYTES bytes) must succeed.
      await expect(
        threadStoreService.put(contextDataStorage, thread.id, {
          namespace: 'size',
          key: 'boundary',
          value: vAtBoundary,
        }),
      ).resolves.toBeDefined();

      // One byte over the limit must be rejected.
      await expect(
        threadStoreService.put(contextDataStorage, thread.id, {
          namespace: 'size',
          key: 'over-boundary',
          value: vOverBoundary,
        }),
      ).rejects.toMatchObject({ code: 'THREAD_STORE_VALUE_TOO_LARGE' });
    },
  );

  it('prevents cross-user thread access', { timeout: 30_000 }, async () => {
    // User A's thread is created by the default test user.
    const threadA = await createTestThread();
    await threadStoreService.put(contextDataStorage, threadA.id, {
      namespace: 'ns',
      key: 'k1',
      value: 'secret-a',
    });

    // User B is a distinct user with their own project.
    const USER_B_ID = '00000000-0000-0000-0000-000000000002';
    const { projectId: projectBId } = await createTestProject(app, USER_B_ID);
    const ctxB = buildTestContext(USER_B_ID, projectBId);

    // User B attempting to read user A's thread must get THREAD_NOT_FOUND.
    await expect(
      threadStoreService.get(ctxB, threadA.id, 'ns', 'k1'),
    ).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });

    // Cleanup project B (thread cleanup handled by afterEach via createdThreadIds).
    await app.get(ProjectsDao).deleteById(projectBId);
  });

  it(
    'prevents cross-project access by the same user',
    { timeout: 30_000 },
    async () => {
      // Thread lives in testProjectId (project A).
      const thread = await createTestThread();
      await threadStoreService.put(contextDataStorage, thread.id, {
        namespace: 'ns',
        key: 'k1',
        value: 'data',
      });

      // Build a context with a different project for the same user.
      const userId = contextDataStorage.checkSub();
      const { projectId: projectBId } = await createTestProject(app, userId);
      const ctxB = buildTestContext(userId, projectBId);

      // Reading the thread under a different project must fail.
      await expect(
        threadStoreService.get(ctxB, thread.id, 'ns', 'k1'),
      ).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });

      // Cleanup project B.
      await app.get(ProjectsDao).deleteById(projectBId);
    },
  );

  it(
    'serializes concurrent puts on the same key without unique-violation crash',
    { timeout: 30_000 },
    async () => {
      const thread = await createTestThread();
      const userId = contextDataStorage.checkSub();

      // Run 10 rounds of two concurrent puts on the same key.
      for (let i = 0; i < 10; i++) {
        await Promise.all([
          threadStoreService.putForUser(userId, testProjectId, thread.id, {
            namespace: 'ns',
            key: 'k1',
            value: 'v1',
          }),
          threadStoreService.putForUser(userId, testProjectId, thread.id, {
            namespace: 'ns',
            key: 'k1',
            value: 'v2',
          }),
        ]);
      }

      // Exactly one row must exist for (threadId, 'ns', 'k1').
      const entries = await threadStoreService.listEntries(
        contextDataStorage,
        thread.id,
        'ns',
      );
      expect(entries).toHaveLength(1);
      expect(['v1', 'v2']).toContain(entries[0]!.value);
    },
  );

  it(
    'resurrects a soft-deleted entry on re-put',
    { timeout: 30_000 },
    async () => {
      const thread = await createTestThread();

      // Initial put.
      await threadStoreService.put(contextDataStorage, thread.id, {
        namespace: 'ns',
        key: 'k1',
        value: 'v1',
      });

      // Soft-delete the entry.
      await threadStoreService.delete(
        contextDataStorage,
        thread.id,
        'ns',
        'k1',
      );
      const afterDelete = await threadStoreService.get(
        contextDataStorage,
        thread.id,
        'ns',
        'k1',
      );
      expect(afterDelete).toBeNull();

      // Re-put must succeed (no unique-violation) and restore the entry.
      await expect(
        threadStoreService.put(contextDataStorage, thread.id, {
          namespace: 'ns',
          key: 'k1',
          value: 'v2',
        }),
      ).resolves.toBeDefined();

      // The entry is visible again with the new value.
      const resurrected = await threadStoreService.get(
        contextDataStorage,
        thread.id,
        'ns',
        'k1',
      );
      expect(resurrected).not.toBeNull();
      expect(resurrected!.value).toBe('v2');

      // Verify deletedAt is null at the raw entity level (soft-delete cleared).
      const rawEntity = await threadStoreDao.getByKey(thread.id, 'ns', 'k1');
      expect(rawEntity).not.toBeNull();
      expect(rawEntity!.deletedAt).toBeNull();
    },
  );
});
