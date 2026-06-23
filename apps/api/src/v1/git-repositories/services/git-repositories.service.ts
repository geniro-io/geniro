import type { FilterQuery } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  BadRequestException,
  DefaultLogger,
  InternalException,
  NotFoundException,
} from '@packages/common';

import { AppContextStorage } from '../../../auth/app-context-storage';
import type { InstallationUnlinkedEvent } from '../../git-auth/git-auth.types';
import { INSTALLATION_UNLINKED_EVENT } from '../../git-auth/git-auth.types';
import { GitPatModeService } from '../../git-auth/services/git-pat-mode.service';
import { GitHubAppService } from '../../git-auth/services/github-app.service';
import { GitHubAppProviderService } from '../../git-auth/services/github-app-provider.service';
import { GitHubAuthMethod } from '../../graph-resources/graph-resources.types';
import { ProjectsDao } from '../../projects/dao/projects.dao';
import { QdrantService } from '../../qdrant/services/qdrant.service';
import { GitRepositoriesDao } from '../dao/git-repositories.dao';
import { RepoIndexDao } from '../dao/repo-index.dao';
import {
  CreateRepository,
  GetRepoIndexesQueryDto,
  GetRepositoriesQueryDto,
  GitRepositoryDto,
  RepoIndexDto,
  SyncRepositoriesResponse,
  TriggerReindex,
  TriggerReindexResponse,
  UpdateRepository,
} from '../dto/git-repositories.dto';
import { GitRepositoryEntity } from '../entity/git-repository.entity';
import { RepoIndexEntity } from '../entity/repo-index.entity';
import {
  GitRepositoryProvider,
  PAT_DEPLOYMENT_OWNER,
  RepoIndexStatus,
} from '../git-repositories.types';
import { RepoIndexQueueService } from './repo-index-queue.service';
import { RepoIndexerService } from './repo-indexer.service';

@Injectable()
export class GitRepositoriesService {
  private readonly syncInProgress = new Set<string>();

  constructor(
    private readonly gitRepositoriesDao: GitRepositoriesDao,
    private readonly repoIndexDao: RepoIndexDao,
    private readonly repoIndexQueueService: RepoIndexQueueService,
    private readonly repoIndexerService: RepoIndexerService,
    private readonly qdrantService: QdrantService,
    private readonly logger: DefaultLogger,
    private readonly projectsDao: ProjectsDao,
    private readonly gitHubAppProviderService: GitHubAppProviderService,
    private readonly gitHubAppService: GitHubAppService,
    private readonly gitPatModeService: GitPatModeService,
  ) {}

  /**
   * Ownership scope for git_repositories rows.
   *
   * Single-source-of-truth policy: in `app` mode rows are per-user
   * (`createdBy = <requesting user>`), the existing behaviour. In `pat` mode the
   * deployment is a SINGLE shared GitHub identity (the operator's PAT), so all
   * repository rows — synced or manually added — live under a fixed deployment
   * sentinel (`PAT_DEPLOYMENT_OWNER`) and every read/write resolves to it
   * regardless of which authenticated user issues the request. This is a
   * deliberate, mode-scoped deviation from the api-security per-user `createdBy`
   * ownership rule: the PAT's repos are intrinsically deployment-wide, so a
   * per-user scope would both duplicate rows (one set per user who syncs) and
   * hide synced repos from every other user. Requests are still authenticated
   * (`ctx.checkSub()`); only the data-ownership key is widened to the
   * deployment.
   *
   * ACCEPTED CONSEQUENCE (security): because the widening applies to every
   * read AND write — including `deleteRepository` (which hard-deletes the repo's
   * Qdrant collections + BullMQ jobs) and `triggerReindex` — in `pat` mode ANY
   * authenticated user can manage (incl. irreversibly delete) ANY repository in
   * the shared deployment set, and `projectId` no longer isolates repo
   * management. This is intentional under the "single shared deployment
   * identity" model and was approved at plan/implement time; it is NOT a
   * per-user/per-project ownership model. If a deployment needs per-project
   * isolation of destructive ops, scope `deleteRepository`/`triggerReindex` by
   * `ctx.checkProjectId()` in addition to this sentinel (note: synced rows carry
   * `projectId = null`, so such scoping would only bind manually-added repos).
   */
  private resolveRepoScope(userId: string): string {
    return this.gitPatModeService.isPatMode() ? PAT_DEPLOYMENT_OWNER : userId;
  }

  // Internal event only — emitted by GitHubAppProviderService after verifying ownership.
  // The userId filter in deleteRepositoriesByInstallationIds is defense-in-depth.
  @OnEvent(INSTALLATION_UNLINKED_EVENT)
  async onInstallationUnlinked(
    event: InstallationUnlinkedEvent,
  ): Promise<void> {
    await this.deleteRepositoriesByInstallationIds(
      event.userId,
      event.githubInstallationIds,
    );
  }

  async createRepository(
    ctx: AppContextStorage,
    data: CreateRepository,
  ): Promise<GitRepositoryDto> {
    const userId = ctx.checkSub();
    const projectId = ctx.checkProjectId();

    const project = await this.projectsDao.getOne({
      id: projectId,
      createdBy: userId,
    });
    if (!project) {
      throw new NotFoundException('PROJECT_NOT_FOUND');
    }

    const created = await this.gitRepositoriesDao.create({
      owner: data.owner,
      repo: data.repo,
      url: data.url,
      provider: data.provider,
      defaultBranch: data.defaultBranch ?? 'main',
      createdBy: this.resolveRepoScope(userId),
      projectId,
      installationId: null,
      syncedAt: null,
    });

    return this.prepareRepositoryResponse(created);
  }

  async updateRepository(
    ctx: AppContextStorage,
    id: string,
    data: UpdateRepository,
  ): Promise<GitRepositoryDto> {
    const userId = ctx.checkSub();

    const existing = await this.gitRepositoriesDao.getOne({
      id,
      createdBy: this.resolveRepoScope(userId),
    });

    if (!existing) {
      throw new NotFoundException('REPOSITORY_NOT_FOUND');
    }

    const updatePayload: Record<string, unknown> = {};
    if (data.url) {
      updatePayload.url = data.url;
    }
    if (data.defaultBranch) {
      updatePayload.defaultBranch = data.defaultBranch;
    }

    // If nothing changed, return existing entity without a DB write
    if (Object.keys(updatePayload).length === 0) {
      return this.prepareRepositoryResponse(existing);
    }

    const updated = await this.gitRepositoriesDao.updateAndReturn(
      id,
      updatePayload as Partial<GitRepositoryEntity>,
    );

    return this.prepareRepositoryResponse(updated);
  }

  async getRepositories(
    ctx: AppContextStorage,
    query: GetRepositoriesQueryDto,
  ): Promise<GitRepositoryDto[]> {
    const userId = ctx.checkSub();

    const whereParams: FilterQuery<GitRepositoryEntity> = {
      createdBy: this.resolveRepoScope(userId),
    };
    if (query.owner) {
      whereParams.owner = query.owner;
    }
    if (query.repo) {
      whereParams.repo = query.repo;
    }
    if (query.provider) {
      whereParams.provider = query.provider;
    }
    if (query.installationId !== undefined) {
      whereParams.installationId = query.installationId;
    }

    const repositories = await this.gitRepositoriesDao.getAll(whereParams, {
      limit: query.limit,
      offset: query.offset,
      orderBy: { createdAt: 'DESC' },
    });

    return repositories.map((repo) => this.prepareRepositoryResponse(repo));
  }

  async getRepositoryById(
    ctx: AppContextStorage,
    id: string,
  ): Promise<GitRepositoryDto> {
    const userId = ctx.checkSub();

    const repository = await this.gitRepositoriesDao.getOne({
      id,
      createdBy: this.resolveRepoScope(userId),
    });

    if (!repository) {
      throw new NotFoundException('REPOSITORY_NOT_FOUND');
    }

    return this.prepareRepositoryResponse(repository);
  }

  async deleteRepository(ctx: AppContextStorage, id: string): Promise<void> {
    const userId = ctx.checkSub();

    // Verify repository exists and belongs to user
    const repository = await this.gitRepositoriesDao.getOne({
      id,
      createdBy: this.resolveRepoScope(userId),
    });

    if (!repository) {
      throw new NotFoundException('REPOSITORY_NOT_FOUND');
    }

    await this.cleanupRepositoryResourcesById(id);

    // Delete the repository (CASCADE will delete repo_indexes rows)
    await this.gitRepositoriesDao.deleteById(id);
  }

  async getRepoIndexes(
    ctx: AppContextStorage,
    query: GetRepoIndexesQueryDto,
  ): Promise<RepoIndexDto[]> {
    const userId = ctx.checkSub();

    // If repositoryId is provided, verify it belongs to the user
    if (query.repositoryId) {
      const repository = await this.gitRepositoriesDao.getOne({
        id: query.repositoryId,
        createdBy: this.resolveRepoScope(userId),
      });

      if (!repository) {
        throw new NotFoundException('REPOSITORY_NOT_FOUND');
      }
    }

    // Fetch only the IDs of user-owned repos for a DB-level IN filter,
    // rather than loading full entities and filtering in memory.
    const userRepos = await this.gitRepositoriesDao.getAll(
      { createdBy: this.resolveRepoScope(userId) },
      { fields: ['id'] },
    );

    const userRepoIds = userRepos.map((repo) => repo.id);
    if (userRepoIds.length === 0) {
      return [];
    }

    // Build search params — filter by repositoryIds at the DB level
    const repoIndexWhere: FilterQuery<RepoIndexEntity> = {};

    if (query.repositoryId) {
      repoIndexWhere.repositoryId = query.repositoryId;
    } else {
      repoIndexWhere.repositoryId = { $in: userRepoIds };
    }

    if (query.branches && query.branches.length > 0) {
      repoIndexWhere.branch = { $in: query.branches };
    } else if (query.branch) {
      repoIndexWhere.branch = query.branch;
    }

    if (query.status) {
      repoIndexWhere.status = query.status as RepoIndexStatus;
    }

    const indexes = await this.repoIndexDao.getAll(repoIndexWhere, {
      limit: query.limit,
      offset: query.offset,
      orderBy: { createdAt: 'DESC' },
    });

    return indexes.map((index) => this.prepareRepoIndexResponse(index));
  }

  async getRepoIndexByRepositoryId(
    ctx: AppContextStorage,
    repositoryId: string,
    branch?: string,
  ): Promise<RepoIndexDto | null> {
    const userId = ctx.checkSub();

    // Verify repository belongs to user
    const repository = await this.gitRepositoriesDao.getOne({
      id: repositoryId,
      createdBy: this.resolveRepoScope(userId),
    });

    if (!repository) {
      throw new NotFoundException('REPOSITORY_NOT_FOUND');
    }

    let index: RepoIndexEntity | null;
    if (branch) {
      index = await this.repoIndexDao.getOne({
        repositoryId,
        branch,
      });
    } else {
      // No branch specified — return the most recently updated index
      const indexes = await this.repoIndexDao.getAll(
        { repositoryId },
        { limit: 1, orderBy: { updatedAt: 'DESC' } },
      );
      index = indexes[0] ?? null;
    }

    if (!index) {
      return null;
    }

    return this.prepareRepoIndexResponse(index);
  }

  async triggerReindex(
    ctx: AppContextStorage,
    data: TriggerReindex,
  ): Promise<TriggerReindexResponse> {
    const userId = ctx.checkSub();

    // Verify repository belongs to user
    const repository = await this.gitRepositoriesDao.getOne({
      id: data.repositoryId,
      createdBy: this.resolveRepoScope(userId),
    });

    if (!repository) {
      throw new NotFoundException('REPOSITORY_NOT_FOUND');
    }

    const branch = data.branch ?? repository.defaultBranch;
    // Normalize so the Qdrant repo_id is always consistent
    const normalizedRepoUrl = this.repoIndexerService.deriveRepoId(
      repository.url,
    );

    // Check if indexing is already in progress. Include soft-deleted rows
    // so we can restore them instead of hitting a unique constraint violation.
    const existingIndex = await this.repoIndexDao.getOne(
      { repositoryId: data.repositoryId, branch },
      { filters: { softDelete: false } },
    );

    const isSoftDeleted = existingIndex?.deletedAt != null;

    if (
      existingIndex &&
      !isSoftDeleted &&
      (existingIndex.status === RepoIndexStatus.InProgress ||
        existingIndex.status === RepoIndexStatus.Pending)
    ) {
      throw new BadRequestException('INDEXING_ALREADY_IN_PROGRESS');
    }

    // Calculate metadata fields upfront so they're available immediately
    const { embeddingModel, vectorSize, chunkingSignatureHash, collection } =
      await this.repoIndexerService.calculateIndexMetadata(
        data.repositoryId,
        branch,
      );

    // Reset the index to pending status and enqueue
    let repoIndex: RepoIndexEntity;

    if (existingIndex) {
      // Restore soft-deleted row before updating
      if (isSoftDeleted) {
        await this.repoIndexDao.restoreById(existingIndex.id);
      }
      // Reset existing index with calculated metadata
      // Keep previous estimatedTokens as a rough estimate until new calculation completes
      await this.repoIndexDao.updateById(existingIndex.id, {
        repoUrl: normalizedRepoUrl,
        status: RepoIndexStatus.Pending,
        qdrantCollection: collection,
        embeddingModel,
        vectorSize,
        chunkingSignatureHash,
        errorMessage: null,
        indexedTokens: 0,
        lastIndexedCommit: null,
        // Preserve estimatedTokens from previous index as initial estimate
        estimatedTokens: isSoftDeleted ? 0 : existingIndex.estimatedTokens,
      });
      repoIndex = {
        ...existingIndex,
        deletedAt: null,
        repoUrl: normalizedRepoUrl,
        status: RepoIndexStatus.Pending,
        qdrantCollection: collection,
        embeddingModel,
        vectorSize,
        chunkingSignatureHash,
        errorMessage: null,
        indexedTokens: 0,
        lastIndexedCommit: null,
        estimatedTokens: isSoftDeleted ? 0 : existingIndex.estimatedTokens,
      };
    } else {
      // Create new index entry with calculated metadata
      repoIndex = await this.repoIndexDao.create({
        repositoryId: data.repositoryId,
        repoUrl: normalizedRepoUrl,
        branch,
        status: RepoIndexStatus.Pending,
        qdrantCollection: collection,
        lastIndexedCommit: null,
        embeddingModel,
        vectorSize,
        chunkingSignatureHash,
        estimatedTokens: 0,
        indexedTokens: 0,
        errorMessage: null,
      });
    }

    // Enqueue the indexing job
    await this.repoIndexQueueService.addIndexJob({
      repoIndexId: repoIndex.id,
      repoUrl: normalizedRepoUrl,
      branch,
    });

    return {
      repoIndex: this.prepareRepoIndexResponse(repoIndex),
      message: 'Repository indexing has been queued',
    };
  }

  async syncRepositories(
    ctx: AppContextStorage,
  ): Promise<SyncRepositoriesResponse> {
    const userId = ctx.checkSub();

    const patMode = this.gitPatModeService.isPatMode();

    // In app mode the GitHub App must be configured. In pat mode it need not be
    // (the deployment PAT replaces it); the PAT itself is validated fail-closed
    // inside performPatSync.
    if (!patMode && !this.gitHubAppProviderService.isConfigured()) {
      throw new BadRequestException('GITHUB_APP_NOT_CONFIGURED');
    }

    // In pat mode the sync is deployment-scoped (a single shared identity), so
    // serialize on a fixed key — any user's click drives the same deployment
    // sync and concurrent runs would race on the shared rows. App mode keeps the
    // per-user lock.
    const lockKey = patMode ? PAT_DEPLOYMENT_OWNER : userId;
    if (this.syncInProgress.has(lockKey)) {
      throw new BadRequestException('SYNC_ALREADY_IN_PROGRESS');
    }

    this.syncInProgress.add(lockKey);
    try {
      return await this.performSync(userId);
    } finally {
      this.syncInProgress.delete(lockKey);
    }
  }

  private async performSync(userId: string): Promise<SyncRepositoriesResponse> {
    // PAT mode is deployment-wide and has no installations — take the dedicated
    // path that lists via GET /user/repos. The app-mode body below is unchanged.
    if (this.gitPatModeService.isPatMode()) {
      return await this.performPatSync();
    }

    const installations =
      await this.gitHubAppProviderService.getActiveInstallations(userId);

    this.logger.log(
      `[git-sync] user=${userId} active_installations=${installations.length} installation_ids=${
        installations
          .map(
            (installation) => installation.metadata['installationId'] as number,
          )
          .join(',') || '(none)'
      }`,
    );

    if (installations.length === 0) {
      this.logger.log(
        `[git-sync] user=${userId} no active installations, returning empty sync result`,
      );
      return { synced: 0, removed: 0, total: 0 };
    }

    const syncedAt = new Date();
    const allGithubRepos: {
      owner: string;
      repo: string;
      url: string;
      defaultBranch: string;
      installationId: number;
    }[] = [];

    for (const installation of installations) {
      const ghInstallationId = installation.metadata[
        'installationId'
      ] as number;
      this.logger.log(
        `[git-sync] user=${userId} installation=${ghInstallationId} account=${installation.accountLogin} starting sync`,
      );
      let token: string;
      try {
        token =
          await this.gitHubAppService.getInstallationToken(ghInstallationId);
        this.logger.log(
          `[git-sync] user=${userId} installation=${ghInstallationId} token fetched successfully`,
        );
      } catch (err) {
        this.logger.warn(
          `Installation ${ghInstallationId} token fetch failed, auto-deactivating: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.gitHubAppProviderService.deactivateByInstallationId(
          userId,
          ghInstallationId,
        );
        continue;
      }

      let page = 1;
      let totalCount: number;
      let installationAccessible = true;

      do {
        const response = await fetch(
          `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        );

        this.logger.log(
          `[git-sync] user=${userId} installation=${ghInstallationId} page=${page} github_status=${response.status}`,
        );

        const rateLimitRemaining = response.headers.get(
          'x-ratelimit-remaining',
        );
        if (
          response.status === 429 ||
          (response.status === 403 && rateLimitRemaining === '0')
        ) {
          throw new InternalException('GITHUB_RATE_LIMITED');
        }

        if (!response.ok) {
          this.logger.warn(
            `Installation ${ghInstallationId} repository listing failed with status ${response.status}, auto-deactivating`,
          );
          await this.gitHubAppProviderService.deactivateByInstallationId(
            userId,
            ghInstallationId,
          );
          installationAccessible = false;
          break;
        }

        const data = (await response.json()) as {
          total_count: number;
          repositories: {
            owner: { login: string };
            name: string;
            html_url: string;
            default_branch: string | null;
          }[];
        };

        totalCount = data.total_count;
        this.logger.log(
          `[git-sync] user=${userId} installation=${ghInstallationId} page=${page} repositories_received=${data.repositories.length} total_count=${data.total_count}`,
        );

        for (const ghRepo of data.repositories) {
          allGithubRepos.push({
            owner: ghRepo.owner.login,
            repo: ghRepo.name,
            url: ghRepo.html_url,
            defaultBranch: ghRepo.default_branch ?? 'main',
            installationId: ghInstallationId,
          });
        }

        if (data.repositories.length < 100) {
          break;
        }
        page++;
      } while (allGithubRepos.length < totalCount);

      if (!installationAccessible) {
        continue;
      }

      this.logger.log(
        `[git-sync] user=${userId} installation=${ghInstallationId} completed sync pass`,
      );
    }

    if (allGithubRepos.length > 0) {
      const upsertData = allGithubRepos.map((r) => ({
        owner: r.owner,
        repo: r.repo,
        url: r.url,
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: r.defaultBranch,
        createdBy: userId,
        projectId: null,
        installationId: r.installationId,
        syncSource: GitHubAuthMethod.GithubApp,
        syncedAt,
      }));

      await this.gitRepositoriesDao.upsertGithubSyncRepos(upsertData);

      await this.gitRepositoriesDao.restoreSoftDeleted(
        userId,
        allGithubRepos.map((r) => ({ owner: r.owner, repo: r.repo })),
      );
    }

    const existingRepos = await this.gitRepositoriesDao.getAll({
      createdBy: userId,
      installationId: { $ne: null },
    } as FilterQuery<GitRepositoryEntity>);

    const syncedKeys = new Set(
      allGithubRepos.map((r) => `${r.owner}/${r.repo}`),
    );
    const toRemove = existingRepos.filter(
      (r) => !syncedKeys.has(`${r.owner}/${r.repo}`),
    );

    for (const repo of toRemove) {
      await this.cleanupRepositoryResourcesById(repo.id);
      await this.gitRepositoriesDao.deleteById(repo.id);
    }

    const total = await this.gitRepositoriesDao.count({ createdBy: userId });

    this.logger.log(
      `[git-sync] user=${userId} sync complete synced=${allGithubRepos.length} removed=${toRemove.length} total=${total}`,
    );

    return {
      synced: allGithubRepos.length,
      removed: toRemove.length,
      total,
    };
  }

  /**
   * PAT-mode repository sync. Lists every repository the deployment PAT can see
   * (including org repos the GitHub App cannot reach) via `GET /user/repos` and
   * upserts them under the shared deployment owner so repeated syncs by
   * different users converge on one set of rows (no per-user duplicates). Fails
   * CLOSED when the PAT is missing/invalid (getValidatedPat throws). The
   * mode-scoped orphan-prune is applied after the upsert and targets
   * `syncSource = Pat` rows ONLY — never App-synced or manually-added repos.
   */
  private async performPatSync(): Promise<SyncRepositoriesResponse> {
    // Fail-closed: throws if GITHUB_PAT is missing/invalid (never proceeds to a
    // tokenless listing). The value is a secret and is never logged.
    const pat = this.gitPatModeService.getValidatedPat();
    const syncedAt = new Date();
    const allGithubRepos: {
      owner: string;
      repo: string;
      url: string;
      defaultBranch: string;
    }[] = [];

    // /user/repos returns every repo the PAT can access, including org repos the
    // App is not installed on (the whole point of pat mode). Paginated 100/page.
    const PER_PAGE = 100;
    const MAX_PAGES = 100; // defensive bound: MAX_PAGES * PER_PAGE = 10k repos
    let page = 1;
    while (page <= MAX_PAGES) {
      const response = await fetch(
        `https://api.github.com/user/repos?per_page=${PER_PAGE}&page=${page}&affiliation=owner,collaborator,organization_member`,
        {
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );

      const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
      if (
        response.status === 429 ||
        (response.status === 403 && rateLimitRemaining === '0')
      ) {
        throw new InternalException('GITHUB_RATE_LIMITED');
      }

      if (!response.ok) {
        // Never echo the response body — it can carry token-derived detail.
        throw new InternalException(
          'GITHUB_PAT_REPO_LISTING_FAILED',
          `GET /user/repos failed with status ${response.status} in pat mode`,
        );
      }

      const data = (await response.json()) as unknown;
      if (!Array.isArray(data)) {
        // A 200 with a non-array body is a contract violation — fail loud
        // rather than dereference. Never echo the body (token-derived detail).
        throw new InternalException(
          'GITHUB_PAT_REPO_LISTING_FAILED',
          'GET /user/repos returned an unexpected (non-array) body in pat mode',
        );
      }

      const pageRepos = data as {
        owner: { login: string } | null;
        name: string;
        html_url: string;
        default_branch: string | null;
      }[];

      for (const ghRepo of pageRepos) {
        // Skip malformed elements — a repo whose owner account was deleted can
        // come back with a null owner; skip it rather than throw mid-sync.
        if (
          !ghRepo ||
          typeof ghRepo.name !== 'string' ||
          !ghRepo.owner?.login
        ) {
          continue;
        }
        allGithubRepos.push({
          owner: ghRepo.owner.login,
          repo: ghRepo.name,
          url: ghRepo.html_url,
          defaultBranch: ghRepo.default_branch ?? 'main',
        });
      }

      if (pageRepos.length < PER_PAGE) {
        break;
      }
      page++;
    }

    if (page > MAX_PAGES) {
      this.logger.warn(
        `[git-sync] pat-mode sync hit MAX_PAGES=${MAX_PAGES}; repository list may be truncated`,
      );
    }

    this.logger.log(
      `[git-sync] pat-mode deployment sync repositories_received=${allGithubRepos.length}`,
    );

    if (allGithubRepos.length > 0) {
      const upsertData = allGithubRepos.map((r) => ({
        owner: r.owner,
        repo: r.repo,
        url: r.url,
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: r.defaultBranch,
        createdBy: PAT_DEPLOYMENT_OWNER,
        projectId: null,
        installationId: null,
        syncSource: GitHubAuthMethod.Pat,
        syncedAt,
      }));

      await this.gitRepositoriesDao.upsertGithubSyncRepos(upsertData);

      await this.gitRepositoriesDao.restoreSoftDeleted(
        PAT_DEPLOYMENT_OWNER,
        allGithubRepos.map((r) => ({ owner: r.owner, repo: r.repo })),
      );
    }

    // Mode-scoped orphan-prune. Scoped to (createdBy = sentinel AND
    // syncSource = Pat) so it removes ONLY PAT-synced rows no longer returned by
    // /user/repos. App-synced rows (different createdBy, installationId set) and
    // manually-added rows (syncSource = null) are excluded on both predicates,
    // so flipping GITHUB_AUTH_MODE never triggers the irreversible
    // cleanupRepositoryResourcesById hard-delete (Qdrant collections + BullMQ
    // jobs, outside any transaction) against the other mode's repositories.
    const existingPatRepos = await this.gitRepositoriesDao.getAll({
      createdBy: PAT_DEPLOYMENT_OWNER,
      syncSource: GitHubAuthMethod.Pat,
    });

    const syncedKeys = new Set(
      allGithubRepos.map((r) => `${r.owner}/${r.repo}`),
    );
    const toRemove = existingPatRepos.filter(
      (r) => !syncedKeys.has(`${r.owner}/${r.repo}`),
    );

    for (const repo of toRemove) {
      await this.cleanupRepositoryResourcesById(repo.id);
      await this.gitRepositoriesDao.deleteById(repo.id);
    }
    const removed = toRemove.length;

    const total = await this.gitRepositoriesDao.count({
      createdBy: PAT_DEPLOYMENT_OWNER,
    });

    this.logger.log(
      `[git-sync] pat-mode sync complete synced=${allGithubRepos.length} removed=${removed} total=${total}`,
    );

    return {
      synced: allGithubRepos.length,
      removed,
      total,
    };
  }

  /**
   * Delete all repositories associated with the given GitHub App installation IDs.
   * Cleans up Qdrant indexes and BullMQ jobs for each repository before deletion.
   * Used when installations are deactivated (unlink/disconnect).
   */
  async deleteRepositoriesByInstallationIds(
    userId: string,
    installationIds: number[],
  ): Promise<number> {
    if (installationIds.length === 0) {
      return 0;
    }

    const repos = await this.gitRepositoriesDao.getAll({
      createdBy: userId,
      installationId: { $in: installationIds },
    });

    for (const repo of repos) {
      await this.cleanupRepositoryResourcesById(repo.id);
      await this.gitRepositoriesDao.deleteById(repo.id);
    }

    return repos.length;
  }

  /**
   * Remove all BullMQ jobs and Qdrant collections associated with a repository's indexes.
   * Called before deleting a repository to ensure external resources are cleaned up.
   */
  private async cleanupRepositoryResourcesById(
    repositoryId: string,
  ): Promise<void> {
    const repoIndexes = await this.repoIndexDao.getAll({ repositoryId });

    const collections = new Set<string>();
    for (const index of repoIndexes) {
      if (index.qdrantCollection) {
        collections.add(index.qdrantCollection);
      }
      await this.repoIndexQueueService.removeJob(index.id);
    }

    for (const collection of collections) {
      try {
        await this.qdrantService.deleteCollection(collection);
      } catch (error) {
        this.logger.warn(`Failed to delete Qdrant collection ${collection}`, {
          collection,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Soft-delete repo_index rows so they don't appear as "indexed" if the
    // repository is restored during a future sync. The unique constraint
    // still covers soft-deleted rows, so getOrInitIndexForRepo will restore
    // and reset them when re-indexing is triggered.
    await this.repoIndexDao.hardDelete({ repositoryId });
  }

  private prepareRepositoryResponse(
    entity: GitRepositoryEntity,
  ): GitRepositoryDto {
    return {
      id: entity.id,
      owner: entity.owner,
      repo: entity.repo,
      url: entity.url,
      provider: entity.provider,
      defaultBranch: entity.defaultBranch,
      createdBy: entity.createdBy,
      projectId: entity.projectId,
      installationId: entity.installationId,
      createdAt: new Date(entity.createdAt).toISOString(),
      updatedAt: new Date(entity.updatedAt).toISOString(),
    };
  }

  private prepareRepoIndexResponse(entity: RepoIndexEntity): RepoIndexDto {
    return {
      id: entity.id,
      repositoryId: entity.repositoryId,
      repoUrl: entity.repoUrl,
      branch: entity.branch,
      status: entity.status,
      qdrantCollection: entity.qdrantCollection,
      lastIndexedCommit: entity.lastIndexedCommit,
      embeddingModel: entity.embeddingModel,
      vectorSize: entity.vectorSize,
      chunkingSignatureHash: entity.chunkingSignatureHash,
      estimatedTokens: entity.estimatedTokens,
      indexedTokens: entity.indexedTokens,
      errorMessage: entity.errorMessage,
      createdAt: new Date(entity.createdAt).toISOString(),
      updatedAt: new Date(entity.updatedAt).toISOString(),
    };
  }
}
