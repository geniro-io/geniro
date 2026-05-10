import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KnowledgeDocDao } from '../../../../knowledge/dao/knowledge-doc.dao';
import { KnowledgeChunksService } from '../../../../knowledge/services/knowledge-chunks.service';
import { KnowledgeSearchChunksTool } from './knowledge-search-chunks.tool';

describe('KnowledgeSearchChunksTool', () => {
  let tool: KnowledgeSearchChunksTool;
  let docDao: { getAll: ReturnType<typeof vi.fn> };
  let knowledgeChunksService: { searchChunks: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    docDao = { getAll: vi.fn() };
    knowledgeChunksService = { searchChunks: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KnowledgeSearchChunksTool,
        { provide: KnowledgeDocDao, useValue: docDao },
        { provide: KnowledgeChunksService, useValue: knowledgeChunksService },
      ],
    }).compile();

    tool = await module.resolve(KnowledgeSearchChunksTool);
  });

  it('returns top chunks with snippets', async () => {
    docDao.getAll.mockResolvedValue([{ id: 'doc-1', publicId: 101 }]);
    knowledgeChunksService.searchChunks.mockResolvedValue([
      {
        id: 'chunk-1',
        docId: 'doc-1',
        publicId: 501,
        score: 0.91,
        text: 'This section covers rate limits and quotas.',
        snippet: 'This section covers rate limits and quotas.',
      },
    ]);

    const result = await tool.invoke(
      { docIds: [101], query: 'rate limits', topK: 3 },
      {},
      {
        configurable: { graph_created_by: 'user-1', thread_id: 'thread-1' },
      },
    );

    expect(docDao.getAll).toHaveBeenCalledWith(
      { createdBy: 'user-1', publicId: { $in: [101] } },
      { fields: ['id', 'publicId', 'tags'], orderBy: { updatedAt: 'DESC' } },
    );
    expect(knowledgeChunksService.searchChunks).toHaveBeenCalledWith({
      docIds: ['doc-1'],
      query: 'rate limits',
      topK: 3,
    });
    expect(result.output).toHaveLength(1);
    expect(result.output[0]?.chunkPublicId).toBe(501);
    expect(result.output[0]?.snippet.toLowerCase()).toContain('rate limits');
  });
});
