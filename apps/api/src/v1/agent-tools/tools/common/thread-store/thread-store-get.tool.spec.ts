import type { ToolRunnableConfig } from '@langchain/core/tools';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { ThreadStoreService } from '../../../../thread-store/services/thread-store.service';
import { ThreadStoreEntryMode } from '../../../../thread-store/thread-store.types';
import { ThreadStoreGetTool } from './thread-store-get.tool';

const THREAD_EXTERNAL_ID = 'graph-1:thread-1';
const THREAD_INTERNAL_ID = 'thread-1-db-id';

type ServiceMock = {
  resolveInternalThreadId: ReturnType<typeof vi.fn>;
  getForUser: ReturnType<typeof vi.fn>;
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

const MOCK_ENTRY = {
  id: 'entry-1',
  namespace: 'plan',
  key: 'root',
  value: { steps: ['a', 'b'] },
  mode: ThreadStoreEntryMode.Kv,
  authorAgentId: 'agent-node',
  tags: ['important'],
  createdAt: '2026-04-20T10:00:00.000Z',
  updatedAt: '2026-04-20T10:00:00.000Z',
  threadId: THREAD_INTERNAL_ID,
};

describe('ThreadStoreGetTool', () => {
  let tool: ThreadStoreGetTool;
  let service: ServiceMock;

  beforeEach(async () => {
    service = {
      resolveInternalThreadId: vi.fn().mockResolvedValue(THREAD_INTERNAL_ID),
      getForUser: vi.fn().mockResolvedValue(MOCK_ENTRY),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadStoreGetTool,
        { provide: ThreadStoreService, useValue: service },
      ],
    }).compile();

    tool = module.get(ThreadStoreGetTool);
  });

  it('resolves the internal thread id and returns the mapped entry', async () => {
    const result = await tool.invoke(
      { namespace: 'plan', key: 'root' },
      {},
      buildCfg(),
    );

    expect(service.resolveInternalThreadId).toHaveBeenCalledWith(
      'user-1',
      PROJECT_ID,
      THREAD_EXTERNAL_ID,
    );
    expect(service.getForUser).toHaveBeenCalledWith(
      'user-1',
      PROJECT_ID,
      THREAD_INTERNAL_ID,
      'plan',
      'root',
    );
    expect(result.output).toEqual({
      found: true,
      entry: {
        namespace: 'plan',
        key: 'root',
        value: MOCK_ENTRY.value,
        mode: ThreadStoreEntryMode.Kv,
        authorAgentId: 'agent-node',
        tags: ['important'],
        createdAt: '2026-04-20T10:00:00.000Z',
        updatedAt: '2026-04-20T10:00:00.000Z',
      },
    });
  });

  it('returns { found: false } when the entry does not exist', async () => {
    service.getForUser.mockResolvedValue(null);

    const result = await tool.invoke(
      { namespace: 'plan', key: 'missing-key' },
      {},
      buildCfg(),
    );

    expect(result.output).toEqual({ found: false });
  });

  it('throws when thread_created_by is missing from the agent config', async () => {
    await expect(
      tool.invoke(
        { namespace: 'plan', key: 'root' },
        {},
        buildCfg({ thread_created_by: undefined }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when graph_project_id is missing from the agent config', async () => {
    await expect(
      tool.invoke(
        { namespace: 'plan', key: 'root' },
        {},
        buildCfg({ graph_project_id: undefined }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('prefers parent_thread_id over thread_id (subagent case)', async () => {
    await tool.invoke(
      { namespace: 'plan', key: 'root' },
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
      tool.invoke({ namespace: 'plan', key: 'root' }, {}, buildCfg()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
