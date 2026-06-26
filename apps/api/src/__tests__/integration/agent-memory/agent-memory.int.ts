import { ToolRunnableConfig } from '@langchain/core/tools';
import { INestApplication } from '@nestjs/common';
import { BadRequestException } from '@packages/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../../environments';
import { AgentMemoryEntryMode } from '../../../v1/agent-memory/agent-memory.types';
import { AgentMemoryDao } from '../../../v1/agent-memory/dao/agent-memory.dao';
import { AgentMemoryService } from '../../../v1/agent-memory/services/agent-memory.service';
import { MemoryAppendTool } from '../../../v1/agent-tools/tools/common/agent-memory/memory-append.tool';
import { MemoryDeleteTool } from '../../../v1/agent-tools/tools/common/agent-memory/memory-delete.tool';
import { MemoryGetTool } from '../../../v1/agent-tools/tools/common/agent-memory/memory-get.tool';
import { MemoryListTool } from '../../../v1/agent-tools/tools/common/agent-memory/memory-list.tool';
import { MemorySaveTool } from '../../../v1/agent-tools/tools/common/agent-memory/memory-save.tool';
import { BaseAgentConfigurable } from '../../../v1/agents/agents.types';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { createTestModule, TEST_USER_ID } from '../setup';

const cfgFor = (
  projectId: string | undefined,
  agentName = 'node-1',
): ToolRunnableConfig<BaseAgentConfigurable> =>
  ({
    configurable: {
      graph_project_id: projectId,
      thread_created_by: TEST_USER_ID,
      node_id: agentName,
    },
  }) as unknown as ToolRunnableConfig<BaseAgentConfigurable>;

describe('Agent memory integration', () => {
  let app: INestApplication;
  let service: AgentMemoryService;
  let dao: AgentMemoryDao;
  let projectsDao: ProjectsDao;
  let saveTool: MemorySaveTool;
  let getTool: MemoryGetTool;
  let listTool: MemoryListTool;
  let appendTool: MemoryAppendTool;
  let deleteTool: MemoryDeleteTool;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    app = await createTestModule();
    service = app.get(AgentMemoryService);
    dao = app.get(AgentMemoryDao);
    projectsDao = app.get(ProjectsDao);
    saveTool = app.get(MemorySaveTool);
    getTool = app.get(MemoryGetTool);
    listTool = app.get(MemoryListTool);
    appendTool = app.get(MemoryAppendTool);
    deleteTool = app.get(MemoryDeleteTool);

    projectA = (
      await projectsDao.create({
        name: 'Agent Memory Project A',
        createdBy: TEST_USER_ID,
        settings: {},
      })
    ).id;
    projectB = (
      await projectsDao.create({
        name: 'Agent Memory Project B',
        createdBy: TEST_USER_ID,
        settings: {},
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dao.hardDelete({ projectId: projectA });
    await dao.hardDelete({ projectId: projectB });
  });

  it('round-trips a saved key/value memory', async () => {
    await service.putForProject(TEST_USER_ID, projectA, {
      namespace: 'facts',
      key: 'pm',
      value: 'pnpm, not npm',
      title: 'Package manager',
      tags: ['build'],
    });

    const entry = await service.getForProject(projectA, 'facts', 'pm');
    expect(entry?.value).toBe('pnpm, not npm');
    expect(entry?.title).toBe('Package manager');
    expect(entry?.tags).toEqual(['build']);
  });

  it('overwrites in place on a repeated key without adding a row', async () => {
    await service.putForProject(TEST_USER_ID, projectA, {
      namespace: 'facts',
      key: 'pm',
      value: 'v1',
    });
    await service.putForProject(TEST_USER_ID, projectA, {
      namespace: 'facts',
      key: 'pm',
      value: 'v2',
    });

    const entry = await service.getForProject(projectA, 'facts', 'pm');
    expect(entry?.value).toBe('v2');
    expect(await dao.countForNamespace(projectA, 'facts')).toBe(1);
  });

  it('isolates memory per project — A is invisible to B', async () => {
    await service.putForProject(TEST_USER_ID, projectA, {
      namespace: 'facts',
      key: 'secret',
      value: 'project-A-only',
    });

    expect(await service.getForProject(projectB, 'facts', 'secret')).toBeNull();
    expect(await service.listNamespacesForProject(projectB)).toHaveLength(0);
    expect(
      await service.getForProject(projectA, 'facts', 'secret'),
    ).not.toBeNull();
  });

  it('accumulates append-mode entries', async () => {
    for (const note of ['one', 'two', 'three']) {
      await service.appendForProject(TEST_USER_ID, projectA, {
        namespace: 'learnings',
        value: note,
      });
    }
    const entries = await service.listEntriesForProject(projectA, 'learnings');
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.value)).toEqual(['one', 'two', 'three']);
  });

  it('is a shared brain: a different author can overwrite an entry', async () => {
    await service.putForProject(TEST_USER_ID, projectA, {
      namespace: 'plan',
      key: 'root',
      value: 'draft',
      authorAgentId: 'Engineer',
    });
    const updated = await service.putForProject(TEST_USER_ID, projectA, {
      namespace: 'plan',
      key: 'root',
      value: 'revised',
      authorAgentId: 'Reviewer',
    });

    expect(updated.value).toBe('revised');
    expect(updated.authorAgentId).toBe('Reviewer');
    expect(await dao.countForNamespace(projectA, 'plan')).toBe(1);
  });

  it('returns a live index (titles/keys/tags, no bodies) for the project', async () => {
    await service.putForProject(TEST_USER_ID, projectA, {
      namespace: 'facts',
      key: 'pm',
      value: 'a-large-body-that-should-not-appear-in-the-index',
      title: 'Package manager',
      tags: ['build'],
    });

    const index = await service.getIndexForProject(projectA);
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({
      namespace: 'facts',
      key: 'pm',
      title: 'Package manager',
      tags: ['build'],
    });
    expect(index[0]).not.toHaveProperty('value');
  });

  it('deletes a KV entry but refuses to delete an append entry', async () => {
    await service.putForProject(TEST_USER_ID, projectA, {
      namespace: 'facts',
      key: 'pm',
      value: 'v',
    });
    await service.deleteForProject(projectA, 'facts', 'pm');
    expect(await service.getForProject(projectA, 'facts', 'pm')).toBeNull();

    const appended = await service.appendForProject(TEST_USER_ID, projectA, {
      namespace: 'learnings',
      value: 'immutable',
    });
    await expect(
      service.deleteForProject(projectA, 'learnings', appended.key),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an oversized value', async () => {
    const huge = 'x'.repeat(33 * 1024);
    await expect(
      service.putForProject(TEST_USER_ID, projectA, {
        namespace: 'facts',
        key: 'big',
        value: huge,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('prunes the oldest entries over the namespace cap, keeping the newest', async () => {
    // Drive a small cap so the prune fires on a handful of rows instead of 500.
    // `environment` is the shared resolved singleton the service reads at call
    // time. Its properties are `as const` (compile-time readonly) but the
    // resolved object is a plain, non-frozen literal at runtime, so a mutable
    // view lets the test override one cap and restore it in finally — the
    // override never bleeds into later tests in this file.
    const mutableEnv = environment as {
      agentMemoryMaxEntriesPerNamespace: number;
    };
    const originalCap = mutableEnv.agentMemoryMaxEntriesPerNamespace;
    mutableEnv.agentMemoryMaxEntriesPerNamespace = 2;
    try {
      // Seed three KV rows with distinct, increasing updatedAt straight through
      // the DAO. DAO writes do NOT trigger prune, so the namespace can sit
      // over-cap until the next *service* write. Oldest -> newest: a, b, c.
      const seedAt = async (key: string, updatedAt: Date): Promise<void> => {
        await dao.upsertKvEntry({
          projectId: projectA,
          namespace: 'capped',
          key,
          value: key,
          mode: AgentMemoryEntryMode.Kv,
          createdBy: TEST_USER_ID,
          updatedAt,
        });
      };
      await seedAt('a', new Date('2020-01-01T00:00:00Z'));
      await seedAt('b', new Date('2020-01-02T00:00:00Z'));
      await seedAt('c', new Date('2020-01-03T00:00:00Z'));

      // A service put runs pruneToCapacity. After inserting 'd' (freshest, its
      // updatedAt is now) the namespace holds 4 > cap 2, so the 2 oldest by
      // updatedAt (a, b) are pruned and the 2 newest (c, d) survive — proving
      // findOldest's `updatedAt ASC` victim ordering against a real DB and that
      // the just-written entry is never selected.
      await service.putForProject(TEST_USER_ID, projectA, {
        namespace: 'capped',
        key: 'd',
        value: 'd',
      });

      expect(await dao.countForNamespace(projectA, 'capped')).toBe(2);
      expect(await service.getForProject(projectA, 'capped', 'a')).toBeNull();
      expect(await service.getForProject(projectA, 'capped', 'b')).toBeNull();
      expect(
        await service.getForProject(projectA, 'capped', 'c'),
      ).not.toBeNull();
      expect(
        await service.getForProject(projectA, 'capped', 'd'),
      ).not.toBeNull();
    } finally {
      mutableEnv.agentMemoryMaxEntriesPerNamespace = originalCap;
    }
  });

  it('writes from an agent tool WITHOUT a thread (project scope only)', async () => {
    const result = await saveTool.invoke(
      { namespace: 'facts', key: 'tooled', value: 'written-by-tool' },
      {},
      cfgFor(projectA),
    );
    expect(result.output).toMatchObject({ namespace: 'facts', key: 'tooled' });

    const fetched = await getTool.invoke(
      { namespace: 'facts', key: 'tooled' },
      {},
      cfgFor(projectA),
    );
    expect(fetched.output?.value).toBe('written-by-tool');

    // memory_list reflects the just-written entry (live read).
    const listed = await listTool.invoke({}, {}, cfgFor(projectA));
    expect(listed.output.entries.map((e) => e.key)).toContain('tooled');
  });

  it('throws when the agent config carries no project id', async () => {
    await expect(
      saveTool.invoke(
        { namespace: 'facts', key: 'k', value: 'v' },
        {},
        cfgFor(undefined),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stamps the author agent id from the tool config', async () => {
    await saveTool.invoke(
      { namespace: 'facts', key: 'authored', value: 'v' },
      {},
      cfgFor(projectA, 'Engineer'),
    );
    const entry = await service.getForProject(projectA, 'facts', 'authored');
    expect(entry?.authorAgentId).toBe('Engineer');
  });

  it('resurrects a soft-deleted KV key on re-put (no duplicate, fresh value)', async () => {
    await service.putForProject(TEST_USER_ID, projectA, {
      namespace: 'facts',
      key: 'pm',
      value: 'v1',
    });
    await service.deleteForProject(projectA, 'facts', 'pm');
    expect(await service.getForProject(projectA, 'facts', 'pm')).toBeNull();

    await service.putForProject(TEST_USER_ID, projectA, {
      namespace: 'facts',
      key: 'pm',
      value: 'v2',
    });

    const entry = await service.getForProject(projectA, 'facts', 'pm');
    expect(entry?.value).toBe('v2');
    expect(await dao.countForNamespace(projectA, 'facts')).toBe(1);
  });

  it('deletes a KV entry via the tool but refuses an append entry', async () => {
    await saveTool.invoke(
      { namespace: 'facts', key: 'tdel', value: 'v' },
      {},
      cfgFor(projectA),
    );
    const result = await deleteTool.invoke(
      { namespace: 'facts', key: 'tdel' },
      {},
      cfgFor(projectA),
    );
    expect(result.output).toMatchObject({ key: 'tdel', deleted: true });
    expect(await service.getForProject(projectA, 'facts', 'tdel')).toBeNull();

    const appended = await appendTool.invoke(
      { namespace: 'learnings', value: 'immutable' },
      {},
      cfgFor(projectA),
    );
    await expect(
      deleteTool.invoke(
        { namespace: 'learnings', key: appended.output.key },
        {},
        cfgFor(projectA),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stamps the author agent id on an append written via the tool', async () => {
    await appendTool.invoke(
      { namespace: 'learnings', value: 'noted' },
      {},
      cfgFor(projectA, 'Reviewer'),
    );
    const entries = await service.listEntriesForProject(projectA, 'learnings');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.authorAgentId).toBe('Reviewer');
  });
});
