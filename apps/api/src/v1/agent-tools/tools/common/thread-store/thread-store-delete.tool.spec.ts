import type { ToolRunnableConfig } from '@langchain/core/tools';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { ThreadStoreService } from '../../../../thread-store/services/thread-store.service';
import { ThreadStoreDeleteTool } from './thread-store-delete.tool';

const THREAD_EXTERNAL_ID = 'graph-1:thread-1';
const THREAD_INTERNAL_ID = 'thread-1-db-id';

type ServiceMock = {
  resolveInternalThreadId: ReturnType<typeof vi.fn>;
  deleteForUser: ReturnType<typeof vi.fn>;
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

describe('ThreadStoreDeleteTool', () => {
  let tool: ThreadStoreDeleteTool;
  let service: ServiceMock;

  beforeEach(async () => {
    service = {
      resolveInternalThreadId: vi.fn().mockResolvedValue(THREAD_INTERNAL_ID),
      deleteForUser: vi.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadStoreDeleteTool,
        { provide: ThreadStoreService, useValue: service },
      ],
    }).compile();

    tool = module.get(ThreadStoreDeleteTool);
  });

  it('resolves the internal thread id and calls deleteForUser with correct args', async () => {
    const result = await tool.invoke(
      { namespace: 'todo', key: 'verify-migration' },
      {},
      buildCfg(),
    );

    expect(service.resolveInternalThreadId).toHaveBeenCalledWith(
      'user-1',
      PROJECT_ID,
      THREAD_EXTERNAL_ID,
    );
    expect(service.deleteForUser).toHaveBeenCalledWith(
      'user-1',
      PROJECT_ID,
      THREAD_INTERNAL_ID,
      'todo',
      'verify-migration',
    );
    expect(result.output).toEqual({ success: true });
  });

  it('rejects writes in read-only mode', async () => {
    await expect(
      tool.invoke(
        { namespace: 'todo', key: 'verify-migration' },
        { readOnly: true },
        buildCfg(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.deleteForUser).not.toHaveBeenCalled();
  });

  it('throws when thread_created_by is missing from the agent config', async () => {
    await expect(
      tool.invoke(
        { namespace: 'todo', key: 'verify-migration' },
        {},
        buildCfg({ thread_created_by: undefined }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when graph_project_id is missing from the agent config', async () => {
    await expect(
      tool.invoke(
        { namespace: 'todo', key: 'verify-migration' },
        {},
        buildCfg({ graph_project_id: undefined }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('prefers parent_thread_id over thread_id (subagent case)', async () => {
    await tool.invoke(
      { namespace: 'todo', key: 'verify-migration' },
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
      tool.invoke(
        { namespace: 'todo', key: 'verify-migration' },
        {},
        buildCfg(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
