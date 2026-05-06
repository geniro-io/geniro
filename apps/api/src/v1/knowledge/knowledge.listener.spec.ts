import { Test } from '@nestjs/testing';
import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KnowledgeDocDao } from './dao/knowledge-doc.dao';
import { KnowledgeListener } from './knowledge.listener';

describe('KnowledgeListener', () => {
  let listener: KnowledgeListener;
  let knowledgeDocDao: KnowledgeDocDao;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        KnowledgeListener,
        { provide: KnowledgeDocDao, useValue: { delete: vi.fn() } },
        { provide: DefaultLogger, useValue: { log: vi.fn(), error: vi.fn() } },
      ],
    }).compile();

    listener = module.get(KnowledgeListener);
    knowledgeDocDao = module.get(KnowledgeDocDao);
  });

  it('deletes knowledge docs for the deleted project', async () => {
    vi.mocked(knowledgeDocDao.delete).mockResolvedValue(undefined as never);

    await listener.onProjectDeleted({ projectId: 'p-1', userId: 'u-1' });

    expect(knowledgeDocDao.delete).toHaveBeenCalledWith({
      projectId: 'p-1',
      createdBy: 'u-1',
    });
  });

  it('propagates DAO errors', async () => {
    vi.mocked(knowledgeDocDao.delete).mockRejectedValue(
      new Error('DB failure'),
    );

    await expect(
      listener.onProjectDeleted({ projectId: 'p-1', userId: 'u-1' }),
    ).rejects.toThrow('DB failure');
  });
});
