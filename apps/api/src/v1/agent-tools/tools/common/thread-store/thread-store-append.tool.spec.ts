import type { ToolRunnableConfig } from '@langchain/core/tools';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { ThreadStoreService } from '../../../../thread-store/services/thread-store.service';
import { ThreadStoreEntryMode } from '../../../../thread-store/thread-store.types';
import { ThreadStoreAppendTool } from './thread-store-append.tool';

const THREAD_EXTERNAL_ID = 'graph-1:thread-1';
const THREAD_INTERNAL_ID = 'thread-1-db-id';

type ServiceMock = {
  resolveInternalThreadId: ReturnType<typeof vi.fn>;
  appendForUser: ReturnType<typeof vi.fn>;
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

describe('ThreadStoreAppendTool', () => {
  let tool: ThreadStoreAppendTool;
  let service: ServiceMock;

  beforeEach(async () => {
    service = {
      resolveInternalThreadId: vi.fn().mockResolvedValue(THREAD_INTERNAL_ID),
      appendForUser: vi.fn().mockResolvedValue({
        id: 'entry-1',
        namespace: 'learnings',
        key: '2026-04-20T10:00:00.000Z-abc12345',
        value: 'the build step requires NODE_OPTIONS',
        mode: ThreadStoreEntryMode.Append,
        authorAgentId: 'agent-node',
        tags: null,
        createdAt: '2026-04-20T10:00:00.000Z',
        updatedAt: '2026-04-20T10:00:00.000Z',
        threadId: THREAD_INTERNAL_ID,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadStoreAppendTool,
        { provide: ThreadStoreService, useValue: service },
      ],
    }).compile();

    tool = module.get(ThreadStoreAppendTool);
  });

  it('resolves the internal thread id and calls appendForUser with correct args', async () => {
    const result = await tool.invoke(
      { namespace: 'learnings', value: 'the build step requires NODE_OPTIONS' },
      {},
      buildCfg(),
    );

    expect(service.resolveInternalThreadId).toHaveBeenCalledWith(
      'user-1',
      PROJECT_ID,
      THREAD_EXTERNAL_ID,
    );
    expect(service.appendForUser).toHaveBeenCalledWith(
      'user-1',
      PROJECT_ID,
      THREAD_INTERNAL_ID,
      expect.objectContaining({
        namespace: 'learnings',
        value: 'the build step requires NODE_OPTIONS',
        authorAgentId: 'agent-node',
      }),
    );
    expect(result.output).toEqual({
      id: 'entry-1',
      namespace: 'learnings',
      key: '2026-04-20T10:00:00.000Z-abc12345',
    });
  });

  it('rejects writes in read-only mode', async () => {
    await expect(
      tool.invoke(
        { namespace: 'learnings', value: 'x' },
        { readOnly: true },
        buildCfg(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.appendForUser).not.toHaveBeenCalled();
  });

  it('throws when thread_created_by is missing from the agent config', async () => {
    await expect(
      tool.invoke(
        { namespace: 'learnings', value: 'x' },
        {},
        buildCfg({ thread_created_by: undefined }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when graph_project_id is missing from the agent config', async () => {
    await expect(
      tool.invoke(
        { namespace: 'learnings', value: 'x' },
        {},
        buildCfg({ graph_project_id: undefined }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('prefers parent_thread_id over thread_id (subagent case)', async () => {
    await tool.invoke(
      { namespace: 'learnings', value: 'subagent finding' },
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
      tool.invoke({ namespace: 'learnings', value: 'x' }, {}, buildCfg()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
