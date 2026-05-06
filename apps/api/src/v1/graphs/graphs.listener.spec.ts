import { Test } from '@nestjs/testing';
import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphDao } from './dao/graph.dao';
import { GraphsListener } from './graphs.listener';

describe('GraphsListener', () => {
  let listener: GraphsListener;
  let graphDao: GraphDao;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        GraphsListener,
        { provide: GraphDao, useValue: { delete: vi.fn() } },
        { provide: DefaultLogger, useValue: { log: vi.fn(), error: vi.fn() } },
      ],
    }).compile();

    listener = module.get(GraphsListener);
    graphDao = module.get(GraphDao);
  });

  it('deletes graphs for the deleted project', async () => {
    vi.mocked(graphDao.delete).mockResolvedValue(undefined as never);

    await listener.onProjectDeleted({ projectId: 'p-1', userId: 'u-1' });

    expect(graphDao.delete).toHaveBeenCalledWith({
      projectId: 'p-1',
      createdBy: 'u-1',
    });
  });

  it('propagates DAO errors', async () => {
    vi.mocked(graphDao.delete).mockRejectedValue(new Error('DB failure'));

    await expect(
      listener.onProjectDeleted({ projectId: 'p-1', userId: 'u-1' }),
    ).rejects.toThrow('DB failure');
  });
});
