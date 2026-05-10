import { EntityManager, type FilterQuery } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { GitProviderConnectionDao } from '../../../v1/git-auth/dao/git-provider-connection.dao';
import { GitProvider } from '../../../v1/git-auth/git-auth.types';
import { GitHubAppService } from '../../../v1/git-auth/services/github-app.service';
import { GitHubAppProviderService } from '../../../v1/git-auth/services/github-app-provider.service';
import { GitRepositoriesDao } from '../../../v1/git-repositories/dao/git-repositories.dao';
import { GitRepositoryEntity } from '../../../v1/git-repositories/entity/git-repository.entity';
import { GitRepositoryProvider } from '../../../v1/git-repositories/git-repositories.types';
import { GitRepositoriesService } from '../../../v1/git-repositories/services/git-repositories.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { createTestModule, TEST_USER_ID } from '../setup';

const TEST_PROJECT_ID = '99999999-9999-9999-9999-999999999901';

// ctx without project ID (user-level sync)
const ctx = new AppContextStorage({ sub: TEST_USER_ID }, {
  headers: {},
} as unknown as FastifyRequest);

// ctx with project ID (for operations that need it)
const ctxWithProject = new AppContextStorage({ sub: TEST_USER_ID }, {
  headers: { 'x-project-id': TEST_PROJECT_ID },
} as unknown as FastifyRequest);

const makeGithubResponse = (
  repos: {
    owner: string;
    name: string;
    html_url: string;
    default_branch: string;
  }[],
): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      total_count: repos.length,
      repositories: repos.map((r) => ({
        owner: { login: r.owner },
        name: r.name,
        html_url: r.html_url,
        default_branch: r.default_branch,
      })),
    }),
    headers: { get: () => null },
  }) as unknown as Response;

describe('GitRepositoriesService sync (integration)', () => {
  let app: INestApplication;
  let gitRepositoriesService: GitRepositoriesService;
  let gitRepositoriesDao: GitRepositoriesDao;
  let gitProviderConnectionDao: GitProviderConnectionDao;
  let gitHubAppProviderService: GitHubAppProviderService;
  let gitHubAppService: GitHubAppService;
  let projectsDao: ProjectsDao;

  const createdRepoIds: string[] = [];
  const createdInstallationIds: string[] = [];
  let projectCreated = false;

  beforeAll(async () => {
    app = await createTestModule();
    gitRepositoriesService = app.get(GitRepositoriesService);
    gitRepositoriesDao = app.get(GitRepositoriesDao);
    gitProviderConnectionDao = app.get(GitProviderConnectionDao);
    gitHubAppProviderService = app.get(GitHubAppProviderService);
    gitHubAppService = app.get(GitHubAppService);
    projectsDao = app.get(ProjectsDao);

    // Create a test project with a deterministic ID so ctx.checkProjectId() resolves correctly.
    const existingProject = await projectsDao.getOne({ id: TEST_PROJECT_ID });
    if (!existingProject) {
      const em = app.get(EntityManager);
      await em.getConnection().execute(
        `INSERT INTO projects (id, name, "created_by", settings, "created_at", "updated_at")
         VALUES (?, ?, ?, ?, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [TEST_PROJECT_ID, 'Sync Integration Test Project', TEST_USER_ID, '{}'],
      );
      projectCreated = true;
    }

    // Defensively wipe any rows leaked from prior failed runs. Soft-deleted
    // rows still occupy the (owner, repo, created_by, provider) unique
    // constraint, so a previous test that exercised the soft-delete path
    // (e.g. "revoked repo deleted when not in GitHub response") would block
    // the fresh `dao.create(...)` call here with a 23505. Hard-deleting at
    // setup keeps the suite repeatable across runs.
    const em = app.get(EntityManager);
    await em
      .getConnection()
      .execute(`DELETE FROM git_repositories WHERE created_by = ?`, [
        TEST_USER_ID,
      ]);
    await em
      .getConnection()
      .execute(`DELETE FROM git_provider_connections WHERE user_id = ?`, [
        TEST_USER_ID,
      ]);
  }, 360_000);

  beforeEach(() => {
    // Always mock isConfigured to return true so tests don't depend on env vars
    vi.spyOn(gitHubAppProviderService, 'isConfigured').mockReturnValue(true);
    vi.spyOn(gitHubAppService, 'getInstallationToken').mockResolvedValue(
      'ghs_mock_token',
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    for (const id of [...createdRepoIds]) {
      try {
        await gitRepositoriesDao.hardDeleteById(id);
      } catch {
        // Already deleted — ignore
      }
    }
    createdRepoIds.length = 0;

    for (const id of [...createdInstallationIds]) {
      try {
        await gitProviderConnectionDao.hardDeleteById(id);
      } catch {
        // Already deleted — ignore
      }
    }
    createdInstallationIds.length = 0;
  });

  afterAll(async () => {
    if (projectCreated) {
      try {
        const em = app.get(EntityManager);
        await em
          .getConnection()
          .execute(`DELETE FROM projects WHERE id = ?`, [TEST_PROJECT_ID]);
      } catch {
        // Ignore
      }
    }
    await app?.close();
  }, 360_000);

  const createInstallation = async (
    installationId: number,
    accountLogin: string,
  ) => {
    const conn = await gitProviderConnectionDao.create({
      userId: TEST_USER_ID,
      provider: GitProvider.GitHub,
      accountLogin,
      metadata: { installationId, accountType: 'Organization' },
      isActive: true,
    });
    createdInstallationIds.push(conn.id);
    return conn;
  };

  const trackRepo = (id: string) => {
    if (!createdRepoIds.includes(id)) {
      createdRepoIds.push(id);
    }
  };

  describe('happy path: sync upserts repos into DB with null projectId', () => {
    it('syncs repos from one installation and verifies DB records have null projectId', async () => {
      const installation = await createInstallation(88001, 'sync-org');

      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([installation]);
      vi.spyOn(global, 'fetch').mockResolvedValue(
        makeGithubResponse([
          {
            owner: 'sync-org',
            name: 'api-service',
            html_url: 'https://github.com/sync-org/api-service',
            default_branch: 'main',
          },
          {
            owner: 'sync-org',
            name: 'web-app',
            html_url: 'https://github.com/sync-org/web-app',
            default_branch: 'main',
          },
        ]),
      );

      const result = await gitRepositoriesService.syncRepositories(ctx);

      expect(result.synced).toBe(2);
      expect(result.removed).toBe(0);
      expect(result.total).toBeGreaterThanOrEqual(2);

      // Verify DB records exist with null projectId
      const savedRepos = await gitRepositoriesDao.getAll({
        createdBy: TEST_USER_ID,
        installationId: { $ne: null },
      } as FilterQuery<GitRepositoryEntity>);

      const apiService = savedRepos.find((r) => r.repo === 'api-service');
      const webApp = savedRepos.find((r) => r.repo === 'web-app');

      expect(apiService).toBeDefined();
      expect(apiService!.owner).toBe('sync-org');
      expect(apiService!.provider).toBe(GitRepositoryProvider.GITHUB);
      expect(apiService!.installationId).toBe(
        installation.metadata['installationId'],
      );
      expect(apiService!.createdBy).toBe(TEST_USER_ID);
      expect(apiService!.projectId).toBeNull();

      expect(webApp).toBeDefined();
      expect(webApp!.owner).toBe('sync-org');
      expect(webApp!.projectId).toBeNull();

      for (const r of savedRepos) {
        if (r.owner === 'sync-org') {
          trackRepo(r.id);
        }
      }
    });
  });

  describe('revoked repo deleted when not in GitHub response', () => {
    it('deletes an installation-linked repo that GitHub no longer returns', async () => {
      const installation = await createInstallation(88002, 'revoke-org');

      // Manually insert a repo that "was" previously synced via GitHub App
      const existingRepo = await gitRepositoriesDao.create({
        owner: 'revoke-org',
        repo: 'old-repo',
        url: 'https://github.com/revoke-org/old-repo',
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: 'main',
        createdBy: TEST_USER_ID,
        projectId: null,
        installationId: 88002,
        syncedAt: new Date(),
      });
      trackRepo(existingRepo.id);

      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([installation]);
      // GitHub returns empty — the existing repo has been revoked
      vi.spyOn(global, 'fetch').mockResolvedValue(makeGithubResponse([]));

      const result = await gitRepositoriesService.syncRepositories(ctx);

      expect(result.removed).toBe(1);

      // Row should be soft-deleted (not visible in default queries)
      const afterSync = await gitRepositoriesDao.getOne({
        id: existingRepo.id,
      });
      expect(afterSync).toBeNull();

      // Confirm deletedAt is set
      const withDeleted = await gitRepositoriesDao.getOne(
        { id: existingRepo.id },
        { filters: { softDelete: false } },
      );
      expect(withDeleted).not.toBeNull();
      expect(withDeleted!.deletedAt).not.toBeNull();
    });
  });

  describe('manually added repo survives sync unchanged', () => {
    it('does not delete a repo with installationId = null during sync (PAT repo)', async () => {
      const installation = await createInstallation(88003, 'pat-test-org');

      // Insert a manually-added repo (no installationId)
      const patRepo = await gitRepositoriesDao.create({
        owner: 'some-personal',
        repo: 'my-private-repo',
        url: 'https://github.com/some-personal/my-private-repo',
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: 'main',
        createdBy: TEST_USER_ID,
        projectId: TEST_PROJECT_ID,
        installationId: null,
        syncedAt: null,
      });
      trackRepo(patRepo.id);

      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([installation]);
      // GitHub returns zero repos for the installation
      vi.spyOn(global, 'fetch').mockResolvedValue(makeGithubResponse([]));

      await gitRepositoriesService.syncRepositories(ctx);

      // PAT repo must still exist after sync
      const afterSync = await gitRepositoriesDao.getOne({ id: patRepo.id });
      expect(afterSync).not.toBeNull();
      expect(afterSync!.id).toBe(patRepo.id);
      expect(afterSync!.installationId).toBeNull();
    });
  });

  describe('disconnect and reconnect cycle', () => {
    it('disconnect then reconnect then sync works without stale state', async () => {
      const installation = await createInstallation(88010, 'reconnect-org');

      // First sync — creates repos
      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([installation]);
      vi.spyOn(global, 'fetch').mockResolvedValue(
        makeGithubResponse([
          {
            owner: 'reconnect-org',
            name: 'project-a',
            html_url: 'https://github.com/reconnect-org/project-a',
            default_branch: 'main',
          },
        ]),
      );

      const firstSync = await gitRepositoriesService.syncRepositories(ctx);
      expect(firstSync.synced).toBe(1);

      // Track created repos for cleanup
      const reposAfterFirst = await gitRepositoriesDao.getAll({
        createdBy: TEST_USER_ID,
        installationId: { $ne: null },
      } as FilterQuery<GitRepositoryEntity>);
      for (const r of reposAfterFirst) {
        if (r.owner === 'reconnect-org') {
          trackRepo(r.id);
        }
      }

      // Simulate disconnect: deactivate the installation and remove repos
      vi.restoreAllMocks();
      vi.spyOn(gitHubAppProviderService, 'isConfigured').mockReturnValue(true);
      vi.spyOn(gitHubAppService, 'getInstallationToken').mockResolvedValue(
        'ghs_mock_token',
      );
      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([]);
      vi.spyOn(global, 'fetch').mockResolvedValue(makeGithubResponse([]));

      const disconnectSync = await gitRepositoriesService.syncRepositories(ctx);
      expect(disconnectSync.synced).toBe(0);

      // Reconnect: remove the old installation record (simulates uninstall/reinstall),
      // then create a fresh one with a new installationId.
      vi.restoreAllMocks();
      vi.spyOn(gitHubAppProviderService, 'isConfigured').mockReturnValue(true);
      vi.spyOn(gitHubAppService, 'getInstallationToken').mockResolvedValue(
        'ghs_mock_token',
      );

      await gitProviderConnectionDao.hardDeleteById(installation.id);
      createdInstallationIds.splice(
        createdInstallationIds.indexOf(installation.id),
        1,
      );

      const reconnectedInstallation = await createInstallation(
        88011,
        'reconnect-org',
      );
      vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      ).mockResolvedValue([reconnectedInstallation]);
      vi.spyOn(global, 'fetch').mockResolvedValue(
        makeGithubResponse([
          {
            owner: 'reconnect-org',
            name: 'project-a',
            html_url: 'https://github.com/reconnect-org/project-a',
            default_branch: 'main',
          },
          {
            owner: 'reconnect-org',
            name: 'project-b',
            html_url: 'https://github.com/reconnect-org/project-b',
            default_branch: 'develop',
          },
        ]),
      );

      const reconnectSync = await gitRepositoriesService.syncRepositories(ctx);
      expect(reconnectSync.synced).toBe(2);

      // Verify repos exist with correct data
      const reposAfterReconnect = await gitRepositoriesDao.getAll({
        createdBy: TEST_USER_ID,
        installationId: { $ne: null },
      } as FilterQuery<GitRepositoryEntity>);
      const reconnectRepos = reposAfterReconnect.filter(
        (r) => r.owner === 'reconnect-org',
      );
      expect(reconnectRepos.length).toBeGreaterThanOrEqual(2);

      for (const r of reconnectRepos) {
        trackRepo(r.id);
        expect(r.projectId).toBeNull();
      }
    });
  });
});
