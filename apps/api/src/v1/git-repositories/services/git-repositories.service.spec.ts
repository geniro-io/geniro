import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  DefaultLogger,
  InternalException,
  NotFoundException,
} from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { GitProvider } from '../../git-auth/git-auth.types';
import { GitUserPatService } from '../../git-auth/services/git-user-pat.service';
import { GitHubAppService } from '../../git-auth/services/github-app.service';
import { GitHubAppProviderService } from '../../git-auth/services/github-app-provider.service';
import { GitHubAuthMethod } from '../../graph-resources/graph-resources.types';
import { ProjectsDao } from '../../projects/dao/projects.dao';
import { QdrantService } from '../../qdrant/services/qdrant.service';
import { GitRepositoriesDao } from '../dao/git-repositories.dao';
import { RepoIndexDao } from '../dao/repo-index.dao';
import { GetRepositoriesQueryDto } from '../dto/git-repositories.dto';
import { GitRepositoryEntity } from '../entity/git-repository.entity';
import { RepoIndexEntity } from '../entity/repo-index.entity';
import {
  GitRepositoryProvider,
  RepoIndexStatus,
} from '../git-repositories.types';
import { GitRepositoriesService } from './git-repositories.service';
import { RepoIndexQueueService } from './repo-index-queue.service';
import { RepoIndexerService } from './repo-indexer.service';

describe('GitRepositoriesService', () => {
  let service: GitRepositoriesService;
  let dao: GitRepositoriesDao;
  let repoIndexDao: RepoIndexDao;
  let repoIndexQueueService: RepoIndexQueueService;
  let repoIndexerService: RepoIndexerService;
  let qdrantService: QdrantService;
  let gitHubAppProviderService: GitHubAppProviderService;
  let gitHubAppService: GitHubAppService;
  let logger: DefaultLogger;
  let gitUserPatMock: {
    resolvePatToken: ReturnType<typeof vi.fn>;
  };

  const mockUserId = 'user-123';
  const mockProjectId = '11111111-1111-1111-1111-111111111111';
  const mockRepositoryId = 'repo-456';
  const mockCtx = new AppContextStorage({ sub: mockUserId }, {
    headers: { 'x-project-id': mockProjectId },
  } as unknown as import('fastify').FastifyRequest);

  const createMockRepositoryEntity = (
    overrides: Partial<GitRepositoryEntity> = {},
  ): GitRepositoryEntity =>
    ({
      id: mockRepositoryId,
      owner: 'octocat',
      repo: 'Hello-World',
      url: 'https://github.com/octocat/Hello-World.git',
      provider: GitRepositoryProvider.GITHUB,
      defaultBranch: 'main',
      createdBy: mockUserId,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z'),
      deletedAt: null,
      ...overrides,
    }) as GitRepositoryEntity;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitRepositoriesService,
        {
          provide: GitRepositoriesDao,
          useValue: {
            getAll: vi.fn(),
            getOne: vi.fn(),
            create: vi.fn(),
            updateById: vi.fn(),
            updateAndReturn: vi.fn(),
            getById: vi.fn(),
            deleteById: vi.fn(),
            upsertMany: vi.fn(),
            upsertGithubSyncRepos: vi.fn(),
            restoreSoftDeleted: vi.fn(),
            count: vi.fn(),
          },
        },
        {
          provide: RepoIndexDao,
          useValue: {
            getAll: vi.fn(),
            getOne: vi.fn(),
            create: vi.fn(),
            updateById: vi.fn(),
            deleteById: vi.fn(),
            delete: vi.fn(),
            hardDelete: vi.fn(),
            restoreById: vi.fn(),
            incrementIndexedTokens: vi.fn(),
          },
        },
        {
          provide: RepoIndexQueueService,
          useValue: {
            addIndexJob: vi.fn(),
            setCallbacks: vi.fn(),
            removeJob: vi.fn(),
          },
        },
        {
          provide: RepoIndexerService,
          useValue: {
            deriveRepoId: vi.fn((url: string) => url),
            calculateIndexMetadata: vi.fn().mockResolvedValue({
              embeddingModel: 'text-embedding-3-small',
              vectorSize: 1536,
              chunkingSignatureHash: 'sig-hash-123',
              repoSlug: 'my_repo',
              collection: 'codebase_my_repo_1536',
            }),
          },
        },
        {
          provide: QdrantService,
          useValue: {
            deleteCollection: vi.fn(),
          },
        },
        {
          provide: DefaultLogger,
          useValue: {
            log: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          },
        },
        {
          provide: ProjectsDao,
          useValue: {
            getOne: vi
              .fn()
              .mockResolvedValue({ id: 'project-1', createdBy: mockUserId }),
          },
        },
        {
          provide: GitHubAppProviderService,
          useValue: {
            isConfigured: vi.fn().mockReturnValue(true),
            getActiveInstallations: vi.fn(),
            deactivateByInstallationId: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: GitHubAppService,
          useValue: {
            getInstallationToken: vi.fn(),
          },
        },
        {
          provide: GitUserPatService,
          useValue: {
            // Default: the user has no stored PAT — these unit tests exercise the
            // App-mode path (createdBy = the requesting user).
            resolvePatToken: vi.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = module.get<GitRepositoriesService>(GitRepositoriesService);
    dao = module.get<GitRepositoriesDao>(GitRepositoriesDao);
    repoIndexDao = module.get<RepoIndexDao>(RepoIndexDao);
    repoIndexQueueService = module.get<RepoIndexQueueService>(
      RepoIndexQueueService,
    );
    repoIndexerService = module.get<RepoIndexerService>(RepoIndexerService);
    qdrantService = module.get<QdrantService>(QdrantService);
    gitHubAppProviderService = module.get<GitHubAppProviderService>(
      GitHubAppProviderService,
    );
    gitHubAppService = module.get<GitHubAppService>(GitHubAppService);
    logger = module.get<DefaultLogger>(DefaultLogger);
    gitUserPatMock = module.get(
      GitUserPatService,
    ) as unknown as typeof gitUserPatMock;
  });

  describe('createRepository', () => {
    it('should create a new repository', async () => {
      const createData = {
        owner: 'octocat',
        repo: 'Hello-World',
        url: 'https://github.com/octocat/Hello-World.git',
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: 'main',
      };

      vi.spyOn(dao, 'create').mockResolvedValue(createMockRepositoryEntity());

      const result = await service.createRepository(mockCtx, createData);

      expect(dao.create).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'Hello-World',
        url: 'https://github.com/octocat/Hello-World.git',
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: 'main',
        createdBy: mockUserId,
        projectId: mockProjectId,
        installationId: null,
        syncedAt: null,
      });
      expect(result).toMatchObject({
        owner: 'octocat',
        repo: 'Hello-World',
      });
    });
  });

  describe('updateRepository', () => {
    it('should update existing repository', async () => {
      const existing = createMockRepositoryEntity();
      const updateData = {
        url: 'https://github.com/octocat/Hello-World-New.git',
      };

      vi.spyOn(dao, 'getOne').mockResolvedValue(existing);
      vi.spyOn(dao, 'updateAndReturn').mockResolvedValue({
        ...existing,
        url: 'https://github.com/octocat/Hello-World-New.git',
      });

      const result = await service.updateRepository(
        mockCtx,
        mockRepositoryId,
        updateData,
      );

      expect(dao.getOne).toHaveBeenCalledWith({
        id: mockRepositoryId,
        createdBy: mockUserId,
      });
      expect(dao.updateAndReturn).toHaveBeenCalledWith(
        mockRepositoryId,
        updateData,
      );
      expect(result.url).toBe('https://github.com/octocat/Hello-World-New.git');
    });

    it('should throw NotFoundException when repository not found', async () => {
      vi.spyOn(dao, 'getOne').mockResolvedValue(null);

      await expect(
        service.updateRepository(mockCtx, mockRepositoryId, { url: '...' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getRepositories', () => {
    it('should return repositories for authenticated user with projectId from header', async () => {
      const mockRepositories = [
        createMockRepositoryEntity(),
        createMockRepositoryEntity({
          id: 'repo-789',
          owner: 'facebook',
          repo: 'react',
        }),
      ];

      vi.spyOn(dao, 'getAll').mockResolvedValue(mockRepositories);

      const query: GetRepositoriesQueryDto = {
        limit: 50,
        offset: 0,
      };

      const result = await service.getRepositories(mockCtx, query);

      expect(dao.getAll).toHaveBeenCalledWith(
        { createdBy: mockUserId },
        { limit: 50, offset: 0, orderBy: { createdAt: 'DESC' } },
      );
      expect(result).toHaveLength(2);
    });

    it('should not filter by projectId even when x-project-id header is present', async () => {
      // mockCtx already carries the x-project-id header
      vi.spyOn(dao, 'getAll').mockResolvedValue([]);

      await service.getRepositories(mockCtx, { limit: 50, offset: 0 });

      const whereArg = vi.mocked(dao.getAll).mock.calls[0]?.[0];
      expect(whereArg).not.toHaveProperty('projectId');
    });

    it('should pass installationId filter to DAO when provided in query', async () => {
      vi.spyOn(dao, 'getAll').mockResolvedValue([]);

      const query: GetRepositoriesQueryDto = {
        limit: 50,
        offset: 0,
        installationId: 12345,
      };

      await service.getRepositories(mockCtx, query);

      expect(dao.getAll).toHaveBeenCalledWith(
        expect.objectContaining({
          installationId: 12345,
        }),
        expect.any(Object),
      );
    });
  });

  describe('getRepositoryById', () => {
    it('should return repository when found', async () => {
      const mockRepository = createMockRepositoryEntity();
      vi.spyOn(dao, 'getOne').mockResolvedValue(mockRepository);

      const result = await service.getRepositoryById(mockCtx, mockRepositoryId);

      expect(dao.getOne).toHaveBeenCalledWith({
        id: mockRepositoryId,
        createdBy: mockUserId,
      });
      expect(result.id).toBe(mockRepositoryId);
    });
  });

  describe('deleteRepository', () => {
    it('should delete repository and cleanup Qdrant collection when it exists', async () => {
      const mockRepository = createMockRepositoryEntity();
      const mockRepoIndex = {
        id: 'index-123',
        repositoryId: mockRepositoryId,
        repoUrl: 'https://github.com/octocat/Hello-World.git',
        qdrantCollection: 'codebase_my_repo_1536',
        status: 'completed',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(dao, 'getOne').mockResolvedValue(mockRepository);
      vi.spyOn(repoIndexDao, 'getAll').mockResolvedValue([
        mockRepoIndex as any,
      ]);
      vi.spyOn(qdrantService, 'deleteCollection').mockResolvedValue(undefined);
      vi.spyOn(dao, 'deleteById').mockResolvedValue(undefined);

      await service.deleteRepository(mockCtx, mockRepositoryId);

      expect(repoIndexDao.getAll).toHaveBeenCalledWith({
        repositoryId: mockRepositoryId,
      });
      expect(qdrantService.deleteCollection).toHaveBeenCalledWith(
        'codebase_my_repo_1536',
      );
      expect(repoIndexDao.hardDelete).toHaveBeenCalledWith({
        repositoryId: mockRepositoryId,
      });
      expect(dao.deleteById).toHaveBeenCalledWith(mockRepositoryId);
    });

    it('should delete repository when no repo index exists', async () => {
      const mockRepository = createMockRepositoryEntity();

      vi.spyOn(dao, 'getOne').mockResolvedValue(mockRepository);
      vi.spyOn(repoIndexDao, 'getAll').mockResolvedValue([]);
      vi.spyOn(dao, 'deleteById').mockResolvedValue(undefined);

      await service.deleteRepository(mockCtx, mockRepositoryId);

      expect(repoIndexDao.hardDelete).toHaveBeenCalledWith({
        repositoryId: mockRepositoryId,
      });
      expect(dao.deleteById).toHaveBeenCalledWith(mockRepositoryId);
      expect(qdrantService.deleteCollection).not.toHaveBeenCalled();
    });

    it('should delete repository even if Qdrant cleanup fails', async () => {
      const mockRepository = createMockRepositoryEntity();
      const mockRepoIndex = {
        id: 'index-123',
        repositoryId: mockRepositoryId,
        qdrantCollection: 'codebase_my_repo_1536',
      };

      vi.spyOn(dao, 'getOne').mockResolvedValue(mockRepository);
      vi.spyOn(repoIndexDao, 'getAll').mockResolvedValue([
        mockRepoIndex as any,
      ]);
      vi.spyOn(qdrantService, 'deleteCollection').mockRejectedValue(
        new Error('Qdrant connection failed'),
      );
      vi.spyOn(dao, 'deleteById').mockResolvedValue(undefined);

      // Should not throw, just warn and continue
      await service.deleteRepository(mockCtx, mockRepositoryId);

      expect(dao.deleteById).toHaveBeenCalledWith(mockRepositoryId);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete Qdrant collection'),
        expect.any(Object),
      );
    });

    it('should call removeJob for each repo index', async () => {
      const mockRepository = createMockRepositoryEntity();
      const mockIndexes = [
        {
          id: 'index-1',
          repositoryId: mockRepositoryId,
          qdrantCollection: 'col-a',
        },
        {
          id: 'index-2',
          repositoryId: mockRepositoryId,
          qdrantCollection: 'col-b',
        },
        {
          id: 'index-3',
          repositoryId: mockRepositoryId,
          qdrantCollection: 'col-c',
        },
      ];

      vi.spyOn(dao, 'getOne').mockResolvedValue(mockRepository);
      vi.spyOn(repoIndexDao, 'getAll').mockResolvedValue(mockIndexes as any);
      vi.spyOn(qdrantService, 'deleteCollection').mockResolvedValue(undefined);
      vi.spyOn(dao, 'deleteById').mockResolvedValue(undefined);

      await service.deleteRepository(mockCtx, mockRepositoryId);

      expect(repoIndexQueueService.removeJob).toHaveBeenCalledTimes(3);
      expect(repoIndexQueueService.removeJob).toHaveBeenCalledWith('index-1');
      expect(repoIndexQueueService.removeJob).toHaveBeenCalledWith('index-2');
      expect(repoIndexQueueService.removeJob).toHaveBeenCalledWith('index-3');
    });

    it('should deduplicate: two indexes sharing one collection calls deleteCollection once', async () => {
      const mockRepository = createMockRepositoryEntity();
      const sharedCollection = 'codebase_shared_1536';
      const mockIndexes = [
        {
          id: 'index-1',
          repositoryId: mockRepositoryId,
          qdrantCollection: sharedCollection,
        },
        {
          id: 'index-2',
          repositoryId: mockRepositoryId,
          qdrantCollection: sharedCollection,
        },
      ];

      vi.spyOn(dao, 'getOne').mockResolvedValue(mockRepository);
      vi.spyOn(repoIndexDao, 'getAll').mockResolvedValue(mockIndexes as any);
      vi.spyOn(qdrantService, 'deleteCollection').mockResolvedValue(undefined);
      vi.spyOn(dao, 'deleteById').mockResolvedValue(undefined);

      await service.deleteRepository(mockCtx, mockRepositoryId);

      expect(qdrantService.deleteCollection).toHaveBeenCalledTimes(1);
      expect(qdrantService.deleteCollection).toHaveBeenCalledWith(
        sharedCollection,
      );
    });

    it('should call deleteCollection for each distinct collection name', async () => {
      const mockRepository = createMockRepositoryEntity();
      const mockIndexes = [
        {
          id: 'index-1',
          repositoryId: mockRepositoryId,
          qdrantCollection: 'col-alpha',
        },
        {
          id: 'index-2',
          repositoryId: mockRepositoryId,
          qdrantCollection: 'col-beta',
        },
      ];

      vi.spyOn(dao, 'getOne').mockResolvedValue(mockRepository);
      vi.spyOn(repoIndexDao, 'getAll').mockResolvedValue(mockIndexes as any);
      vi.spyOn(qdrantService, 'deleteCollection').mockResolvedValue(undefined);
      vi.spyOn(dao, 'deleteById').mockResolvedValue(undefined);

      await service.deleteRepository(mockCtx, mockRepositoryId);

      expect(qdrantService.deleteCollection).toHaveBeenCalledTimes(2);
      expect(qdrantService.deleteCollection).toHaveBeenCalledWith('col-alpha');
      expect(qdrantService.deleteCollection).toHaveBeenCalledWith('col-beta');
    });

    it('should perform cleanup before deleteById (call ordering)', async () => {
      const mockRepository = createMockRepositoryEntity();
      const mockIndexes = [
        {
          id: 'index-1',
          repositoryId: mockRepositoryId,
          qdrantCollection: 'col-a',
        },
      ];

      vi.spyOn(dao, 'getOne').mockResolvedValue(mockRepository);
      vi.spyOn(repoIndexDao, 'getAll').mockResolvedValue(mockIndexes as any);
      vi.spyOn(qdrantService, 'deleteCollection').mockResolvedValue(undefined);
      vi.spyOn(dao, 'deleteById').mockResolvedValue(undefined);

      await service.deleteRepository(mockCtx, mockRepositoryId);

      const removeJobOrder = vi.mocked(repoIndexQueueService.removeJob).mock
        .invocationCallOrder[0]!;
      const deleteCollectionOrder = vi.mocked(qdrantService.deleteCollection)
        .mock.invocationCallOrder[0]!;
      const deleteByIdOrder = vi.mocked(dao.deleteById).mock
        .invocationCallOrder[0]!;

      expect(removeJobOrder).toBeLessThan(deleteByIdOrder);
      expect(deleteCollectionOrder).toBeLessThan(deleteByIdOrder);
    });

    it('should throw NotFoundException and not call cleanup when repository does not exist', async () => {
      vi.spyOn(dao, 'getOne').mockResolvedValue(null);

      await expect(
        service.deleteRepository(mockCtx, mockRepositoryId),
      ).rejects.toThrow(NotFoundException);

      expect(repoIndexDao.getAll).not.toHaveBeenCalled();
      expect(qdrantService.deleteCollection).not.toHaveBeenCalled();
    });
  });

  describe('triggerReindex', () => {
    const createMockRepoIndexEntity = (
      overrides: Partial<RepoIndexEntity> = {},
    ): RepoIndexEntity =>
      ({
        id: 'index-123',
        repositoryId: mockRepositoryId,
        repoUrl: 'https://github.com/octocat/Hello-World.git',
        branch: 'main',
        status: RepoIndexStatus.Completed,
        qdrantCollection: 'codebase_my_repo_1536',
        lastIndexedCommit: 'abc123',
        embeddingModel: 'text-embedding-3-small',
        vectorSize: 1536,
        chunkingSignatureHash: 'sig-hash-123',
        estimatedTokens: 1000,
        indexedTokens: 1000,
        errorMessage: null,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        ...overrides,
      }) as RepoIndexEntity;

    it('should successfully queue a reindex job for a new index', async () => {
      const mockRepository = createMockRepositoryEntity();

      vi.spyOn(dao, 'getOne').mockResolvedValue(mockRepository);
      vi.spyOn(repoIndexDao, 'getOne').mockResolvedValue(null);
      vi.spyOn(repoIndexDao, 'create').mockResolvedValue(
        createMockRepoIndexEntity({
          status: RepoIndexStatus.Pending,
          indexedTokens: 0,
          estimatedTokens: 0,
        }),
      );

      const result = await service.triggerReindex(mockCtx, {
        repositoryId: mockRepositoryId,
        branch: 'main',
      });

      expect(repoIndexerService.deriveRepoId).toHaveBeenCalledWith(
        mockRepository.url,
      );
      expect(repoIndexerService.calculateIndexMetadata).toHaveBeenCalledWith(
        mockRepositoryId,
        'main',
      );
      expect(repoIndexDao.create).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryId: mockRepositoryId,
          branch: 'main',
          status: RepoIndexStatus.Pending,
        }),
      );
      expect(repoIndexQueueService.addIndexJob).toHaveBeenCalledWith({
        repoIndexId: 'index-123',
        repoUrl: mockRepository.url,
        branch: 'main',
      });
      expect(result.message).toBe('Repository indexing has been queued');
      expect(result.repoIndex.status).toBe(RepoIndexStatus.Pending);
    });

    it('should throw BadRequestException when indexing is already in progress', async () => {
      const mockRepository = createMockRepositoryEntity();
      const existingIndex = createMockRepoIndexEntity({
        status: RepoIndexStatus.InProgress,
      });

      vi.spyOn(dao, 'getOne').mockResolvedValue(mockRepository);
      vi.spyOn(repoIndexDao, 'getOne').mockResolvedValue(existingIndex);

      await expect(
        service.triggerReindex(mockCtx, {
          repositoryId: mockRepositoryId,
          branch: 'main',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when repository does not belong to user', async () => {
      vi.spyOn(dao, 'getOne').mockResolvedValue(null);

      await expect(
        service.triggerReindex(mockCtx, {
          repositoryId: 'non-existent-repo',
          branch: 'main',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should restore and reset a soft-deleted index instead of creating a new one', async () => {
      const mockRepository = createMockRepositoryEntity();
      const softDeletedIndex = createMockRepoIndexEntity({
        deletedAt: new Date('2024-06-01'),
      });

      vi.spyOn(dao, 'getOne').mockResolvedValue(mockRepository);
      vi.spyOn(repoIndexDao, 'getOne').mockResolvedValue(softDeletedIndex);
      vi.spyOn(repoIndexDao, 'restoreById').mockResolvedValue(undefined);
      vi.spyOn(repoIndexDao, 'updateById').mockResolvedValue(0);

      const result = await service.triggerReindex(mockCtx, {
        repositoryId: mockRepositoryId,
        branch: 'main',
      });

      expect(repoIndexDao.restoreById).toHaveBeenCalledWith('index-123');
      expect(repoIndexDao.updateById).toHaveBeenCalledWith(
        'index-123',
        expect.objectContaining({
          status: RepoIndexStatus.Pending,
          lastIndexedCommit: null,
          estimatedTokens: 0,
        }),
      );
      expect(repoIndexDao.create).not.toHaveBeenCalled();
      expect(result.repoIndex.status).toBe(RepoIndexStatus.Pending);
    });
  });

  describe('deleteRepositoriesByInstallationIds', () => {
    it('should return 0 when installationIds is empty', async () => {
      const result = await service.deleteRepositoriesByInstallationIds(
        mockUserId,
        [],
      );

      expect(result).toBe(0);
      expect(dao.getAll).not.toHaveBeenCalled();
    });

    it('should delete all repos matching the given installation IDs', async () => {
      const repo1 = createMockRepositoryEntity({
        id: 'repo-1',
        installationId: 100,
      } as Partial<GitRepositoryEntity>);
      const repo2 = createMockRepositoryEntity({
        id: 'repo-2',
        installationId: 200,
      } as Partial<GitRepositoryEntity>);

      vi.spyOn(dao, 'getAll').mockResolvedValue([repo1, repo2]);
      vi.spyOn(repoIndexDao, 'getAll').mockResolvedValue([]);
      vi.spyOn(dao, 'deleteById').mockResolvedValue(undefined);

      const result = await service.deleteRepositoriesByInstallationIds(
        mockUserId,
        [100, 200],
      );

      expect(dao.getAll).toHaveBeenCalledWith({
        createdBy: mockUserId,
        installationId: { $in: [100, 200] },
      });
      expect(dao.deleteById).toHaveBeenCalledTimes(2);
      expect(dao.deleteById).toHaveBeenCalledWith('repo-1');
      expect(dao.deleteById).toHaveBeenCalledWith('repo-2');
      expect(result).toBe(2);
    });

    it('should cleanup Qdrant collections and BullMQ jobs before deleting', async () => {
      const repo = createMockRepositoryEntity({
        id: 'repo-1',
        installationId: 100,
      } as Partial<GitRepositoryEntity>);
      const mockIndex = {
        id: 'index-1',
        repositoryId: 'repo-1',
        qdrantCollection: 'col-test',
      };

      vi.spyOn(dao, 'getAll').mockResolvedValue([repo]);
      vi.spyOn(repoIndexDao, 'getAll').mockResolvedValue([mockIndex as any]);
      vi.spyOn(qdrantService, 'deleteCollection').mockResolvedValue(undefined);
      vi.spyOn(dao, 'deleteById').mockResolvedValue(undefined);

      await service.deleteRepositoriesByInstallationIds(mockUserId, [100]);

      expect(repoIndexQueueService.removeJob).toHaveBeenCalledWith('index-1');
      expect(qdrantService.deleteCollection).toHaveBeenCalledWith('col-test');
      expect(repoIndexDao.hardDelete).toHaveBeenCalledWith({
        repositoryId: 'repo-1',
      });
      expect(dao.deleteById).toHaveBeenCalledWith('repo-1');
    });

    it('should return 0 when no repos match the installation IDs', async () => {
      vi.spyOn(dao, 'getAll').mockResolvedValue([]);

      const result = await service.deleteRepositoriesByInstallationIds(
        mockUserId,
        [999],
      );

      expect(result).toBe(0);
      expect(dao.deleteById).not.toHaveBeenCalled();
    });
  });

  describe('syncRepositories', () => {
    const mockInstallation = {
      id: 'install-uuid-1',
      userId: mockUserId,
      provider: 'github',
      isActive: true,
      accountLogin: 'octocat',
      metadata: { installationId: 12345, accountType: 'User' },
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z'),
      deletedAt: null,
    };

    const mockGithubRepo = {
      owner: { login: 'octocat' },
      name: 'Hello-World',
      html_url: 'https://github.com/octocat/Hello-World',
      default_branch: 'main',
    };

    it('returns zeros when no active installations exist', async () => {
      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([]);

      const result = await service.syncRepositories(mockCtx);

      expect(result).toEqual({ synced: 0, removed: 0, total: 0 });
      expect(dao.upsertGithubSyncRepos).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when GitHub App is not configured', async () => {
      vi.spyOn(gitHubAppProviderService, 'isConfigured').mockReturnValue(false);

      await expect(service.syncRepositories(mockCtx)).rejects.toThrow(
        'GITHUB_APP_NOT_CONFIGURED',
      );
    });

    it('throws BadRequestException when sync is already in progress for the same user', async () => {
      // Access private field via type assertion to simulate in-progress sync
      (
        service as unknown as { syncInProgress: Set<string> }
      ).syncInProgress.add(mockUserId);

      try {
        await expect(service.syncRepositories(mockCtx)).rejects.toThrow(
          'SYNC_ALREADY_IN_PROGRESS',
        );
      } finally {
        (
          service as unknown as { syncInProgress: Set<string> }
        ).syncInProgress.delete(mockUserId);
      }
    });

    it('soft-deletes repos with installationId that are no longer returned by GitHub', async () => {
      const revokedRepo = createMockRepositoryEntity({
        id: 'revoked-repo-id',
        owner: 'octocat',
        repo: 'OldRepo',
        installationId: 12345,
      } as Partial<GitRepositoryEntity>);

      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([mockInstallation as any]);
      vi.spyOn(gitHubAppService, 'getInstallationToken').mockResolvedValue(
        'ghs_token123',
      );
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ total_count: 0, repositories: [] }),
        headers: { get: () => null },
      } as unknown as Response);
      vi.spyOn(dao, 'getAll').mockResolvedValue([revokedRepo]);
      vi.spyOn(repoIndexDao, 'getAll').mockResolvedValue([]);
      vi.spyOn(dao, 'deleteById').mockResolvedValue(undefined);
      vi.spyOn(dao, 'count').mockResolvedValue(0);

      const result = await service.syncRepositories(mockCtx);

      expect(dao.deleteById).toHaveBeenCalledWith('revoked-repo-id');
      expect(result).toEqual({ synced: 0, removed: 1, total: 0 });
    });

    it('does not soft-delete repos with installationId = null (PAT repos)', async () => {
      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([mockInstallation as any]);
      vi.spyOn(gitHubAppService, 'getInstallationToken').mockResolvedValue(
        'ghs_token123',
      );
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ total_count: 0, repositories: [] }),
        headers: { get: () => null },
      } as unknown as Response);
      // getAll with hasInstallationId: true returns only repos with installationId — PAT repo is excluded
      vi.spyOn(dao, 'getAll').mockResolvedValue([]);
      vi.spyOn(dao, 'count').mockResolvedValue(1);

      await service.syncRepositories(mockCtx);

      expect(dao.deleteById).not.toHaveBeenCalled();
    });

    it('calls cleanup (removeJob + deleteCollection) before deleteById when sync removes a repo', async () => {
      const revokedRepo = createMockRepositoryEntity({
        id: 'revoked-repo-id',
        owner: 'octocat',
        repo: 'OldRepo',
        installationId: 12345,
      } as Partial<GitRepositoryEntity>);

      const mockIndexes = [
        {
          id: 'idx-1',
          repositoryId: 'revoked-repo-id',
          qdrantCollection: 'col-revoked',
        },
      ];

      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([
        {
          id: 'install-uuid-1',
          userId: mockUserId,
          provider: 'github',
          isActive: true,
          accountLogin: 'octocat',
          metadata: { installationId: 12345, accountType: 'User' },
          createdAt: new Date('2024-01-01T00:00:00Z'),
          updatedAt: new Date('2024-01-01T00:00:00Z'),
          deletedAt: null,
        } as any,
      ]);
      vi.spyOn(gitHubAppService, 'getInstallationToken').mockResolvedValue(
        'ghs_token123',
      );
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ total_count: 0, repositories: [] }),
        headers: { get: () => null },
      } as unknown as Response);
      vi.spyOn(dao, 'getAll').mockResolvedValue([revokedRepo]);
      vi.spyOn(repoIndexDao, 'getAll').mockResolvedValue(mockIndexes as any);
      vi.spyOn(qdrantService, 'deleteCollection').mockResolvedValue(undefined);
      vi.spyOn(dao, 'deleteById').mockResolvedValue(undefined);
      vi.spyOn(dao, 'count').mockResolvedValue(0);

      await service.syncRepositories(mockCtx);

      // Verify cleanup was called
      expect(repoIndexQueueService.removeJob).toHaveBeenCalledWith('idx-1');
      expect(qdrantService.deleteCollection).toHaveBeenCalledWith(
        'col-revoked',
      );
      expect(dao.deleteById).toHaveBeenCalledWith('revoked-repo-id');

      // Verify ordering: cleanup before delete
      const removeJobOrder = vi.mocked(repoIndexQueueService.removeJob).mock
        .invocationCallOrder[0]!;
      const deleteCollectionOrder = vi.mocked(qdrantService.deleteCollection)
        .mock.invocationCallOrder[0]!;
      const deleteByIdOrder = vi.mocked(dao.deleteById).mock
        .invocationCallOrder[0]!;

      expect(removeJobOrder).toBeLessThan(deleteByIdOrder);
      expect(deleteCollectionOrder).toBeLessThan(deleteByIdOrder);
    });

    it('auto-deactivates installation when getInstallationToken fails during sync', async () => {
      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([mockInstallation as any]);
      vi.spyOn(gitHubAppService, 'getInstallationToken').mockRejectedValue(
        new Error('Bad credentials'),
      );
      vi.spyOn(dao, 'getAll').mockResolvedValue([]);
      vi.spyOn(dao, 'count').mockResolvedValue(0);

      const result = await service.syncRepositories(mockCtx);

      expect(
        gitHubAppProviderService.deactivateByInstallationId,
      ).toHaveBeenCalledWith(mockUserId, 12345);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('auto-deactivating'),
      );
      expect(result).toEqual({ synced: 0, removed: 0, total: 0 });
    });

    it('continues syncing remaining installations after one is auto-deactivated', async () => {
      const deadInstallation = {
        ...mockInstallation,
        id: 'install-dead',
        metadata: { installationId: 99999, accountType: 'Organization' },
      };
      const healthyInstallation = {
        ...mockInstallation,
        id: 'install-healthy',
        metadata: { installationId: 12345, accountType: 'User' },
      };

      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([
        deadInstallation as any,
        healthyInstallation as any,
      ]);
      vi.spyOn(gitHubAppService, 'getInstallationToken')
        .mockRejectedValueOnce(new Error('Bad credentials'))
        .mockResolvedValueOnce('ghs_token123');
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ total_count: 1, repositories: [mockGithubRepo] }),
        headers: { get: () => null },
      } as unknown as Response);
      vi.spyOn(dao, 'upsertGithubSyncRepos').mockResolvedValue(undefined);
      vi.spyOn(dao, 'restoreSoftDeleted').mockResolvedValue(undefined);
      vi.spyOn(dao, 'getAll').mockResolvedValue([]);
      vi.spyOn(dao, 'count').mockResolvedValue(1);

      const result = await service.syncRepositories(mockCtx);

      expect(
        gitHubAppProviderService.deactivateByInstallationId,
      ).toHaveBeenCalledWith(mockUserId, 99999);
      expect(dao.upsertGithubSyncRepos).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ synced: 1, removed: 0, total: 1 });
    });

    it('auto-deactivates installation when repository listing returns not found during sync', async () => {
      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([mockInstallation as any]);
      vi.spyOn(gitHubAppService, 'getInstallationToken').mockResolvedValue(
        'ghs_token123',
      );
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 404,
        headers: { get: () => null },
      } as unknown as Response);
      vi.spyOn(dao, 'getAll').mockResolvedValue([]);
      vi.spyOn(dao, 'count').mockResolvedValue(0);

      const result = await service.syncRepositories(mockCtx);

      expect(
        gitHubAppProviderService.deactivateByInstallationId,
      ).toHaveBeenCalledWith(mockUserId, 12345);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('repository listing failed with status 404'),
      );
      expect(result).toEqual({ synced: 0, removed: 0, total: 0 });
    });

    it('continues syncing healthy installations when another installation listing is inaccessible', async () => {
      const deadInstallation = {
        ...mockInstallation,
        id: 'install-dead',
        metadata: { installationId: 99999, accountType: 'Organization' },
      };
      const healthyInstallation = {
        ...mockInstallation,
        id: 'install-healthy',
        metadata: { installationId: 12345, accountType: 'User' },
      };

      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([
        deadInstallation as any,
        healthyInstallation as any,
      ]);
      vi.spyOn(gitHubAppService, 'getInstallationToken')
        .mockResolvedValueOnce('ghs_dead_token')
        .mockResolvedValueOnce('ghs_token123');
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          headers: { get: () => '10' },
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            total_count: 1,
            repositories: [mockGithubRepo],
          }),
          headers: { get: () => null },
        } as unknown as Response);
      vi.spyOn(dao, 'upsertGithubSyncRepos').mockResolvedValue(undefined);
      vi.spyOn(dao, 'restoreSoftDeleted').mockResolvedValue(undefined);
      vi.spyOn(dao, 'getAll').mockResolvedValue([]);
      vi.spyOn(dao, 'count').mockResolvedValue(1);

      const result = await service.syncRepositories(mockCtx);

      expect(
        gitHubAppProviderService.deactivateByInstallationId,
      ).toHaveBeenCalledWith(mockUserId, 99999);
      expect(dao.upsertGithubSyncRepos).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ synced: 1, removed: 0, total: 1 });
    });

    it('throws when GitHub rate limits repository listing', async () => {
      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([mockInstallation as any]);
      vi.spyOn(gitHubAppService, 'getInstallationToken').mockResolvedValue(
        'ghs_token123',
      );
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 403,
        headers: {
          get: (name: string) =>
            name === 'x-ratelimit-remaining' ? '0' : null,
        },
      } as unknown as Response);

      await expect(service.syncRepositories(mockCtx)).rejects.toThrow(
        'GITHUB_RATE_LIMITED',
      );
      expect(
        gitHubAppProviderService.deactivateByInstallationId,
      ).not.toHaveBeenCalled();
    });

    it('does not trigger indexing after successful sync', async () => {
      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([mockInstallation as any]);
      vi.spyOn(gitHubAppService, 'getInstallationToken').mockResolvedValue(
        'ghs_token123',
      );
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ total_count: 1, repositories: [mockGithubRepo] }),
        headers: { get: () => null },
      } as unknown as Response);
      vi.spyOn(dao, 'upsertGithubSyncRepos').mockResolvedValue(undefined);
      vi.spyOn(dao, 'restoreSoftDeleted').mockResolvedValue(undefined);
      vi.spyOn(dao, 'getAll').mockResolvedValue([]);
      vi.spyOn(dao, 'count').mockResolvedValue(1);

      await service.syncRepositories(mockCtx);

      expect(repoIndexQueueService.addIndexJob).not.toHaveBeenCalled();
    });

    it('aggregates repos from multiple installations into a single upsertMany call', async () => {
      const installation1 = {
        ...mockInstallation,
        id: 'install-uuid-1',
        metadata: { installationId: 11111, accountType: 'User' },
      };
      const installation2 = {
        ...mockInstallation,
        id: 'install-uuid-2',
        metadata: { installationId: 22222, accountType: 'User' },
      };

      const reposForInstallation1 = [
        {
          owner: { login: 'org-a' },
          name: 'repo-1',
          html_url: 'https://github.com/org-a/repo-1',
          default_branch: 'main',
        },
        {
          owner: { login: 'org-a' },
          name: 'repo-2',
          html_url: 'https://github.com/org-a/repo-2',
          default_branch: 'main',
        },
        {
          owner: { login: 'org-a' },
          name: 'repo-3',
          html_url: 'https://github.com/org-a/repo-3',
          default_branch: 'main',
        },
      ];
      const reposForInstallation2 = [
        {
          owner: { login: 'org-b' },
          name: 'repo-4',
          html_url: 'https://github.com/org-b/repo-4',
          default_branch: 'develop',
        },
        {
          owner: { login: 'org-b' },
          name: 'repo-5',
          html_url: 'https://github.com/org-b/repo-5',
          default_branch: 'develop',
        },
        {
          owner: { login: 'org-b' },
          name: 'repo-6',
          html_url: 'https://github.com/org-b/repo-6',
          default_branch: 'develop',
        },
      ];

      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([installation1 as any, installation2 as any]);
      vi.spyOn(gitHubAppService, 'getInstallationToken').mockResolvedValue(
        'ghs_token123',
      );

      let fetchCallCount = 0;
      vi.spyOn(global, 'fetch').mockImplementation(async () => {
        fetchCallCount++;
        const repos =
          fetchCallCount === 1 ? reposForInstallation1 : reposForInstallation2;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_count: repos.length,
            repositories: repos,
          }),
          headers: { get: () => null },
        } as unknown as Response;
      });

      vi.spyOn(dao, 'upsertGithubSyncRepos').mockResolvedValue(undefined);
      vi.spyOn(dao, 'restoreSoftDeleted').mockResolvedValue(undefined);
      vi.spyOn(dao, 'getAll').mockResolvedValue([]);
      vi.spyOn(dao, 'count').mockResolvedValue(6);

      const result = await service.syncRepositories(mockCtx);

      expect(dao.upsertGithubSyncRepos).toHaveBeenCalledTimes(1);

      const upsertArgs = vi.mocked(dao.upsertGithubSyncRepos).mock.calls[0]![0];
      expect(upsertArgs).toHaveLength(6);

      const installationIds = upsertArgs.map((r) => r.installationId);
      expect(installationIds.filter((id) => id === 11111)).toHaveLength(3);
      expect(installationIds.filter((id) => id === 22222)).toHaveLength(3);

      const reposForInstall1 = upsertArgs.filter(
        (r) => r.installationId === 11111,
      );
      expect(reposForInstall1.map((r) => r.repo).sort()).toEqual([
        'repo-1',
        'repo-2',
        'repo-3',
      ]);
      expect(reposForInstall1[0]!.owner).toBe('org-a');

      const reposForInstall2 = upsertArgs.filter(
        (r) => r.installationId === 22222,
      );
      expect(reposForInstall2.map((r) => r.repo).sort()).toEqual([
        'repo-4',
        'repo-5',
        'repo-6',
      ]);
      expect(reposForInstall2[0]!.owner).toBe('org-b');

      for (const entry of upsertArgs) {
        expect(entry.provider).toBe(GitRepositoryProvider.GITHUB);
        expect(entry.createdBy).toBe(mockUserId);
        expect(entry.projectId).toBeNull();
      }

      expect(result).toEqual({ synced: 6, removed: 0, total: 6 });
    });
  });

  describe('onInstallationUnlinked', () => {
    it('should call deleteRepositoriesByInstallationIds when INSTALLATION_UNLINKED_EVENT fires', async () => {
      const spy = vi
        .spyOn(service, 'deleteRepositoriesByInstallationIds')
        .mockResolvedValue(2);
      await service.onInstallationUnlinked({
        userId: 'mock-user-id',
        provider: GitProvider.GitHub,
        connectionIds: ['conn-1'],
        accountLogins: ['my-org'],
        githubInstallationIds: [12345],
      });
      expect(spy).toHaveBeenCalledWith('mock-user-id', [12345]);
    });
  });

  describe('per-user PAT sync', () => {
    beforeEach(() => {
      gitUserPatMock.resolvePatToken.mockResolvedValue('ghp_user_token');
    });

    it('does NOT throw GITHUB_APP_NOT_CONFIGURED when the user has a PAT but the App is unconfigured, and prunes ONLY the user own Pat rows', async () => {
      vi.mocked(gitHubAppProviderService.isConfigured).mockReturnValue(false);
      vi.mocked(dao.getAll).mockResolvedValue([]);
      vi.mocked(dao.count).mockResolvedValue(0);
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [],
        headers: { get: () => null },
      } as unknown as Response);

      await expect(service.syncRepositories(mockCtx)).resolves.toEqual({
        synced: 0,
        removed: 0,
        total: 0,
      });

      // The orphan-prune is scoped strictly to the requesting user's PAT-synced
      // rows (createdBy AND syncSource=Pat AND installationId IS NULL) — never a
      // cross-user / cross-source delete. The installationId predicate is the
      // belt-and-braces guard that an App row sharing this user's createdBy is
      // never enumerated for pruning even if mislabeled.
      expect(dao.getAll).toHaveBeenCalledWith({
        createdBy: mockUserId,
        syncSource: GitHubAuthMethod.Pat,
        installationId: null,
      });
      expect(dao.count).toHaveBeenCalledWith({ createdBy: mockUserId });

      fetchSpy.mockRestore();
    });

    it('upserts synced repos under the requesting user createdBy with syncSource Pat', async () => {
      vi.mocked(gitHubAppProviderService.isConfigured).mockReturnValue(false);
      vi.mocked(dao.getAll).mockResolvedValue([]);
      vi.mocked(dao.count).mockResolvedValue(1);
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [
          {
            owner: { login: 'octo' },
            name: 'hello',
            html_url: 'https://github.com/octo/hello',
            default_branch: 'main',
          },
        ],
        headers: { get: () => null },
      } as unknown as Response);

      await service.syncRepositories(mockCtx);

      // mergeSource:false — the PAT upsert must never relabel an App row that
      // shares this user's (owner, repo, createdBy, provider).
      expect(dao.upsertGithubSyncRepos).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            owner: 'octo',
            repo: 'hello',
            createdBy: mockUserId,
            installationId: null,
            syncSource: GitHubAuthMethod.Pat,
          }),
        ],
        { mergeSource: false },
      );

      fetchSpy.mockRestore();
    });

    it('fails CLOSED when the stored PAT is present-but-unreadable (resolvePatToken throws)', async () => {
      gitUserPatMock.resolvePatToken.mockRejectedValue(
        new InternalException(
          'GITHUB_USER_PAT_UNREADABLE',
          'stored PAT present but unreadable',
        ),
      );

      await expect(service.syncRepositories(mockCtx)).rejects.toThrow(
        InternalException,
      );
    });

    it('does NOT prune an existing PAT repo when /user/repos pagination is truncated at the page cap', async () => {
      // /user/repos returns 100 FULL pages (each exactly PER_PAGE=100 repos),
      // which drives the loop to its MAX_PAGES=100 defensive bound and exits
      // with the listing truncated — none of the user's repos beyond page 100
      // are in the synced set. A real account with >10k accessible repos hits
      // this on every sync.
      const PER_PAGE = 100;
      const MAX_PAGES = 100;
      const fullPage = (pageNum: number) =>
        Array.from({ length: PER_PAGE }, (_, i) => ({
          owner: { login: 'big-org' },
          name: `repo-p${pageNum}-${i}`,
          html_url: `https://github.com/big-org/repo-p${pageNum}-${i}`,
          default_branch: 'main',
        }));
      let pageCounter = 0;
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockImplementation(async () => {
          pageCounter += 1;
          return {
            ok: true,
            status: 200,
            // Always a full page → the loop never short-circuits and runs the
            // full MAX_PAGES iterations, hitting the truncation bound.
            json: async () => fullPage(pageCounter),
            headers: { get: () => null },
          } as unknown as Response;
        });

      // The user already has a PAT-synced repo that lives beyond the page cap,
      // so it is NOT in the (truncated) synced set this run returned. Its Qdrant
      // collections + BullMQ jobs are hard-deleted by cleanupRepositoryResourcesById
      // on prune — an IRREVERSIBLE delete. On a truncated listing it must survive.
      const beyondCapRepo = createMockRepositoryEntity({
        id: 'beyond-cap-repo',
        owner: 'big-org',
        repo: 'repo-on-page-101',
        installationId: null,
        syncSource: GitHubAuthMethod.Pat,
      });
      vi.mocked(dao.getAll).mockResolvedValue([beyondCapRepo]);
      vi.mocked(dao.count).mockResolvedValue(1);
      // Let cleanupRepositoryResourcesById complete cleanly if it is reached, so
      // the prune (deleteById) assertion below is what catches the bug — not an
      // unmocked-dependency TypeError inside the cleanup step.
      vi.mocked(repoIndexDao.getAll).mockResolvedValue([]);

      await service.syncRepositories(mockCtx);

      // The listing was truncated, so the absence of repo-on-page-101 from the
      // synced set is NOT proof it was revoked — pruning it destroys live data.
      expect(dao.deleteById).not.toHaveBeenCalledWith('beyond-cap-repo');

      // Confirm the test actually drove the loop to the page cap (guards against
      // the assertion passing because the loop exited early for another reason).
      expect(pageCounter).toBe(MAX_PAGES);

      fetchSpy.mockRestore();
    });
  });
});
