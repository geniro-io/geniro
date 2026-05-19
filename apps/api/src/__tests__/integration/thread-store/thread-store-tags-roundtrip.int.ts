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
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { createTestProject } from '../helpers/test-context';
import { createTestModule } from '../setup';

// Round-trip tests for ThreadStoreService.putForUser → getForUser focused on
// the `tags: string[] | null` column. The PR #27 rewrite swapped a raw-SQL
// upsert (which depended on a custom `toPostgresArrayLiteral`) for MikroORM's
// native `em.upsert()`. The custom serializer + its unit spec were deleted.
// MikroORM v7's `marshallArray` (apps/api node_modules ... BasePostgreSqlPlatform.js
// L190) quotes ONLY elements matching `/["{},\\]/` or that are the empty string.
// Tags containing other characters PostgreSQL treats specially (whitespace,
// the literal token `NULL`) are emitted unquoted — PG then strips boundary
// whitespace and reinterprets unquoted `NULL` as SQL NULL, both producing
// silent round-trip drift. These tests exercise that surface end-to-end.

let contextDataStorage: AppContextStorage;

describe('ThreadStoreService tag round-trip (integration)', () => {
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
        // best effort
      }
    }
    await app?.close();
  });

  const createTestThread = async () => {
    const em = mikroOrm.em.fork();
    const userId = contextDataStorage.checkSub();

    const graphId = randomUUID();
    await em.getConnection().execute(
      `insert into "graphs" ("id", "created_by", "project_id", "name", "status", "schema", "version", "target_version", "created_at", "updated_at")
       values (?, ?, ?, ?, ?, ?::jsonb, ?, ?, now(), now())`,
      [
        graphId,
        userId,
        testProjectId,
        `Thread Store Tag Roundtrip Test Graph ${Date.now()}`,
        GraphStatus.Created,
        JSON.stringify({ nodes: [], edges: [] }),
        '1.0.0',
        '1.0.0',
      ],
    );
    createdGraphIds.push(graphId);

    const externalThreadId = `${graphId}:${Date.now()}-${randomUUID().slice(0, 6)}`;
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
    'preserves a tag whose entire value is the literal token NULL (string, not SQL NULL)',
    { timeout: 30_000 },
    async () => {
      const thread = await createTestThread();
      await threadStoreService.putForUser(
        contextDataStorage.checkSub(),
        testProjectId,
        thread.id,
        {
          namespace: 'tags-null-token',
          key: 'k1',
          value: 'v',
          tags: ['NULL'],
        },
      );

      const fetched = await threadStoreDao.getByKey(
        thread.id,
        'tags-null-token',
        'k1',
      );
      expect(fetched).not.toBeNull();
      expect(fetched!.tags).toEqual(['NULL']);
      expect(fetched!.tags?.[0]).not.toBeNull();
    },
  );

  it(
    'preserves leading and trailing whitespace inside a tag value',
    { timeout: 30_000 },
    async () => {
      const thread = await createTestThread();
      const tagWithSpaces = '  spaced  ';
      await threadStoreService.putForUser(
        contextDataStorage.checkSub(),
        testProjectId,
        thread.id,
        {
          namespace: 'tags-whitespace',
          key: 'k1',
          value: 'v',
          tags: [tagWithSpaces],
        },
      );

      const fetched = await threadStoreDao.getByKey(
        thread.id,
        'tags-whitespace',
        'k1',
      );
      expect(fetched).not.toBeNull();
      expect(fetched!.tags).toEqual([tagWithSpaces]);
    },
  );

  it(
    'preserves a tag that is only whitespace (single space character)',
    { timeout: 30_000 },
    async () => {
      const thread = await createTestThread();
      await threadStoreService.putForUser(
        contextDataStorage.checkSub(),
        testProjectId,
        thread.id,
        {
          namespace: 'tags-whitespace-only',
          key: 'k1',
          value: 'v',
          tags: [' '],
        },
      );

      const fetched = await threadStoreDao.getByKey(
        thread.id,
        'tags-whitespace-only',
        'k1',
      );
      expect(fetched).not.toBeNull();
      expect(fetched!.tags).toEqual([' ']);
    },
  );

  it(
    'preserves an exhaustive mix of PostgreSQL array escape edge cases',
    { timeout: 30_000 },
    async () => {
      const thread = await createTestThread();
      const tags = ['a,b', 'a"b', 'a{}b', "a'b", 'NULL', 'a\\b'];
      await threadStoreService.putForUser(
        contextDataStorage.checkSub(),
        testProjectId,
        thread.id,
        {
          namespace: 'tags-special',
          key: 'k1',
          value: 'v',
          tags,
        },
      );

      const fetched = await threadStoreDao.getByKey(
        thread.id,
        'tags-special',
        'k1',
      );
      expect(fetched).not.toBeNull();
      expect(fetched!.tags).toEqual(tags);
    },
  );
});
