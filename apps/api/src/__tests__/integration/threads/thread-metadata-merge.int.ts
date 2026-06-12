import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { createTestProject } from '../helpers/test-context';
import { createTestModule, TEST_USER_ID } from '../setup';

/**
 * Pins ThreadsDao.mergeMetadataKey's raw-SQL semantics against a real
 * Postgres: the method must MERGE (never clobber) both at the metadata level
 * and inside the targeted key, and must coalesce a NULL metadata column —
 * a clobbering `updateById` re-implementation must fail here.
 */
describe('ThreadsDao.mergeMetadataKey (integration)', () => {
  let app: INestApplication;
  let threadsDao: ThreadsDao;
  let graphDao: GraphDao;

  let projectId: string;
  let graphId: string;
  const threadIds: string[] = [];

  beforeAll(async () => {
    app = await createTestModule();
    threadsDao = app.get(ThreadsDao);
    graphDao = app.get(GraphDao);

    const project = await createTestProject(app);
    projectId = project.projectId;

    const graph = await graphDao.create({
      name: 'metadata-merge-graph',
      description: 'mergeMetadataKey fixture',
      error: undefined,
      version: '1.0.0',
      targetVersion: '1.0.0',
      schema: { nodes: [], edges: [] },
      status: GraphStatus.Running,
      metadata: {},
      createdBy: TEST_USER_ID,
      projectId,
      temporary: true,
    });
    graphId = graph.id;
  }, 60_000);

  afterAll(async () => {
    for (const id of threadIds) {
      await threadsDao.hardDeleteById(id);
    }
    if (graphId) {
      await graphDao.hardDeleteById(graphId);
    }
    await app.close();
  });

  const createThread = async (
    metadata: Record<string, unknown> | undefined,
  ) => {
    const thread = await threadsDao.create({
      graphId,
      createdBy: TEST_USER_ID,
      projectId,
      externalThreadId: `meta-merge-${Date.now()}-${threadIds.length}`,
      metadata,
      source: undefined,
      name: 'metadata merge test thread',
      status: ThreadStatus.Done,
    });
    threadIds.push(thread.id);
    return thread;
  };

  it('merges into the targeted key while preserving sibling metadata keys and existing entries', async () => {
    const thread = await createThread({
      name: 'user-named-thread',
      claudeSessions: { 'node-a': 'sess-a' },
    });

    await threadsDao.mergeMetadataKey(thread.id, 'claudeSessions', {
      'node-b': 'sess-b',
    });

    const row = await threadsDao.getById(thread.id);
    expect(row!.metadata).toEqual({
      name: 'user-named-thread',
      claudeSessions: { 'node-a': 'sess-a', 'node-b': 'sess-b' },
    });
  });

  it('overwrites the same entry on repeat (session rotation) without touching siblings', async () => {
    const thread = await createThread({
      claudeSessions: { 'node-a': 'sess-old', 'node-b': 'sess-b' },
    });

    await threadsDao.mergeMetadataKey(thread.id, 'claudeSessions', {
      'node-a': 'sess-new',
    });

    const row = await threadsDao.getById(thread.id);
    expect(
      (row!.metadata as { claudeSessions: Record<string, string> })
        .claudeSessions,
    ).toEqual({ 'node-a': 'sess-new', 'node-b': 'sess-b' });
  });

  it('coalesces a missing metadata object (NULL column)', async () => {
    const thread = await createThread(undefined);

    await threadsDao.mergeMetadataKey(thread.id, 'claudeSessions', {
      'node-a': 'sess-a',
    });

    const row = await threadsDao.getById(thread.id);
    expect(row!.metadata).toEqual({
      claudeSessions: { 'node-a': 'sess-a' },
    });
  });
});
