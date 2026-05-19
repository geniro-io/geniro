import type { ToolRunnableConfig } from '@langchain/core/tools';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { ThreadStoreService } from '../../../../thread-store/services/thread-store.service';
import { ThreadStoreEntryMode } from '../../../../thread-store/thread-store.types';
import { ThreadStorePutTool } from './thread-store-put.tool';

const THREAD_EXTERNAL_ID = 'graph-1:thread-1';
const THREAD_INTERNAL_ID = 'thread-1-db-id';

type ServiceMock = {
  resolveInternalThreadId: ReturnType<typeof vi.fn>;
  putForUser: ReturnType<typeof vi.fn>;
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

describe('ThreadStorePutTool', () => {
  let tool: ThreadStorePutTool;
  let service: ServiceMock;

  beforeEach(async () => {
    service = {
      resolveInternalThreadId: vi.fn().mockResolvedValue(THREAD_INTERNAL_ID),
      putForUser: vi.fn().mockResolvedValue({
        id: 'entry-1',
        namespace: 'plan',
        key: 'root',
        value: { ok: true },
        mode: ThreadStoreEntryMode.Kv,
        authorAgentId: 'agent-node',
        tags: null,
        createdAt: '2026-04-19T10:00:00Z',
        updatedAt: '2026-04-19T10:00:00Z',
        threadId: THREAD_INTERNAL_ID,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadStorePutTool,
        { provide: ThreadStoreService, useValue: service },
      ],
    }).compile();

    tool = module.get(ThreadStorePutTool);
  });

  it('resolves the internal thread id and stamps author agent from node id', async () => {
    const result = await tool.invoke(
      { namespace: 'plan', key: 'root', value: { ok: true } },
      {},
      buildCfg(),
    );

    expect(service.resolveInternalThreadId).toHaveBeenCalledWith(
      'user-1',
      PROJECT_ID,
      THREAD_EXTERNAL_ID,
    );
    expect(service.putForUser).toHaveBeenCalledWith(
      'user-1',
      PROJECT_ID,
      THREAD_INTERNAL_ID,
      expect.objectContaining({
        namespace: 'plan',
        key: 'root',
        authorAgentId: 'agent-node',
      }),
    );
    expect(result.output).toEqual({
      id: 'entry-1',
      namespace: 'plan',
      key: 'root',
    });
  });

  it('prefers parent_thread_id (subagent case) when set', async () => {
    await tool.invoke(
      { namespace: 'plan', key: 'root', value: 'x' },
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

  it('rejects writes in read-only mode', async () => {
    await expect(
      tool.invoke(
        { namespace: 'plan', key: 'root', value: 'x' },
        { readOnly: true },
        buildCfg(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.putForUser).not.toHaveBeenCalled();
  });

  it('throws when thread_created_by is missing from the agent config', async () => {
    await expect(
      tool.invoke(
        { namespace: 'plan', key: 'root', value: 'x' },
        {},
        buildCfg({ thread_created_by: undefined }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('persists authorAgentId from caller_agent.getConfig().name when getConfig succeeds', async () => {
    const callerAgent = {
      getConfig: vi.fn(() => ({ name: 'MySubagent' })),
    };

    await tool.invoke(
      { namespace: 'ns', key: 'k', value: 'v' },
      {},
      buildCfg({
        caller_agent:
          callerAgent as unknown as Required<BaseAgentConfigurable>['caller_agent'],
      }),
    );

    expect(service.putForUser).toHaveBeenCalledWith(
      'user-1',
      PROJECT_ID,
      THREAD_INTERNAL_ID,
      expect.objectContaining({ authorAgentId: 'MySubagent' }),
    );
  });

  it('falls back to node_id author when caller_agent.getConfig() throws (e.g. uninitialized agent config)', async () => {
    // Agents emit `getConfig()` throwing 'Agent config not initialized' when
    // the framework instantiates the agent shell before the LangGraph runtime
    // has populated currentConfig. The tool runs in that window for some
    // subagent boot orderings, and we don't want a put() call from an agent
    // to crash with an opaque 'Agent config not initialized' just because we
    // were trying to label authorship — the write should succeed with the
    // node_id (or 'unknown-agent') label as a fallback.
    const callerAgent = {
      getConfig: vi.fn(() => {
        throw new Error('Agent config not initialized');
      }),
    };

    const result = await tool.invoke(
      { namespace: 'plan', key: 'root', value: { ok: true } },
      {},
      // Cast required: caller_agent is typed as BaseAgent but we only need
      // the getConfig() shape that resolveContext touches.
      buildCfg({
        caller_agent:
          callerAgent as unknown as Required<BaseAgentConfigurable>['caller_agent'],
      }),
    );

    expect(result.output).toEqual({
      id: 'entry-1',
      namespace: 'plan',
      key: 'root',
    });
    expect(service.putForUser).toHaveBeenCalledWith(
      'user-1',
      PROJECT_ID,
      THREAD_INTERNAL_ID,
      expect.objectContaining({
        // Falls back to node_id from the config when caller_agent metadata
        // is unavailable.
        authorAgentId: 'agent-node',
      }),
    );
  });
});
