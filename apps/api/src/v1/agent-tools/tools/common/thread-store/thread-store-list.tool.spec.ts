import type { ToolRunnableConfig } from '@langchain/core/tools';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { ThreadStoreService } from '../../../../thread-store/services/thread-store.service';
import { ThreadStoreEntryMode } from '../../../../thread-store/thread-store.types';
import { ThreadStoreListTool } from './thread-store-list.tool';

const THREAD_EXTERNAL_ID = 'graph-1:thread-1';
const THREAD_INTERNAL_ID = 'thread-1-db-id';

type ServiceMock = {
  resolveInternalThreadId: ReturnType<typeof vi.fn>;
  listEntriesForUser: ReturnType<typeof vi.fn>;
  listNamespacesForUser: ReturnType<typeof vi.fn>;
};

const PROJECT_ID = 'proj-1';

const buildCfg = (
  overrides: Partial<BaseAgentConfigurable> = {},
): ToolRunnableConfig<BaseAgentConfigurable> =>
  ({
    configurable: {
      thread_id: THREAD_EXTERNAL_ID,
      thread_created_by: 'user-1',
      graph_project_id: PROJECT_ID,
      node_id: 'agent-node',
      ...overrides,
    } as BaseAgentConfigurable,
  }) as ToolRunnableConfig<BaseAgentConfigurable>;

const makeEntry = (key: string) => ({
  id: `entry-${key}`,
  namespace: 'learnings',
  key,
  value: `value-${key}`,
  mode: ThreadStoreEntryMode.Append,
  authorAgentId: 'agent-node',
  tags: null,
  createdAt: '2026-04-20T10:00:00.000Z',
  updatedAt: '2026-04-20T10:00:00.000Z',
  threadId: THREAD_INTERNAL_ID,
});

const NAMESPACE_SUMMARIES = [
  {
    namespace: 'learnings',
    entryCount: 42,
    lastUpdatedAt: '2026-04-20T10:00:00.000Z',
  },
  {
    namespace: 'plan',
    entryCount: 3,
    lastUpdatedAt: '2026-04-20T09:00:00.000Z',
  },
];

describe('ThreadStoreListTool', () => {
  let tool: ThreadStoreListTool;
  let service: ServiceMock;

  beforeEach(async () => {
    service = {
      resolveInternalThreadId: vi.fn().mockResolvedValue(THREAD_INTERNAL_ID),
      listEntriesForUser: vi
        .fn()
        .mockResolvedValue([makeEntry('key-1'), makeEntry('key-2')]),
      listNamespacesForUser: vi.fn().mockResolvedValue(NAMESPACE_SUMMARIES),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadStoreListTool,
        { provide: ThreadStoreService, useValue: service },
      ],
    }).compile();

    tool = module.get(ThreadStoreListTool);
  });

  it('returns namespace summary when no namespace is provided', async () => {
    const result = await tool.invoke({}, {}, buildCfg());

    expect(service.listNamespacesForUser).toHaveBeenCalledWith(
      'user-1',
      PROJECT_ID,
      THREAD_INTERNAL_ID,
    );
    expect(service.listEntriesForUser).not.toHaveBeenCalled();
    expect(result.output).toEqual({ namespaces: NAMESPACE_SUMMARIES });
  });

  it('returns entries, totalCount, and truncated when namespace is provided', async () => {
    const result = await tool.invoke(
      { namespace: 'learnings', limit: 50 },
      {},
      buildCfg(),
    );

    expect(service.listEntriesForUser).toHaveBeenCalledWith(
      'user-1',
      PROJECT_ID,
      THREAD_INTERNAL_ID,
      'learnings',
      { limit: 50, offset: 0 },
    );
    expect(result.output.totalCount).toBe(42);
    expect(result.output.truncated).toBe(false);
    expect(result.output.entries).toHaveLength(2);
  });

  it('forwards offset to listEntriesForUser', async () => {
    await tool.invoke(
      { namespace: 'learnings', limit: 20, offset: 20 },
      {},
      buildCfg(),
    );

    expect(service.listEntriesForUser).toHaveBeenCalledWith(
      'user-1',
      PROJECT_ID,
      THREAD_INTERNAL_ID,
      'learnings',
      { limit: 20, offset: 20 },
    );
  });

  it('sets truncated = true when entries.length equals limit', async () => {
    const limit = 3;
    service.listEntriesForUser.mockResolvedValue([
      makeEntry('k1'),
      makeEntry('k2'),
      makeEntry('k3'),
    ]);

    const result = await tool.invoke(
      { namespace: 'learnings', limit },
      {},
      buildCfg(),
    );

    expect(result.output.truncated).toBe(true);
  });

  it('sets truncated = false when entries.length is less than limit', async () => {
    service.listEntriesForUser.mockResolvedValue([
      makeEntry('k1'),
      makeEntry('k2'),
    ]);

    const result = await tool.invoke(
      { namespace: 'learnings', limit: 10 },
      {},
      buildCfg(),
    );

    expect(result.output.truncated).toBe(false);
  });

  it('derives totalCount from the matching namespace summary', async () => {
    const result = await tool.invoke({ namespace: 'plan' }, {}, buildCfg());

    expect(result.output.totalCount).toBe(3);
  });

  it('throws when graph_project_id is missing from the agent config', async () => {
    await expect(
      tool.invoke(
        { namespace: 'learnings' },
        {},
        buildCfg({ graph_project_id: undefined }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when thread_created_by is missing from the agent config', async () => {
    await expect(
      tool.invoke(
        { namespace: 'learnings' },
        {},
        buildCfg({ thread_created_by: undefined }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('prefers parent_thread_id over thread_id (subagent case)', async () => {
    await tool.invoke(
      { namespace: 'learnings' },
      {},
      buildCfg({
        thread_id: 'subagent_abc',
        parent_thread_id: THREAD_EXTERNAL_ID,
      }),
    );

    expect(service.resolveInternalThreadId).toHaveBeenCalledWith(
      'user-1',
      PROJECT_ID,
      THREAD_EXTERNAL_ID,
    );
  });

  it('propagates NotFoundException when thread cannot be resolved', async () => {
    service.resolveInternalThreadId.mockRejectedValue(
      new NotFoundException('THREAD_NOT_FOUND'),
    );

    await expect(
      tool.invoke({ namespace: 'learnings' }, {}, buildCfg()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('falls back to entries.length for totalCount when namespace summary is absent', async () => {
    service.listNamespacesForUser.mockResolvedValue([]);
    service.listEntriesForUser.mockResolvedValue([
      makeEntry('k1'),
      makeEntry('k2'),
    ]);

    const result = await tool.invoke({ namespace: 'unknown' }, {}, buildCfg());

    expect(result.output.totalCount).toBe(2);
  });

  it('reports truncated=false when the last page is exactly limit entries with no more remaining', async () => {
    // Namespace has 30 entries total; caller requests offset=20, limit=10.
    // Service returns entries 21..30 (length = 10 == limit). No further entries
    // exist (totalCount === offset + entries.length), so the result is NOT
    // truncated — there is nothing more for the agent to fetch.
    const limit = 10;
    const offset = 20;
    const totalEntriesInNamespace = 30;

    service.listEntriesForUser.mockResolvedValue(
      Array.from({ length: limit }, (_, i) => makeEntry(`k${offset + i}`)),
    );
    service.listNamespacesForUser.mockResolvedValue([
      {
        namespace: 'learnings',
        entryCount: totalEntriesInNamespace,
        lastUpdatedAt: '2026-04-20T10:00:00.000Z',
      },
    ]);

    const result = await tool.invoke(
      { namespace: 'learnings', limit, offset },
      {},
      buildCfg(),
    );

    expect(result.output.entries).toHaveLength(limit);
    expect(result.output.totalCount).toBe(totalEntriesInNamespace);
    // Agent should NOT be told to paginate further when the page exactly
    // exhausted the namespace.
    expect(result.output.truncated).toBe(false);
  });
});
