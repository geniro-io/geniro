import { INestApplication } from '@nestjs/common';
import { BadRequestException } from '@packages/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AgentMemoryDao } from '../../../v1/agent-memory/dao/agent-memory.dao';
import { AgentMemoryService } from '../../../v1/agent-memory/services/agent-memory.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { createTestModule, TEST_USER_ID } from '../setup';

/**
 * Adversarial edge-case coverage for project agent memory. These probe inputs
 * that the happy-path suite does not: a `null`/`undefined` body (rejected cleanly
 * rather than crashing the NOT NULL jsonb column), and the ordering contract the
 * live index promises ("newest-updated first") which `listEntries` must match for
 * an overwritten KV entry.
 */
describe('Agent memory edge cases', () => {
  let app: INestApplication;
  let service: AgentMemoryService;
  let dao: AgentMemoryDao;
  let projectsDao: ProjectsDao;
  let projectId: string;

  beforeAll(async () => {
    app = await createTestModule();
    service = app.get(AgentMemoryService);
    dao = app.get(AgentMemoryDao);
    projectsDao = app.get(ProjectsDao);

    projectId = (
      await projectsDao.create({
        name: 'Agent Memory Edge Project',
        createdBy: TEST_USER_ID,
        settings: {},
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dao.hardDelete({ projectId });
  });

  it('rejects a null save value cleanly instead of crashing the NOT NULL column', async () => {
    // A memory needs content; null/undefined is rejected with a 400-class
    // BadRequestException, never a 500-class DB not-null violation.
    await expect(
      service.putForProject(TEST_USER_ID, projectId, {
        namespace: 'facts',
        key: 'cleared',
        value: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await dao.countForNamespace(projectId, 'facts')).toBe(0);
  });

  it('rejects a null append value cleanly', async () => {
    await expect(
      service.appendForProject(TEST_USER_ID, projectId, {
        namespace: 'learnings',
        value: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await dao.countForNamespace(projectId, 'learnings')).toBe(0);
  });

  it('round-trips non-null falsy values (0 / false / empty string)', async () => {
    for (const [key, value] of [
      ['zero', 0],
      ['flag', false],
      ['empty', ''],
    ] as const) {
      await service.putForProject(TEST_USER_ID, projectId, {
        namespace: 'falsy',
        key,
        value,
      });
      const entry = await service.getForProject(projectId, 'falsy', key);
      expect(entry?.value).toBe(value);
    }
  });

  it('overwriting a KV value floats it to the top of listEntries (newest-updated first)', async () => {
    // Create k1 then k2, then overwrite k1. The newest write is to k1, so a
    // "newest first" namespace read must surface k1 ahead of k2. The live index
    // (updatedAt DESC) already does; listEntries must agree for the same data.
    await service.putForProject(TEST_USER_ID, projectId, {
      namespace: 'kv',
      key: 'k1',
      value: 'first',
    });
    await service.putForProject(TEST_USER_ID, projectId, {
      namespace: 'kv',
      key: 'k2',
      value: 'second',
    });
    await service.putForProject(TEST_USER_ID, projectId, {
      namespace: 'kv',
      key: 'k1',
      value: 'first-updated',
    });

    const entries = await service.listEntriesForProject(projectId, 'kv');
    expect(entries.map((e) => e.key)).toEqual(['k1', 'k2']);

    const index = await service.getIndexForProject(projectId);
    expect(index.map((r) => r.key)).toEqual(['k1', 'k2']);
  });
});
