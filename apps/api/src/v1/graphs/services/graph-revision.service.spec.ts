import { EntityManager } from '@mikro-orm/postgresql';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  DefaultLogger,
  NotFoundException,
} from '@packages/common';
import { compare } from 'fast-json-patch';
import type { FastifyRequest } from 'fastify';
import * as timers from 'timers/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { TemplateRegistry } from '../../graph-templates/services/template-registry';
import { LlmModelsService } from '../../litellm/services/llm-models.service';
import { NotificationEvent } from '../../notifications/notifications.types';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { ProjectsDao } from '../../projects/dao/projects.dao';
import { GraphDao } from '../dao/graph.dao';
import { GraphRevisionDao } from '../dao/graph-revision.dao';
import { GraphEntity } from '../entity/graph.entity';
import { GraphRevisionEntity } from '../entity/graph-revision.entity';
import { GraphRevisionStatus, GraphStatus } from '../graphs.types';
import { GraphCompiler } from './graph-compiler';
import { GraphMergeService } from './graph-merge.service';
import { GraphRegistry } from './graph-registry';
import { GraphRevisionService } from './graph-revision.service';
import {
  GraphRevisionJobData,
  GraphRevisionQueueService,
} from './graph-revision-queue.service';

vi.mock('timers/promises', () => ({
  setTimeout: vi.fn(),
}));

describe('GraphRevisionService', () => {
  let service: GraphRevisionService;
  let graphUpdateDao: GraphRevisionDao;
  let graphDao: GraphDao;
  let graphUpdateQueue: GraphRevisionQueueService;
  let graphCompiler: GraphCompiler;
  let graphMergeService: GraphMergeService;
  let graphRegistry: GraphRegistry;
  let templateRegistry: TemplateRegistry;
  let em: EntityManager;
  let notificationsService: NotificationsService;
  const mockUserId = 'user-123';
  const mockGraphId = 'graph-456';
  const mockUpdateId = 'update-789';

  const mockCtx = new AppContextStorage(
    {
      userId: mockUserId,
      sub: mockUserId,
      email: 'test@example.com',
    },
    { headers: {} } as FastifyRequest,
  );

  const createMockGraphEntity = (
    overrides: Partial<GraphEntity> = {},
  ): GraphEntity =>
    ({
      id: mockGraphId,
      name: 'Test Graph',
      description: 'A test graph',
      version: '1.0.0',
      targetVersion: '1.0.0',
      schema: {
        nodes: [
          {
            id: 'node-1',
            template: 'runtime',
            config: { image: 'python:3.11' },
          },
        ],
        edges: [],
      },
      status: GraphStatus.Running,
      createdBy: mockUserId,
      projectId: 'project-123',
      temporary: false,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z'),
      deletedAt: null,
      ...overrides,
    }) as unknown as GraphEntity;

  const createMockUpdateEntity = (
    overrides: Partial<GraphRevisionEntity> = {},
  ): GraphRevisionEntity => ({
    id: mockUpdateId,
    graphId: mockGraphId,
    baseVersion: '1.0.0',
    toVersion: '1.0.1',
    configDiff: [],
    clientConfig: {
      schema: {
        nodes: [
          {
            id: 'node-1',
            template: 'runtime',
            config: { image: 'python:3.12' },
          },
        ],
        edges: [],
      },
      name: 'Test Graph',
      description: 'A test graph',
      temporary: false,
    },
    newConfig: {
      schema: {
        nodes: [
          {
            id: 'node-1',
            template: 'runtime',
            config: { image: 'python:3.12' },
          },
        ],
        edges: [],
      },
      name: 'Test Graph',
      description: 'A test graph',
      temporary: false,
    },
    status: GraphRevisionStatus.Pending,
    createdBy: mockUserId,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GraphRevisionService,
        {
          provide: GraphRevisionDao,
          useValue: {
            create: vi.fn(),
            getOne: vi.fn(),
            getAll: vi.fn(),
            updateById: vi.fn(),
            getById: vi.fn(),
          },
        },
        {
          provide: GraphDao,
          useValue: {
            getOne: vi.fn(),
            getById: vi.fn(),
            updateById: vi.fn(),
          },
        },
        {
          provide: GraphRevisionQueueService,
          useValue: {
            addRevision: vi.fn(),
            setProcessor: vi.fn(),
          },
        },
        {
          provide: GraphRegistry,
          useValue: {
            get: vi.fn(),
            destroy: vi.fn(),
          },
        },
        {
          provide: GraphCompiler,
          useValue: {
            validateSchema: vi.fn(),
            destroyNode: vi.fn(),
            prepareNode: vi.fn().mockReturnValue({
              template: { kind: 'runtime' },
              validatedConfig: {},
              init: {
                inputNodeIds: new Set(),
                outputNodeIds: new Set(),
                metadata: {},
              },
            }),
            createAndConfigureHandle: vi.fn().mockResolvedValue({
              instance: {},
              handle: {
                provide: async () => ({}),
                configure: vi.fn(),
                destroy: vi.fn(),
              },
            }),
            templateRegistry: {
              getTemplate: vi.fn(),
            },
          },
        },
        {
          provide: GraphMergeService,
          useValue: {
            mergeSchemas: vi.fn(),
          },
        },
        {
          provide: EntityManager,
          useValue: {
            transactional: vi.fn(),
            getUnitOfWork: vi.fn().mockReturnValue({
              getById: vi.fn().mockReturnValue(undefined),
              unsetIdentity: vi.fn(),
            }),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            emit: vi.fn(),
          },
        },
        {
          provide: DefaultLogger,
          useValue: {
            log: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
          },
        },
        {
          provide: TemplateRegistry,
          useValue: {
            validateTemplateConfig: vi.fn(),
            getTemplate: vi.fn(),
          },
        },
        {
          provide: LlmModelsService,
          useValue: {
            buildLLMRequestContext: vi
              .fn()
              .mockResolvedValue({ models: undefined }),
          },
        },
        {
          provide: ProjectsDao,
          useValue: {
            getOne: vi.fn().mockResolvedValue({ settings: {} }),
          },
        },
      ],
    }).compile();

    service = module.get<GraphRevisionService>(GraphRevisionService);
    graphUpdateDao = module.get<GraphRevisionDao>(GraphRevisionDao);
    graphDao = module.get<GraphDao>(GraphDao);
    graphUpdateQueue = module.get<GraphRevisionQueueService>(
      GraphRevisionQueueService,
    );
    graphCompiler = module.get<GraphCompiler>(GraphCompiler);
    graphMergeService = module.get<GraphMergeService>(GraphMergeService);
    graphRegistry = module.get<GraphRegistry>(GraphRegistry);
    em = module.get<EntityManager>(EntityManager);
    notificationsService =
      module.get<NotificationsService>(NotificationsService);
    // authContext removal
    templateRegistry = module.get<TemplateRegistry>(TemplateRegistry);
  });

  describe('queueRevision', () => {
    it('should queue a graph update successfully with 3-way merge', async () => {
      const mockGraph = createMockGraphEntity();
      const mockUpdate = createMockUpdateEntity();
      const baseVersion = '1.0.0';
      const clientSchema = {
        nodes: [
          {
            id: 'node-1',
            template: 'runtime',
            config: { image: 'python:3.12' },
          },
        ],
        edges: [],
      };

      // authContext expectation removal
      vi.mocked(em.transactional).mockImplementation(async (callback) => {
        return await callback(em as never);
      });
      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphCompiler.validateSchema).mockReturnValue(undefined);
      vi.mocked(graphMergeService.mergeSchemas).mockReturnValue({
        success: true,
        mergedSchema: clientSchema,
        conflicts: [],
      });
      vi.mocked(graphUpdateDao.create).mockResolvedValue(mockUpdate);
      vi.mocked(graphUpdateQueue.addRevision).mockResolvedValue(undefined);
      vi.mocked(notificationsService.emit).mockResolvedValue(undefined as any);

      const result = await service.queueRevision(
        mockCtx,
        mockGraph,
        baseVersion,
        {
          schema: clientSchema,
          name: mockGraph.name,
          description: mockGraph.description ?? null,
          temporary: mockGraph.temporary,
        },
      );

      expect(result).toEqual(
        expect.objectContaining({
          id: mockUpdateId,
          graphId: mockGraphId,
          toVersion: '1.0.1',
          status: GraphRevisionStatus.Pending,
        }),
      );

      expect(graphCompiler.validateSchema).toHaveBeenCalledWith(clientSchema);
      expect(graphMergeService.mergeSchemas).toHaveBeenCalled();
      expect(graphUpdateDao.create).toHaveBeenCalled();
      expect(graphUpdateQueue.addRevision).toHaveBeenCalledWith({
        id: mockUpdateId,
        graphId: mockGraphId,
      });
      expect(notificationsService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationEvent.GraphRevisionCreate,
          graphId: mockGraphId,
        }),
      );
    });

    it('should allow deferring queue scheduling', async () => {
      const mockGraph = createMockGraphEntity();
      const mockUpdate = createMockUpdateEntity();

      // authContext expectation removal
      vi.mocked(em.transactional).mockImplementation(async (callback) => {
        return await callback(em as never);
      });
      vi.mocked(graphCompiler.validateSchema).mockReturnValue(undefined);
      vi.mocked(graphMergeService.mergeSchemas).mockReturnValue({
        success: true,
        mergedSchema: mockUpdate.newConfig.schema,
        conflicts: [],
      });
      vi.mocked(graphUpdateDao.create).mockResolvedValue(mockUpdate);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);
      vi.mocked(notificationsService.emit).mockResolvedValue(undefined as any);

      await service.queueRevision(
        mockCtx,
        mockGraph,
        mockGraph.version,
        mockUpdate.newConfig,
        undefined,
        { enqueueImmediately: false },
      );

      expect(graphUpdateQueue.addRevision).not.toHaveBeenCalled();
    });

    it('should validate schema before queuing', async () => {
      // authContext expectation removal
      vi.mocked(em.transactional).mockImplementation(async (callback) => {
        return await callback(em as never);
      });

      const mockGraph = createMockGraphEntity();
      const baseVersion = '1.0.0';
      const clientSchema = { nodes: [], edges: [] };

      vi.mocked(graphCompiler.validateSchema).mockImplementation(() => {
        throw new Error('Invalid schema');
      });

      await expect(
        service.queueRevision(mockCtx, mockGraph, baseVersion, {
          schema: clientSchema,
          name: mockGraph.name,
          description: mockGraph.description ?? null,
          temporary: mockGraph.temporary,
        }),
      ).rejects.toThrow('Invalid schema');

      expect(graphCompiler.validateSchema).toHaveBeenCalledWith(clientSchema);
    });

    it('should calculate diff when schemas are different', async () => {
      const mockGraph = createMockGraphEntity({
        schema: {
          nodes: [{ id: 'node-1', template: 'test', config: {} }],
          edges: [],
        },
      });

      const baseVersion = '1.0.0';
      const clientSchema = {
        nodes: [
          { id: 'node-1', template: 'test', config: {} },
          { id: 'node-2', template: 'test', config: {} },
        ],
        edges: [],
      };

      // authContext expectation removal
      vi.mocked(em.transactional).mockImplementation(async (callback) => {
        return await callback(em as never);
      });
      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphCompiler.validateSchema).mockReturnValue(undefined);
      vi.mocked(graphMergeService.mergeSchemas).mockReturnValue({
        success: true,
        mergedSchema: clientSchema,
        conflicts: [],
      });

      const mockUpdate = createMockUpdateEntity({
        configDiff: [
          { op: 'add', path: '/schema/nodes/1', value: clientSchema.nodes[1] },
        ],
      });

      vi.mocked(graphUpdateDao.create).mockResolvedValue(mockUpdate);
      vi.mocked(graphUpdateQueue.addRevision).mockResolvedValue(undefined);
      vi.mocked(notificationsService.emit).mockResolvedValue(undefined as any);

      await service.queueRevision(mockCtx, mockGraph, baseVersion, {
        schema: clientSchema,
        name: mockGraph.name,
        description: mockGraph.description ?? null,
        temporary: mockGraph.temporary,
      });

      expect(graphUpdateDao.create).toHaveBeenCalledWith(
        expect.objectContaining({
          configDiff: expect.anything(),
        }),
        expect.any(Object),
      );
    });

    it('should throw when no schema changes are detected', async () => {
      const mockGraph = createMockGraphEntity();
      const baseVersion = mockGraph.version;
      const clientSchema = JSON.parse(JSON.stringify(mockGraph.schema));

      // authContext expectation removal
      vi.mocked(em.transactional).mockImplementation(async (callback) => {
        return await callback(em as never);
      });
      vi.mocked(graphCompiler.validateSchema).mockReturnValue(undefined);
      vi.mocked(graphMergeService.mergeSchemas).mockReturnValue({
        success: true,
        mergedSchema: clientSchema,
        conflicts: [],
      });

      await expect(
        service.queueRevision(mockCtx, mockGraph, baseVersion, {
          schema: clientSchema,
          name: mockGraph.name,
          description: mockGraph.description ?? null,
          temporary: mockGraph.temporary,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(graphUpdateDao.create).not.toHaveBeenCalled();
      expect(graphDao.updateById).not.toHaveBeenCalled();
    });

    it('should throw MERGE_CONFLICT when merge fails', async () => {
      const mockGraph = createMockGraphEntity();
      const baseVersion = '1.0.0';
      const clientSchema = { nodes: [], edges: [] };

      // authContext expectation removal
      vi.mocked(em.transactional).mockImplementation(async (callback) => {
        return await callback(em as never);
      });
      vi.mocked(graphCompiler.validateSchema).mockReturnValue(undefined);
      vi.mocked(graphMergeService.mergeSchemas).mockReturnValue({
        success: false,
        conflicts: [
          {
            path: '/nodes/0/config/image',
            baseValue: 'python:3.11',
            headValue: 'python:3.12',
            clientValue: 'python:3.13',
            type: 'concurrent_modification',
            description: 'Concurrent modification detected',
          },
        ],
      });

      await expect(
        service.queueRevision(mockCtx, mockGraph, baseVersion, {
          schema: clientSchema,
          name: mockGraph.name,
          description: mockGraph.description ?? null,
          temporary: mockGraph.temporary,
        }),
      ).rejects.toThrow('Cannot merge changes due to conflicts');
    });
  });

  describe('getRevisions', () => {
    it('should return all revisions for a graph', async () => {
      const mockRevisions = [
        createMockUpdateEntity(),
        createMockUpdateEntity({ id: 'update-2' }),
      ];

      // authContext expectation removal
      vi.mocked(graphUpdateDao.getAll).mockResolvedValue(mockRevisions);

      const result = await service.getRevisions(mockCtx, mockGraphId, {});

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: mockUpdateId,
          graphId: mockGraphId,
        }),
      );

      expect(graphUpdateDao.getAll).toHaveBeenCalledWith(
        expect.objectContaining({
          graphId: mockGraphId,
          createdBy: mockUserId,
        }),
        expect.objectContaining({
          orderBy: { createdAt: 'DESC' },
        }),
      );

      const optionsArg = vi.mocked(graphUpdateDao.getAll).mock.calls[0]?.[1];
      expect(optionsArg?.limit).toBeUndefined();
    });

    it('should filter revisions by status if provided', async () => {
      const mockRevisions = [
        createMockUpdateEntity({ status: GraphRevisionStatus.Applied }),
      ];

      // authContext expectation removal
      vi.mocked(graphUpdateDao.getAll).mockResolvedValue(mockRevisions);

      await service.getRevisions(mockCtx, mockGraphId, {
        status: GraphRevisionStatus.Applied,
      });

      expect(graphUpdateDao.getAll).toHaveBeenCalledWith(
        expect.objectContaining({
          graphId: mockGraphId,
          createdBy: mockUserId,
          status: GraphRevisionStatus.Applied,
        }),
        expect.objectContaining({
          orderBy: { createdAt: 'DESC' },
        }),
      );
    });

    it('should apply limit when provided', async () => {
      const mockRevisions = [createMockUpdateEntity()];

      // authContext expectation removal
      vi.mocked(graphUpdateDao.getAll).mockResolvedValue(mockRevisions);

      await service.getRevisions(mockCtx, mockGraphId, { limit: 1 } as any);

      expect(graphUpdateDao.getAll).toHaveBeenCalledWith(
        expect.objectContaining({
          graphId: mockGraphId,
          createdBy: mockUserId,
        }),
        expect.objectContaining({
          orderBy: { createdAt: 'DESC' },
          limit: 1,
        }),
      );
    });
  });

  describe('getRevisionById', () => {
    it('should return a specific revision', async () => {
      const mockRevision = createMockUpdateEntity();

      // authContext expectation removal
      vi.mocked(graphUpdateDao.getOne).mockResolvedValue(mockRevision);

      const result = await service.getRevisionById(
        mockCtx,
        mockGraphId,
        mockUpdateId,
      );

      expect(result).toEqual(
        expect.objectContaining({
          id: mockUpdateId,
          graphId: mockGraphId,
        }),
      );

      expect(graphUpdateDao.getOne).toHaveBeenCalledWith({
        id: mockUpdateId,
        graphId: mockGraphId,
        createdBy: mockUserId,
      });
    });

    it('should throw NotFoundException when revision does not exist', async () => {
      // authContext expectation removal
      vi.mocked(graphUpdateDao.getOne).mockResolvedValue(null);

      await expect(
        service.getRevisionById(mockCtx, mockGraphId, mockUpdateId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('applyRevision', () => {
    it('re-merges revision when head changes and persists updated schema and diff', async () => {
      const baseVersion = '1.0.0';
      const toVersion = '1.0.2';

      const baseSchema = {
        nodes: [
          {
            id: 'node-1',
            template: 'runtime',
            config: { image: 'python:3.11' },
          },
        ],
        edges: [],
      };

      const headSchema = {
        nodes: [
          {
            id: 'node-1',
            template: 'runtime',
            config: { image: 'python:3.12' },
          },
        ],
        edges: [],
      };

      const clientSchema = {
        nodes: [
          {
            id: 'node-1',
            template: 'runtime',
            config: { image: 'python:3.13' },
          },
        ],
        edges: [],
      };

      const mergedSchema = {
        nodes: [
          {
            id: 'node-1',
            template: 'runtime',
            config: { image: 'python:3.13', restartPolicy: 'always' },
          },
        ],
        edges: [],
      };

      const revision = createMockUpdateEntity({
        baseVersion,
        toVersion,
        clientConfig: {
          schema: clientSchema,
          name: 'Test Graph',
          description: 'A test graph',
          temporary: false,
        },
        newConfig: {
          schema: clientSchema,
          name: 'Test Graph',
          description: 'A test graph',
          temporary: false,
        },
        configDiff: [],
      });

      const graph = createMockGraphEntity({
        version: '1.0.1',
        targetVersion: toVersion,
        schema: headSchema,
        status: GraphStatus.Stopped,
      });

      const baseRevision = createMockUpdateEntity({
        toVersion: baseVersion,
        newConfig: {
          schema: baseSchema,
          name: 'Test Graph',
          description: 'A test graph',
          temporary: false,
        },
      });

      vi.mocked(em.transactional).mockImplementation(async (callback) => {
        return await callback(em as never);
      });
      vi.mocked(graphUpdateDao.getById).mockResolvedValue(revision);
      vi.mocked(graphUpdateDao.getOne).mockImplementation(
        async (params: any) => {
          if (params?.toVersion === baseVersion) {
            return baseRevision;
          }
          return null;
        },
      );
      vi.mocked(graphMergeService.mergeSchemas).mockReturnValue({
        success: true,
        mergedSchema,
        conflicts: [],
      });
      vi.mocked(graphCompiler.validateSchema).mockReturnValue(undefined);
      vi.mocked(graphDao.getOne).mockResolvedValue(graph);
      vi.mocked(graphRegistry.get).mockReturnValue(undefined);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);
      vi.mocked(graphUpdateDao.updateById).mockImplementation(
        async (_id: string, data: any) =>
          ({
            ...revision,
            ...(data || {}),
          }) as unknown as Promise<number>,
      );
      vi.mocked(notificationsService.emit).mockResolvedValue(undefined as any);

      await (
        service as unknown as {
          applyRevision(job: GraphRevisionJobData): Promise<void>;
        }
      ).applyRevision({
        revisionId: revision.id,
        graphId: revision.graphId,
      });

      expect(graphMergeService.mergeSchemas).toHaveBeenCalledWith(
        baseSchema,
        headSchema,
        clientSchema,
      );

      const headConfig = {
        schema: headSchema,
        name: graph.name,
        description: graph.description,
        temporary: graph.temporary,
      };
      const mergedConfig = {
        schema: mergedSchema,
        name: graph.name,
        description: graph.description,
        temporary: graph.temporary,
      };

      const expectedDiff = compare(headConfig, mergedConfig);

      expect(revision.newConfig.schema).toEqual(mergedSchema);
      expect(revision.configDiff).toEqual(expectedDiff);

      const schemaUpdateCall = vi
        .mocked(graphUpdateDao.updateById)
        .mock.calls.find(
          (call) =>
            call[0] === revision.id &&
            call[1] &&
            'newConfig' in call[1] &&
            'configDiff' in call[1],
        );

      expect(schemaUpdateCall?.[1]).toEqual(
        expect.objectContaining({
          newConfig: mergedConfig,
          configDiff: expectedDiff,
        }),
      );
    });
  });

  describe('applyRevision - waiting for graph during restoration', () => {
    it('should wait for graph to become available when being restored', async () => {
      const revision = createMockUpdateEntity({
        status: GraphRevisionStatus.Pending,
      });

      const graph = createMockGraphEntity({
        status: GraphStatus.Compiling, // Graph is compiling and not yet in registry
      });

      const mockCompiledGraph = {
        metadata: {
          graphId: revision.graphId,
          version: '1.0.0',
          graph_created_by: 'user-123',
          graph_project_id: 'project-123',
        },
        nodes: new Map([
          [
            'node-1',
            {
              id: 'node-1',
              type: 'runtime',
              template: 'runtime',
              config: { image: 'python:3.11' },
              instance: {},
              handle: {
                provide: async () => ({}),
                configure: vi.fn().mockResolvedValue(undefined),
                destroy: vi.fn().mockResolvedValue(undefined),
              },
            },
          ],
        ]),
        edges: [],
        state: {
          registerNode: vi.fn(),
          unregisterNode: vi.fn(),
          attachGraphNode: vi.fn(),
        },
        status: GraphStatus.Compiling,
      };

      vi.mocked(em.transactional).mockImplementation(async (callback) => {
        return await callback(em as never);
      });
      vi.mocked(graphUpdateDao.getById).mockResolvedValue(revision);
      vi.mocked(graphUpdateDao.getOne).mockResolvedValue(null);
      vi.mocked(graphDao.getOne).mockResolvedValue(graph);

      const setTimeoutMock = vi.mocked(timers.setTimeout);
      setTimeoutMock.mockImplementation(async () => {
        mockCompiledGraph.status = GraphStatus.Running;
      });

      vi.mocked(graphRegistry.get).mockReturnValue(mockCompiledGraph as any);

      // Mock getById for the waitForGraphInRegistry check
      vi.mocked(graphDao.getById).mockResolvedValue(graph);

      vi.mocked(graphCompiler.validateSchema).mockReturnValue(undefined);
      vi.mocked(graphUpdateDao.updateById).mockResolvedValue(1);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);
      vi.mocked(notificationsService.emit).mockResolvedValue(undefined as any);

      // Mock template registry for applyLiveUpdate
      const mockTemplate = {
        kind: 'runtime',
        create: vi.fn().mockResolvedValue({} as any),
      };
      vi.mocked(templateRegistry.getTemplate).mockReturnValue(
        mockTemplate as any,
      );
      vi.mocked(templateRegistry.validateTemplateConfig).mockReturnValue(
        revision.newConfig.schema.nodes[0]?.config,
      );
      (graphCompiler as any).getBuildOrder = vi
        .fn()
        .mockReturnValue(revision.newConfig.schema.nodes);
      (graphCompiler as any).destroyNode = vi.fn().mockResolvedValue(undefined);

      await (
        service as unknown as {
          applyRevision(job: GraphRevisionJobData): Promise<void>;
        }
      ).applyRevision({
        revisionId: revision.id,
        graphId: revision.graphId,
      });

      // Should have waited for compiling graph to reach running status
      expect(graphRegistry.get).toHaveBeenCalledWith(revision.graphId);
      expect(setTimeoutMock).toHaveBeenCalled();
      expect(mockCompiledGraph.status).toBe(GraphStatus.Running);

      setTimeoutMock.mockReset();
    });

    it('should apply revision only to persisted schema when graph is stopped', async () => {
      const revision = createMockUpdateEntity({
        status: GraphRevisionStatus.Pending,
      });

      const graph = createMockGraphEntity({
        status: GraphStatus.Stopped, // Graph is stopped, not being restored
      });

      vi.mocked(em.transactional).mockImplementation(async (callback) => {
        return await callback(em as never);
      });
      vi.mocked(graphUpdateDao.getById).mockResolvedValue(revision);
      vi.mocked(graphUpdateDao.getOne).mockResolvedValue(null);
      vi.mocked(graphDao.getOne).mockResolvedValue(graph);
      vi.mocked(graphRegistry.get).mockReturnValue(undefined);
      vi.mocked(graphCompiler.validateSchema).mockReturnValue(undefined);
      vi.mocked(graphUpdateDao.updateById).mockResolvedValue(1);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);
      vi.mocked(notificationsService.emit).mockResolvedValue(undefined as any);

      await (
        service as unknown as {
          applyRevision(job: GraphRevisionJobData): Promise<void>;
        }
      ).applyRevision({
        revisionId: revision.id,
        graphId: revision.graphId,
      });

      // Should only call registry.get once since graph is stopped (not being restored)
      expect(graphRegistry.get).toHaveBeenCalledTimes(1);
      expect(graphDao.updateById).toHaveBeenCalledWith(
        revision.graphId,
        expect.objectContaining({
          schema: revision.newConfig.schema,
          version: revision.toVersion,
        }),
        expect.anything(),
      );
    });

    it('should throw when graph stays in Compiling status beyond the timeout', async () => {
      const compiledGraph = {
        metadata: {
          graphId: 'test',
          version: '1.0.0',
          graph_created_by: 'user',
          graph_project_id: 'project',
        },
        nodes: new Map(),
        edges: [],
        state: {
          registerNode: vi.fn(),
          unregisterNode: vi.fn(),
          attachGraphNode: vi.fn(),
        },
        status: GraphStatus.Compiling,
      };

      const setTimeoutMock = vi.mocked(timers.setTimeout);
      // Each setTimeout call simulates waiting but does NOT change the status,
      // so the loop keeps going until the time exceeds 180_000 ms.
      let elapsedTime = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        // First call returns 0 (startTime), subsequent calls advance past timeout
        const current = elapsedTime;
        elapsedTime += 200_000;
        return current;
      });
      setTimeoutMock.mockResolvedValue(undefined);

      await expect(
        (service as any).waitForGraphCompilationIfNeeded(compiledGraph),
      ).rejects.toThrow('Graph compilation did not complete within 3 minutes');

      vi.restoreAllMocks();
      setTimeoutMock.mockReset();
    });

    it('should stop waiting when graph status changes to non-running state', async () => {
      const revision = createMockUpdateEntity({
        status: GraphRevisionStatus.Pending,
      });

      const runningGraph = createMockGraphEntity({
        status: GraphStatus.Running,
      });

      const stoppedGraph = createMockGraphEntity({
        status: GraphStatus.Stopped, // Status changed during wait
      });

      vi.mocked(em.transactional).mockImplementation(async (callback) => {
        return await callback(em as never);
      });
      vi.mocked(graphUpdateDao.getById).mockResolvedValue(revision);
      vi.mocked(graphUpdateDao.getOne).mockResolvedValue(null);
      vi.mocked(graphDao.getOne).mockResolvedValue(runningGraph);
      vi.mocked(graphRegistry.get).mockReturnValue(undefined);
      vi.mocked(graphCompiler.validateSchema).mockReturnValue(undefined);
      vi.mocked(graphUpdateDao.updateById).mockResolvedValue(1);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);
      vi.mocked(notificationsService.emit).mockResolvedValue(undefined as any);

      // Return stopped graph on subsequent getById calls (simulating status change)
      vi.mocked(graphDao.getById).mockResolvedValue(stoppedGraph);

      await (
        service as unknown as {
          applyRevision(job: GraphRevisionJobData): Promise<void>;
        }
      ).applyRevision({
        revisionId: revision.id,
        graphId: revision.graphId,
      });

      // Should have stopped waiting early due to status change
      expect(graphRegistry.get).toHaveBeenCalled();
      // Revision should still be finalized to persisted schema
      expect(graphDao.updateById).toHaveBeenCalled();
    });
  });

  describe('handleRevisionFailure', () => {
    it('should destroy running graph and set status to Error', async () => {
      const revision = createMockUpdateEntity();
      const error = new Error('Live update failed');
      const graph = createMockGraphEntity({ status: GraphStatus.Running });

      const compiledGraph = {
        metadata: {
          graphId: revision.graphId,
          version: '1.0.0',
          graph_created_by: 'user',
          graph_project_id: 'project',
        },
        nodes: new Map(),
        edges: [],
        state: {
          registerNode: vi.fn(),
          unregisterNode: vi.fn(),
          attachGraphNode: vi.fn(),
        },
        status: GraphStatus.Running,
      };

      vi.mocked(em.transactional).mockImplementation(async (callback) => {
        return await callback(em as never);
      });
      vi.mocked(graphDao.getOne).mockResolvedValue(graph);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);
      vi.mocked(graphUpdateDao.updateById).mockResolvedValue(1);
      vi.mocked(graphRegistry.get).mockReturnValue(compiledGraph as any);
      vi.mocked(graphRegistry.destroy).mockResolvedValue(undefined);
      vi.mocked(notificationsService.emit).mockResolvedValue(undefined as any);

      await (service as any).handleRevisionFailure(revision, error);

      expect(graphRegistry.destroy).toHaveBeenCalledWith(revision.graphId);
      expect(graphDao.updateById).toHaveBeenCalledWith(
        revision.graphId,
        expect.objectContaining({
          status: GraphStatus.Error,
        }),
      );
      expect(notificationsService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationEvent.Graph,
          graphId: revision.graphId,
          data: { status: GraphStatus.Error },
        }),
      );
      // GraphRevisionFailed notification should also be emitted
      expect(notificationsService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationEvent.GraphRevisionFailed,
          graphId: revision.graphId,
        }),
      );
    });

    it('should NOT destroy graph when compiled graph is not running', async () => {
      const revision = createMockUpdateEntity();
      const error = new Error('Merge failed');
      const graph = createMockGraphEntity({ status: GraphStatus.Stopped });

      vi.mocked(em.transactional).mockImplementation(async (callback) => {
        return await callback(em as never);
      });
      vi.mocked(graphDao.getOne).mockResolvedValue(graph);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);
      vi.mocked(graphUpdateDao.updateById).mockResolvedValue(1);
      vi.mocked(graphRegistry.get).mockReturnValue(undefined);
      vi.mocked(notificationsService.emit).mockResolvedValue(undefined as any);

      await (service as any).handleRevisionFailure(revision, error);

      expect(graphRegistry.destroy).not.toHaveBeenCalled();
      // GraphRevisionFailed notification should still be emitted
      expect(notificationsService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationEvent.GraphRevisionFailed,
          graphId: revision.graphId,
        }),
      );
    });

    it('should still emit GraphRevisionFailed even if graphRegistry.destroy() throws', async () => {
      const revision = createMockUpdateEntity();
      const error = new Error('Live update failed');
      const graph = createMockGraphEntity({ status: GraphStatus.Running });

      const compiledGraph = {
        metadata: {
          graphId: revision.graphId,
          version: '1.0.0',
          graph_created_by: 'user',
          graph_project_id: 'project',
        },
        nodes: new Map(),
        edges: [],
        state: {
          registerNode: vi.fn(),
          unregisterNode: vi.fn(),
          attachGraphNode: vi.fn(),
        },
        status: GraphStatus.Running,
      };

      vi.mocked(em.transactional).mockImplementation(async (callback) => {
        return await callback(em as never);
      });
      vi.mocked(graphDao.getOne).mockResolvedValue(graph);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);
      vi.mocked(graphUpdateDao.updateById).mockResolvedValue(1);
      vi.mocked(graphRegistry.get).mockReturnValue(compiledGraph as any);
      vi.mocked(graphRegistry.destroy).mockRejectedValue(
        new Error('Container cleanup failed'),
      );
      vi.mocked(notificationsService.emit).mockResolvedValue(undefined as any);

      await (service as any).handleRevisionFailure(revision, error);

      expect(graphRegistry.destroy).toHaveBeenCalledWith(revision.graphId);
      // Even though destroy threw, the GraphRevisionFailed notification must still be emitted
      expect(notificationsService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationEvent.GraphRevisionFailed,
          graphId: revision.graphId,
        }),
      );
    });
  });

  describe('reMergeRevisionIfNeeded', () => {
    it('should throw REVISION_BASE_UNAVAILABLE when base config is null and re-merge is needed', async () => {
      const revision = createMockUpdateEntity({
        baseVersion: '1.0.0',
      });
      const graph = createMockGraphEntity({
        version: '1.0.1', // Different from revision.baseVersion, so re-merge is needed
      });

      vi.mocked(graphCompiler.validateSchema).mockReturnValue(undefined);

      const thrownError = await (service as any)
        .reMergeRevisionIfNeeded(
          revision,
          graph,
          null, // baseSchemaCache is null
          null, // baseConfigCache is null
          {} as EntityManager,
        )
        .catch((e: unknown) => e);

      expect(thrownError).toBeInstanceOf(BadRequestException);
      expect((thrownError as BadRequestException).errorCode).toBe(
        'REVISION_BASE_UNAVAILABLE',
      );
    });
  });

  describe('finalizeAppliedRevision', () => {
    it('should call pruneOldRevisions and finalize even if pruning fails', async () => {
      const revision = createMockUpdateEntity({
        toVersion: '1.0.1',
      });
      const graph = createMockGraphEntity({
        version: '1.0.0',
        targetVersion: '1.0.1',
      });

      const mockEntityManager = {} as unknown as EntityManager;

      vi.mocked(graphDao.updateById).mockResolvedValue(1);
      vi.mocked(graphUpdateDao.updateById).mockResolvedValue(1);

      // Should not throw even though pruning will fail internally
      await (service as any).finalizeAppliedRevision(
        graph,
        revision,
        mockEntityManager,
      );

      // Graph and revision should still be updated (finalization succeeded)
      expect(graphDao.updateById).toHaveBeenCalledWith(
        revision.graphId,
        expect.objectContaining({
          schema: revision.newConfig.schema,
          version: revision.toVersion,
        }),
        mockEntityManager,
      );
      expect(graphUpdateDao.updateById).toHaveBeenCalledWith(
        revision.id,
        expect.objectContaining({
          status: GraphRevisionStatus.Applied,
        }),
        mockEntityManager,
      );
      // GraphRevisionApplied notification is now emitted by applyRevisionTransaction
      // after the Phase 3 transaction commits, not inside finalizeAppliedRevision.
      expect(notificationsService.emit).not.toHaveBeenCalled();
    });
  });
});
