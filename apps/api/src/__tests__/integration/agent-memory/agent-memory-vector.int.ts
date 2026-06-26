import { ToolRunnableConfig } from '@langchain/core/tools';
import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../../environments';
import { AgentMemoryService } from '../../../v1/agent-memory/services/agent-memory.service';
import { MemoryAppendTool } from '../../../v1/agent-tools/tools/common/agent-memory/memory-append.tool';
import { MemorySaveTool } from '../../../v1/agent-tools/tools/common/agent-memory/memory-save.tool';
import { MemorySearchTool } from '../../../v1/agent-tools/tools/common/agent-memory/memory-search.tool';
import { BaseAgentConfigurable } from '../../../v1/agents/agents.types';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { getMockLlm } from '../mocks/mock-llm';
import { createTestModule, TEST_USER_ID } from '../setup';

/** Non-zero embed price so a "$0 means unattributed" regression is detectable. */
const EMBED_PRICE = 0.00042;

/**
 * Deterministic keyword->axis vectors. Cosine similarity is 1 for inputs that
 * land on the same axis and 0 otherwise, so a query and a memory that share a
 * keyword rank together regardless of embedding stubs. `padOrTruncate` in the
 * mock adapter pads these short vectors to the configured dimension count.
 */
const axisVector = (axis: number): number[] => {
  const v = new Array(8).fill(0);
  v[axis] = 1;
  return v;
};
const vectorFor = (input: string): number[] => {
  if (/postgres|database/i.test(input)) {
    return axisVector(0);
  }
  if (/react|frontend/i.test(input)) {
    return axisVector(1);
  }
  if (/deploy|kubernetes/i.test(input)) {
    return axisVector(2);
  }
  return axisVector(7);
};

const cfgFor = (
  projectId: string,
  agentName = 'node-1',
): ToolRunnableConfig<BaseAgentConfigurable> =>
  ({
    configurable: {
      graph_project_id: projectId,
      thread_created_by: TEST_USER_ID,
      node_id: agentName,
    },
  }) as unknown as ToolRunnableConfig<BaseAgentConfigurable>;

describe('Agent memory semantic recall (M2)', () => {
  let app: INestApplication;
  let service: AgentMemoryService;
  let projectsDao: ProjectsDao;
  let saveTool: MemorySaveTool;
  let appendTool: MemoryAppendTool;
  let searchTool: MemorySearchTool;
  let projectA: string;
  let projectB: string;

  // reset() clears the global applyDefaults fixtures, so this becomes the only
  // embeddings matcher. `{ model: /.*/ }` keeps specificity 1 (vs a bare `{}`) so
  // it still wins should a catch-all default ever be re-registered.
  const registerEmbeddings = (opts: { error?: boolean } = {}): void => {
    const mockLlm = getMockLlm(app);
    mockLlm.reset();
    if (opts.error) {
      mockLlm.onEmbeddings(
        { model: /.*/ },
        { kind: 'error', status: 500, message: 'embed boom' },
      );
      return;
    }
    mockLlm.onEmbeddings(
      { model: /.*/ },
      {
        kind: 'embeddings',
        vector: (input: string) => vectorFor(input),
        usage: {
          inputTokens: 12,
          outputTokens: 0,
          totalTokens: 12,
          totalPrice: EMBED_PRICE,
        },
      },
    );
  };

  beforeAll(async () => {
    app = await createTestModule();
    service = app.get(AgentMemoryService);
    projectsDao = app.get(ProjectsDao);
    saveTool = app.get(MemorySaveTool);
    appendTool = app.get(MemoryAppendTool);
    searchTool = app.get(MemorySearchTool);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Fresh project ids per test so vectors from a prior test (which live in the
    // shared Qdrant collection across the file) can never match this test's
    // project-filtered search.
    projectA = (
      await projectsDao.create({
        name: 'M2 Project A',
        createdBy: TEST_USER_ID,
        settings: {},
      })
    ).id;
    projectB = (
      await projectsDao.create({
        name: 'M2 Project B',
        createdBy: TEST_USER_ID,
        settings: {},
      })
    ).id;
    registerEmbeddings();
  });

  it('attributes embed-on-write cost to memory_save (no silent $0)', async () => {
    const result = await saveTool.invoke(
      {
        namespace: 'facts',
        key: 'db',
        value: 'We run Postgres for the database',
      },
      {},
      cfgFor(projectA),
    );

    expect(result.output).toMatchObject({ namespace: 'facts', key: 'db' });
    expect(result.toolRequestUsage?.totalPrice).toBe(EMBED_PRICE);
  });

  it('attributes embed-on-write cost to memory_append', async () => {
    const result = await appendTool.invoke(
      { namespace: 'learnings', value: 'Postgres handles our database load' },
      {},
      cfgFor(projectA),
    );

    expect(result.output.namespace).toBe('learnings');
    expect(result.toolRequestUsage?.totalPrice).toBe(EMBED_PRICE);
  });

  it('attributes the query-embedding cost to memory_search', async () => {
    await saveTool.invoke(
      { namespace: 'facts', key: 'db', value: 'Postgres is our database' },
      {},
      cfgFor(projectA),
    );

    // Re-register the embed fixture with a DISTINCT price so the assertion pins
    // the QUERY embed's own cost — not a stale write-path usage object that
    // happened to carry the same price.
    const SEARCH_PRICE = 0.00099;
    const mockLlm = getMockLlm(app);
    mockLlm.reset();
    mockLlm.onEmbeddings(
      { model: /.*/ },
      {
        kind: 'embeddings',
        vector: (input: string) => vectorFor(input),
        usage: {
          inputTokens: 5,
          outputTokens: 0,
          totalTokens: 5,
          totalPrice: SEARCH_PRICE,
        },
      },
    );

    const result = await searchTool.invoke(
      { query: 'which database engine do we use' },
      {},
      cfgFor(projectA),
    );

    expect(result.toolRequestUsage?.totalPrice).toBe(SEARCH_PRICE);
    expect(result.output.results.map((r) => r.key)).toContain('db');
  });

  it('returns only same-project entries (no cross-project leakage)', async () => {
    // Two project-A entries on the SAME axis the project-B query hits, so if the
    // projectId filter were removed they would rank into B's results — the exact
    // count assertion below then fails instead of passing vacuously.
    await saveTool.invoke(
      {
        namespace: 'facts',
        key: 'secret',
        value: 'Postgres database secret A',
      },
      {},
      cfgFor(projectA),
    );
    await saveTool.invoke(
      {
        namespace: 'facts',
        key: 'secret2',
        value: 'Postgres database secret A2',
      },
      {},
      cfgFor(projectA),
    );
    await saveTool.invoke(
      { namespace: 'facts', key: 'ownentry', value: 'Postgres database in B' },
      {},
      cfgFor(projectB),
    );

    const result = await searchTool.invoke(
      { query: 'database', limit: 50 },
      {},
      cfgFor(projectB),
    );

    const keys = result.output.results.map((r) => r.key);
    expect(keys).toEqual(['ownentry']);
    expect(keys).not.toContain('secret');
    expect(keys).not.toContain('secret2');
  });

  it('ranks the semantically-closest entry first', async () => {
    await saveTool.invoke(
      {
        namespace: 'facts',
        key: 'db',
        value: 'We run Postgres for the database',
      },
      {},
      cfgFor(projectA),
    );
    await saveTool.invoke(
      {
        namespace: 'facts',
        key: 'ui',
        value: 'The frontend is built with React',
      },
      {},
      cfgFor(projectA),
    );

    const result = await searchTool.invoke(
      { query: 'what database do we use', limit: 5 },
      {},
      cfgFor(projectA),
    );

    expect(result.output.results[0]?.key).toBe('db');
  });

  it('drops a deleted entry from semantic search', async () => {
    await saveTool.invoke(
      { namespace: 'facts', key: 'db', value: 'Postgres is the database' },
      {},
      cfgFor(projectA),
    );
    const before = await searchTool.invoke(
      { query: 'database' },
      {},
      cfgFor(projectA),
    );
    expect(before.output.results.map((r) => r.key)).toContain('db');

    await service.deleteForProject(projectA, 'facts', 'db');

    const after = await searchTool.invoke(
      { query: 'database' },
      {},
      cfgFor(projectA),
    );
    expect(after.output.results.map((r) => r.key)).not.toContain('db');
  });

  it('drops a pruned entry from semantic search', async () => {
    const mutableEnv = environment as {
      agentMemoryMaxEntriesPerNamespace: number;
    };
    const originalCap = mutableEnv.agentMemoryMaxEntriesPerNamespace;
    mutableEnv.agentMemoryMaxEntriesPerNamespace = 1;
    try {
      await saveTool.invoke(
        { namespace: 'caps', key: 'old', value: 'Postgres database one' },
        {},
        cfgFor(projectA),
      );
      // Saving a second entry pushes the namespace over cap 1, pruning 'old'
      // (oldest) — and its vector must be removed alongside the row.
      await saveTool.invoke(
        { namespace: 'caps', key: 'new', value: 'Postgres database two' },
        {},
        cfgFor(projectA),
      );

      expect(await service.getForProject(projectA, 'caps', 'old')).toBeNull();

      const result = await searchTool.invoke(
        { query: 'database' },
        {},
        cfgFor(projectA),
      );
      const keys = result.output.results.map((r) => r.key);
      expect(keys).toContain('new');
      expect(keys).not.toContain('old');
    } finally {
      mutableEnv.agentMemoryMaxEntriesPerNamespace = originalCap;
    }
  });

  it('persists the row and attributes no cost when the embed best-effort fails', async () => {
    registerEmbeddings({ error: true });

    const result = await saveTool.invoke(
      {
        namespace: 'facts',
        key: 'resilient',
        value: 'survives an embed failure',
      },
      {},
      cfgFor(projectA),
    );

    // The write committed despite the embed throwing; no bogus cost is attached
    // (undefined, never a NaN/0 placeholder).
    expect(result.output).toMatchObject({ key: 'resilient' });
    expect(result.toolRequestUsage).toBeUndefined();

    const entry = await service.getForProject(projectA, 'facts', 'resilient');
    expect(entry?.value).toBe('survives an embed failure');
  });

  it('persists an append row and attributes no cost when the embed fails', async () => {
    // appendForProject shares embedAndReconcileVectors with the save path, but
    // with a generated key + immutable mode — assert that path is best-effort too.
    registerEmbeddings({ error: true });

    const result = await appendTool.invoke(
      { namespace: 'learnings', value: 'append survives an embed failure' },
      {},
      cfgFor(projectA),
    );

    expect(result.toolRequestUsage).toBeUndefined();
    const entries = await service.listEntriesForProject(projectA, 'learnings');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe('append survives an embed failure');
  });
});
