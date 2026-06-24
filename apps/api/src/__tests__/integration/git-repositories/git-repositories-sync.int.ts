import { EntityManager, type FilterQuery } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { InternalException } from '@packages/common';
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
import { GitUserPatService } from '../../../v1/git-auth/services/git-user-pat.service';
import { GitHubAppService } from '../../../v1/git-auth/services/github-app.service';
import { GitHubAppProviderService } from '../../../v1/git-auth/services/github-app-provider.service';
import { GitRepositoriesDao } from '../../../v1/git-repositories/dao/git-repositories.dao';
import { GitRepositoryEntity } from '../../../v1/git-repositories/entity/git-repository.entity';
import { GitRepositoryProvider } from '../../../v1/git-repositories/git-repositories.types';
import { GitRepositoriesService } from '../../../v1/git-repositories/services/git-repositories.service';
import { GitHubAuthMethod } from '../../../v1/graph-resources/graph-resources.types';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { createTestModule, TEST_USER_ID } from '../setup';

const TEST_PROJECT_ID = '99999999-9999-9999-9999-999999999901';
const PAT_USER_B_ID = 'pat-user-b-0002';

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

// GET /user/repos returns a flat ARRAY (no { total_count, repositories } wrapper)
// — the shape the pat-mode sync path consumes.
const makeUserReposResponse = (
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
    json: async () =>
      repos.map((r) => ({
        owner: { login: r.owner },
        name: r.name,
        html_url: r.html_url,
        default_branch: r.default_branch,
      })),
    headers: { get: () => null },
  }) as unknown as Response;

describe('GitRepositoriesService sync (integration)', () => {
  let app: INestApplication;
  let gitRepositoriesService: GitRepositoriesService;
  let gitRepositoriesDao: GitRepositoriesDao;
  let gitProviderConnectionDao: GitProviderConnectionDao;
  let gitHubAppProviderService: GitHubAppProviderService;
  let gitHubAppService: GitHubAppService;
  let gitUserPatService: GitUserPatService;
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
    gitUserPatService = app.get(GitUserPatService);
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
    // The per-user PAT tests also sync under a second user — wipe their rows so
    // the tests are repeatable across runs.
    await em
      .getConnection()
      .execute(`DELETE FROM git_repositories WHERE created_by = ?`, [
        PAT_USER_B_ID,
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
      // App sync must stamp syncSource=GithubApp so the source-scoped PAT prune
      // can never target these rows.
      expect(apiService!.syncSource).toBe(GitHubAuthMethod.GithubApp);

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

  describe('per-user PAT sync', () => {
    const ctxUserB = new AppContextStorage({ sub: PAT_USER_B_ID }, {
      headers: {},
    } as unknown as FastifyRequest);

    beforeEach(() => {
      // The token resolver reads the per-user PAT from OpenBao, which is not
      // available in the integration harness — stub the resolve seam to return a
      // PAT for any user. The DB sync/prune behaviour below runs for real.
      vi.spyOn(gitUserPatService, 'resolvePatToken').mockResolvedValue(
        'ghp_integration_pat',
      );
    });

    const trackUserRepos = async (userId: string) => {
      const rows = await gitRepositoriesDao.getAll({ createdBy: userId });
      for (const r of rows) {
        trackRepo(r.id);
      }
    };

    it('syncs from GET /user/repos under the requesting user createdBy with syncSource=Pat', async () => {
      const getInstallationsSpy = vi.spyOn(
        gitHubAppProviderService,
        'getActiveInstallations',
      );
      vi.spyOn(global, 'fetch').mockResolvedValue(
        makeUserReposResponse([
          {
            owner: 'acme-org',
            name: 'backend',
            html_url: 'https://github.com/acme-org/backend',
            default_branch: 'main',
          },
          {
            owner: 'acme-org',
            name: 'frontend',
            html_url: 'https://github.com/acme-org/frontend',
            default_branch: 'develop',
          },
        ]),
      );

      const result = await gitRepositoriesService.syncRepositories(ctx);
      await trackUserRepos(TEST_USER_ID);

      expect(result.synced).toBe(2);
      // The PAT path must never consult GitHub App installations.
      expect(getInstallationsSpy).not.toHaveBeenCalled();

      const rows = await gitRepositoriesDao.getAll({ createdBy: TEST_USER_ID });
      const backend = rows.find((r) => r.repo === 'backend');
      expect(backend).toBeDefined();
      expect(backend!.createdBy).toBe(TEST_USER_ID);
      expect(backend!.syncSource).toBe(GitHubAuthMethod.Pat);
      expect(backend!.installationId).toBeNull();
    });

    it('resolves the PAT and syncs even when the GitHub App is not configured', async () => {
      vi.spyOn(gitHubAppProviderService, 'isConfigured').mockReturnValue(false);
      vi.spyOn(global, 'fetch').mockResolvedValue(
        makeUserReposResponse([
          {
            owner: 'acme-org',
            name: 'solo',
            html_url: 'https://github.com/acme-org/solo',
            default_branch: 'main',
          },
        ]),
      );

      const result = await gitRepositoriesService.syncRepositories(ctx);
      await trackUserRepos(TEST_USER_ID);

      expect(result.synced).toBe(1);
    });

    it('two users syncing the same repo get independent per-user rows (no collision, no cross-user prune)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        makeUserReposResponse([
          {
            owner: 'acme-org',
            name: 'shared-repo',
            html_url: 'https://github.com/acme-org/shared-repo',
            default_branch: 'main',
          },
        ]),
      );

      const a = await gitRepositoriesService.syncRepositories(ctx); // user A
      const b = await gitRepositoriesService.syncRepositories(ctxUserB); // user B
      await trackUserRepos(TEST_USER_ID);
      await trackUserRepos(PAT_USER_B_ID);

      expect(a.synced).toBe(1);
      expect(b.synced).toBe(1);
      // User B's sync writes its OWN row and prunes nothing of user A's.
      expect(b.removed).toBe(0);

      const aRows = await gitRepositoriesDao.getAll({
        createdBy: TEST_USER_ID,
        owner: 'acme-org',
        repo: 'shared-repo',
      });
      const bRows = await gitRepositoriesDao.getAll({
        createdBy: PAT_USER_B_ID,
        owner: 'acme-org',
        repo: 'shared-repo',
      });
      expect(aRows.length).toBe(1);
      expect(bRows.length).toBe(1);
    });

    it('surfaces a clear error when GET /user/repos returns 401 (PAT revoked)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => null },
      } as unknown as Response);

      await expect(
        gitRepositoriesService.syncRepositories(ctx),
      ).rejects.toThrow(/failed with status 401/);
    });

    it('throws GITHUB_RATE_LIMITED when GET /user/repos returns 429', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 429,
        headers: { get: () => null },
      } as unknown as Response);

      let caught: unknown;
      try {
        await gitRepositoriesService.syncRepositories(ctx);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InternalException);
      expect((caught as InternalException).code).toBe('GITHUB_RATE_LIMITED');
    });

    it('fails CLOSED when the stored PAT is present-but-unreadable (resolvePatToken throws), never listing repos', async () => {
      vi.mocked(gitUserPatService.resolvePatToken).mockRejectedValue(
        new InternalException(
          'GITHUB_USER_PAT_UNREADABLE',
          'stored PAT present but unreadable',
        ),
      );
      const fetchSpy = vi.spyOn(global, 'fetch');

      await expect(
        gitRepositoriesService.syncRepositories(ctx),
      ).rejects.toThrow(InternalException);
      // Failed closed at resolve time — never reached the GitHub listing.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('per-user prune removes only THIS user PAT orphans, never App-synced or another user rows', async () => {
      // App-synced row for the requesting user (installationId set).
      const appRow = await gitRepositoriesDao.create({
        owner: 'app-org',
        repo: 'app-repo',
        url: 'https://github.com/app-org/app-repo',
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: 'main',
        createdBy: TEST_USER_ID,
        projectId: null,
        installationId: 77001,
        syncSource: GitHubAuthMethod.GithubApp,
        syncedAt: new Date(),
      });
      trackRepo(appRow.id);

      // A PAT orphan for the requesting user the next sync drops.
      const patOrphan = await gitRepositoriesDao.create({
        owner: 'acme-org',
        repo: 'stale-repo',
        url: 'https://github.com/acme-org/stale-repo',
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: 'main',
        createdBy: TEST_USER_ID,
        projectId: null,
        installationId: null,
        syncSource: GitHubAuthMethod.Pat,
        syncedAt: new Date(),
      });
      trackRepo(patOrphan.id);

      // Another user's identical PAT row — must NOT be pruned by THIS user's sync.
      const otherUserRow = await gitRepositoriesDao.create({
        owner: 'acme-org',
        repo: 'stale-repo',
        url: 'https://github.com/acme-org/stale-repo',
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: 'main',
        createdBy: PAT_USER_B_ID,
        projectId: null,
        installationId: null,
        syncSource: GitHubAuthMethod.Pat,
        syncedAt: new Date(),
      });
      trackRepo(otherUserRow.id);

      vi.spyOn(global, 'fetch').mockResolvedValue(
        makeUserReposResponse([
          {
            owner: 'acme-org',
            name: 'live-repo',
            html_url: 'https://github.com/acme-org/live-repo',
            default_branch: 'main',
          },
        ]),
      );

      const result = await gitRepositoriesService.syncRepositories(ctx);
      await trackUserRepos(TEST_USER_ID);

      expect(result.removed).toBe(1);

      // The requesting user's PAT orphan is pruned.
      const orphanAfter = await gitRepositoriesDao.getOne({ id: patOrphan.id });
      expect(orphanAfter).toBeNull();

      // App-synced row UNTOUCHED — the cross-source safety guarantee.
      const appAfter = await gitRepositoriesDao.getOne({ id: appRow.id });
      expect(appAfter).not.toBeNull();
      expect(appAfter!.installationId).toBe(77001);
      expect(appAfter!.syncSource).toBe(GitHubAuthMethod.GithubApp);

      // Another user's identical PAT row UNTOUCHED — no cross-user delete.
      const otherAfter = await gitRepositoriesDao.getOne({
        id: otherUserRow.id,
      });
      expect(otherAfter).not.toBeNull();
    });

    it('does NOT relabel an App-synced row when the PAT lists the same owner/repo (no reclassification → no prune exposure)', async () => {
      // App-synced row whose (owner, repo) EXACTLY matches a repo the PAT will
      // also list — the upsert conflict path. Pre-fix, the PAT upsert merged
      // installationId + syncSource and relabeled this row to (Pat, null),
      // exposing an App repo to the per-user PAT orphan-prune (irreversible
      // Qdrant + BullMQ hard-delete). The mergeSource:false fix must leave the
      // App identity intact.
      const appRow = await gitRepositoriesDao.create({
        owner: 'collide-org',
        repo: 'shared-repo',
        url: 'https://github.com/collide-org/shared-repo',
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: 'main',
        createdBy: TEST_USER_ID,
        projectId: null,
        installationId: 99001,
        syncSource: GitHubAuthMethod.GithubApp,
        syncedAt: new Date(),
      });
      trackRepo(appRow.id);

      // The PAT lists the SAME owner/repo (so the row is in the live set and the
      // upsert hits the (owner, repo, createdBy, provider) conflict).
      vi.spyOn(global, 'fetch').mockResolvedValue(
        makeUserReposResponse([
          {
            owner: 'collide-org',
            name: 'shared-repo',
            html_url: 'https://github.com/collide-org/shared-repo',
            default_branch: 'develop',
          },
        ]),
      );

      await gitRepositoriesService.syncRepositories(ctx);
      await trackUserRepos(TEST_USER_ID);

      const after = await gitRepositoriesDao.getOne({ id: appRow.id });
      expect(after).not.toBeNull();
      // SOURCE identity preserved — never relabeled to (Pat, null).
      expect(after!.syncSource).toBe(GitHubAuthMethod.GithubApp);
      expect(after!.installationId).toBe(99001);
      // Mutable fields (defaultBranch/url) still refresh from the listing.
      expect(after!.defaultBranch).toBe('develop');
      // Exactly one row for the pair — no duplicate inserted alongside the App row.
      const pairRows = await gitRepositoriesDao.getAll({
        createdBy: TEST_USER_ID,
        owner: 'collide-org',
        repo: 'shared-repo',
      });
      expect(pairRows.length).toBe(1);
    });

    it('per-user prune leaves a manually-added (syncSource=null) row untouched', async () => {
      // A manually-added repo (syncSource=null, installationId=null) the PAT
      // does NOT list. The prune is scoped to syncSource=Pat, so this row must
      // survive — it falls on the null predicate, not the Pat one.
      const manualRow = await gitRepositoriesDao.create({
        owner: 'manual-org',
        repo: 'hand-added',
        url: 'https://github.com/manual-org/hand-added',
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: 'main',
        createdBy: TEST_USER_ID,
        projectId: null,
        installationId: null,
        syncSource: null,
        syncedAt: null,
      });
      trackRepo(manualRow.id);

      // The PAT lists a different repo, so the manual row is "not in the live
      // set" — the exact condition that would prune a Pat-sourced orphan.
      vi.spyOn(global, 'fetch').mockResolvedValue(
        makeUserReposResponse([
          {
            owner: 'acme-org',
            name: 'live-only',
            html_url: 'https://github.com/acme-org/live-only',
            default_branch: 'main',
          },
        ]),
      );

      await gitRepositoriesService.syncRepositories(ctx);
      await trackUserRepos(TEST_USER_ID);

      const after = await gitRepositoriesDao.getOne({ id: manualRow.id });
      expect(after).not.toBeNull();
      expect(after!.syncSource).toBeNull();
      expect(after!.installationId).toBeNull();
    });

    it('does NOT prune any PAT rows when GET /user/repos returns an empty (200) listing — guards the data-loss path (F1)', async () => {
      // A scope-reduced PAT (passes validate-on-save, which only checks GET
      // /user) lists ZERO repos. The prune MUST be skipped on an empty listing,
      // exactly like a truncated one — otherwise every syncSource=Pat row enters
      // toRemove and its Qdrant collection + index are irreversibly hard-deleted.
      const patRepo = await gitRepositoriesDao.create({
        owner: 'acme-org',
        repo: 'keep-me',
        url: 'https://github.com/acme-org/keep-me',
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: 'main',
        createdBy: TEST_USER_ID,
        projectId: null,
        installationId: null,
        syncSource: GitHubAuthMethod.Pat,
        syncedAt: new Date(),
      });
      trackRepo(patRepo.id);

      vi.spyOn(global, 'fetch').mockResolvedValue(makeUserReposResponse([]));

      const result = await gitRepositoriesService.syncRepositories(ctx);

      expect(result.synced).toBe(0);
      expect(result.removed).toBe(0);
      // The previously-synced PAT repo survives, NOT soft-deleted or cleaned up.
      const after = await gitRepositoriesDao.getOne({ id: patRepo.id });
      expect(after).not.toBeNull();
      expect(after!.deletedAt).toBeNull();
    });

    it('restores a soft-deleted Pat row when the PAT lists it again (same-source resurrection)', async () => {
      const patRow = await gitRepositoriesDao.create({
        owner: 'acme-org',
        repo: 'comeback',
        url: 'https://github.com/acme-org/comeback',
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: 'main',
        createdBy: TEST_USER_ID,
        projectId: null,
        installationId: null,
        syncSource: GitHubAuthMethod.Pat,
        syncedAt: new Date(),
      });
      trackRepo(patRow.id);
      // Soft-delete it (sets deletedAt) — the softDelete filter now hides it.
      await gitRepositoriesDao.deleteById(patRow.id);

      vi.spyOn(global, 'fetch').mockResolvedValue(
        makeUserReposResponse([
          {
            owner: 'acme-org',
            name: 'comeback',
            html_url: 'https://github.com/acme-org/comeback',
            default_branch: 'main',
          },
        ]),
      );

      await gitRepositoriesService.syncRepositories(ctx);

      // Read via a FRESH EM fork: restoreAndClaimForPat issues a raw QueryBuilder
      // UPDATE that does not refresh the shared EM's identity map (the row was
      // loaded + soft-deleted earlier in this test), so a shared-EM read would
      // return the stale pre-restore entity. Restored (deletedAt cleared) + Pat.
      const em = app.get(EntityManager).fork();
      const after = await em.findOne(
        GitRepositoryEntity,
        { id: patRow.id },
        { filters: { softDelete: false } },
      );
      expect(after).not.toBeNull();
      expect(after!.deletedAt).toBeNull();
      expect(after!.syncSource).toBe(GitHubAuthMethod.Pat);
    });

    it('claims a soft-deleted App row as a Pat row when the PAT lists it (F6 — no hidden, churning zombie)', async () => {
      // A repo the user removed under the App, soft-deleted (deletedAt set,
      // syncSource=GithubApp, installationId set). The PAT now lists it. Under
      // PAT-exclusive precedence the PAT must resurrect AND claim it as a Pat row
      // — otherwise the source-scoped restore skips it (wrong source) and it
      // stays a hidden row whose syncedAt churns every run.
      const appRow = await gitRepositoriesDao.create({
        owner: 'acme-org',
        repo: 'crossover',
        url: 'https://github.com/acme-org/crossover',
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: 'main',
        createdBy: TEST_USER_ID,
        projectId: null,
        installationId: 55001,
        syncSource: GitHubAuthMethod.GithubApp,
        syncedAt: new Date(),
      });
      trackRepo(appRow.id);
      await gitRepositoriesDao.deleteById(appRow.id);

      vi.spyOn(global, 'fetch').mockResolvedValue(
        makeUserReposResponse([
          {
            owner: 'acme-org',
            name: 'crossover',
            html_url: 'https://github.com/acme-org/crossover',
            default_branch: 'main',
          },
        ]),
      );

      await gitRepositoriesService.syncRepositories(ctx);

      // Fresh EM fork — restoreAndClaimForPat's raw UPDATE bypasses the shared
      // identity map (see the same-source test above for the full rationale).
      const em = app.get(EntityManager).fork();
      const after = await em.findOne(
        GitRepositoryEntity,
        { id: appRow.id },
        { filters: { softDelete: false } },
      );
      expect(after).not.toBeNull();
      expect(after!.deletedAt).toBeNull();
      // Claimed as a fully PAT-governed row.
      expect(after!.syncSource).toBe(GitHubAuthMethod.Pat);
      expect(after!.installationId).toBeNull();
    });

    it('leaves a soft-deleted cross-source App row untouched when the PAT does NOT list it (restore-skip)', async () => {
      const appRow = await gitRepositoriesDao.create({
        owner: 'other-org',
        repo: 'still-removed',
        url: 'https://github.com/other-org/still-removed',
        provider: GitRepositoryProvider.GITHUB,
        defaultBranch: 'main',
        createdBy: TEST_USER_ID,
        projectId: null,
        installationId: 55002,
        syncSource: GitHubAuthMethod.GithubApp,
        syncedAt: new Date(),
      });
      trackRepo(appRow.id);
      await gitRepositoriesDao.deleteById(appRow.id);

      // The PAT lists a DIFFERENT repo, so the soft-deleted App row is not in the
      // resurrection pairs and must stay soft-deleted with its App source intact.
      vi.spyOn(global, 'fetch').mockResolvedValue(
        makeUserReposResponse([
          {
            owner: 'acme-org',
            name: 'unrelated',
            html_url: 'https://github.com/acme-org/unrelated',
            default_branch: 'main',
          },
        ]),
      );

      await gitRepositoriesService.syncRepositories(ctx);

      // Still soft-deleted (hidden by the default filter) — read with the filter
      // off to assert it survives unclaimed, not hard-deleted.
      const visible = await gitRepositoriesDao.getOne({ id: appRow.id });
      expect(visible).toBeNull();
      const raw = await gitRepositoriesDao.getOne(
        { id: appRow.id },
        { filters: { softDelete: false } },
      );
      expect(raw).not.toBeNull();
      expect(raw!.deletedAt).not.toBeNull();
      expect(raw!.syncSource).toBe(GitHubAuthMethod.GithubApp);
      expect(raw!.installationId).toBe(55002);
    });

    it('accumulates repos ACROSS pages — a full first page triggers a second fetch and both pages are upserted (F10)', async () => {
      // PER_PAGE is 100; a full first page (length === PER_PAGE) must NOT break
      // the loop — it advances to page 2 and accumulates the partial page too.
      // The truncation test only asserts the page-cap bound; this asserts the
      // page++ / `< PER_PAGE` break actually unions page-2 repos.
      const PER_PAGE = 100;
      const page1 = Array.from({ length: PER_PAGE }, (_, i) => ({
        owner: 'page-org',
        name: `repo-${i}`,
        html_url: `https://github.com/page-org/repo-${i}`,
        default_branch: 'main',
      }));
      const page2 = [
        {
          owner: 'page-org',
          name: 'last-page-repo',
          html_url: 'https://github.com/page-org/last-page-repo',
          default_branch: 'main',
        },
      ];

      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(makeUserReposResponse(page1))
        .mockResolvedValueOnce(makeUserReposResponse(page2));

      const result = await gitRepositoriesService.syncRepositories(ctx);
      await trackUserRepos(TEST_USER_ID);

      // A full first page forced a second fetch; the partial page ended it.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.synced).toBe(PER_PAGE + 1);

      // The page-2 repo made it into the DB (accumulation, not just page 1).
      const page2Row = await gitRepositoriesDao.getOne({
        createdBy: TEST_USER_ID,
        owner: 'page-org',
        repo: 'last-page-repo',
      });
      expect(page2Row).not.toBeNull();
      expect(page2Row!.syncSource).toBe(GitHubAuthMethod.Pat);
    });
  });
});
