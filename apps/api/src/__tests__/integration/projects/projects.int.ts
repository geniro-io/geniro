import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { BaseException } from '@packages/common';
import type { FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { ProjectsService } from '../../../v1/projects/services/projects.service';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { createTestModule, TEST_USER_ID } from '../setup';

const EMPTY_REQUEST = { headers: {} } as unknown as FastifyRequest;

const ctx = new AppContextStorage({ sub: TEST_USER_ID }, EMPTY_REQUEST);
const otherCtx = new AppContextStorage(
  { sub: '00000000-0000-0000-0000-000000000099' },
  EMPTY_REQUEST,
);

describe('ProjectsService (integration)', () => {
  let app: INestApplication;
  let projectsService: ProjectsService;
  let projectsDao: ProjectsDao;
  let graphDao: GraphDao;
  let threadsDao: ThreadsDao;
  const createdProjectIds: string[] = [];
  const createdGraphIds: string[] = [];
  const createdThreadIds: string[] = [];

  beforeAll(async () => {
    app = await createTestModule();
    projectsService = app.get(ProjectsService);
    projectsDao = app.get(ProjectsDao);
    graphDao = app.get(GraphDao);
    threadsDao = app.get(ThreadsDao);
    const em = app.get(EntityManager);
    const conn = em.getConnection();

    // Backfill NULL project_id rows before updateSchema() attempts SET NOT NULL.
    // This mirrors the data migration in 1772088372277-AddProjectsFeature.
    await conn.execute(`
      INSERT INTO "projects" ("id","name","description","icon","color","settings","created_by","created_at","updated_at")
      SELECT gen_random_uuid(),'Default',NULL,NULL,NULL,'{}',sub,NOW(),NOW()
      FROM (
        SELECT DISTINCT "created_by" AS sub FROM "graphs" WHERE "project_id" IS NULL
        UNION
        SELECT DISTINCT "created_by" AS sub FROM "knowledge_docs" WHERE "project_id" IS NULL
        UNION
        SELECT DISTINCT "created_by" AS sub FROM "git_repositories" WHERE "project_id" IS NULL
      ) AS users
      ON CONFLICT DO NOTHING
    `);
    for (const table of ['graphs', 'knowledge_docs', 'git_repositories']) {
      await conn.execute(`
        UPDATE "${table}" t SET "project_id" = (
          SELECT p."id" FROM "projects" p WHERE p."created_by" = t."created_by"
          ORDER BY p."created_at" ASC LIMIT 1
        ) WHERE t."project_id" IS NULL
      `);
    }

    // MikroORM v7 exposes the schema generator via `orm.schema` and the update
    // method is `orm.schema.update()` — `getSchemaGenerator()` was removed.
    const orm = app.get(MikroORM);
    await orm.schema.update();
  }, 120_000);

  afterEach(async () => {
    for (const id of createdThreadIds) {
      try {
        await threadsDao.hardDeleteById(id);
      } catch {
        // Already deleted — ignore
      }
    }
    createdThreadIds.length = 0;

    for (const id of createdGraphIds) {
      try {
        await graphDao.hardDeleteById(id);
      } catch {
        // Already deleted — ignore
      }
    }
    createdGraphIds.length = 0;

    for (const id of createdProjectIds) {
      try {
        await projectsDao.deleteById(id);
      } catch {
        // Already deleted — ignore
      }
    }
    createdProjectIds.length = 0;
  });

  afterAll(async () => {
    await app?.close();
  });

  const registerProject = (id: string) => {
    if (!createdProjectIds.includes(id)) {
      createdProjectIds.push(id);
    }
  };

  describe('create', () => {
    it('should create a project with the correct owner', async () => {
      const project = await projectsService.create(ctx, {
        name: 'Integration Project',
        description: 'Created by integration test',
        settings: {},
      });
      registerProject(project.id);

      expect(project.id).toBeTruthy();
      expect(project.name).toBe('Integration Project');
      expect(project.description).toBe('Created by integration test');
      expect(project.createdBy).toBe(TEST_USER_ID);
      expect(project.settings).toEqual({});
    });

    it('should create a project with optional color and icon', async () => {
      const project = await projectsService.create(ctx, {
        name: 'Colored Project',
        color: '#FF5733',
        icon: 'star',
        settings: {},
      });
      registerProject(project.id);

      expect(project.color).toBe('#FF5733');
      expect(project.icon).toBe('star');
    });
  });

  describe('getAll', () => {
    it('should return only projects belonging to the current user', async () => {
      const p1 = await projectsService.create(ctx, {
        name: 'User Project 1',
        settings: {},
      });
      registerProject(p1.id);

      // Create a project under the other user context — should not appear in ctx's list
      const p2 = await projectsService.create(otherCtx, {
        name: 'Other User Project',
        settings: {},
      });
      registerProject(p2.id);

      const results = await projectsService.getAll(ctx);

      const ids = results.map((p) => p.id);
      expect(ids).toContain(p1.id);
      expect(ids).not.toContain(p2.id);
    });

    it('should return an empty array when user has no projects', async () => {
      const emptyCtx = new AppContextStorage(
        { sub: '00000000-0000-0000-0000-000000000098' },
        EMPTY_REQUEST,
      );
      const results = await projectsService.getAll(emptyCtx);
      expect(results).toEqual([]);
    });

    it('should return enriched stats (graphCount, threadCount)', async () => {
      const project = await projectsService.create(ctx, {
        name: 'Stats Project',
        settings: {},
      });
      registerProject(project.id);

      const graph1 = await graphDao.create({
        name: 'Graph 1',
        version: '1.0.0',
        targetVersion: '1.0.0',
        schema: { nodes: [], edges: [] },
        status: GraphStatus.Created,
        createdBy: TEST_USER_ID,
        projectId: project.id,
        temporary: false,
      });
      createdGraphIds.push(graph1.id);

      const graph2 = await graphDao.create({
        name: 'Graph 2',
        version: '1.0.0',
        targetVersion: '1.0.0',
        schema: { nodes: [], edges: [] },
        status: GraphStatus.Created,
        createdBy: TEST_USER_ID,
        projectId: project.id,
        temporary: false,
      });
      createdGraphIds.push(graph2.id);

      const thread = await threadsDao.create({
        graphId: graph1.id,
        createdBy: TEST_USER_ID,
        projectId: project.id,
        externalThreadId: `stats-test-${Date.now()}`,
        status: ThreadStatus.Done,
      });
      createdThreadIds.push(thread.id);

      const results = await projectsService.getAll(ctx);
      const statsProject = results.find((p) => p.id === project.id);

      expect(statsProject).toBeDefined();
      expect(statsProject!.graphCount).toBe(2);
      expect(statsProject!.threadCount).toBe(1);
    });

    it('should exclude soft-deleted graphs from graphCount', async () => {
      const project = await projectsService.create(ctx, {
        name: 'Soft Delete Stats Project',
        settings: {},
      });
      registerProject(project.id);

      const graph = await graphDao.create({
        name: 'Deletable Graph',
        version: '1.0.0',
        targetVersion: '1.0.0',
        schema: { nodes: [], edges: [] },
        status: GraphStatus.Created,
        createdBy: TEST_USER_ID,
        projectId: project.id,
        temporary: false,
      });
      createdGraphIds.push(graph.id);

      // Soft-delete the graph
      await graphDao.deleteById(graph.id);

      const results = await projectsService.getAll(ctx);
      const statsProject = results.find((p) => p.id === project.id);

      expect(statsProject).toBeDefined();
      expect(statsProject!.graphCount).toBe(0);
    });

    it('should exclude soft-deleted threads from threadCount', async () => {
      const project = await projectsService.create(ctx, {
        name: 'Soft Delete Threads Project',
        settings: {},
      });
      registerProject(project.id);

      const graph = await graphDao.create({
        name: 'Graph For Thread Deletion Test',
        version: '1.0.0',
        targetVersion: '1.0.0',
        schema: { nodes: [], edges: [] },
        status: GraphStatus.Created,
        createdBy: TEST_USER_ID,
        projectId: project.id,
        temporary: false,
      });
      createdGraphIds.push(graph.id);

      const liveThread = await threadsDao.create({
        graphId: graph.id,
        createdBy: TEST_USER_ID,
        projectId: project.id,
        externalThreadId: `live-thread-${Date.now()}`,
        status: ThreadStatus.Done,
      });
      createdThreadIds.push(liveThread.id);

      const deletedThread = await threadsDao.create({
        graphId: graph.id,
        createdBy: TEST_USER_ID,
        projectId: project.id,
        externalThreadId: `deleted-thread-${Date.now()}`,
        status: ThreadStatus.Done,
      });
      createdThreadIds.push(deletedThread.id);

      // Soft-delete one thread
      await threadsDao.deleteById(deletedThread.id);

      const results = await projectsService.getAll(ctx);
      const statsProject = results.find((p) => p.id === project.id);

      expect(statsProject).toBeDefined();
      expect(statsProject!.graphCount).toBe(1);
      expect(statsProject!.threadCount).toBe(1);
    });

    it('should exclude temporary graphs from graphCount', async () => {
      const project = await projectsService.create(ctx, {
        name: 'Temporary Stats Project',
        settings: {},
      });
      registerProject(project.id);

      const graph = await graphDao.create({
        name: 'Temporary Graph',
        version: '1.0.0',
        targetVersion: '1.0.0',
        schema: { nodes: [], edges: [] },
        status: GraphStatus.Created,
        createdBy: TEST_USER_ID,
        projectId: project.id,
        temporary: true,
      });
      createdGraphIds.push(graph.id);

      const results = await projectsService.getAll(ctx);
      const statsProject = results.find((p) => p.id === project.id);

      expect(statsProject).toBeDefined();
      expect(statsProject!.graphCount).toBe(0);
    });
  });

  describe('findById', () => {
    it('should return the project for the correct owner', async () => {
      const created = await projectsService.create(ctx, {
        name: 'Findable Project',
        settings: {},
      });
      registerProject(created.id);

      const found = await projectsService.findById(ctx, created.id);
      expect(found.id).toBe(created.id);
      expect(found.name).toBe('Findable Project');
    });

    it('should throw NotFoundException when project belongs to a different user', async () => {
      const created = await projectsService.create(ctx, {
        name: 'Ownership Test',
        settings: {},
      });
      registerProject(created.id);

      await expect(
        projectsService.findById(otherCtx, created.id),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof BaseException && err.errorCode === 'PROJECT_NOT_FOUND',
      );
    });

    it('should throw NotFoundException for a non-existent project ID', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';
      await expect(
        projectsService.findById(ctx, nonExistentId),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof BaseException && err.errorCode === 'PROJECT_NOT_FOUND',
      );
    });
  });

  describe('update', () => {
    it('should update a project name', async () => {
      const created = await projectsService.create(ctx, {
        name: 'Original Name',
        settings: {},
      });
      registerProject(created.id);

      const updated = await projectsService.update(ctx, created.id, {
        name: 'Updated Name',
      });

      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe('Updated Name');
    });

    it('should throw NotFoundException when updating a project of a different user', async () => {
      const created = await projectsService.create(ctx, {
        name: 'My Project',
        settings: {},
      });
      registerProject(created.id);

      await expect(
        projectsService.update(otherCtx, created.id, { name: 'Hijacked' }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof BaseException && err.errorCode === 'PROJECT_NOT_FOUND',
      );
    });
  });

  describe('delete', () => {
    it('should soft-delete the project', async () => {
      const created = await projectsService.create(ctx, {
        name: 'To Delete',
        settings: {},
      });
      registerProject(created.id);

      await projectsService.delete(ctx, created.id);

      // After deletion, findById should throw
      await expect(projectsService.findById(ctx, created.id)).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof BaseException && err.errorCode === 'PROJECT_NOT_FOUND',
      );
    });

    it('should cascade soft-delete graphs belonging to the project', async () => {
      const project = await projectsService.create(ctx, {
        name: 'Project With Graphs',
        settings: {},
      });
      registerProject(project.id);

      // Create a graph directly via DAO to keep the test focused on cascade behavior
      const graph = await graphDao.create({
        name: 'Cascade Graph',
        version: '1.0.0',
        targetVersion: '1.0.0',
        schema: { nodes: [], edges: [] },
        status: GraphStatus.Created,
        createdBy: TEST_USER_ID,
        projectId: project.id,
        temporary: false,
      });

      // Confirm graph exists before deletion
      const beforeDelete = await graphDao.getOne({ id: graph.id });
      expect(beforeDelete).not.toBeNull();

      await projectsService.delete(ctx, project.id);

      // Graph should be soft-deleted (getOne without withDeleted returns null)
      const afterDelete = await graphDao.getOne({ id: graph.id });
      expect(afterDelete).toBeNull();

      // Confirm deletedAt is set on the soft-deleted row
      const withDeleted = await graphDao.getOne(
        { id: graph.id },
        { filters: { softDelete: false } },
      );
      expect(withDeleted).not.toBeNull();
      expect(withDeleted!.deletedAt).not.toBeNull();

      // Hard-delete the graph row to keep the DB clean.
      // hardDeleteById uses a plain DELETE WHERE id=..., which ignores deletedAt.
      await graphDao.hardDeleteById(graph.id);
    });

    it('should throw NotFoundException when deleting a project of a different user', async () => {
      const created = await projectsService.create(ctx, {
        name: 'Protected Project',
        settings: {},
      });
      registerProject(created.id);

      await expect(
        projectsService.delete(otherCtx, created.id),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof BaseException && err.errorCode === 'PROJECT_NOT_FOUND',
      );

      // Project should still exist
      const stillExists = await projectsService.findById(ctx, created.id);
      expect(stillExists.id).toBe(created.id);
    });
  });
});
