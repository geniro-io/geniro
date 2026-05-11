import type { QdrantClient } from '@qdrant/js-client-rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockClient: MockQdrantClient;

vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: class {
    constructor() {
      return mockClient as unknown as QdrantClient;
    }
  },
}));

vi.mock('../../../environments', () => ({
  environment: {
    qdrantUrl: 'http://localhost:6333',
    qdrantApiKey: undefined,
  },
}));

import { DefaultLogger } from '@packages/common';

import { QdrantService } from './qdrant.service';

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as DefaultLogger;

type MockQdrantClient = {
  getCollections: ReturnType<typeof vi.fn>;
  getCollection: ReturnType<typeof vi.fn>;
  createCollection: ReturnType<typeof vi.fn>;
  deleteCollection: ReturnType<typeof vi.fn>;
  createPayloadIndex: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  searchBatch: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
  scroll: ReturnType<typeof vi.fn>;
};

describe('QdrantService', () => {
  let service: QdrantService;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      getCollections: vi.fn().mockResolvedValue({
        collections: [
          { name: 'test-collection' },
          { name: 'knowledge_chunks' },
        ],
      }),
      getCollection: vi.fn().mockResolvedValue({
        config: { params: { vectors: { size: 2 } } },
      }),
      createCollection: vi.fn(),
      deleteCollection: vi.fn(),
      createPayloadIndex: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      search: vi.fn(),
      searchBatch: vi.fn(),
      retrieve: vi.fn(),
      scroll: vi.fn(),
    };

    service = new QdrantService(mockLogger);
  });

  it('upserts points', async () => {
    await service.upsertPoints('test-collection', [
      { id: 'chunk-1', vector: [0.1, 0.2], payload: { docId: 'doc-1' } },
    ]);

    expect(mockClient.upsert).toHaveBeenCalledWith('test-collection', {
      wait: true,
      points: [
        { id: 'chunk-1', vector: [0.1, 0.2], payload: { docId: 'doc-1' } },
      ],
    });
  });

  it('deletes by filter', async () => {
    await service.deleteByFilter('test-collection', {
      must: [{ key: 'docId', match: { value: 'doc-1' } }],
    });

    expect(mockClient.delete).toHaveBeenCalledWith('test-collection', {
      wait: true,
      filter: {
        must: [{ key: 'docId', match: { value: 'doc-1' } }],
      },
    });
  });

  it('returns raw search results', async () => {
    mockClient.search.mockResolvedValue([
      { id: 'chunk-1', score: 0.9 },
      { id: 2, score: 0.7 },
    ]);

    const results = await service.searchPoints(
      'knowledge_chunks',
      [0.1, 0.2],
      5,
    );

    expect(results).toEqual([
      { id: 'chunk-1', score: 0.9 },
      { id: 2, score: 0.7 },
    ]);
  });

  it('returns raw batch results', async () => {
    mockClient.searchBatch.mockResolvedValue([
      [{ id: 'chunk-1', score: 0.9 }],
      [{ id: 'chunk-2', score: 0.6 }],
    ]);

    const results = await service.searchMany('knowledge_chunks', [
      { vector: [0.1, 0.2], limit: 2 },
      { vector: [0.3, 0.4], limit: 2 },
    ]);

    expect(results).toEqual([
      [{ id: 'chunk-1', score: 0.9 }],
      [{ id: 'chunk-2', score: 0.6 }],
    ]);
  });

  it('returns raw retrieve results', async () => {
    mockClient.retrieve.mockResolvedValue([{ id: 'chunk-1' }]);

    const results = await service.retrievePoints('knowledge_chunks', {
      ids: ['chunk-1'],
      with_payload: true,
    });

    expect(results).toEqual([{ id: 'chunk-1' }]);
  });

  it('scrolls through points', async () => {
    mockClient.scroll
      .mockResolvedValueOnce({
        points: [{ id: 'chunk-1' }],
        next_page_offset: 2,
      })
      .mockResolvedValueOnce({
        points: [{ id: 'chunk-2' }],
        next_page_offset: null,
      });

    const results = await service.scrollAll('knowledge_chunks', {
      filter: { must: [{ key: 'docId', match: { value: 'doc-1' } }] },
    } as Parameters<QdrantService['scrollAll']>[1]);

    expect(results).toEqual([{ id: 'chunk-1' }, { id: 'chunk-2' }]);
  });

  it('lists all collections', async () => {
    const result = await service.getCollections();

    expect(mockClient.getCollections).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      collections: [{ name: 'test-collection' }, { name: 'knowledge_chunks' }],
    });
  });

  describe('knownCollections cache', () => {
    it('skips getCollection on second call after ensureCollection succeeds', async () => {
      // First call: collection exists (getCollection succeeds, returns size 2)
      await service.ensureCollection('cached-col', 2);
      expect(mockClient.getCollection).toHaveBeenCalledTimes(2); // once for collectionExists, once for getCollectionVectorSize

      // Reset the call count
      mockClient.getCollection.mockClear();

      // Second call with same collection — should hit the knownCollections cache
      await service.deleteByFilter('cached-col', {
        must: [{ key: 'x', match: { value: 'y' } }],
      });
      expect(mockClient.getCollection).not.toHaveBeenCalled();
    });

    it('caches collection after createCollection for new collections', async () => {
      // getCollection throws "not found" so ensureCollection creates the collection
      mockClient.getCollection.mockRejectedValueOnce(
        new Error('Collection not found'),
      );

      await service.ensureCollection('brand-new-col', 5);
      expect(mockClient.createCollection).toHaveBeenCalled();
      mockClient.getCollection.mockClear();

      // Subsequent call should skip getCollection — collection is cached
      await service.deleteByFilter('brand-new-col', {
        must: [{ key: 'x', match: { value: 'y' } }],
      });
      expect(mockClient.getCollection).not.toHaveBeenCalled();
    });

    it('does not cache non-existent collections', async () => {
      // getCollection throws "not found" — collectionExists returns false
      mockClient.getCollection.mockRejectedValue(
        new Error('Collection not found'),
      );

      // deleteByFilter checks existence first; should return without calling delete
      await service.deleteByFilter('does-not-exist', {
        must: [{ key: 'x', match: { value: 'y' } }],
      });
      expect(mockClient.delete).not.toHaveBeenCalled();
      expect(mockClient.getCollection).toHaveBeenCalledTimes(1);

      // Second call should NOT be cached — must call getCollection again
      await service.deleteByFilter('does-not-exist', {
        must: [{ key: 'x', match: { value: 'y' } }],
      });
      expect(mockClient.getCollection).toHaveBeenCalledTimes(2);
    });
  });

  describe('ensureCollection – vector size mismatch', () => {
    it('drops and recreates the collection when vector size changes', async () => {
      // Existing collection has size 2 (from default getCollection mock)
      await service.ensureCollection('resized-col', 5);

      expect(mockClient.deleteCollection).toHaveBeenCalledWith('resized-col');
      expect(mockClient.createCollection).toHaveBeenCalledWith('resized-col', {
        vectors: { size: 5, distance: 'Cosine' },
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('vector size changed (2 → 5)'),
      );
    });

    it('caches the new size after recreating', async () => {
      await service.ensureCollection('resized-col', 5);
      mockClient.getCollection.mockClear();
      mockClient.deleteCollection.mockClear();
      mockClient.createCollection.mockClear();

      // Second call with same size should hit cache — no Qdrant calls
      await service.ensureCollection('resized-col', 5);
      expect(mockClient.getCollection).not.toHaveBeenCalled();
      expect(mockClient.deleteCollection).not.toHaveBeenCalled();
      expect(mockClient.createCollection).not.toHaveBeenCalled();
    });
  });

  describe('isCollectionNotFoundError', () => {
    it('matches Qdrant "Collection not found" errors', () => {
      expect(
        QdrantService.isCollectionNotFoundError(
          new Error('Collection my_col not found'),
        ),
      ).toBe(true);
    });

    it('matches Qdrant "Collection does not exist" errors', () => {
      expect(
        QdrantService.isCollectionNotFoundError(
          new Error('Collection my_col does not exist'),
        ),
      ).toBe(true);
    });

    it('matches "doesn\'t exist" errors', () => {
      expect(
        QdrantService.isCollectionNotFoundError(
          new Error("Collection my_col doesn't exist"),
        ),
      ).toBe(true);
    });

    it('does not match unrelated "not found" errors', () => {
      expect(
        QdrantService.isCollectionNotFoundError(new Error('User not found')),
      ).toBe(false);
    });

    it('does not match unrelated "does not exist" errors', () => {
      expect(
        QdrantService.isCollectionNotFoundError(
          new Error('File does not exist'),
        ),
      ).toBe(false);
    });

    it('does not match unrelated "doesn\'t exist" errors', () => {
      expect(
        QdrantService.isCollectionNotFoundError(
          new Error("Schema doesn't exist"),
        ),
      ).toBe(false);
    });

    it('does not match generic errors', () => {
      expect(
        QdrantService.isCollectionNotFoundError(
          new Error('Connection timeout'),
        ),
      ).toBe(false);
    });

    it('matches bare "Not Found" from Qdrant REST 404', () => {
      expect(
        QdrantService.isCollectionNotFoundError(new Error('Not Found')),
      ).toBe(true);
    });

    it('handles non-Error values', () => {
      expect(
        QdrantService.isCollectionNotFoundError('Collection my_col not found'),
      ).toBe(true);
      expect(QdrantService.isCollectionNotFoundError('Something else')).toBe(
        false,
      );
    });
  });

  describe('ensurePayloadIndex', () => {
    it('returns silently and invalidates cache when collection vanished mid-call', async () => {
      // Prime the cache so collectionExists() returns true without hitting Qdrant.
      await service.ensureCollection('test-collection', 2);
      mockClient.getCollection.mockClear();

      mockClient.createPayloadIndex.mockRejectedValueOnce(
        new Error('Not Found'),
      );

      await expect(
        service.ensurePayloadIndex('test-collection', 'repo_id', 'keyword'),
      ).resolves.toBeUndefined();

      // Cache invalidated → next collectionExists call hits getCollection again.
      mockClient.getCollection.mockResolvedValueOnce({
        config: { params: { vectors: { size: 2 } } },
      });
      await service.ensureCollection('test-collection', 2);
      expect(mockClient.getCollection).toHaveBeenCalled();
    });

    it('swallows "already exists" errors', async () => {
      await service.ensureCollection('test-collection', 2);
      mockClient.createPayloadIndex.mockRejectedValueOnce(
        new Error('field index repo_id already exists'),
      );

      await expect(
        service.ensurePayloadIndex('test-collection', 'repo_id', 'keyword'),
      ).resolves.toBeUndefined();
    });

    it('rethrows unexpected errors', async () => {
      await service.ensureCollection('test-collection', 2);
      mockClient.createPayloadIndex.mockRejectedValueOnce(
        new Error('Unauthorized'),
      );

      await expect(
        service.ensurePayloadIndex('test-collection', 'repo_id', 'keyword'),
      ).rejects.toThrow('Unauthorized');
    });
  });

  describe('isAlreadyExistsError', () => {
    it('matches "field index already exists" errors', () => {
      expect(
        QdrantService.isAlreadyExistsError(
          new Error('field index repo_id already exists'),
        ),
      ).toBe(true);
    });

    it('matches "Collection already exists" errors', () => {
      expect(
        QdrantService.isAlreadyExistsError(
          new Error('Collection my_col already exists'),
        ),
      ).toBe(true);
    });

    it('does not match unrelated "already exists" errors', () => {
      expect(
        QdrantService.isAlreadyExistsError(new Error('User already exists')),
      ).toBe(false);
    });

    it('does not match generic errors', () => {
      expect(
        QdrantService.isAlreadyExistsError(new Error('Connection timeout')),
      ).toBe(false);
    });
  });

  describe('isTransientError', () => {
    it.each([
      'fetch failed',
      'TypeError: fetch failed',
      'connect ECONNREFUSED 127.0.0.1:6333',
      'read ECONNRESET',
      'connect ETIMEDOUT 10.0.0.1:6333',
      'socket hang up',
      'network error',
      'write EPIPE',
      'getaddrinfo ENOTFOUND qdrant.example.com',
    ])('detects transient error: "%s"', (msg) => {
      expect(QdrantService.isTransientError(new Error(msg))).toBe(true);
    });

    it.each([
      'Collection not found',
      'Connection timeout',
      'Unauthorized',
      'Bad request',
      'field index repo_id already exists',
    ])('rejects non-transient error: "%s"', (msg) => {
      expect(QdrantService.isTransientError(new Error(msg))).toBe(false);
    });

    it('handles non-Error values', () => {
      expect(QdrantService.isTransientError('fetch failed')).toBe(true);
      expect(QdrantService.isTransientError('Something else')).toBe(false);
    });
  });

  describe('withRetry (via upsertPoints)', () => {
    it('succeeds on first attempt without retrying', async () => {
      await service.upsertPoints('test-collection', [
        { id: 'p1', vector: [0.1, 0.2], payload: {} },
      ]);

      expect(mockClient.upsert).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('retries on transient error and succeeds', async () => {
      mockClient.upsert
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce(undefined);

      await service.upsertPoints('test-collection', [
        { id: 'p1', vector: [0.1, 0.2], payload: {} },
      ]);

      expect(mockClient.upsert).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Qdrant upsert failed, retrying'),
        expect.objectContaining({ attempt: 1, maxRetries: 2 }),
      );
    });

    it('throws immediately on non-transient error without retrying', async () => {
      mockClient.upsert.mockRejectedValueOnce(
        new Error('Collection not found'),
      );

      await expect(
        service.upsertPoints('test-collection', [
          { id: 'p1', vector: [0.1, 0.2], payload: {} },
        ]),
      ).rejects.toThrow('Collection not found');

      expect(mockClient.upsert).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('throws after exhausting all retries on transient errors', async () => {
      const transientErr = new Error('fetch failed');
      mockClient.upsert.mockRejectedValue(transientErr);

      await expect(
        service.upsertPoints('test-collection', [
          { id: 'p1', vector: [0.1, 0.2], payload: {} },
        ]),
      ).rejects.toThrow('fetch failed');

      // 1 initial + 2 retries = 3 total attempts
      expect(mockClient.upsert).toHaveBeenCalledTimes(3);
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('withRetry (via deleteByFilter)', () => {
    it('retries delete on transient error and succeeds', async () => {
      mockClient.delete
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce(undefined);

      await service.deleteByFilter('test-collection', {
        must: [{ key: 'docId', match: { value: 'doc-1' } }],
      });

      expect(mockClient.delete).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Qdrant delete failed, retrying'),
        expect.objectContaining({ attempt: 1 }),
      );
    });
  });

  describe('deleteCollection', () => {
    it('should call client.deleteCollection and invalidate both caches', async () => {
      // Pre-populate caches by ensuring a collection
      await service.ensureCollection('del-col', 2);
      mockClient.getCollection.mockClear();

      await service.deleteCollection('del-col');

      expect(mockClient.deleteCollection).toHaveBeenCalledWith('del-col');

      // Verify caches were invalidated: a subsequent collectionExists call
      // should hit getCollection again (not be served from knownCollections cache)
      await service.deleteByFilter('del-col', {
        must: [{ key: 'x', match: { value: 'y' } }],
      });
      expect(mockClient.getCollection).toHaveBeenCalled();
    });

    it('should swallow "collection not found" errors (idempotent)', async () => {
      mockClient.deleteCollection.mockRejectedValueOnce(
        new Error('Collection my_col not found'),
      );

      await expect(service.deleteCollection('my_col')).resolves.toBeUndefined();
    });

    it('should rethrow non-"collection not found" errors', async () => {
      mockClient.deleteCollection.mockRejectedValueOnce(
        new Error('Connection timeout'),
      );

      await expect(service.deleteCollection('my_col')).rejects.toThrow(
        'Connection timeout',
      );
    });

    it('should invalidate cache even when an error is thrown (finally block)', async () => {
      // Pre-populate caches
      await service.ensureCollection('err-col', 2);
      mockClient.getCollection.mockClear();

      mockClient.deleteCollection.mockRejectedValueOnce(
        new Error('Connection timeout'),
      );

      await expect(service.deleteCollection('err-col')).rejects.toThrow(
        'Connection timeout',
      );

      // Cache should still be invalidated — getCollection must be called again
      await service.deleteByFilter('err-col', {
        must: [{ key: 'x', match: { value: 'y' } }],
      });
      expect(mockClient.getCollection).toHaveBeenCalled();
    });
  });

  describe('ensurePayloadIndex', () => {
    it('creates a payload index on an existing collection', async () => {
      await service.ensurePayloadIndex('test-collection', 'repo_id', 'keyword');

      expect(mockClient.createPayloadIndex).toHaveBeenCalledWith(
        'test-collection',
        { field_name: 'repo_id', field_schema: 'keyword' },
      );
    });

    it('silently succeeds when the index already exists', async () => {
      mockClient.createPayloadIndex.mockRejectedValueOnce(
        new Error('field index repo_id already exists'),
      );

      await expect(
        service.ensurePayloadIndex('test-collection', 'repo_id', 'keyword'),
      ).resolves.toBeUndefined();
    });

    it('rethrows non-"already exists" errors', async () => {
      mockClient.createPayloadIndex.mockRejectedValueOnce(
        new Error('Connection timeout'),
      );

      await expect(
        service.ensurePayloadIndex('test-collection', 'repo_id', 'keyword'),
      ).rejects.toThrow('Connection timeout');
    });

    it('skips when collection does not exist', async () => {
      mockClient.getCollection.mockRejectedValue(
        new Error('Collection test-missing not found'),
      );

      await service.ensurePayloadIndex('test-missing', 'repo_id', 'keyword');

      // createPayloadIndex exists on mockClient only if set up — ensure it was NOT called
      expect(mockClient.createPayloadIndex).not.toHaveBeenCalled();
    });
  });
});
