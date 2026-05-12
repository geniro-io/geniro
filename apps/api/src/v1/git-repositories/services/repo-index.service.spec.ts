import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GitTokenResolverService } from '../../git-auth/services/git-token-resolver.service';
import { LlmModelsService } from '../../litellm/services/llm-models.service';
import { OpenaiService } from '../../openai/openai.service';
import { QdrantService } from '../../qdrant/services/qdrant.service';
import { RuntimeInstanceDao } from '../../runtime/dao/runtime-instance.dao';
import { RuntimeProvider } from '../../runtime/services/runtime-provider';
import { GitRepositoriesDao } from '../dao/git-repositories.dao';
import { RepoIndexDao } from '../dao/repo-index.dao';
import { RepoIndexEntity } from '../entity/repo-index.entity';
import { RepoIndexStatus } from '../git-repositories.types';
import { RepoIndexService } from './repo-index.service';
import { RepoIndexQueueService } from './repo-index-queue.service';
import {
  JobCancelledException,
  RepoExecFn,
  RepoIndexerService,
} from './repo-indexer.service';

vi.mock('../../../environments', () => ({
  environment: {
    codebaseIndexTokenThreshold: 30000,
    codebaseUuidNamespace: '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
    codebaseIndexMaxAgeDays: 30,
    codebaseIndexStaleMs: 2 * 60 * 1000,
    codebaseSearchOverfetchFactor: 6,
    codebaseSearchOverfetchFactorWithVariants: 3,
    llmEmbeddingDimensions: 1536,
  },
}));

const mockRepoIndexDao = {
  getOne: vi.fn(),
  getById: vi.fn(),
  getAll: vi.fn().mockResolvedValue([]), // For recoverStuckJobs & cleanupOrphanedIndexes
  create: vi.fn(),
  updateById: vi.fn(),
  deleteById: vi.fn().mockResolvedValue(undefined),
  incrementIndexedTokens: vi.fn().mockResolvedValue(undefined),
  withIndexLock: vi
    .fn()
    .mockImplementation(
      (_repoId: string, _branch: string, cb: () => Promise<unknown>) => cb(),
    ),
};

const mockGitRepositoriesDao = {
  getOne: vi.fn(),
};

const mockGitTokenResolverService = {
  resolveToken: vi.fn().mockResolvedValue(null),
};

const mockRepoIndexerService = {
  estimateTokenCount: vi.fn().mockResolvedValue(100),
  estimateChangedTokenCount: vi.fn().mockResolvedValue(100),
  resolveCurrentCommit: vi.fn().mockResolvedValue('abc123'),
  getCurrentBranch: vi.fn().mockResolvedValue('main'),
  getChunkingSignatureHash: vi.fn().mockReturnValue('sig-hash-123'),
  deriveRepoId: vi.fn((url: string) => url),
  deriveRepoSlug: vi.fn().mockReturnValue('my_repo'),
  buildCollectionName: vi.fn().mockReturnValue('codebase_my_repo_main_1536'),
  calculateIndexMetadata: vi.fn().mockResolvedValue({
    embeddingModel: 'text-embedding-3-small',
    vectorSize: 1536,
    chunkingSignatureHash: 'sig-hash-123',
    repoSlug: 'my_repo',
    collection: 'codebase_my_repo_main_1536',
  }),
  copyCollectionPoints: vi.fn().mockResolvedValue(0),
  runFullIndex: vi.fn().mockResolvedValue(undefined),
  runIncrementalIndex: vi.fn().mockResolvedValue(undefined),
  countIndexedTokens: vi.fn().mockResolvedValue(5000),
  buildRepoFilter: vi.fn().mockImplementation((repoId: string) => ({
    must: [{ key: 'repo_id', match: { value: repoId } }],
  })),
};

const mockRepoIndexQueueService = {
  setCallbacks: vi.fn(),
  addIndexJob: vi.fn().mockResolvedValue(undefined),
  removeJob: vi.fn().mockResolvedValue(undefined),
  cleanStaleActiveJobs: vi.fn().mockResolvedValue(undefined),
  getJobState: vi.fn().mockResolvedValue(null),
};

const mockLlmModelsService = {
  getKnowledgeEmbeddingModel: vi.fn().mockReturnValue('text-embedding-3-small'),
  getKnowledgeSearchModel: vi.fn().mockReturnValue('gpt-5-mini'),
};

const mockOpenaiService = {};
const mockQdrantService = {
  getCollections: vi.fn().mockResolvedValue({ collections: [] }),
  deleteCollection: vi.fn().mockResolvedValue(undefined),
};
const mockRuntimeProvider = {
  provide: vi.fn(),
  getDefaultRuntimeType: vi.fn().mockReturnValue('docker'),
};
const mockRuntimeInstanceDao = {
  getOne: vi.fn(),
  updateById: vi.fn(),
};

const mockLogger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

const execFn: RepoExecFn = vi.fn().mockResolvedValue({
  exitCode: 0,
  stdout: '',
  stderr: '',
});

describe('RepoIndexService', () => {
  let service: RepoIndexService;

  beforeEach(async () => {
    vi.resetAllMocks();
    // Restore default mock implementations after reset
    mockRepoIndexDao.getAll.mockResolvedValue([]);
    mockRepoIndexDao.deleteById.mockResolvedValue(undefined);
    mockRepoIndexDao.incrementIndexedTokens.mockResolvedValue(undefined);
    mockRepoIndexDao.withIndexLock.mockImplementation(
      (_repoId: string, _branch: string, cb: () => Promise<unknown>) => cb(),
    );
    mockRepoIndexerService.estimateTokenCount.mockResolvedValue(100);
    mockRepoIndexerService.estimateChangedTokenCount.mockResolvedValue(100);
    mockRepoIndexerService.resolveCurrentCommit.mockResolvedValue('abc123');
    mockRepoIndexerService.getCurrentBranch.mockResolvedValue('main');
    mockRepoIndexerService.getChunkingSignatureHash.mockReturnValue(
      'sig-hash-123',
    );
    mockRepoIndexerService.deriveRepoId.mockImplementation(
      (url: string) => url,
    );
    mockRepoIndexerService.deriveRepoSlug.mockReturnValue('my_repo');
    mockRepoIndexerService.buildCollectionName.mockReturnValue(
      'codebase_my_repo_main_1536',
    );
    mockRepoIndexerService.calculateIndexMetadata.mockResolvedValue({
      embeddingModel: 'text-embedding-3-small',
      vectorSize: 1536,
      chunkingSignatureHash: 'sig-hash-123',
      repoSlug: 'my_repo',
      collection: 'codebase_my_repo_main_1536',
    });
    mockRepoIndexerService.copyCollectionPoints.mockResolvedValue(0);
    mockRepoIndexerService.runFullIndex.mockResolvedValue(undefined);
    mockRepoIndexerService.runIncrementalIndex.mockResolvedValue(undefined);
    mockRepoIndexerService.buildRepoFilter.mockImplementation(
      (repoId: string) => ({
        must: [{ key: 'repo_id', match: { value: repoId } }],
      }),
    );
    mockRepoIndexQueueService.addIndexJob.mockResolvedValue(undefined);
    mockRepoIndexQueueService.removeJob.mockResolvedValue(undefined);
    mockRepoIndexQueueService.getJobState.mockResolvedValue(null);
    mockQdrantService.getCollections.mockResolvedValue({ collections: [] });
    mockQdrantService.deleteCollection.mockResolvedValue(undefined);
    mockLlmModelsService.getKnowledgeEmbeddingModel.mockReturnValue(
      'text-embedding-3-small',
    );
    mockGitTokenResolverService.resolveToken.mockResolvedValue(null);
    mockRuntimeProvider.getDefaultRuntimeType.mockReturnValue('docker');
    service = new RepoIndexService(
      mockRepoIndexDao as unknown as RepoIndexDao,
      mockGitRepositoriesDao as unknown as GitRepositoriesDao,
      mockGitTokenResolverService as unknown as GitTokenResolverService,
      mockRepoIndexerService as unknown as RepoIndexerService,
      mockRepoIndexQueueService as unknown as RepoIndexQueueService,
      mockLlmModelsService as unknown as LlmModelsService,
      mockOpenaiService as unknown as OpenaiService,
      mockQdrantService as unknown as QdrantService,
      mockRuntimeProvider as unknown as RuntimeProvider,
      mockRuntimeInstanceDao as unknown as RuntimeInstanceDao,
      mockLogger as unknown as DefaultLogger,
    );
    await service.onModuleInit();
  });

  describe('getOrInitIndexForRepo', () => {
    const baseParams = {
      repositoryId: 'repo-uuid',
      repoUrl: 'https://github.com/owner/repo',
      repoRoot: '/workspace/repo',
      branch: 'main',
      execFn,
    };

    it('returns ready when index is completed and up-to-date', async () => {
      const existingEntity = {
        id: 'index-1',
        status: RepoIndexStatus.Completed,
        lastIndexedCommit: 'abc123',
        embeddingModel: 'text-embedding-3-small',
        vectorSize: 1536,
        chunkingSignatureHash: 'sig-hash-123',
      } as unknown as RepoIndexEntity;

      mockRepoIndexDao.getOne.mockResolvedValue(existingEntity);

      const result = await service.getOrInitIndexForRepo(baseParams);

      expect(result.status).toBe('ready');
      expect(mockRepoIndexerService.runFullIndex).not.toHaveBeenCalled();
      expect(mockRepoIndexQueueService.addIndexJob).not.toHaveBeenCalled();
    });

    it('returns in_progress when entity status is in_progress', async () => {
      const existingEntity = {
        id: 'index-1',
        status: RepoIndexStatus.InProgress,
        updatedAt: new Date(),
      } as unknown as RepoIndexEntity;

      mockRepoIndexDao.getOne.mockResolvedValue(existingEntity);

      const result = await service.getOrInitIndexForRepo(baseParams);

      expect(result.status).toBe('in_progress');
      expect(mockRepoIndexerService.runFullIndex).not.toHaveBeenCalled();
    });

    it('returns in_progress when entity status is pending', async () => {
      const existingEntity = {
        id: 'index-1',
        status: RepoIndexStatus.Pending,
        updatedAt: new Date(),
      } as unknown as RepoIndexEntity;

      mockRepoIndexDao.getOne.mockResolvedValue(existingEntity);

      const result = await service.getOrInitIndexForRepo(baseParams);

      expect(result.status).toBe('in_progress');
      expect(mockRepoIndexQueueService.addIndexJob).not.toHaveBeenCalled();
    });

    it('runs inline indexing when estimated tokens are below threshold', async () => {
      mockRepoIndexDao.getOne.mockResolvedValueOnce(null); // no existing index for branch
      // Donor query now uses getAll (defaults to []) — no getOne mock needed
      mockRepoIndexerService.estimateTokenCount.mockResolvedValue(1000); // below 30000
      mockRepoIndexDao.create.mockResolvedValue({
        id: 'new-index',
        status: RepoIndexStatus.InProgress,
      } as unknown as RepoIndexEntity);

      const result = await service.getOrInitIndexForRepo(baseParams);

      expect(result.status).toBe('ready');
      expect(mockRepoIndexerService.runFullIndex).toHaveBeenCalled();
      expect(mockRepoIndexQueueService.addIndexJob).not.toHaveBeenCalled();
      expect(mockRepoIndexDao.updateById).toHaveBeenCalledWith(
        'new-index',
        expect.objectContaining({ status: RepoIndexStatus.Completed }),
      );
    });

    it('enqueues background job when estimated tokens exceed threshold', async () => {
      mockRepoIndexDao.getOne.mockResolvedValueOnce(null); // no existing index for branch
      // Donor query now uses getAll (defaults to []) — no getOne mock needed
      mockRepoIndexerService.estimateTokenCount.mockResolvedValue(50000); // above 30000
      mockRepoIndexDao.create.mockResolvedValue({
        id: 'new-index',
        status: RepoIndexStatus.InProgress, // claimIndexSlot creates with InProgress
      } as unknown as RepoIndexEntity);

      const result = await service.getOrInitIndexForRepo(baseParams);

      expect(result.status).toBe('pending');
      expect(mockRepoIndexQueueService.addIndexJob).toHaveBeenCalledWith(
        expect.objectContaining({ repoIndexId: 'new-index', branch: 'main' }),
      );
      expect(mockRepoIndexerService.runFullIndex).not.toHaveBeenCalled();
      // Verify entity was switched from InProgress to Pending for background job
      expect(mockRepoIndexDao.updateById).toHaveBeenCalledWith(
        'new-index',
        expect.objectContaining({ status: RepoIndexStatus.Pending }),
      );
    });

    it('runs incremental index when only commit changed', async () => {
      const existingEntity = {
        id: 'index-1',
        status: RepoIndexStatus.Completed,
        lastIndexedCommit: 'old-commit',
        embeddingModel: 'text-embedding-3-small',
        vectorSize: 1536,
        chunkingSignatureHash: 'sig-hash-123',
      } as unknown as RepoIndexEntity;

      mockRepoIndexDao.getOne.mockResolvedValue(existingEntity);
      // For incremental, estimateChangedTokenCount is used instead of estimateTokenCount
      mockRepoIndexerService.estimateChangedTokenCount.mockResolvedValue(1000);
      mockRepoIndexDao.updateById.mockResolvedValue(1);
      mockRepoIndexDao.getById.mockResolvedValue(existingEntity);

      const result = await service.getOrInitIndexForRepo(baseParams);

      expect(result.status).toBe('ready');
      expect(mockRepoIndexerService.runIncrementalIndex).toHaveBeenCalled();
      expect(mockRepoIndexerService.runFullIndex).not.toHaveBeenCalled();
      // Verify that estimateChangedTokenCount was called for incremental
      expect(
        mockRepoIndexerService.estimateChangedTokenCount,
      ).toHaveBeenCalled();
    });

    it('sets entity to failed on inline indexing error', async () => {
      mockRepoIndexDao.getOne.mockResolvedValueOnce(null); // no existing index for branch
      // Donor query now uses getAll (defaults to []) — no getOne mock needed
      mockRepoIndexerService.estimateTokenCount.mockResolvedValue(1000);
      mockRepoIndexerService.runFullIndex.mockRejectedValue(
        new Error('embed failed'),
      );
      mockRepoIndexDao.create.mockResolvedValue({
        id: 'new-index',
        status: RepoIndexStatus.InProgress,
      } as unknown as RepoIndexEntity);

      await expect(service.getOrInitIndexForRepo(baseParams)).rejects.toThrow(
        'embed failed',
      );

      expect(mockRepoIndexDao.updateById).toHaveBeenCalledWith(
        'new-index',
        expect.objectContaining({
          status: RepoIndexStatus.Failed,
          errorMessage: 'embed failed',
        }),
      );
    });

    it('re-enqueues when pending row is older than staleness window', async () => {
      const existingEntity = {
        id: 'stale-index',
        status: RepoIndexStatus.Pending,
        indexedTokens: 0,
        estimatedTokens: 1444254,
        updatedAt: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000),
        repoUrl: baseParams.repoUrl,
        branch: baseParams.branch,
      } as unknown as RepoIndexEntity;

      mockRepoIndexDao.getOne.mockResolvedValue(existingEntity);

      const callOrder: string[] = [];
      mockRepoIndexQueueService.addIndexJob.mockImplementation(async () => {
        callOrder.push('addIndexJob');
      });
      mockRepoIndexDao.updateById.mockImplementation(async () => {
        callOrder.push('updateById');
        return 1;
      });

      const result = await service.getOrInitIndexForRepo(baseParams);

      expect(result.status).toBe('in_progress');
      expect(mockRepoIndexDao.updateById).toHaveBeenCalledWith('stale-index', {
        status: RepoIndexStatus.Pending,
        errorMessage: null,
      });
      expect(mockRepoIndexQueueService.addIndexJob).toHaveBeenCalledWith({
        repoIndexId: 'stale-index',
        repoUrl: baseParams.repoUrl,
        branch: baseParams.branch,
      });
      expect(callOrder).toEqual(['addIndexJob', 'updateById']);
    });

    it('does not re-enqueue when pending row is within staleness window', async () => {
      const existingEntity = {
        id: 'fresh-index',
        status: RepoIndexStatus.Pending,
        indexedTokens: 0,
        estimatedTokens: 1000,
        updatedAt: new Date(Date.now() - 60_000),
        repoUrl: baseParams.repoUrl,
        branch: baseParams.branch,
      } as unknown as RepoIndexEntity;

      mockRepoIndexDao.getOne.mockResolvedValue(existingEntity);

      const result = await service.getOrInitIndexForRepo(baseParams);

      expect(result.status).toBe('in_progress');
      expect(mockRepoIndexQueueService.addIndexJob).not.toHaveBeenCalled();
    });

    it('re-enqueues when InProgress row is older than staleness window', async () => {
      const existingEntity = {
        id: 'stale-inprogress-index',
        status: RepoIndexStatus.InProgress,
        indexedTokens: 500_000,
        estimatedTokens: 1_444_254,
        updatedAt: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000),
        repoUrl: baseParams.repoUrl,
        branch: baseParams.branch,
      } as unknown as RepoIndexEntity;

      mockRepoIndexDao.getOne.mockResolvedValue(existingEntity);

      const result = await service.getOrInitIndexForRepo(baseParams);

      expect(result.status).toBe('in_progress');
      expect(mockRepoIndexDao.updateById).toHaveBeenCalledWith(
        'stale-inprogress-index',
        {
          status: RepoIndexStatus.Pending,
          errorMessage: null,
        },
      );
      expect(mockRepoIndexQueueService.addIndexJob).toHaveBeenCalledWith({
        repoIndexId: 'stale-inprogress-index',
        repoUrl: baseParams.repoUrl,
        branch: baseParams.branch,
      });
    });

    it('does not re-enqueue stale pending row when BullMQ job is still active', async () => {
      const existingEntity = {
        id: 'active-stale-index',
        status: RepoIndexStatus.Pending,
        indexedTokens: 100_000,
        estimatedTokens: 1_444_254,
        updatedAt: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000),
        repoUrl: baseParams.repoUrl,
        branch: baseParams.branch,
      } as unknown as RepoIndexEntity;

      mockRepoIndexDao.getOne.mockResolvedValue(existingEntity);
      mockRepoIndexQueueService.getJobState.mockResolvedValue('active');

      const result = await service.getOrInitIndexForRepo(baseParams);

      expect(result.status).toBe('in_progress');
      expect(mockRepoIndexQueueService.addIndexJob).not.toHaveBeenCalled();
      expect(mockRepoIndexDao.updateById).not.toHaveBeenCalledWith(
        'active-stale-index',
        expect.objectContaining({ status: RepoIndexStatus.Pending }),
      );
    });

    it('does not re-enqueue stale InProgress row when BullMQ job is still active', async () => {
      const existingEntity = {
        id: 'active-stale-inprogress',
        status: RepoIndexStatus.InProgress,
        indexedTokens: 500_000,
        estimatedTokens: 1_444_254,
        updatedAt: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000),
        repoUrl: baseParams.repoUrl,
        branch: baseParams.branch,
      } as unknown as RepoIndexEntity;

      mockRepoIndexDao.getOne.mockResolvedValue(existingEntity);
      mockRepoIndexQueueService.getJobState.mockResolvedValue('active');

      const result = await service.getOrInitIndexForRepo(baseParams);

      expect(result.status).toBe('in_progress');
      expect(mockRepoIndexQueueService.addIndexJob).not.toHaveBeenCalled();
      expect(mockRepoIndexDao.updateById).not.toHaveBeenCalledWith(
        'active-stale-inprogress',
        expect.objectContaining({ status: RepoIndexStatus.Pending }),
      );
    });

    it('retries the repair on the next call when the first repair fails without refreshing updatedAt', async () => {
      // The repair path calls addIndexJob FIRST and only runs updateById on
      // success. If addIndexJob rejects (Redis flaky), updateById is never
      // reached so updatedAt is NOT bumped. The row remains semantically stale
      // (old updatedAt, status Pending), so the next call will detect it as
      // stale again and retry the repair once Redis recovers.
      //
      // The updateById mock below still bumps updatedAt to simulate MikroORM's
      // @Property onUpdate behaviour — it fires on the second (successful) call
      // only, confirming the repair completes cleanly on retry.
      // This test exercises the end-to-end retry promise.
      const STALE_MS = 21 * 24 * 60 * 60 * 1000;
      const existingEntity = {
        id: 'repair-retry-index',
        status: RepoIndexStatus.Pending,
        indexedTokens: 0,
        estimatedTokens: 1_444_254,
        updatedAt: new Date(Date.now() - STALE_MS),
        repoUrl: baseParams.repoUrl,
        branch: baseParams.branch,
      } as unknown as RepoIndexEntity;

      // MikroORM-faithful: persistence bumps updatedAt.
      mockRepoIndexDao.updateById.mockImplementation(
        async (
          _id: string,
          patch: Partial<RepoIndexEntity>,
        ): Promise<number> => {
          Object.assign(existingEntity, patch, { updatedAt: new Date() });
          return 1;
        },
      );
      mockRepoIndexDao.getOne.mockResolvedValue(existingEntity);
      mockRepoIndexQueueService.getJobState.mockResolvedValue(null);

      // First call: Redis is flaky — addIndexJob rejects. The repair attempt
      // is intentionally swallowed by the try/catch; the caller is told
      // "in_progress" and is expected to retry on the next interaction.
      mockRepoIndexQueueService.addIndexJob.mockRejectedValueOnce(
        new Error('ECONNREFUSED — redis down'),
      );

      const first = await service.getOrInitIndexForRepo(baseParams);
      expect(first.status).toBe('in_progress');
      expect(mockRepoIndexQueueService.addIndexJob).toHaveBeenCalledTimes(1);

      // Second call (next user interaction). Redis has recovered:
      // addIndexJob succeeds. The repair path MUST retry — the row is still
      // semantically stale (status Pending, updatedAt not bumped because the
      // first repair short-circuited before updateById).
      mockRepoIndexQueueService.addIndexJob.mockResolvedValueOnce(undefined);

      const second = await service.getOrInitIndexForRepo(baseParams);
      expect(second.status).toBe('in_progress');
      // The promise made in the inline comment: the next call retries.
      expect(mockRepoIndexQueueService.addIndexJob).toHaveBeenCalledTimes(2);
    });
  });

  describe('searchCodebase', () => {
    const baseSearchParams = {
      collection: 'codebase_my_repo_main_1536',
      query: 'find authentication logic',
      repoId: 'https://github.com/owner/repo',
      topK: 5,
    };

    const makeScoredPoint = (
      path: string,
      text: string,
      score: number,
      startLine = 1,
      endLine = 10,
    ) => ({
      id: `point-${path}`,
      score,
      payload: {
        repo_id: 'https://github.com/owner/repo',
        path,
        start_line: startLine,
        end_line: endLine,
        text,
      },
    });

    beforeEach(() => {
      (mockOpenaiService as Record<string, unknown>).embeddings = vi
        .fn()
        .mockResolvedValue({
          embeddings: [[0.1, 0.2, 0.3]],
        });
      (mockQdrantService as Record<string, unknown>).searchPoints = vi
        .fn()
        .mockResolvedValue([]);
    });

    it('returns filtered search results (happy path)', async () => {
      const points = [
        makeScoredPoint('src/auth/login.ts', 'function login() {}', 0.95),
        makeScoredPoint('src/auth/guard.ts', 'class AuthGuard {}', 0.88),
        makeScoredPoint('src/utils/hash.ts', 'function hashPassword() {}', 0.7),
      ];
      (mockQdrantService as Record<string, unknown>).searchPoints = vi
        .fn()
        .mockResolvedValue(points);

      const results = await service.searchCodebase(baseSearchParams);

      expect(results).toHaveLength(3);
      expect(results[0]!.path).toBe('src/auth/login.ts');
      expect(results[0]!.score).toBe(0.95);
      expect(results[0]!.text).toBe('function login() {}');
      expect(results[0]!.start_line).toBe(1);
      expect(results[0]!.end_line).toBe(10);

      // Verify embedding model was fetched
      expect(
        mockLlmModelsService.getKnowledgeEmbeddingModel,
      ).toHaveBeenCalled();
      // Verify embeddings were requested
      expect(
        (mockOpenaiService as Record<string, unknown>).embeddings,
      ).toHaveBeenCalledWith({
        model: 'text-embedding-3-small',
        input: ['find authentication logic'],
        dimensions: 1536,
      });
      // Verify search was called with expansion factor (topK * 6 = 30)
      expect(
        (mockQdrantService as Record<string, unknown>).searchPoints,
      ).toHaveBeenCalledWith(
        'codebase_my_repo_main_1536',
        [0.1, 0.2, 0.3],
        30, // topK(5) * codebaseSearchOverfetchFactor(6)
        expect.objectContaining({
          filter: expect.objectContaining({
            must: [
              {
                key: 'repo_id',
                match: { value: 'https://github.com/owner/repo' },
              },
            ],
          }),
          with_payload: true,
        }),
      );
    });

    it('returns empty array when Qdrant collection does not exist', async () => {
      (mockQdrantService as Record<string, unknown>).searchPoints = vi
        .fn()
        .mockRejectedValue(new Error('Collection not found'));

      const results = await service.searchCodebase(baseSearchParams);

      expect(results).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Qdrant collection not found during search',
        expect.objectContaining({
          collection: 'codebase_my_repo_main_1536',
          repoId: 'https://github.com/owner/repo',
        }),
      );
    });

    it('returns empty array when Qdrant collection "does not exist"', async () => {
      (mockQdrantService as Record<string, unknown>).searchPoints = vi
        .fn()
        .mockRejectedValue(new Error('Collection does not exist'));

      const results = await service.searchCodebase(baseSearchParams);

      expect(results).toEqual([]);
    });

    it('rethrows non-"not found" errors from Qdrant', async () => {
      (mockQdrantService as Record<string, unknown>).searchPoints = vi
        .fn()
        .mockRejectedValue(new Error('Connection timeout'));

      await expect(service.searchCodebase(baseSearchParams)).rejects.toThrow(
        'Connection timeout',
      );
    });

    it('filters by language using direct extension match (e.g. "ts")', async () => {
      const points = [
        makeScoredPoint('src/auth/login.ts', 'function login() {}', 0.95),
        makeScoredPoint('src/auth/guard.py', 'class AuthGuard:', 0.88),
        makeScoredPoint('src/config.json', '{"key": "val"}', 0.7),
      ];
      (mockQdrantService as Record<string, unknown>).searchPoints = vi
        .fn()
        .mockResolvedValue(points);

      const results = await service.searchCodebase({
        ...baseSearchParams,
        languageFilter: 'ts',
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.path).toBe('src/auth/login.ts');
    });

    it('filters by language name (e.g. "typescript" matches ts and tsx)', async () => {
      const points = [
        makeScoredPoint('src/auth/login.ts', 'function login() {}', 0.95),
        makeScoredPoint('src/auth/App.tsx', '<Component />', 0.9),
        makeScoredPoint('src/auth/guard.py', 'class AuthGuard:', 0.88),
        makeScoredPoint('src/auth/main.js', 'const x = 1;', 0.7),
      ];
      (mockQdrantService as Record<string, unknown>).searchPoints = vi
        .fn()
        .mockResolvedValue(points);

      const results = await service.searchCodebase({
        ...baseSearchParams,
        languageFilter: 'typescript',
      });

      expect(results).toHaveLength(2);
      expect(results[0]!.path).toBe('src/auth/login.ts');
      expect(results[1]!.path).toBe('src/auth/App.tsx');
    });

    it('filters by directory prefix', async () => {
      const points = [
        makeScoredPoint('src/auth/login.ts', 'function login() {}', 0.95),
        makeScoredPoint('src/auth/guard.ts', 'class AuthGuard {}', 0.88),
        makeScoredPoint('src/utils/hash.ts', 'function hashPassword() {}', 0.7),
        makeScoredPoint('lib/helpers.ts', 'export const helper = 1', 0.6),
      ];
      (mockQdrantService as Record<string, unknown>).searchPoints = vi
        .fn()
        .mockResolvedValue(points);

      const results = await service.searchCodebase({
        ...baseSearchParams,
        directoryFilter: 'src/auth',
      });

      expect(results).toHaveLength(2);
      expect(results[0]!.path).toBe('src/auth/login.ts');
      expect(results[1]!.path).toBe('src/auth/guard.ts');
    });

    it('combines directory and language filters', async () => {
      const points = [
        makeScoredPoint('src/auth/login.ts', 'function login() {}', 0.95),
        makeScoredPoint('src/auth/guard.py', 'class AuthGuard:', 0.88),
        makeScoredPoint('src/utils/hash.ts', 'function hashPassword() {}', 0.7),
      ];
      (mockQdrantService as Record<string, unknown>).searchPoints = vi
        .fn()
        .mockResolvedValue(points);

      const results = await service.searchCodebase({
        ...baseSearchParams,
        directoryFilter: 'src/auth',
        languageFilter: 'ts',
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.path).toBe('src/auth/login.ts');
    });

    it('limits results to topK after filtering', async () => {
      const points = Array.from({ length: 10 }, (_, i) =>
        makeScoredPoint(`src/file${i}.ts`, `code ${i}`, 0.9 - i * 0.05),
      );
      (mockQdrantService as Record<string, unknown>).searchPoints = vi
        .fn()
        .mockResolvedValue(points);

      const results = await service.searchCodebase({
        ...baseSearchParams,
        topK: 3,
      });

      expect(results).toHaveLength(3);
    });

    it('filters out results below minScore threshold', async () => {
      const points = [
        makeScoredPoint('src/auth/login.ts', 'function login() {}', 0.95),
        makeScoredPoint('src/auth/guard.ts', 'class AuthGuard {}', 0.45),
        makeScoredPoint(
          'src/utils/hash.ts',
          'function hashPassword() {}',
          0.25,
        ),
        makeScoredPoint('src/utils/misc.ts', 'const x = 1;', 0.1),
      ];
      (mockQdrantService as Record<string, unknown>).searchPoints = vi
        .fn()
        .mockResolvedValue(points);

      const results = await service.searchCodebase({
        ...baseSearchParams,
        minScore: 0.3,
      });

      expect(results).toHaveLength(2);
      expect(results[0]!.path).toBe('src/auth/login.ts');
      expect(results[0]!.score).toBe(0.95);
      expect(results[1]!.path).toBe('src/auth/guard.ts');
      expect(results[1]!.score).toBe(0.45);
    });

    it('returns all results when minScore is not specified', async () => {
      const points = [
        makeScoredPoint('src/auth/login.ts', 'function login() {}', 0.95),
        makeScoredPoint('src/utils/hash.ts', 'function hashPassword() {}', 0.1),
      ];
      (mockQdrantService as Record<string, unknown>).searchPoints = vi
        .fn()
        .mockResolvedValue(points);

      const results = await service.searchCodebase(baseSearchParams);

      expect(results).toHaveLength(2);
    });

    it('skips results with missing path or text in payload', async () => {
      const points = [
        makeScoredPoint('src/auth/login.ts', 'function login() {}', 0.95),
        {
          id: 'point-no-path',
          score: 0.9,
          payload: { text: 'some text' },
        },
        {
          id: 'point-no-text',
          score: 0.85,
          payload: { path: 'src/file.ts' },
        },
        {
          id: 'point-empty-payload',
          score: 0.8,
          payload: {},
        },
      ];
      (mockQdrantService as Record<string, unknown>).searchPoints = vi
        .fn()
        .mockResolvedValue(points);

      const results = await service.searchCodebase(baseSearchParams);

      expect(results).toHaveLength(1);
      expect(results[0]!.path).toBe('src/auth/login.ts');
    });

    it('throws when embedding generation returns empty result', async () => {
      (mockOpenaiService as Record<string, unknown>).embeddings = vi
        .fn()
        .mockResolvedValue({ embeddings: [] });

      await expect(service.searchCodebase(baseSearchParams)).rejects.toThrow(
        'Failed to generate embedding for query',
      );
    });
  });

  describe('processIndexJob (background path)', () => {
    type ProcessIndexJobFn = (
      data: { repoIndexId: string; repoUrl: string; branch: string },
      signal?: AbortSignal,
    ) => Promise<void>;

    const callProcessIndexJob = (
      data: { repoIndexId: string; repoUrl: string; branch: string },
      signal?: AbortSignal,
    ) =>
      (
        service as unknown as { processIndexJob: ProcessIndexJobFn }
      ).processIndexJob(data, signal);

    it('skips when entity is not found', async () => {
      mockRepoIndexDao.getOne.mockResolvedValue(null);

      await callProcessIndexJob({
        repoIndexId: 'missing-id',
        repoUrl: 'https://github.com/owner/repo',
        branch: 'main',
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Repo index entity not found, skipping job',
        { repoIndexId: 'missing-id' },
      );
      expect(mockRepoIndexerService.runFullIndex).not.toHaveBeenCalled();
    });

    it('skips when entity is already completed', async () => {
      mockRepoIndexDao.getOne.mockResolvedValue({
        id: 'done-id',
        status: RepoIndexStatus.Completed,
      } as unknown as RepoIndexEntity);

      await callProcessIndexJob({
        repoIndexId: 'done-id',
        repoUrl: 'https://github.com/owner/repo',
        branch: 'main',
      });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Repo index already completed, skipping job',
        { repoIndexId: 'done-id' },
      );
      expect(mockRepoIndexerService.runFullIndex).not.toHaveBeenCalled();
    });

    it('returns cleanly without throwing when signal is already aborted', async () => {
      mockRepoIndexDao.getOne.mockResolvedValue({
        id: 'cancel-id',
        status: RepoIndexStatus.Pending,
        indexedTokens: 0,
        estimatedTokens: 100,
      } as unknown as RepoIndexEntity);

      const abortController = new AbortController();
      abortController.abort();

      await callProcessIndexJob(
        {
          repoIndexId: 'cancel-id',
          repoUrl: 'https://github.com/owner/repo',
          branch: 'main',
        },
        abortController.signal,
      );

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Repo index job cancelled before start',
        { repoIndexId: 'cancel-id' },
      );
      expect(mockRepoIndexerService.runFullIndex).not.toHaveBeenCalled();
      expect(mockRepoIndexDao.updateById).not.toHaveBeenCalled();
    });

    it('wraps runtimeProvider.provide() errors with a user-friendly message', async () => {
      mockRepoIndexDao.getOne.mockResolvedValue({
        id: 'sandbox-fail-id',
        status: RepoIndexStatus.Pending,
        indexedTokens: 0,
        estimatedTokens: 100,
      } as unknown as RepoIndexEntity);
      mockRepoIndexDao.updateById.mockResolvedValue(1);
      mockRuntimeProvider.provide.mockRejectedValue(
        new Error('docker daemon not running'),
      );

      await expect(
        callProcessIndexJob({
          repoIndexId: 'sandbox-fail-id',
          repoUrl: 'https://github.com/owner/repo',
          branch: 'main',
        }),
      ).rejects.toThrow('Failed to start sandbox for repository indexing');
    });

    it('exits cleanly (does not wrap) when runtimeProvider.provide() throws JobCancelledException', async () => {
      mockRepoIndexDao.getOne.mockResolvedValue({
        id: 'cancel-provide-id',
        status: RepoIndexStatus.Pending,
        indexedTokens: 0,
        estimatedTokens: 100,
      } as unknown as RepoIndexEntity);
      mockRepoIndexDao.updateById.mockResolvedValue(1);
      mockRuntimeProvider.provide.mockRejectedValue(
        new JobCancelledException('job was cancelled'),
      );

      // JobCancelledException must propagate to the outer catch which returns
      // cleanly — the error must NOT be wrapped into a plain Error.
      await expect(
        callProcessIndexJob({
          repoIndexId: 'cancel-provide-id',
          repoUrl: 'https://github.com/owner/repo',
          branch: 'main',
        }),
      ).resolves.toBeUndefined();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Repo index job cancelled, exiting cleanly',
        { repoIndexId: 'cancel-provide-id' },
      );
    });
  });

  describe('cross-branch seeding (via getOrInitIndexForRepo)', () => {
    const baseParams = {
      repositoryId: 'repo-uuid',
      repoUrl: 'https://github.com/owner/repo',
      repoRoot: '/workspace/repo',
      branch: 'feature-branch',
      execFn,
    };

    it('seeds from donor branch when available', async () => {
      // No existing index for the target branch
      mockRepoIndexDao.getOne.mockResolvedValue(null);

      // Donor branch exists with completed index
      mockRepoIndexDao.getAll.mockResolvedValue([
        {
          id: 'donor-index',
          repositoryId: 'repo-uuid',
          branch: 'main',
          status: RepoIndexStatus.Completed,
          lastIndexedCommit: 'donor-commit-abc',
          qdrantCollection: 'codebase_my_repo_main_1536',
        },
      ]);

      mockRepoIndexerService.copyCollectionPoints.mockResolvedValue(500);
      // After seeding, estimateChangedTokenCount is used (incremental path)
      mockRepoIndexerService.estimateChangedTokenCount.mockResolvedValue(500);

      mockRepoIndexDao.create.mockResolvedValue({
        id: 'new-branch-index',
        status: RepoIndexStatus.InProgress,
        estimatedTokens: 500,
      } as unknown as RepoIndexEntity);

      const result = await service.getOrInitIndexForRepo(baseParams);

      expect(result.status).toBe('ready');
      // Should have copied points from donor
      expect(mockRepoIndexerService.copyCollectionPoints).toHaveBeenCalledWith(
        'codebase_my_repo_main_1536',
        'codebase_my_repo_main_1536',
      );
      // Should have run incremental index (not full) because seeding succeeded
      expect(mockRepoIndexerService.runIncrementalIndex).toHaveBeenCalled();
      expect(mockRepoIndexerService.runFullIndex).not.toHaveBeenCalled();
    });

    it('runs full index when no donor branch exists', async () => {
      // No existing index for the target branch
      mockRepoIndexDao.getOne.mockResolvedValue(null);

      // No donor branches (getAll returns empty for completed indexes)
      mockRepoIndexDao.getAll.mockResolvedValue([]);

      mockRepoIndexerService.estimateTokenCount.mockResolvedValue(1000);

      mockRepoIndexDao.create.mockResolvedValue({
        id: 'new-index',
        status: RepoIndexStatus.InProgress,
      } as unknown as RepoIndexEntity);

      const result = await service.getOrInitIndexForRepo(baseParams);

      expect(result.status).toBe('ready');
      // Should NOT have attempted to copy points
      expect(
        mockRepoIndexerService.copyCollectionPoints,
      ).not.toHaveBeenCalled();
      // Should have run full index (no donor to seed from)
      expect(mockRepoIndexerService.runFullIndex).toHaveBeenCalled();
      expect(mockRepoIndexerService.runIncrementalIndex).not.toHaveBeenCalled();
    });
  });

  describe('recoverStuckJobs', () => {
    it('re-enqueues incomplete jobs on startup', async () => {
      // Reset to create a fresh service with incomplete jobs
      vi.resetAllMocks();
      mockRepoIndexDao.getAll.mockResolvedValue([
        {
          id: 'stuck-1',
          repoUrl: 'https://github.com/owner/repo1',
          branch: 'main',
          status: RepoIndexStatus.InProgress,
        },
        {
          id: 'stuck-2',
          repoUrl: 'https://github.com/owner/repo2',
          branch: 'develop',
          status: RepoIndexStatus.Pending,
        },
      ]);
      mockRepoIndexDao.withIndexLock.mockImplementation(
        (_repoId: string, _branch: string, cb: () => Promise<unknown>) => cb(),
      );
      mockQdrantService.getCollections.mockResolvedValue({
        collections: [],
      });

      const svc = new RepoIndexService(
        mockRepoIndexDao as unknown as RepoIndexDao,
        mockGitRepositoriesDao as unknown as GitRepositoriesDao,
        mockGitTokenResolverService as unknown as GitTokenResolverService,
        mockRepoIndexerService as unknown as RepoIndexerService,
        mockRepoIndexQueueService as unknown as RepoIndexQueueService,
        mockLlmModelsService as unknown as LlmModelsService,
        mockOpenaiService as unknown as OpenaiService,
        mockQdrantService as unknown as QdrantService,
        mockRuntimeProvider as unknown as RuntimeProvider,
        mockRuntimeInstanceDao as unknown as RuntimeInstanceDao,
        mockLogger as unknown as DefaultLogger,
      );
      await svc.onModuleInit();

      // Verify each stuck job was reset to Pending
      expect(mockRepoIndexDao.updateById).toHaveBeenCalledWith('stuck-1', {
        status: RepoIndexStatus.Pending,
      });
      expect(mockRepoIndexDao.updateById).toHaveBeenCalledWith('stuck-2', {
        status: RepoIndexStatus.Pending,
      });

      // Verify each stuck job was re-enqueued
      expect(mockRepoIndexQueueService.addIndexJob).toHaveBeenCalledWith({
        repoIndexId: 'stuck-1',
        repoUrl: 'https://github.com/owner/repo1',
        branch: 'main',
      });
      expect(mockRepoIndexQueueService.addIndexJob).toHaveBeenCalledWith({
        repoIndexId: 'stuck-2',
        repoUrl: 'https://github.com/owner/repo2',
        branch: 'develop',
      });

      // Verify warning was logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Recovering incomplete repo index jobs on startup',
        { count: 2 },
      );
    });

    it('handles no incomplete jobs gracefully', async () => {
      // The default beforeEach already sets getAll to return [] and calls onModuleInit.
      // Verify no jobs were enqueued and no warning was logged.
      expect(mockRepoIndexQueueService.addIndexJob).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Recovering incomplete repo index jobs on startup',
        expect.anything(),
      );
    });

    it('handles errors in recovery gracefully', async () => {
      vi.resetAllMocks();
      const recoveryError = new Error('DB connection lost');
      mockRepoIndexDao.getAll.mockRejectedValue(recoveryError);
      mockRepoIndexDao.withIndexLock.mockImplementation(
        (_repoId: string, _branch: string, cb: () => Promise<unknown>) => cb(),
      );
      mockQdrantService.getCollections.mockResolvedValue({
        collections: [],
      });

      const svc = new RepoIndexService(
        mockRepoIndexDao as unknown as RepoIndexDao,
        mockGitRepositoriesDao as unknown as GitRepositoriesDao,
        mockGitTokenResolverService as unknown as GitTokenResolverService,
        mockRepoIndexerService as unknown as RepoIndexerService,
        mockRepoIndexQueueService as unknown as RepoIndexQueueService,
        mockLlmModelsService as unknown as LlmModelsService,
        mockOpenaiService as unknown as OpenaiService,
        mockQdrantService as unknown as QdrantService,
        mockRuntimeProvider as unknown as RuntimeProvider,
        mockRuntimeInstanceDao as unknown as RuntimeInstanceDao,
        mockLogger as unknown as DefaultLogger,
      );

      // onModuleInit should NOT throw — recoverStuckJobs catches errors
      await svc.onModuleInit();

      expect(mockLogger.error).toHaveBeenCalledWith(
        recoveryError,
        'Failed to recover incomplete repo index jobs',
      );

      // Verify no jobs were enqueued
      expect(mockRepoIndexQueueService.addIndexJob).not.toHaveBeenCalled();
    });
  });

  describe('cleanupOrphanedIndexes', () => {
    // Helper to create a fresh service and trigger onModuleInit with custom mocks
    const initServiceWithMocks = async (setup: {
      qdrantCollections: { name: string }[];
      dbIndexes: Partial<RepoIndexEntity>[];
    }) => {
      vi.resetAllMocks();
      // recoverStuckJobs defaults
      mockRepoIndexDao.getAll.mockResolvedValue(setup.dbIndexes);
      mockRepoIndexDao.deleteById.mockResolvedValue(undefined);
      mockRepoIndexDao.withIndexLock.mockImplementation(
        (_repoId: string, _branch: string, cb: () => Promise<unknown>) => cb(),
      );
      mockRepoIndexQueueService.removeJob.mockResolvedValue(undefined);
      mockQdrantService.getCollections.mockResolvedValue({
        collections: setup.qdrantCollections,
      });
      mockQdrantService.deleteCollection.mockResolvedValue(undefined);

      const svc = new RepoIndexService(
        mockRepoIndexDao as unknown as RepoIndexDao,
        mockGitRepositoriesDao as unknown as GitRepositoriesDao,
        mockGitTokenResolverService as unknown as GitTokenResolverService,
        mockRepoIndexerService as unknown as RepoIndexerService,
        mockRepoIndexQueueService as unknown as RepoIndexQueueService,
        mockLlmModelsService as unknown as LlmModelsService,
        mockOpenaiService as unknown as OpenaiService,
        mockQdrantService as unknown as QdrantService,
        mockRuntimeProvider as unknown as RuntimeProvider,
        mockRuntimeInstanceDao as unknown as RuntimeInstanceDao,
        mockLogger as unknown as DefaultLogger,
      );
      await svc.onModuleInit();
      // Flush fire-and-forget cleanupOrphanedIndexes microtask
      await new Promise((resolve) => setTimeout(resolve, 0));
      return svc;
    };

    it('deletes orphaned Qdrant collections with no matching DB row', async () => {
      await initServiceWithMocks({
        qdrantCollections: [
          { name: 'codebase_orphan_1536' },
          { name: 'codebase_valid_1536' },
        ],
        dbIndexes: [
          {
            id: 'idx-1',
            qdrantCollection: 'codebase_valid_1536',
            status: RepoIndexStatus.Completed,
            updatedAt: new Date(),
          } as Partial<RepoIndexEntity>,
        ],
      });

      expect(mockQdrantService.deleteCollection).toHaveBeenCalledWith(
        'codebase_orphan_1536',
      );
      expect(mockQdrantService.deleteCollection).not.toHaveBeenCalledWith(
        'codebase_valid_1536',
      );
    });

    it('deletes orphaned DB rows whose Qdrant collection no longer exists', async () => {
      await initServiceWithMocks({
        qdrantCollections: [{ name: 'codebase_existing_1536' }],
        dbIndexes: [
          {
            id: 'idx-orphan',
            qdrantCollection: 'codebase_deleted_1536',
            status: RepoIndexStatus.Completed,
            updatedAt: new Date(),
          } as Partial<RepoIndexEntity>,
          {
            id: 'idx-valid',
            qdrantCollection: 'codebase_existing_1536',
            status: RepoIndexStatus.Completed,
            updatedAt: new Date(),
          } as Partial<RepoIndexEntity>,
        ],
      });

      expect(mockRepoIndexDao.deleteById).toHaveBeenCalledWith('idx-orphan');
      expect(mockRepoIndexDao.deleteById).not.toHaveBeenCalledWith('idx-valid');
      expect(mockRepoIndexQueueService.removeJob).toHaveBeenCalledWith(
        'idx-orphan',
      );
    });

    it('skips DB rows with Pending or InProgress status even if collection is missing', async () => {
      await initServiceWithMocks({
        qdrantCollections: [],
        dbIndexes: [
          {
            id: 'idx-pending',
            qdrantCollection: 'codebase_new_1536',
            status: RepoIndexStatus.Pending,
            updatedAt: new Date(),
          } as Partial<RepoIndexEntity>,
          {
            id: 'idx-progress',
            qdrantCollection: 'codebase_building_1536',
            status: RepoIndexStatus.InProgress,
            updatedAt: new Date(),
          } as Partial<RepoIndexEntity>,
        ],
      });

      expect(mockRepoIndexDao.deleteById).not.toHaveBeenCalled();
    });

    it('skips non-codebase Qdrant collections', async () => {
      await initServiceWithMocks({
        qdrantCollections: [
          { name: 'knowledge_chunks_1536' },
          { name: 'other_collection' },
        ],
        dbIndexes: [],
      });

      expect(mockQdrantService.deleteCollection).not.toHaveBeenCalled();
    });

    it('deletes stale indexes older than the configured threshold', async () => {
      const staleDate = new Date(
        Date.now() - 31 * 24 * 60 * 60 * 1000, // 31 days ago
      );

      await initServiceWithMocks({
        qdrantCollections: [
          { name: 'codebase_stale_1536' },
          { name: 'codebase_fresh_1536' },
        ],
        dbIndexes: [
          {
            id: 'idx-stale',
            qdrantCollection: 'codebase_stale_1536',
            status: RepoIndexStatus.Completed,
            updatedAt: staleDate,
          } as Partial<RepoIndexEntity>,
          {
            id: 'idx-fresh',
            qdrantCollection: 'codebase_fresh_1536',
            status: RepoIndexStatus.Completed,
            updatedAt: new Date(),
          } as Partial<RepoIndexEntity>,
        ],
      });

      // Stale index: both DB row and Qdrant collection should be deleted
      expect(mockRepoIndexDao.deleteById).toHaveBeenCalledWith('idx-stale');
      expect(mockQdrantService.deleteCollection).toHaveBeenCalledWith(
        'codebase_stale_1536',
      );
      // Fresh index: neither should be deleted
      expect(mockRepoIndexDao.deleteById).not.toHaveBeenCalledWith('idx-fresh');
    });

    it('handles errors gracefully without throwing', async () => {
      vi.resetAllMocks();
      const qdrantError = new Error('Qdrant connection failed');
      mockRepoIndexDao.getAll.mockResolvedValue([]);
      mockRepoIndexDao.withIndexLock.mockImplementation(
        (_repoId: string, _branch: string, cb: () => Promise<unknown>) => cb(),
      );
      mockQdrantService.getCollections.mockRejectedValue(qdrantError);

      const svc = new RepoIndexService(
        mockRepoIndexDao as unknown as RepoIndexDao,
        mockGitRepositoriesDao as unknown as GitRepositoriesDao,
        mockGitTokenResolverService as unknown as GitTokenResolverService,
        mockRepoIndexerService as unknown as RepoIndexerService,
        mockRepoIndexQueueService as unknown as RepoIndexQueueService,
        mockLlmModelsService as unknown as LlmModelsService,
        mockOpenaiService as unknown as OpenaiService,
        mockQdrantService as unknown as QdrantService,
        mockRuntimeProvider as unknown as RuntimeProvider,
        mockRuntimeInstanceDao as unknown as RuntimeInstanceDao,
        mockLogger as unknown as DefaultLogger,
      );

      // Should not throw
      await svc.onModuleInit();
      // Flush fire-and-forget cleanupOrphanedIndexes microtask
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockLogger.error).toHaveBeenCalledWith(
        qdrantError,
        'Failed to cleanup orphaned indexes',
      );
    });

    it('deletes Failed DB rows whose Qdrant collection is missing', async () => {
      await initServiceWithMocks({
        qdrantCollections: [],
        dbIndexes: [
          {
            id: 'idx-failed',
            qdrantCollection: 'codebase_failed_1536',
            status: RepoIndexStatus.Failed,
            updatedAt: new Date(),
          } as Partial<RepoIndexEntity>,
        ],
      });

      expect(mockRepoIndexDao.deleteById).toHaveBeenCalledWith('idx-failed');
    });

    it('does not delete DB rows for Completed status indexes with existing Qdrant collection', async () => {
      await initServiceWithMocks({
        qdrantCollections: [{ name: 'codebase_valid_1536' }],
        dbIndexes: [
          {
            id: 'idx-valid',
            qdrantCollection: 'codebase_valid_1536',
            status: RepoIndexStatus.Completed,
            updatedAt: new Date(),
          } as Partial<RepoIndexEntity>,
        ],
      });

      expect(mockRepoIndexDao.deleteById).not.toHaveBeenCalled();
      expect(mockQdrantService.deleteCollection).not.toHaveBeenCalled();
    });

    it('does not delete Qdrant collection when another fresh row still references it', async () => {
      const staleDate = new Date(
        Date.now() - 31 * 24 * 60 * 60 * 1000, // 31 days ago
      );

      await initServiceWithMocks({
        qdrantCollections: [{ name: 'codebase_shared_1536' }],
        dbIndexes: [
          {
            id: 'idx-stale',
            qdrantCollection: 'codebase_shared_1536',
            status: RepoIndexStatus.Completed,
            updatedAt: staleDate,
          } as Partial<RepoIndexEntity>,
          {
            id: 'idx-fresh',
            qdrantCollection: 'codebase_shared_1536',
            status: RepoIndexStatus.Completed,
            updatedAt: new Date(),
          } as Partial<RepoIndexEntity>,
        ],
      });

      // Stale row should be deleted from DB
      expect(mockRepoIndexDao.deleteById).toHaveBeenCalledWith('idx-stale');
      // But the Qdrant collection must NOT be deleted — fresh row still needs it
      expect(mockQdrantService.deleteCollection).not.toHaveBeenCalledWith(
        'codebase_shared_1536',
      );
      // Fresh row should not be deleted
      expect(mockRepoIndexDao.deleteById).not.toHaveBeenCalledWith('idx-fresh');
    });
  });

  describe('query expansion (via searchCodebase)', () => {
    const baseSearchParams = {
      collection: 'codebase_my_repo_main_1536',
      query: 'find authentication logic',
      repoId: 'https://github.com/owner/repo',
      topK: 15, // >= QUERY_EXPANSION_MIN_TOP_K (10) to trigger expansion
    };

    const mockOpenaiResponse = {
      content: {
        queries: [
          'find authentication logic',
          'login auth middleware',
          'authGuard token verification',
        ],
      },
    };

    beforeEach(() => {
      (mockOpenaiService as Record<string, unknown>).embeddings = vi
        .fn()
        .mockResolvedValue({
          embeddings: [[0.1, 0.2, 0.3]],
        });
      (mockOpenaiService as Record<string, unknown>).response = vi
        .fn()
        .mockResolvedValue(mockOpenaiResponse);
      (mockOpenaiService as Record<string, unknown>).jsonRequest = vi
        .fn()
        .mockResolvedValue(mockOpenaiResponse);
      (mockQdrantService as Record<string, unknown>).searchPoints = vi
        .fn()
        .mockResolvedValue([]);
      (mockQdrantService as Record<string, unknown>).searchMany = vi
        .fn()
        .mockResolvedValue([[]]);
    });

    it('does not trigger query expansion when topK is below threshold', async () => {
      const results = await service.searchCodebase({
        ...baseSearchParams,
        topK: 5, // below QUERY_EXPANSION_MIN_TOP_K (10)
      });

      expect(results).toEqual([]);
      // Should use single searchPoints, not searchMany (no expansion)
      expect(
        (mockQdrantService as Record<string, unknown>).searchPoints,
      ).toHaveBeenCalledTimes(1);
      expect(
        (mockQdrantService as Record<string, unknown>).searchMany,
      ).not.toHaveBeenCalled();
      // LLM should not be called for expansion
      expect(
        (mockOpenaiService as Record<string, unknown>).response,
      ).not.toHaveBeenCalled();
      expect(
        (mockOpenaiService as Record<string, unknown>).jsonRequest,
      ).not.toHaveBeenCalled();
    });

    it('triggers query expansion when topK meets threshold', async () => {
      // The LLM returns 3 queries, 1 is original (filtered), 2 are unique.
      // Return embeddings matching the number of inputs per call.
      (mockOpenaiService as Record<string, unknown>).embeddings = vi
        .fn()
        .mockImplementation((params: { input: string[] }) => ({
          embeddings: params.input.map((_, i) => [0.1 + i * 0.1, 0.2, 0.3]),
        }));
      (mockQdrantService as Record<string, unknown>).searchMany = vi
        .fn()
        .mockResolvedValue([[], [], []]);

      await service.searchCodebase(baseSearchParams);

      // LLM should be called for expansion (either response or complete)
      const responseCalls = (
        (mockOpenaiService as Record<string, unknown>).response as ReturnType<
          typeof vi.fn
        >
      ).mock.calls.length;
      const completeCalls = (
        (mockOpenaiService as Record<string, unknown>)
          .jsonRequest as ReturnType<typeof vi.fn>
      ).mock.calls.length;
      expect(responseCalls + completeCalls).toBeGreaterThan(0);
    });

    it('uses searchMany with multiple embeddings when expansion produces variants', async () => {
      // Return 2 additional unique variants (original is filtered out)
      (mockOpenaiService as Record<string, unknown>).jsonRequest = vi
        .fn()
        .mockResolvedValue({
          content: {
            queries: [
              'find authentication logic', // same as original — should be filtered
              'login auth middleware',
              'authGuard token verification',
            ],
          },
        });
      // Return embeddings matching the number of inputs per call
      (mockOpenaiService as Record<string, unknown>).embeddings = vi
        .fn()
        .mockImplementation((params: { input: string[] }) => ({
          embeddings: params.input.map((_, i) => [0.1 + i * 0.1, 0.2, 0.3]),
        }));

      (mockQdrantService as Record<string, unknown>).searchMany = vi
        .fn()
        .mockResolvedValue([[], [], []]);

      await service.searchCodebase(baseSearchParams);

      // searchMany should be used (multiple query vectors)
      expect(
        (mockQdrantService as Record<string, unknown>).searchMany,
      ).toHaveBeenCalled();
    });

    it('falls back to single embedding when expansion fails', async () => {
      (mockOpenaiService as Record<string, unknown>).jsonRequest = vi
        .fn()
        .mockRejectedValue(new Error('LLM timeout'));

      await service.searchCodebase(baseSearchParams);

      // Should fall back to single-vector search
      expect(
        (mockQdrantService as Record<string, unknown>).searchPoints,
      ).toHaveBeenCalledTimes(1);
    });

    it('deduplicates expansion variants case-insensitively', async () => {
      (mockOpenaiService as Record<string, unknown>).jsonRequest = vi
        .fn()
        .mockResolvedValue({
          content: {
            queries: [
              'Find Authentication Logic', // case-insensitive match with original
              'LOGIN AUTH MIDDLEWARE', // unique
            ],
          },
        });

      // Return embeddings matching the number of inputs per call
      (mockOpenaiService as Record<string, unknown>).embeddings = vi
        .fn()
        .mockImplementation((params: { input: string[] }) => ({
          embeddings: params.input.map((_, i) => [0.1 + i * 0.1, 0.2, 0.3]),
        }));

      (mockQdrantService as Record<string, unknown>).searchMany = vi
        .fn()
        .mockResolvedValue([[], []]);

      await service.searchCodebase(baseSearchParams);

      // Verify that the batch embedding call only includes the unique variant
      const embeddingsCalls = (
        (mockOpenaiService as Record<string, unknown>).embeddings as ReturnType<
          typeof vi.fn
        >
      ).mock.calls;

      // First call is for primary embedding (original query)
      // Second call (if any) is for unique additional variants
      const allInputs = embeddingsCalls.flatMap(
        (call: unknown[]) => (call[0] as { input: string[] }).input,
      );
      // The original query should appear exactly once
      const originalOccurrences = allInputs.filter(
        (input: string) =>
          input.toLowerCase().trim() ===
          'find authentication logic'.toLowerCase(),
      );
      expect(originalOccurrences).toHaveLength(1);
    });

    it('uses reduced expansion factor when multiple variants are active', async () => {
      (mockOpenaiService as Record<string, unknown>).jsonRequest = vi
        .fn()
        .mockResolvedValue({
          content: {
            queries: ['unique variant 1', 'unique variant 2'],
          },
        });
      // Return embeddings matching the number of inputs per call
      (mockOpenaiService as Record<string, unknown>).embeddings = vi
        .fn()
        .mockImplementation((params: { input: string[] }) => ({
          embeddings: params.input.map((_, i) => [0.1 + i * 0.1, 0.2, 0.3]),
        }));

      (mockQdrantService as Record<string, unknown>).searchMany = vi
        .fn()
        .mockResolvedValue([[], [], []]);

      await service.searchCodebase(baseSearchParams);

      // With variants, searchMany should be called with limit = topK * 3
      // (codebaseSearchOverfetchFactorWithVariants = 3) instead of topK * 6
      expect(
        (mockQdrantService as Record<string, unknown>).searchMany,
      ).toHaveBeenCalledWith(
        baseSearchParams.collection,
        expect.arrayContaining([
          expect.objectContaining({
            limit: baseSearchParams.topK * 3,
          }),
        ]),
      );
    });
  });

  describe('BullMQ callback handlers', () => {
    // Access private methods via type assertion
    const callPrivateMethod = (
      methodName: 'handleStalledJob' | 'handleRetryJob' | 'handleFailedJob',
      ...args: unknown[]
    ) =>
      (
        service as unknown as Record<string, (...a: unknown[]) => Promise<void>>
      )[methodName]!(...args);

    it('handleStalledJob resets entity status to Pending', async () => {
      await callPrivateMethod('handleStalledJob', 'stalled-id');

      expect(mockRepoIndexDao.updateById).toHaveBeenCalledWith('stalled-id', {
        status: RepoIndexStatus.Pending,
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Repo index job stalled, resetting status',
        { repoIndexId: 'stalled-id' },
      );
    });

    it('handleRetryJob resets entity status to Pending and logs the error', async () => {
      const retryError = new Error('Temporary failure');
      await callPrivateMethod('handleRetryJob', 'retry-id', retryError);

      expect(mockRepoIndexDao.updateById).toHaveBeenCalledWith('retry-id', {
        status: RepoIndexStatus.Pending,
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Repo index job failed, will be retried',
        {
          repoIndexId: 'retry-id',
          error: 'Temporary failure',
        },
      );
    });

    it('handleFailedJob sets entity status to Failed with error message', async () => {
      const finalError = new Error('Permanent failure');
      await callPrivateMethod('handleFailedJob', 'failed-id', finalError);

      expect(mockRepoIndexDao.updateById).toHaveBeenCalledWith('failed-id', {
        status: RepoIndexStatus.Failed,
        errorMessage: 'Permanent failure',
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        finalError,
        'Repo index job failed permanently',
        { repoIndexId: 'failed-id' },
      );
    });
  });

  describe('embeddingCacheKey', () => {
    it('produces different keys for different texts', () => {
      // Access the static method
      const key1 = (
        RepoIndexService as unknown as {
          embeddingCacheKey: (model: string, text: string) => string;
        }
      ).embeddingCacheKey('model-a', 'text one');
      const key2 = (
        RepoIndexService as unknown as {
          embeddingCacheKey: (model: string, text: string) => string;
        }
      ).embeddingCacheKey('model-a', 'text two');

      expect(key1).not.toBe(key2);
      // Both should start with model prefix
      expect(key1).toMatch(/^model-a:/);
      expect(key2).toMatch(/^model-a:/);
    });

    it('produces different keys for different models', () => {
      const key1 = (
        RepoIndexService as unknown as {
          embeddingCacheKey: (model: string, text: string) => string;
        }
      ).embeddingCacheKey('model-a', 'same text');
      const key2 = (
        RepoIndexService as unknown as {
          embeddingCacheKey: (model: string, text: string) => string;
        }
      ).embeddingCacheKey('model-b', 'same text');

      expect(key1).not.toBe(key2);
    });

    it('produces consistent keys for the same input', () => {
      const key1 = (
        RepoIndexService as unknown as {
          embeddingCacheKey: (model: string, text: string) => string;
        }
      ).embeddingCacheKey('model-a', 'test text');
      const key2 = (
        RepoIndexService as unknown as {
          embeddingCacheKey: (model: string, text: string) => string;
        }
      ).embeddingCacheKey('model-a', 'test text');

      expect(key1).toBe(key2);
    });
  });
});
