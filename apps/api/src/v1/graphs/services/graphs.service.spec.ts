import type { BaseMessage } from '@langchain/core/messages';
import { EntityManager } from '@mikro-orm/postgresql';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  DefaultLogger,
  NotFoundException,
} from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { GraphCheckpointsDao } from '../../agents/dao/graph-checkpoints.dao';
import { CheckpointStateService } from '../../agents/services/checkpoint-state.service';
import { PgCheckpointSaver } from '../../agents/services/pg-checkpoint-saver';
import { TemplateRegistry } from '../../graph-templates/services/template-registry';
import { NotificationEvent } from '../../notifications/notifications.types';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { ProjectsDao } from '../../projects/dao/projects.dao';
import { ThreadsDao } from '../../threads/dao/threads.dao';
import { ThreadResumeQueueService } from '../../threads/services/thread-resume-queue.service';
import { ThreadStatus } from '../../threads/threads.types';
import { GraphDao } from '../dao/graph.dao';
import {
  CreateGraphDto,
  GraphDto,
  GraphNodesQueryDto,
  MessageDto,
  UpdateGraphDto,
} from '../dto/graphs.dto';
import { GraphEntity } from '../entity/graph.entity';
import { GRAPH_DELETED_EVENT, GraphDeletedEvent } from '../graphs.events';
import {
  CompiledGraph,
  CompiledGraphNode,
  GraphNodeStatus,
  GraphStatus,
  MessageRole,
  NodeKind,
} from '../graphs.types';
import { CostLimitResolverService } from './cost-limit-resolver.service';
import { GraphCompiler } from './graph-compiler';
import { GraphRegistry } from './graph-registry';
import { GraphRevisionService } from './graph-revision.service';
import { GraphsService } from './graphs.service';
import { MessageTransformerService } from './message-transformer.service';

describe('GraphsService', () => {
  let module: TestingModule;
  let service: GraphsService;
  let graphDao: GraphDao;
  let graphCompiler: GraphCompiler;
  let graphRegistry: GraphRegistry;
  let em: EntityManager;
  let _graphCheckpointsDao: GraphCheckpointsDao;
  let _pgCheckpointSaver: PgCheckpointSaver;
  let messageTransformer: MessageTransformerService;
  let notificationsService: NotificationsService;
  let graphRevisionService: GraphRevisionService;
  let threadsDao: ThreadsDao;
  let eventEmitter: EventEmitter2;
  let logger: DefaultLogger;
  let projectsDao: ProjectsDao;
  let costLimitResolver: CostLimitResolverService;
  let checkpointStateService: CheckpointStateService;

  const mockUserId = 'user-123';
  const mockProjectId = '11111111-1111-1111-1111-111111111111';
  const mockCtx = new AppContextStorage({ sub: mockUserId }, {
    headers: { 'x-project-id': mockProjectId },
  } as unknown as import('fastify').FastifyRequest);
  const mockGraphId = 'graph-456';

  const makeCtxWithProject = (projectId: string) =>
    new AppContextStorage({ sub: mockUserId }, {
      headers: { 'x-project-id': projectId },
    } as unknown as import('fastify').FastifyRequest);

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
      status: GraphStatus.Created,
      createdBy: mockUserId,
      projectId: 'project-123',
      temporary: true,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z'),
      deletedAt: null,
      ...overrides,
    }) as unknown as GraphEntity;

  const createMockGraphDto = (overrides: Partial<GraphDto> = {}): GraphDto => ({
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
    status: GraphStatus.Created,
    runningThreads: 0,
    totalThreads: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  });

  const createMockCompiledGraph = (): CompiledGraph => {
    const instance = { container: 'test-container' };
    const nodes = new Map<string, CompiledGraphNode>([
      [
        'node-1',
        {
          id: 'node-1',
          type: NodeKind.Runtime,
          template: 'test-runtime',
          config: {},
          instance,
          handle: {
            provide: async () => instance,
            configure: vi.fn(),
            destroy: vi.fn(),
          },
        },
      ],
    ]);

    const state = {
      getSnapshots: vi.fn().mockImplementation(() =>
        Array.from(nodes.values()).map((node) => ({
          id: node.id,
          name: node.id,
          template: node.template,
          type: node.type,
          status: GraphNodeStatus.Idle,
          config: node.config,
          error: null,
        })),
      ),
      handleGraphDestroyed: vi.fn(),
    } as unknown as CompiledGraph['state'];

    return {
      metadata: {
        graphId: mockGraphId,
        version: '1.0.0',
        graph_created_by: mockUserId,
        graph_project_id: 'project-123',
      },
      nodes,
      edges: [],
      state,
      status: GraphStatus.Running,
      destroy: vi.fn().mockResolvedValue(undefined),
    } as CompiledGraph;
  };

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        GraphsService,
        {
          provide: GraphDao,
          useValue: {
            create: vi.fn(),
            getOne: vi.fn(),
            getAll: vi.fn(),
            updateById: vi.fn(),
            deleteById: vi.fn(),
          },
        },
        {
          provide: GraphCompiler,
          useValue: {
            compile: vi.fn(),
            validateSchema: vi.fn(),
          },
        },
        {
          provide: GraphRegistry,
          useValue: {
            register: vi.fn(),
            get: vi.fn(),
            getNode: vi.fn(),
            destroy: vi.fn(),
            setStatus: vi.fn(),
            getStatus: vi.fn().mockReturnValue(undefined),
          },
        },
        {
          provide: ThreadsDao,
          useValue: {
            getOne: vi.fn(),
            getAll: vi.fn(),
            create: vi.fn(),
            upsertByExternalThreadId: vi.fn(),
            updateById: vi.fn(),
            deleteById: vi.fn(),
            hardDelete: vi.fn(),
            countByGraphIds: vi.fn(),
          },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emitAsync: vi.fn().mockResolvedValue([]),
          },
        },
        {
          provide: EntityManager,
          useValue: {
            transactional: vi.fn(),
            fork: vi.fn().mockReturnValue({
              transactional: vi.fn(async (cb) =>
                cb({} as unknown as EntityManager),
              ),
            }),
          },
        },
        {
          provide: GraphCheckpointsDao,
          useValue: {
            getOne: vi.fn(),
            getAll: vi.fn(),
          },
        },
        {
          provide: PgCheckpointSaver,
          useValue: {
            serde: {
              loadsTyped: vi.fn(),
            },
          },
        },
        {
          provide: MessageTransformerService,
          useValue: {
            transformMessageToDto: vi.fn(),
            transformMessagesToDto: vi.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            emit: vi.fn(),
          },
        },
        {
          provide: GraphRevisionService,
          useValue: {
            queueRevision: vi.fn(),
            getRevisions: vi.fn(),
            generateNextVersion: vi.fn(),
            enqueueRevisionProcessing: vi.fn(),
            isVersionLess: vi.fn().mockReturnValue(false),
          },
        },
        {
          provide: DefaultLogger,
          useValue: {
            debug: vi.fn(),
            info: vi.fn(),
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
          provide: TemplateRegistry,
          useValue: {
            getTemplate: vi.fn().mockReturnValue(undefined),
            getTemplatesByKind: vi.fn().mockReturnValue([]),
          },
        },
        {
          provide: ThreadResumeQueueService,
          useValue: {
            cancelAllForGraph: vi.fn().mockResolvedValue(undefined),
            cancelResumeJob: vi.fn().mockResolvedValue(undefined),
            scheduleResume: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CostLimitResolverService,
          useValue: {
            resolveForThread: vi.fn().mockResolvedValue(null),
          },
        },
        {
          provide: CheckpointStateService,
          useValue: {
            getThreadTokenUsage: vi.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = module.get<GraphsService>(GraphsService);
    graphDao = module.get<GraphDao>(GraphDao);
    graphCompiler = module.get<GraphCompiler>(GraphCompiler);
    graphRegistry = module.get<GraphRegistry>(GraphRegistry);
    em = module.get<EntityManager>(EntityManager);
    _graphCheckpointsDao = module.get<GraphCheckpointsDao>(GraphCheckpointsDao);
    _pgCheckpointSaver = module.get<PgCheckpointSaver>(PgCheckpointSaver);
    messageTransformer = module.get<MessageTransformerService>(
      MessageTransformerService,
    );
    notificationsService =
      module.get<NotificationsService>(NotificationsService);
    graphRevisionService =
      module.get<GraphRevisionService>(GraphRevisionService);
    threadsDao = module.get<ThreadsDao>(ThreadsDao);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    logger = module.get<DefaultLogger>(DefaultLogger);
    projectsDao = module.get<ProjectsDao>(ProjectsDao);
    costLimitResolver = module.get<CostLimitResolverService>(
      CostLimitResolverService,
    );
    checkpointStateService = module.get<CheckpointStateService>(
      CheckpointStateService,
    );
    vi.mocked(threadsDao.getOne).mockResolvedValue(null);
    vi.mocked(threadsDao.create).mockResolvedValue({} as any);
    vi.mocked(threadsDao.getAll).mockResolvedValue([]);
    vi.mocked(threadsDao.updateById).mockResolvedValue(0 as never);
    vi.mocked(threadsDao.deleteById).mockResolvedValue(undefined);
    vi.mocked(threadsDao.hardDelete).mockResolvedValue(undefined);
    vi.mocked(threadsDao.countByGraphIds).mockResolvedValue(new Map());
    vi.mocked(graphRegistry.getStatus).mockReturnValue(undefined);
    vi.mocked(notificationsService.emit).mockResolvedValue(void 0 as any);
    vi.mocked(graphRevisionService.queueRevision).mockResolvedValue({
      id: 'revision-1',
      graphId: mockGraphId,
      baseVersion: '1.0.0',
      toVersion: '1.0.1',
      status: 'pending',
      configDiff: [],
      clientConfig: {} as any,
      newConfig: {} as any,
      createdBy: mockUserId,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      entity: {
        id: 'revision-1',
        graphId: mockGraphId,
        baseVersion: '1.0.0',
        toVersion: '1.0.1',
        status: 'pending',
        configDiff: [],
        clientConfig: {} as any,
        newConfig: {} as any,
        createdBy: mockUserId,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    } as any);
    vi.mocked(graphRevisionService.enqueueRevisionProcessing).mockResolvedValue(
      undefined,
    );
    vi.mocked(graphRevisionService.getRevisions).mockResolvedValue([]);
    vi.mocked(graphRevisionService.generateNextVersion).mockImplementation(
      (version) => {
        const parts = version.split('.');
        const lastIndex = parts.length - 1;
        const lastValue = parseInt(parts[lastIndex] ?? '0', 10) || 0;
        parts[lastIndex] = String(lastValue + 1);
        return parts.join('.');
      },
    );

    // Setup default mocks
    vi.mocked(em.transactional).mockImplementation(async (callback) => {
      const mockEntityManager = {} as unknown as EntityManager;
      return callback(mockEntityManager);
    });

    // Mock message transformer to transform BaseMessage instances
    const transformMessage = (msg: BaseMessage): MessageDto => {
      const typeName =
        (msg.constructor as unknown as { name?: string })?.name ??
        'BaseMessage';
      const obj = msg as unknown as Record<string, unknown>;

      if (typeName === 'HumanMessage') {
        return {
          role: MessageRole.Human,
          content: String(obj['content'] ?? ''),
          additionalKwargs: obj['additional_kwargs'] as
            | Record<string, unknown>
            | undefined,
        };
      }

      if (typeName === 'AIMessage' || typeName === 'AIMessageChunk') {
        return {
          role: MessageRole.AI,
          content: String(obj['content'] ?? ''),
          id: typeof obj['id'] === 'string' ? obj['id'] : undefined,
          // Keep this mock minimal; detailed toolCall mapping is tested elsewhere.
          toolCalls: undefined,
          additionalKwargs: obj['additional_kwargs'] as
            | Record<string, unknown>
            | undefined,
        };
      }

      return {
        role: MessageRole.System,
        content: String(obj['content'] ?? ''),
        additionalKwargs: obj['additional_kwargs'] as
          | Record<string, unknown>
          | undefined,
      };
    };

    vi.mocked(messageTransformer.transformMessageToDto).mockImplementation(
      transformMessage as unknown as typeof messageTransformer.transformMessageToDto,
    );
    vi.mocked(messageTransformer.transformMessagesToDto).mockImplementation(
      (messages) => (messages as BaseMessage[]).map((m) => transformMessage(m)),
    );
  });

  describe('create', () => {
    it('should create a new graph successfully', async () => {
      const createData: CreateGraphDto = {
        name: 'New Graph',
        description: 'A new test graph',
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
        metadata: {
          graphId: 'new-graph',
          name: 'New Graph',
          version: '1.0.0',
        },
      };

      const expectedEntity = createMockGraphEntity({
        id: 'new-graph-id',
        name: 'New Graph',
        description: 'A new test graph',
        status: GraphStatus.Created,
        createdBy: mockUserId,
      });

      const expectedGraph = createMockGraphDto({
        id: 'new-graph-id',
        name: 'New Graph',
        description: 'A new test graph',
        status: GraphStatus.Created,
      });

      vi.mocked(graphDao.create).mockResolvedValue(expectedEntity);

      const result = await service.create(mockCtx, createData);

      expect(result).toMatchObject(expectedGraph);
      expect(graphDao.create).toHaveBeenCalledWith(
        {
          ...createData,
          projectId: mockProjectId,
          status: GraphStatus.Created,
          createdBy: mockUserId,
          temporary: false,
          version: '1.0.0',
          targetVersion: '1.0.0',
          agents: [],
        },
        expect.any(Object), // EntityManager
      );
    });

    it('should extract agents from schema when template is a SimpleAgent', async () => {
      const templateRegistry = module.get<TemplateRegistry>(TemplateRegistry);
      vi.mocked(templateRegistry.getTemplate).mockImplementation(
        (id: string) => {
          if (id === 'simple-agent') {
            return { kind: NodeKind.SimpleAgent } as ReturnType<
              TemplateRegistry['getTemplate']
            >;
          }
          return undefined;
        },
      );

      const createData: CreateGraphDto = {
        name: 'Agent Graph',
        schema: {
          nodes: [
            {
              id: 'agent-node-1',
              template: 'simple-agent',
              config: { name: 'My Agent', description: 'Test desc' },
            },
            {
              id: 'trigger-1',
              template: 'manual-trigger',
              config: {},
            },
          ],
          edges: [],
        },
        metadata: {
          graphId: 'agent-graph',
          version: '1.0.0',
        },
      };

      const expectedEntity = createMockGraphEntity({
        id: 'agent-graph-id',
        name: 'Agent Graph',
        status: GraphStatus.Created,
        createdBy: mockUserId,
        agents: [
          {
            nodeId: 'agent-node-1',
            name: 'My Agent',
            description: 'Test desc',
          },
        ],
      });

      vi.mocked(graphDao.create).mockResolvedValue(expectedEntity);

      await service.create(mockCtx, createData);

      expect(graphDao.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agents: [
            {
              nodeId: 'agent-node-1',
              name: 'My Agent',
              description: 'Test desc',
            },
          ],
        }),
        expect.any(Object),
      );
    });

    it('should handle creation errors', async () => {
      const createData: CreateGraphDto = {
        name: 'New Graph',
        schema: {
          nodes: [],
          edges: [],
        },
        metadata: {
          graphId: 'new-graph',
          version: '1.0.0',
        },
      };

      const error = new Error('Database error');
      vi.mocked(graphDao.create).mockRejectedValue(error);

      await expect(service.create(mockCtx, createData)).rejects.toThrow(
        'Database error',
      );
    });

    it('should validate schema before creating graph', async () => {
      const createData: CreateGraphDto = {
        name: 'New Graph',
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
        metadata: {
          graphId: 'new-graph',
          version: '1.0.0',
        },
      };

      const expectedEntity = createMockGraphEntity({
        id: 'new-graph-id',
        name: 'New Graph',
        status: GraphStatus.Created,
        createdBy: mockUserId,
      });

      vi.mocked(graphDao.create).mockResolvedValue(expectedEntity);
      vi.mocked(graphCompiler.validateSchema).mockImplementation(() => {});

      await service.create(mockCtx, createData);

      expect(graphCompiler.validateSchema).toHaveBeenCalledWith(
        createData.schema,
      );
    });

    it('should throw BadRequestException for invalid schema', async () => {
      const createData: CreateGraphDto = {
        name: 'New Graph',
        schema: {
          nodes: [
            {
              id: 'node-1',
              template: 'invalid-template',
              config: {},
            },
          ],
          edges: [],
        },
        metadata: {
          graphId: 'new-graph',
          version: '1.0.0',
        },
      };

      const validationError = new BadRequestException(
        "Template 'invalid-template' is not registered",
      );
      vi.mocked(graphCompiler.validateSchema).mockImplementation(() => {
        throw validationError;
      });

      await expect(service.create(mockCtx, createData)).rejects.toThrow(
        validationError,
      );
      expect(graphDao.create).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException for duplicate node IDs', async () => {
      const createData: CreateGraphDto = {
        name: 'New Graph',
        schema: {
          nodes: [
            {
              id: 'duplicate-id',
              template: 'runtime',
              config: { image: 'python:3.11' },
            },
            {
              id: 'duplicate-id',
              template: 'runtime',
              config: { image: 'python:3.11' },
            },
          ],
          edges: [],
        },
        metadata: {
          graphId: 'new-graph',
          version: '1.0.0',
        },
      };

      const validationError = new BadRequestException(
        'Duplicate node IDs found in graph schema',
      );
      vi.mocked(graphCompiler.validateSchema).mockImplementation(() => {
        throw validationError;
      });

      await expect(service.create(mockCtx, createData)).rejects.toThrow(
        validationError,
      );
      expect(graphDao.create).not.toHaveBeenCalled();
    });

    it('should create graph with projectId when valid project provided in ctx', async () => {
      const projectUuid = '11111111-1111-1111-1111-111111111111';
      const ctxWithProject = makeCtxWithProject(projectUuid);

      const createData: CreateGraphDto = {
        name: 'Project Graph',
        schema: { nodes: [], edges: [] },
        metadata: { graphId: 'project-graph', version: '1.0.0' },
      };

      const expectedEntity = createMockGraphEntity({
        id: 'project-graph-id',
        name: 'Project Graph',
        status: GraphStatus.Created,
        createdBy: mockUserId,
      });

      vi.mocked(projectsDao.getOne).mockResolvedValue({
        id: projectUuid,
        createdBy: mockUserId,
      } as any);
      vi.mocked(graphDao.create).mockResolvedValue(expectedEntity);

      await service.create(ctxWithProject, createData);

      expect(projectsDao.getOne).toHaveBeenCalledWith({
        id: projectUuid,
        createdBy: mockUserId,
      });
      expect(graphDao.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: projectUuid }),
        expect.any(Object),
      );
    });

    it('should throw NotFoundException when ctx.projectId does not belong to user', async () => {
      const ctxWithProject = makeCtxWithProject(
        '22222222-2222-2222-2222-222222222222',
      );

      const createData: CreateGraphDto = {
        name: 'Unauthorized Graph',
        schema: { nodes: [], edges: [] },
        metadata: { graphId: 'unauthorized-graph', version: '1.0.0' },
      };

      vi.mocked(projectsDao.getOne).mockResolvedValue(null);

      await expect(service.create(ctxWithProject, createData)).rejects.toThrow(
        NotFoundException,
      );
      expect(graphDao.create).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException for invalid edge references', async () => {
      const createData: CreateGraphDto = {
        name: 'New Graph',
        schema: {
          nodes: [
            {
              id: 'node-1',
              template: 'runtime',
              config: { image: 'python:3.11' },
            },
          ],
          edges: [
            {
              from: 'node-1',
              to: 'non-existent-node',
            },
          ],
        },
        metadata: {
          graphId: 'new-graph',
          version: '1.0.0',
        },
      };

      const validationError = new BadRequestException(
        'Edge references non-existent target node: non-existent-node',
      );
      vi.mocked(graphCompiler.validateSchema).mockImplementation(() => {
        throw validationError;
      });

      await expect(service.create(mockCtx, createData)).rejects.toThrow(
        validationError,
      );
      expect(graphDao.create).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('should return graph when found', async () => {
      const expectedEntity = createMockGraphEntity();
      const expectedGraph = createMockGraphDto();
      vi.mocked(graphDao.getOne).mockResolvedValue(expectedEntity);

      const result = await service.findById(mockCtx, mockGraphId);

      expect(result).toMatchObject(expectedGraph);
      expect(graphDao.getOne).toHaveBeenCalledWith({
        id: mockGraphId,
        createdBy: mockUserId,
      });
    });

    it('should throw NotFoundException when graph not found', async () => {
      vi.mocked(graphDao.getOne).mockResolvedValue(null);

      await expect(service.findById(mockCtx, mockGraphId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getAll', () => {
    it('should return all graphs for user', async () => {
      const entities = [
        createMockGraphEntity({ id: 'graph-1' }),
        createMockGraphEntity({ id: 'graph-2' }),
      ];
      const expectedGraphs = [
        createMockGraphDto({ id: 'graph-1' }),
        createMockGraphDto({ id: 'graph-2' }),
      ];
      vi.mocked(graphDao.getAll).mockResolvedValue(entities);

      const result = await service.getAll(mockCtx);

      expect(result).toMatchObject(expectedGraphs);
      expect(graphDao.getAll).toHaveBeenCalledWith(
        expect.objectContaining({
          createdBy: mockUserId,
        }),
        expect.objectContaining({
          orderBy: { updatedAt: 'DESC' },
        }),
      );
    });

    it('should return empty array when no graphs found', async () => {
      vi.mocked(graphDao.getAll).mockResolvedValue([]);

      const result = await service.getAll(mockCtx);

      expect(result).toEqual([]);
    });

    it('should filter graphs by projectId when set in ctx', async () => {
      const ctxWithProject = makeCtxWithProject(
        '42424242-4242-4242-4242-424242424242',
      );

      vi.mocked(graphDao.getAll).mockResolvedValue([]);

      await service.getAll(ctxWithProject);

      expect(graphDao.getAll).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: '42424242-4242-4242-4242-424242424242',
        }),
        expect.any(Object),
      );
    });
  });

  describe('getCompiledNodes', () => {
    it('should throw NotFoundException when graph is missing', async () => {
      vi.mocked(graphDao.getOne).mockResolvedValue(null);

      await expect(
        service.getCompiledNodes(
          mockCtx,
          mockGraphId,
          {} as GraphNodesQueryDto,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when compiled graph is not available', async () => {
      vi.mocked(graphDao.getOne).mockResolvedValue(createMockGraphEntity());
      vi.mocked(graphRegistry.get).mockReturnValue(undefined);

      await expect(
        service.getCompiledNodes(
          mockCtx,
          mockGraphId,
          {} as GraphNodesQueryDto,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should return compiled nodes with statuses', async () => {
      const compiledGraph = createMockCompiledGraph();
      const stateGetSnapshots = compiledGraph.state
        .getSnapshots as unknown as ReturnType<typeof vi.fn>;
      stateGetSnapshots.mockReturnValue([
        {
          id: 'node-1',
          name: 'node-1',
          template: 'manual-trigger',
          type: NodeKind.Trigger,
          status: GraphNodeStatus.Running,
          config: { enabled: true },
          error: null,
          metadata: {
            threadId: undefined,
            runId: undefined,
            parentThreadId: undefined,
            source: undefined,
          },
        },
      ]);

      vi.mocked(graphDao.getOne).mockResolvedValue(
        createMockGraphEntity({ status: GraphStatus.Running }),
      );
      vi.mocked(graphRegistry.get).mockReturnValue(compiledGraph);

      const result = await service.getCompiledNodes(
        mockCtx,
        mockGraphId,
        {} as GraphNodesQueryDto,
      );

      expect(result).toEqual([
        {
          id: 'node-1',
          name: 'node-1',
          template: 'manual-trigger',
          type: NodeKind.Trigger,
          status: GraphNodeStatus.Running,
          config: { enabled: true },
          error: null,
          metadata: {
            threadId: undefined,
            runId: undefined,
            parentThreadId: undefined,
            source: undefined,
          },
        },
      ]);
      expect(stateGetSnapshots).toHaveBeenCalledWith(undefined, undefined);

      stateGetSnapshots.mockClear();
      stateGetSnapshots.mockReturnValue([
        {
          id: 'node-1',
          name: 'node-1',
          template: 'manual-trigger',
          type: NodeKind.Trigger,
          status: GraphNodeStatus.Idle,
          config: { enabled: true },
          error: 'failed',
          metadata: {
            threadId: 'thread-123',
            runId: 'run-456',
            parentThreadId: undefined,
            source: undefined,
          },
        },
      ]);

      await service.getCompiledNodes(mockCtx, mockGraphId, {
        threadId: 'thread-123',
        runId: 'run-456',
      } as GraphNodesQueryDto);

      expect(stateGetSnapshots).toHaveBeenLastCalledWith(
        'thread-123',
        'run-456',
      );
    });
  });

  describe('update', () => {
    it('should update name and description synchronously without creating revision', async () => {
      const updateData: UpdateGraphDto = {
        name: 'Updated Graph',
        description: 'Updated description',
        currentVersion: '1.0.0',
      };

      const mockGraph = createMockGraphEntity({
        status: GraphStatus.Created,
      });

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);

      const result = await service.update(mockCtx, mockGraphId, updateData);

      expect(result.revision).toBeUndefined();
      expect(result.graph.version).toBe(mockGraph.version);
      expect(result.graph.name).toBe('Updated Graph');
      expect(result.graph.description).toBe('Updated description');

      expect(graphRevisionService.queueRevision).not.toHaveBeenCalled();
      expect(
        graphRevisionService.enqueueRevisionProcessing,
      ).not.toHaveBeenCalled();
      expect(graphDao.updateById).toHaveBeenCalledWith(
        mockGraphId,
        { name: 'Updated Graph', description: 'Updated description' },
        expect.any(Object),
      );
    });

    it('should only update changed fields and ignore undefined values', async () => {
      const updateData: UpdateGraphDto = {
        name: 'Updated Graph',
        description: undefined,
        currentVersion: '1.0.0',
      };

      const mockGraph = createMockGraphEntity({
        status: GraphStatus.Created,
      });

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);

      const result = await service.update(mockCtx, mockGraphId, updateData);

      expect(result.revision).toBeUndefined();
      expect(graphRevisionService.queueRevision).not.toHaveBeenCalled();
      // Only name should be in the sync update (description is undefined → unchanged)
      expect(graphDao.updateById).toHaveBeenCalledWith(
        mockGraphId,
        { name: 'Updated Graph' },
        expect.any(Object),
      );
    });

    it('should throw NotFoundException when graph not found', async () => {
      const updateData: UpdateGraphDto = {
        name: 'Updated Graph',
        currentVersion: '1.0.0',
      };
      vi.mocked(graphDao.getOne).mockResolvedValue(null);

      await expect(
        service.update(mockCtx, mockGraphId, updateData),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when currentVersion is missing', async () => {
      const updateData = {
        name: 'Updated Graph',
      } as unknown as UpdateGraphDto;

      const mockGraph = createMockGraphEntity({ status: GraphStatus.Created });
      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);

      await expect(
        service.update(mockCtx, mockGraphId, updateData),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when currentVersion mismatches', async () => {
      const updateData: UpdateGraphDto = {
        name: 'Updated Graph',
        currentVersion: '0.9.0',
      };

      const mockGraph = createMockGraphEntity({ status: GraphStatus.Created });
      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);

      await expect(
        service.update(mockCtx, mockGraphId, updateData),
      ).rejects.toThrow(BadRequestException);
    });

    it('should queue revision when updating running graph schema', async () => {
      const updateData: UpdateGraphDto = {
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
        currentVersion: '1.0.0',
      };

      const mockGraph = createMockGraphEntity({ status: GraphStatus.Running });
      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);

      const result = await service.update(mockCtx, mockGraphId, updateData);

      expect(graphRevisionService.queueRevision).toHaveBeenCalledWith(
        mockCtx,
        mockGraph,
        '1.0.0',
        expect.objectContaining({
          schema: updateData.schema,
          name: mockGraph.name,
          description: mockGraph.description ?? null,
          temporary: mockGraph.temporary,
        }),
        expect.any(Object),
        { enqueueImmediately: false },
      );
      expect(
        graphRevisionService.enqueueRevisionProcessing,
      ).toHaveBeenCalledWith({
        id: 'revision-1',
        graphId: mockGraphId,
      });
      // Should return current graph state with the created revision
      expect(result.graph.version).toBe('1.0.0');
      expect(result.revision).toBeDefined();
      expect(graphDao.updateById).not.toHaveBeenCalled();
    });

    it('should not queue revision when running graph schema is unchanged', async () => {
      const mockGraph = createMockGraphEntity({ status: GraphStatus.Running });
      const updateData: UpdateGraphDto = {
        schema: mockGraph.schema,
        currentVersion: mockGraph.version,
      };

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);

      const result = await service.update(mockCtx, mockGraphId, updateData);

      expect(graphRevisionService.queueRevision).not.toHaveBeenCalled();
      expect(
        graphRevisionService.enqueueRevisionProcessing,
      ).not.toHaveBeenCalled();
      expect(graphDao.updateById).not.toHaveBeenCalled();
      expect(result.graph.version).toBe(mockGraph.version);
      expect(result.revision).toBeUndefined();
    });

    it('should apply name synchronously even if same schema is provided', async () => {
      const mockGraph = createMockGraphEntity({ status: GraphStatus.Running });
      const updateData: UpdateGraphDto = {
        schema: mockGraph.schema,
        name: 'Updated Graph',
        currentVersion: mockGraph.version,
      };

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);

      const result = await service.update(mockCtx, mockGraphId, updateData);

      // Name is applied synchronously; schema unchanged → no revision
      expect(result.revision).toBeUndefined();
      expect(graphRevisionService.queueRevision).not.toHaveBeenCalled();
      expect(graphDao.updateById).toHaveBeenCalledWith(
        mockGraphId,
        { name: 'Updated Graph' },
        expect.any(Object),
      );
    });

    it('should queue revision when updating compiling graph schema', async () => {
      const updateData: UpdateGraphDto = {
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
        currentVersion: '1.0.0',
      };

      const mockGraph = createMockGraphEntity({
        status: GraphStatus.Compiling,
      });
      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);

      const result = await service.update(mockCtx, mockGraphId, updateData);

      expect(graphRevisionService.queueRevision).toHaveBeenCalledWith(
        mockCtx,
        mockGraph,
        '1.0.0',
        expect.objectContaining({
          schema: updateData.schema,
          name: mockGraph.name,
          description: mockGraph.description ?? null,
          temporary: mockGraph.temporary,
        }),
        expect.any(Object),
        { enqueueImmediately: false },
      );
      expect(
        graphRevisionService.enqueueRevisionProcessing,
      ).toHaveBeenCalledWith({
        id: 'revision-1',
        graphId: mockGraphId,
      });
      // Should return current graph state with created revision
      expect(result.graph.version).toBe('1.0.0');
      expect(result.revision).toBeDefined();
      expect(graphDao.updateById).not.toHaveBeenCalled();
    });

    it('should create a revision when updating non-running graph schema', async () => {
      const updateData: UpdateGraphDto = {
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
        currentVersion: '1.0.0',
      };

      const mockGraph = createMockGraphEntity({ status: GraphStatus.Created });

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);

      const result = await service.update(mockCtx, mockGraphId, updateData);

      expect(result.revision).toBeDefined();
      expect(graphRevisionService.queueRevision).toHaveBeenCalledWith(
        mockCtx,
        mockGraph,
        '1.0.0',
        expect.objectContaining({
          schema: updateData.schema,
          name: mockGraph.name,
          description: mockGraph.description ?? null,
          temporary: mockGraph.temporary,
        }),
        expect.any(Object),
        { enqueueImmediately: false },
      );
      expect(graphDao.updateById).not.toHaveBeenCalled();
    });

    it('should not increment version when non-running graph schema is unchanged', async () => {
      const mockGraph = createMockGraphEntity({ status: GraphStatus.Created });
      const updateData: UpdateGraphDto = {
        schema: mockGraph.schema,
        currentVersion: mockGraph.version,
      };

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);

      const result = await service.update(mockCtx, mockGraphId, updateData);

      expect(graphDao.updateById).not.toHaveBeenCalled();
      expect(result.graph.version).toBe(mockGraph.version);
      expect(result.revision).toBeUndefined();
    });

    it('should apply name synchronously without revision when schema unchanged on non-running graph', async () => {
      const mockGraph = createMockGraphEntity({ status: GraphStatus.Created });
      const updateData: UpdateGraphDto = {
        schema: mockGraph.schema,
        name: 'Updated Graph',
        currentVersion: mockGraph.version,
      };

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);

      const result = await service.update(mockCtx, mockGraphId, updateData);

      // Name is applied synchronously; schema unchanged → no revision
      expect(result.revision).toBeUndefined();
      expect(graphRevisionService.queueRevision).not.toHaveBeenCalled();
      expect(graphDao.updateById).toHaveBeenCalledWith(
        mockGraphId,
        { name: 'Updated Graph' },
        expect.any(Object),
      );
    });
  });

  describe('costLimitUsd projection', () => {
    it('findById should project costLimitUsd from settings', async () => {
      const entity = createMockGraphEntity({
        settings: { costLimitUsd: 42 } as unknown as Record<string, unknown>,
      });
      vi.mocked(graphDao.getOne).mockResolvedValue(entity);

      const result = await service.findById(mockCtx, mockGraphId);

      expect(result.costLimitUsd).toBe(42);
    });

    it('findById should return costLimitUsd=null when settings is empty', async () => {
      const entity = createMockGraphEntity({
        settings: {} as Record<string, unknown>,
      });
      vi.mocked(graphDao.getOne).mockResolvedValue(entity);

      const result = await service.findById(mockCtx, mockGraphId);

      expect(result.costLimitUsd).toBeNull();
    });

    it('findById should return costLimitUsd=null when settings is absent on entity', async () => {
      const entity = createMockGraphEntity();
      // Explicitly ensure settings is absent (undefined) to mirror legacy rows.
      delete (entity as { settings?: unknown }).settings;
      vi.mocked(graphDao.getOne).mockResolvedValue(entity);

      const result = await service.findById(mockCtx, mockGraphId);

      expect(result.costLimitUsd).toBeNull();
    });

    it('getGraphsPreview should include costLimitUsd in each row', async () => {
      const entities = [
        createMockGraphEntity({
          id: 'graph-1',
          settings: { costLimitUsd: 10 } as Record<string, unknown>,
        }),
        createMockGraphEntity({
          id: 'graph-2',
          settings: {} as Record<string, unknown>,
        }),
      ];
      const graphDaoAny = graphDao as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      graphDaoAny['getPreview'] = vi.fn().mockResolvedValue(entities);
      graphDaoAny['getSchemaAndMetadata'] = vi.fn().mockResolvedValue(
        new Map([
          [
            'graph-1',
            { schema: { nodes: [], edges: [] }, metadata: null, agents: [] },
          ],
          [
            'graph-2',
            { schema: { nodes: [], edges: [] }, metadata: null, agents: [] },
          ],
        ]),
      );

      const result = await service.getGraphsPreview(mockCtx);

      expect(result).toHaveLength(2);
      expect(result[0]!.costLimitUsd).toBe(10);
      expect(result[1]!.costLimitUsd).toBeNull();
    });

    it('update should persist costLimitUsd into settings.costLimitUsd', async () => {
      const mockGraph = createMockGraphEntity({
        status: GraphStatus.Created,
        settings: {} as Record<string, unknown>,
      });
      const updateData: UpdateGraphDto = {
        costLimitUsd: 25,
        currentVersion: mockGraph.version,
      };

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);

      const result = await service.update(mockCtx, mockGraphId, updateData);

      expect(graphDao.updateById).toHaveBeenCalledWith(
        mockGraphId,
        { settings: { costLimitUsd: 25 } },
        expect.any(Object),
      );
      expect(result.graph.costLimitUsd).toBe(25);
      expect(graphRevisionService.queueRevision).not.toHaveBeenCalled();
    });

    it('update should preserve existing settings keys when setting costLimitUsd', async () => {
      const mockGraph = createMockGraphEntity({
        status: GraphStatus.Created,
        settings: { foo: 'bar' } as Record<string, unknown>,
      });
      const updateData: UpdateGraphDto = {
        costLimitUsd: 5,
        currentVersion: mockGraph.version,
      };

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);

      await service.update(mockCtx, mockGraphId, updateData);

      expect(graphDao.updateById).toHaveBeenCalledWith(
        mockGraphId,
        { settings: { foo: 'bar', costLimitUsd: 5 } },
        expect.any(Object),
      );
    });
  });

  describe('delete', () => {
    it('should delete graph successfully when not running', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Created });
      vi.mocked(graphDao.getOne).mockResolvedValue(graph);
      vi.mocked(graphDao.deleteById).mockResolvedValue(undefined);

      await service.delete(mockCtx, mockGraphId);

      expect(graphDao.getOne).toHaveBeenCalledWith({
        id: mockGraphId,
        createdBy: mockUserId,
      });
      expect(graphDao.deleteById).toHaveBeenCalledWith(mockGraphId);
      expect(graphRegistry.destroy).not.toHaveBeenCalled();
    });

    it('should emit GRAPH_DELETED_EVENT before deleting the graph', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Created });

      vi.mocked(graphDao.getOne).mockResolvedValue(graph);
      vi.mocked(graphDao.deleteById).mockResolvedValue(undefined);

      await service.delete(mockCtx, mockGraphId);

      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        GRAPH_DELETED_EVENT,
        expect.objectContaining({ graphId: mockGraphId, userId: mockUserId }),
      );
      expect(graphDao.deleteById).toHaveBeenCalledWith(mockGraphId);
    });

    it('should destroy running graph before deletion', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Running });
      vi.mocked(graphDao.getOne).mockResolvedValue(graph);
      vi.mocked(graphRegistry.get).mockReturnValue(createMockCompiledGraph());
      vi.mocked(graphRegistry.destroy).mockResolvedValue(undefined);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);
      vi.mocked(graphDao.deleteById).mockResolvedValue(undefined);

      await service.delete(mockCtx, mockGraphId);

      expect(graphRegistry.destroy).toHaveBeenCalledWith(mockGraphId);
      expect(graphDao.deleteById).toHaveBeenCalledWith(mockGraphId);
    });

    it('should throw NotFoundException when graph not found', async () => {
      vi.mocked(graphDao.getOne).mockResolvedValue(null);

      await expect(service.delete(mockCtx, mockGraphId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('run', () => {
    it('should run graph successfully', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Created });
      const compiledGraph = createMockCompiledGraph();
      const compilingEntity = createMockGraphEntity({
        status: GraphStatus.Compiling,
      });
      const updatedEntity = createMockGraphEntity({
        status: GraphStatus.Running,
      });
      const updatedGraph = createMockGraphDto({
        status: GraphStatus.Running,
      });

      vi.mocked(graphDao.getOne)
        .mockResolvedValueOnce(graph)
        .mockResolvedValueOnce(updatedEntity);
      vi.mocked(graphRegistry.get).mockReturnValue(undefined);
      vi.mocked(graphCompiler.compile).mockResolvedValue(compiledGraph);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);

      const result = await service.run(mockCtx, mockGraphId);

      expect(result).toMatchObject(updatedGraph);
      expect(graphCompiler.compile).toHaveBeenCalledWith(graph, {
        graphId: graph.id,
        name: graph.name,
        version: graph.version,
      });
      // GraphRegistry.register is now called by GraphCompiler, not by service
      expect(graphDao.updateById).toHaveBeenNthCalledWith(
        1,
        mockGraphId,
        expect.objectContaining({ status: GraphStatus.Compiling }),
      );
      expect(graphDao.updateById).toHaveBeenNthCalledWith(
        2,
        mockGraphId,
        expect.objectContaining({ status: GraphStatus.Running }),
      );
      expect(notificationsService.emit).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          type: NotificationEvent.Graph,
          graphId: mockGraphId,
          data: expect.objectContaining({
            status: GraphStatus.Compiling,
          }),
        }),
      );
      expect(notificationsService.emit).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          type: NotificationEvent.GraphPreview,
          graphId: mockGraphId,
          data: expect.objectContaining({
            status: GraphStatus.Compiling,
          }),
        }),
      );
      expect(notificationsService.emit).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          type: NotificationEvent.Graph,
          graphId: mockGraphId,
          data: expect.objectContaining({
            status: GraphStatus.Running,
          }),
        }),
      );
      expect(notificationsService.emit).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({
          type: NotificationEvent.GraphPreview,
          graphId: mockGraphId,
          data: expect.objectContaining({
            status: GraphStatus.Running,
          }),
        }),
      );
    });

    it('should throw BadRequestException when graph is already running', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Created });
      vi.mocked(graphDao.getOne).mockResolvedValue(graph);
      vi.mocked(graphRegistry.getStatus).mockReturnValueOnce(
        GraphStatus.Running,
      );

      await expect(service.run(mockCtx, mockGraphId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException when graph not found', async () => {
      vi.mocked(graphDao.getOne).mockResolvedValue(null);

      await expect(service.run(mockCtx, mockGraphId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should handle compilation errors and cleanup', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Created });
      const compilationError = new Error('Compilation failed');
      const compilingEntity = createMockGraphEntity({
        status: GraphStatus.Compiling,
      });
      const errorEntity = createMockGraphEntity({
        status: GraphStatus.Error,
        error: 'Compilation failed',
      });

      vi.mocked(graphDao.getOne).mockResolvedValue(graph);
      vi.mocked(graphRegistry.get).mockReturnValue(undefined);
      vi.mocked(graphCompiler.compile).mockRejectedValue(compilationError);
      vi.mocked(graphDao.updateById)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1);

      await expect(service.run(mockCtx, mockGraphId)).rejects.toThrow(
        'Compilation failed',
      );

      expect(graphDao.updateById).toHaveBeenNthCalledWith(
        1,
        mockGraphId,
        expect.objectContaining({ status: GraphStatus.Compiling }),
      );
      expect(graphDao.updateById).toHaveBeenNthCalledWith(
        2,
        mockGraphId,
        expect.objectContaining({
          status: GraphStatus.Error,
          error: 'Compilation failed',
        }),
      );
      expect(notificationsService.emit).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          type: NotificationEvent.Graph,
          data: expect.objectContaining({
            status: GraphStatus.Compiling,
          }),
        }),
      );
      expect(notificationsService.emit).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          type: NotificationEvent.GraphPreview,
          data: expect.objectContaining({
            status: GraphStatus.Compiling,
          }),
        }),
      );
      expect(notificationsService.emit).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          type: NotificationEvent.Graph,
          data: expect.objectContaining({
            status: GraphStatus.Error,
          }),
        }),
      );
      expect(notificationsService.emit).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({
          type: NotificationEvent.GraphPreview,
          data: expect.objectContaining({
            status: GraphStatus.Error,
          }),
        }),
      );
    });

    it('should stop running threads when graph fails to start', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Created });
      const compilationError = new Error('Compilation failed');
      const compilingEntity = createMockGraphEntity({
        status: GraphStatus.Compiling,
      });

      vi.mocked(graphDao.getOne).mockResolvedValue(graph);
      vi.mocked(graphRegistry.get).mockReturnValue(undefined);
      vi.mocked(graphCompiler.compile).mockRejectedValue(compilationError);
      vi.mocked(graphDao.updateById)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1);

      const runningThread = {
        id: 'thread-1',
        externalThreadId: 'external-1',
      } as any;
      vi.mocked(threadsDao.getAll).mockResolvedValue([runningThread]);
      vi.mocked(threadsDao.updateById).mockResolvedValue(1);

      await expect(service.run(mockCtx, mockGraphId)).rejects.toThrow(
        'Compilation failed',
      );

      expect(threadsDao.getAll).toHaveBeenCalledWith({
        graphId: mockGraphId,
        status: { $in: [ThreadStatus.Running, ThreadStatus.Waiting] },
      });
      expect(threadsDao.updateById).toHaveBeenCalledWith(runningThread.id, {
        status: ThreadStatus.Stopped,
      });
      // ThreadUpdate(Stooped) is emitted by GraphStateManager, not GraphsService.
    });

    it('should cleanup registry when database update fails', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Created });
      const compiledGraph = createMockCompiledGraph();
      const compilingEntity = createMockGraphEntity({
        status: GraphStatus.Compiling,
      });

      vi.mocked(graphDao.getOne)
        .mockResolvedValueOnce(graph)
        .mockResolvedValueOnce(null);
      vi.mocked(graphRegistry.get).mockReturnValue(undefined);
      vi.mocked(graphCompiler.compile).mockResolvedValue(compiledGraph);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);
      vi.mocked(graphRegistry.destroy).mockResolvedValue(undefined);

      await expect(service.run(mockCtx, mockGraphId)).rejects.toThrow(
        NotFoundException,
      );

      // GraphRegistry.register is now called by GraphCompiler, not by service
      expect(graphRegistry.destroy).toHaveBeenCalledWith(mockGraphId);
      expect(graphDao.updateById).toHaveBeenNthCalledWith(
        1,
        mockGraphId,
        expect.objectContaining({ status: GraphStatus.Compiling }),
      );
      expect(notificationsService.emit).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({
            status: GraphStatus.Compiling,
          }),
        }),
      );
    });

    it('should cleanup registry when compilation fails after registration', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Created });
      const compiledGraph = createMockCompiledGraph();
      const compilationError = new Error('Compilation failed');
      const compilingEntity = createMockGraphEntity({
        status: GraphStatus.Compiling,
      });
      const errorEntity = createMockGraphEntity({
        status: GraphStatus.Error,
        error: 'Compilation failed',
      });

      vi.mocked(graphDao.getOne).mockResolvedValue(graph);
      vi.mocked(graphRegistry.get).mockReturnValue(compiledGraph);
      vi.mocked(graphCompiler.compile).mockRejectedValue(compilationError);
      vi.mocked(graphRegistry.destroy).mockResolvedValue(undefined);
      vi.mocked(graphDao.updateById)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1);

      await expect(service.run(mockCtx, mockGraphId)).rejects.toThrow(
        'Compilation failed',
      );

      expect(graphRegistry.destroy).toHaveBeenCalledWith(mockGraphId);
      expect(graphDao.updateById).toHaveBeenNthCalledWith(
        1,
        mockGraphId,
        expect.objectContaining({ status: GraphStatus.Compiling }),
      );
      expect(graphDao.updateById).toHaveBeenNthCalledWith(
        2,
        mockGraphId,
        expect.objectContaining({
          status: GraphStatus.Error,
          error: 'Compilation failed',
        }),
      );
      expect(notificationsService.emit).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          type: NotificationEvent.Graph,
          data: expect.objectContaining({
            status: GraphStatus.Compiling,
          }),
        }),
      );
      expect(notificationsService.emit).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          type: NotificationEvent.GraphPreview,
          data: expect.objectContaining({
            status: GraphStatus.Compiling,
          }),
        }),
      );
      expect(notificationsService.emit).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          type: NotificationEvent.Graph,
          data: expect.objectContaining({
            status: GraphStatus.Error,
          }),
        }),
      );
      expect(notificationsService.emit).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({
          type: NotificationEvent.GraphPreview,
          data: expect.objectContaining({
            status: GraphStatus.Error,
          }),
        }),
      );
    });
  });

  describe('destroy', () => {
    it('should destroy running graph successfully', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Running });
      const compiledGraph = createMockCompiledGraph();
      const updatedEntity = createMockGraphEntity({
        status: GraphStatus.Stopped,
      });
      const updatedGraph = createMockGraphDto({
        status: GraphStatus.Stopped,
      });

      vi.mocked(graphDao.getOne)
        .mockResolvedValueOnce(graph)
        .mockResolvedValueOnce(updatedEntity);
      vi.mocked(graphRegistry.get).mockReturnValue(compiledGraph);
      vi.mocked(graphRegistry.destroy).mockResolvedValue(undefined);
      vi.mocked(threadsDao.getAll).mockResolvedValue([]);
      vi.mocked(graphDao.updateById).mockResolvedValue(undefined as never);

      const result = await service.destroy(mockCtx, mockGraphId);

      expect(result).toMatchObject(updatedGraph);
      expect(graphRegistry.destroy).toHaveBeenCalledWith(mockGraphId);
      expect(threadsDao.getAll).toHaveBeenCalledWith({
        graphId: mockGraphId,
        status: { $in: [ThreadStatus.Running, ThreadStatus.Waiting] },
      });
      expect(graphDao.updateById).toHaveBeenCalledWith(mockGraphId, {
        status: GraphStatus.Stopped,
        error: undefined,
      });
      expect(notificationsService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: GraphStatus.Stopped }),
        }),
      );
    });

    it('should stop running threads in DB during destroy', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Running });
      const compiledGraph = createMockCompiledGraph();
      const updatedEntity = createMockGraphEntity({
        status: GraphStatus.Stopped,
      });
      const runningThread = {
        id: 'thread-1',
        graphId: mockGraphId,
        status: ThreadStatus.Running,
        externalThreadId: 'ext-thread-1',
      };

      vi.mocked(graphDao.getOne)
        .mockResolvedValueOnce(graph)
        .mockResolvedValueOnce(updatedEntity);
      vi.mocked(graphRegistry.get).mockReturnValue(compiledGraph);
      vi.mocked(graphRegistry.destroy).mockResolvedValue(undefined);
      vi.mocked(threadsDao.getAll).mockResolvedValue([runningThread as never]);
      vi.mocked(threadsDao.updateById).mockResolvedValue(undefined as never);
      vi.mocked(graphDao.updateById).mockResolvedValue(undefined as never);

      await service.destroy(mockCtx, mockGraphId);

      expect(threadsDao.getAll).toHaveBeenCalledWith({
        graphId: mockGraphId,
        status: { $in: [ThreadStatus.Running, ThreadStatus.Waiting] },
      });
      expect(threadsDao.updateById).toHaveBeenCalledWith('thread-1', {
        status: ThreadStatus.Stopped,
      });
    });

    it('should continue destroy even when thread cleanup fails', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Running });
      const compiledGraph = createMockCompiledGraph();
      const updatedEntity = createMockGraphEntity({
        status: GraphStatus.Stopped,
      });

      vi.mocked(graphDao.getOne)
        .mockResolvedValueOnce(graph)
        .mockResolvedValueOnce(updatedEntity);
      vi.mocked(graphRegistry.get).mockReturnValue(compiledGraph);
      vi.mocked(graphRegistry.destroy).mockResolvedValue(undefined);
      // Simulate thread cleanup throwing
      vi.mocked(threadsDao.getAll).mockRejectedValue(
        new Error('DB connection lost'),
      );
      vi.mocked(graphDao.updateById).mockResolvedValue(undefined as never);

      // Destroy must succeed despite thread cleanup failure
      const result = await service.destroy(mockCtx, mockGraphId);

      expect(result).toMatchObject({ status: GraphStatus.Stopped });
      expect(graphDao.updateById).toHaveBeenCalledWith(mockGraphId, {
        status: GraphStatus.Stopped,
        error: undefined,
      });
    });

    it('should handle destroying non-running graph', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Created });
      const updatedEntity = createMockGraphEntity({
        status: GraphStatus.Stopped,
      });
      const updatedGraph = createMockGraphDto({
        status: GraphStatus.Stopped,
      });

      vi.mocked(graphDao.getOne)
        .mockResolvedValueOnce(graph)
        .mockResolvedValueOnce(updatedEntity);
      vi.mocked(graphRegistry.get).mockReturnValue(undefined);
      vi.mocked(threadsDao.getAll).mockResolvedValue([]);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);

      const result = await service.destroy(mockCtx, mockGraphId);

      expect(result).toMatchObject(updatedGraph);
      expect(graphRegistry.destroy).not.toHaveBeenCalled();
      expect(threadsDao.getAll).toHaveBeenCalledWith({
        graphId: mockGraphId,
        status: { $in: [ThreadStatus.Running, ThreadStatus.Waiting] },
      });
      expect(graphDao.updateById).toHaveBeenCalledWith(mockGraphId, {
        status: GraphStatus.Stopped,
        error: undefined,
      });
      expect(notificationsService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: GraphStatus.Stopped }),
        }),
      );
    });

    it('should throw NotFoundException when graph not found', async () => {
      vi.mocked(graphDao.getOne).mockResolvedValue(null);

      await expect(service.destroy(mockCtx, mockGraphId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when database update fails', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Running });
      const compiledGraph = createMockCompiledGraph();

      vi.mocked(graphDao.getOne)
        .mockResolvedValueOnce(graph)
        .mockResolvedValueOnce(null);
      vi.mocked(graphRegistry.get).mockReturnValue(compiledGraph);
      vi.mocked(graphRegistry.destroy).mockResolvedValue(undefined);
      vi.mocked(threadsDao.getAll).mockResolvedValue([]);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);

      await expect(service.destroy(mockCtx, mockGraphId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('executeTrigger', () => {
    it('should execute trigger in async mode, pass flag, and return thread info', async () => {
      const triggerId = 'trigger-1';
      const agentId = 'agent-1';
      const customThreadId = 'async-thread';
      const expectedThreadId = `${mockGraphId}:${customThreadId}`;

      const mockGraph = createMockGraphEntity({
        status: GraphStatus.Running,
        schema: {
          nodes: [
            {
              id: triggerId,
              template: 'manual-trigger',
              config: { agentId },
            },
          ],
          edges: [],
        },
      });

      const mockTrigger = {
        isStarted: true,
        invokeAgent: vi.fn().mockResolvedValue({
          messages: [],
          threadId: expectedThreadId,
          checkpointNs: `${expectedThreadId}:${agentId}`,
        }),
      };
      const mockTriggerNode = {
        id: triggerId,
        type: NodeKind.Trigger,
        template: 'manual-trigger',
        instance: mockTrigger,
        handle: {
          provide: async () => mockTrigger,
          configure: vi.fn().mockResolvedValue(undefined),
          destroy: vi.fn().mockResolvedValue(undefined),
        },
        getStatus: vi.fn().mockReturnValue(GraphNodeStatus.Idle),
      };
      const mockCompiledGraph = createMockCompiledGraph();

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphRegistry.get).mockReturnValue(mockCompiledGraph);
      vi.mocked(graphRegistry.getNode).mockReturnValue(
        mockTriggerNode as unknown as CompiledGraphNode,
      );

      const result = await service.executeTrigger(
        mockCtx,
        mockGraphId,
        triggerId,
        {
          messages: ['Async test message'],
          threadSubId: customThreadId,
          async: true,
        },
      );

      expect(result).toEqual({
        externalThreadId: expectedThreadId,
        checkpointNs: `${expectedThreadId}:${agentId}`,
      });

      // Ensure invokeAgent was called with provided threadSubId
      expect(mockTrigger.invokeAgent).toHaveBeenCalledWith(
        [expect.objectContaining({ content: 'Async test message' })],
        {
          configurable: expect.objectContaining({
            thread_id: customThreadId,
            async: true,
            thread_created_by: mockUserId,
            effective_cost_limit_usd: null,
          }),
        },
      );
    });

    it('should execute trigger in async mode with auto-generated threadId when threadSubId not provided', async () => {
      const triggerId = 'trigger-1';
      const agentId = 'agent-1';
      const mockGraph = createMockGraphEntity({
        status: GraphStatus.Running,
        schema: {
          nodes: [
            {
              id: triggerId,
              template: 'manual-trigger',
              config: { agentId },
            },
          ],
          edges: [],
        },
      });

      const mockTrigger = {
        isStarted: true,
        invokeAgent: vi.fn().mockResolvedValue({
          messages: [],
          threadId: `${mockGraphId}:generated-uuid`,
          checkpointNs: `${mockGraphId}:generated-uuid:${agentId}`,
        }),
      };
      const mockTriggerNode = {
        id: triggerId,
        type: NodeKind.Trigger,
        template: 'manual-trigger',
        instance: mockTrigger,
        handle: {
          provide: async () => mockTrigger,
          configure: vi.fn().mockResolvedValue(undefined),
          destroy: vi.fn().mockResolvedValue(undefined),
        },
        getStatus: vi.fn().mockReturnValue(GraphNodeStatus.Idle),
      };
      const mockCompiledGraph = createMockCompiledGraph();

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphRegistry.get).mockReturnValue(mockCompiledGraph);
      vi.mocked(graphRegistry.getNode).mockReturnValue(
        mockTriggerNode as unknown as CompiledGraphNode,
      );

      const result = await service.executeTrigger(
        mockCtx,
        mockGraphId,
        triggerId,
        {
          messages: ['Async test message'],
          async: true,
        },
      );

      expect(result.externalThreadId).toMatch(new RegExp(`^${mockGraphId}:`));
      expect(result).toHaveProperty('checkpointNs');

      expect(mockTrigger.invokeAgent).toHaveBeenCalledWith(
        [expect.objectContaining({ content: 'Async test message' })],
        {
          configurable: expect.objectContaining({
            thread_id: undefined,
            async: true,
            thread_created_by: mockUserId,
            effective_cost_limit_usd: null,
          }),
        },
      );
    });
    it('should execute trigger with custom threadId and return thread info', async () => {
      const triggerId = 'trigger-1';
      const agentId = 'agent-1';
      const customThreadId = 'my-thread';
      const expectedThreadId = `${mockGraphId}:${customThreadId}`;
      const expectedCheckpointNs = `${expectedThreadId}:${agentId}`;

      const mockGraph = createMockGraphEntity({
        status: GraphStatus.Running,
        schema: {
          nodes: [
            {
              id: triggerId,
              template: 'manual-trigger',
              config: { agentId },
            },
          ],
          edges: [],
        },
      });
      const mockTrigger = {
        isStarted: true,
        invokeAgent: vi.fn().mockResolvedValue({
          messages: [],
          threadId: expectedThreadId,
          checkpointNs: expectedCheckpointNs,
        }),
      };
      const mockTriggerNode = {
        id: triggerId,
        type: NodeKind.Trigger,
        template: 'manual-trigger',
        instance: mockTrigger,
        handle: {
          provide: async () => mockTrigger,
          configure: vi.fn().mockResolvedValue(undefined),
          destroy: vi.fn().mockResolvedValue(undefined),
        },
        getStatus: vi.fn().mockReturnValue(GraphNodeStatus.Idle),
      };
      const mockCompiledGraph = createMockCompiledGraph();

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphRegistry.get).mockReturnValue(mockCompiledGraph);
      vi.mocked(graphRegistry.getNode).mockReturnValue(
        mockTriggerNode as unknown as CompiledGraphNode,
      );

      const result = await service.executeTrigger(
        mockCtx,
        mockGraphId,
        triggerId,
        {
          messages: ['Test message'],
          threadSubId: customThreadId,
        },
      );

      expect(result).toEqual({
        externalThreadId: expectedThreadId,
        checkpointNs: expectedCheckpointNs,
      });

      expect(mockTrigger.invokeAgent).toHaveBeenCalledWith(
        [expect.objectContaining({ content: 'Test message' })],
        {
          configurable: expect.objectContaining({
            thread_id: customThreadId,
            thread_created_by: mockUserId,
            effective_cost_limit_usd: null,
          }),
        },
      );
    });

    it('should execute trigger with auto-generated threadId (UUID) and return thread info', async () => {
      const triggerId = 'trigger-1';
      const agentId = 'agent-1';
      const mockGraph = createMockGraphEntity({
        status: GraphStatus.Running,
        schema: {
          nodes: [
            {
              id: triggerId,
              template: 'manual-trigger',
              config: { agentId },
            },
          ],
          edges: [],
        },
      });
      // Mock with dynamic return value
      const mockTrigger = {
        isStarted: true,
        invokeAgent: vi.fn().mockImplementation((messages, config) => {
          // Generate threadId based on what's passed
          const threadIdFromConfig = config?.configurable?.thread_id;
          const fullThreadId = `${mockGraphId}:${threadIdFromConfig || 'generated-uuid'}`;
          const checkpointNs = `${fullThreadId}:${agentId}`;
          return Promise.resolve({
            messages: [],
            threadId: fullThreadId,
            checkpointNs,
          });
        }),
      };
      const mockTriggerNode = {
        id: triggerId,
        type: NodeKind.Trigger,
        template: 'manual-trigger',
        instance: mockTrigger,
        handle: {
          provide: async () => mockTrigger,
          configure: vi.fn().mockResolvedValue(undefined),
          destroy: vi.fn().mockResolvedValue(undefined),
        },
        getStatus: vi.fn().mockReturnValue(GraphNodeStatus.Idle),
      };
      const mockCompiledGraph = createMockCompiledGraph();

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphRegistry.get).mockReturnValue(mockCompiledGraph);
      vi.mocked(graphRegistry.getNode).mockReturnValue(
        mockTriggerNode as unknown as CompiledGraphNode,
      );

      const result = await service.executeTrigger(
        mockCtx,
        mockGraphId,
        triggerId,
        {
          messages: ['Test message'],
        },
      );

      // Verify externalThreadId format is graphId:generated or similar
      expect(result.externalThreadId).toMatch(new RegExp(`^${mockGraphId}:`));
      // Verify checkpointNs format includes agentId
      expect(result.checkpointNs).toContain(agentId);

      expect(mockTrigger.invokeAgent).toHaveBeenCalledWith(
        [expect.objectContaining({ content: 'Test message' })],
        {
          configurable: expect.objectContaining({
            thread_id: undefined, // No threadId provided
            thread_created_by: mockUserId,
            effective_cost_limit_usd: null,
          }),
        },
      );
    });

    it('should throw NotFoundException when graph not found', async () => {
      vi.mocked(graphDao.getOne).mockResolvedValue(null);

      await expect(
        service.executeTrigger(mockCtx, mockGraphId, 'trigger-1', {
          messages: ['Test'],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when graph is not running', async () => {
      const mockGraph = createMockGraphEntity({ status: GraphStatus.Created });
      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphRegistry.get).mockReturnValue(undefined);

      await expect(
        service.executeTrigger(mockCtx, mockGraphId, 'trigger-1', {
          messages: ['Test'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when trigger not found', async () => {
      const mockGraph = createMockGraphEntity({ status: GraphStatus.Running });
      const mockCompiledGraph = createMockCompiledGraph();
      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphRegistry.get).mockReturnValue(mockCompiledGraph);
      vi.mocked(graphRegistry.getNode).mockReturnValue(undefined);

      await expect(
        service.executeTrigger(mockCtx, mockGraphId, 'trigger-1', {
          messages: ['Test'],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when node is not a trigger', async () => {
      const mockGraph = createMockGraphEntity({ status: GraphStatus.Running });
      const mockCompiledGraph = createMockCompiledGraph();
      const mockNode = {
        id: 'node-1',
        type: NodeKind.SimpleAgent,
        template: 'simple-agent',
        instance: {},
        getStatus: vi.fn().mockReturnValue(GraphNodeStatus.Idle),
      };

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphRegistry.get).mockReturnValue(mockCompiledGraph);
      vi.mocked(graphRegistry.getNode).mockReturnValue(
        mockNode as unknown as CompiledGraphNode,
      );

      await expect(
        service.executeTrigger(mockCtx, mockGraphId, 'node-1', {
          messages: ['Test'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when trigger is not started', async () => {
      const triggerId = 'trigger-1';
      const mockGraph = createMockGraphEntity({ status: GraphStatus.Running });
      const mockTrigger = {
        isStarted: false,
        invokeAgent: vi.fn(),
      };
      const mockTriggerNode = {
        id: triggerId,
        type: NodeKind.Trigger,
        template: 'manual-trigger',
        instance: mockTrigger,
        handle: {
          provide: async () => mockTrigger,
          configure: vi.fn().mockResolvedValue(undefined),
          destroy: vi.fn().mockResolvedValue(undefined),
        },
        getStatus: vi.fn().mockReturnValue(GraphNodeStatus.Idle),
      };
      const mockCompiledGraph = createMockCompiledGraph();

      vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
      vi.mocked(graphRegistry.get).mockReturnValue(mockCompiledGraph);
      vi.mocked(graphRegistry.getNode).mockReturnValue(
        mockTriggerNode as unknown as CompiledGraphNode,
      );

      await expect(
        service.executeTrigger(mockCtx, mockGraphId, triggerId, {
          messages: ['Test'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    describe('eager thread creation', () => {
      const triggerId = 'trigger-1';
      const expectedThreadId = `${mockGraphId}:my-thread`;

      const setupTriggerMocks = () => {
        const mockTrigger = {
          isStarted: true,
          invokeAgent: vi.fn().mockResolvedValue({
            messages: [],
            threadId: expectedThreadId,
            checkpointNs: `${expectedThreadId}:agent-1`,
          }),
        };
        const mockTriggerNode = {
          id: triggerId,
          type: NodeKind.Trigger,
          template: 'manual-trigger',
          instance: mockTrigger,
          handle: {
            provide: async () => mockTrigger,
            configure: vi.fn().mockResolvedValue(undefined),
            destroy: vi.fn().mockResolvedValue(undefined),
          },
          getStatus: vi.fn().mockReturnValue(GraphNodeStatus.Idle),
        };
        const mockGraph = createMockGraphEntity({
          status: GraphStatus.Running,
        });
        const mockCompiledGraph = createMockCompiledGraph();

        vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
        vi.mocked(graphRegistry.get).mockReturnValue(mockCompiledGraph);
        vi.mocked(graphRegistry.getNode).mockReturnValue(
          mockTriggerNode as unknown as CompiledGraphNode,
        );

        return mockTrigger;
      };

      it('should eagerly upsert thread by externalThreadId', async () => {
        setupTriggerMocks();
        vi.mocked(threadsDao.upsertByExternalThreadId).mockResolvedValue(
          {} as any,
        );

        const result = await service.executeTrigger(
          mockCtx,
          mockGraphId,
          triggerId,
          {
            messages: ['Hello'],
            threadSubId: 'my-thread',
            metadata: { key: 'value' },
          },
        );

        expect(result.externalThreadId).toBe(expectedThreadId);
        expect(threadsDao.upsertByExternalThreadId).toHaveBeenCalledWith({
          graphId: mockGraphId,
          createdBy: mockUserId,
          projectId: 'project-123',
          externalThreadId: expectedThreadId,
          status: ThreadStatus.Running,
          metadata: { key: 'value', effectiveCostLimitUsd: null },
        });
      });

      it('should upsert (no-op merge) when thread already exists', async () => {
        setupTriggerMocks();
        vi.mocked(threadsDao.upsertByExternalThreadId).mockResolvedValue(
          {} as any,
        );

        const result = await service.executeTrigger(
          mockCtx,
          mockGraphId,
          triggerId,
          {
            messages: ['Hello'],
            threadSubId: 'my-thread',
          },
        );

        expect(result.externalThreadId).toBe(expectedThreadId);
        expect(threadsDao.upsertByExternalThreadId).toHaveBeenCalledOnce();
      });

      it('should cancel resume job and clear wait metadata when thread is waiting', async () => {
        setupTriggerMocks();
        const waitingThread = {
          id: 'waiting-thread-id',
          graphId: mockGraphId,
          externalThreadId: expectedThreadId,
          createdBy: mockUserId,
          status: ThreadStatus.Waiting,
          metadata: {
            scheduledResumeAt: '2026-04-02T10:00:00.000Z',
            waitReason: 'Waiting for CI',
            waitNodeId: 'node-123',
            waitCheckPrompt: 'Check CI',
            customField: 'preserved',
          },
        } as any;

        // First call: waiting check (uses graphId:threadSubId format)
        // Second call: eager create check (uses forked EM)
        vi.mocked(threadsDao.getOne)
          .mockResolvedValueOnce(waitingThread)
          .mockResolvedValueOnce(waitingThread);

        const resumeQueueService = module.get<ThreadResumeQueueService>(
          ThreadResumeQueueService,
        );

        const result = await service.executeTrigger(
          mockCtx,
          mockGraphId,
          triggerId,
          {
            messages: ['Follow-up message'],
            threadSubId: 'my-thread',
          },
        );

        expect(result.externalThreadId).toBe(expectedThreadId);

        // Should cancel the pending resume job
        expect(resumeQueueService.cancelResumeJob).toHaveBeenCalledWith(
          'waiting-thread-id',
        );

        // Should clear wait metadata, set to Running, and persist the resolved
        // effective cost limit (null when no limit is configured).
        // H1: updateById now receives a 3rd arg (transactional em) — use
        // mock.calls to check the first two args without strict arity matching.
        const updateCall = vi
          .mocked(threadsDao.updateById)
          .mock.calls.find(([id]) => id === 'waiting-thread-id') as [
          string,
          { status?: ThreadStatus; metadata: Record<string, unknown> },
          unknown,
        ];
        expect(updateCall).toBeDefined();
        const [, update] = updateCall;
        expect(update.status).toBe(ThreadStatus.Running);
        expect(update.metadata).toMatchObject({
          customField: 'preserved',
          effectiveCostLimitUsd: null,
        });
      });
    });

    describe('cost-limit resume guard', () => {
      const triggerId = 'trigger-1';
      const expectedThreadId = `${mockGraphId}:my-thread`;

      const setupTriggerMocks = () => {
        const mockTrigger = {
          isStarted: true,
          invokeAgent: vi.fn().mockResolvedValue({
            messages: [],
            threadId: expectedThreadId,
            checkpointNs: `${expectedThreadId}:agent-1`,
          }),
        };
        const mockTriggerNode = {
          id: triggerId,
          type: NodeKind.Trigger,
          template: 'manual-trigger',
          instance: mockTrigger,
          handle: {
            provide: async () => mockTrigger,
            configure: vi.fn().mockResolvedValue(undefined),
            destroy: vi.fn().mockResolvedValue(undefined),
          },
          getStatus: vi.fn().mockReturnValue(GraphNodeStatus.Idle),
        };
        const mockGraph = createMockGraphEntity({
          status: GraphStatus.Running,
        });
        const mockCompiledGraph = createMockCompiledGraph();

        vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
        vi.mocked(graphRegistry.get).mockReturnValue(mockCompiledGraph);
        vi.mocked(graphRegistry.getNode).mockReturnValue(
          mockTriggerNode as unknown as CompiledGraphNode,
        );

        return mockTrigger;
      };

      const makeStoppedThread = (
        overrides: Partial<{
          metadata: Record<string, unknown>;
          status: ThreadStatus;
        }> = {},
      ) =>
        ({
          id: 'stopped-thread-id',
          graphId: mockGraphId,
          externalThreadId: expectedThreadId,
          createdBy: mockUserId,
          status: ThreadStatus.Stopped,
          // H2: include stopCostUsd in default so resume-guard tests have a valid
          // metadataStopCost to read (checkpoint fallback was removed by H2).
          metadata: {
            stopReason: 'cost_limit',
            stopCostUsd: 3,
            other: 'keep-me',
          },
          ...overrides,
        }) as any;

      it('clears stopReason and proceeds when limit is raised above current cost', async () => {
        setupTriggerMocks();
        // Default makeStoppedThread includes stopCostUsd=3; limit raised to 10.
        const stoppedThread = makeStoppedThread();
        vi.mocked(threadsDao.getOne)
          .mockResolvedValueOnce(stoppedThread)
          .mockResolvedValueOnce(stoppedThread);
        vi.mocked(costLimitResolver.resolveForThread).mockResolvedValue(10);

        const result = await service.executeTrigger(
          mockCtx,
          mockGraphId,
          triggerId,
          {
            messages: ['Continue'],
            threadSubId: 'my-thread',
          },
        );

        expect(result.externalThreadId).toBe(expectedThreadId);
        // H2: checkpoint no longer consulted — metadataStopCost=3 < limit=10, so proceed.
        expect(
          checkpointStateService.getThreadTokenUsage,
        ).not.toHaveBeenCalled();
        expect(costLimitResolver.resolveForThread).toHaveBeenCalledWith(
          mockUserId,
          mockGraphId,
        );

        const updateCall = vi
          .mocked(threadsDao.updateById)
          .mock.calls.find(([id]) => id === 'stopped-thread-id') as [
          string,
          { metadata: Record<string, unknown>; status?: unknown },
          unknown,
        ];
        expect(updateCall).toBeDefined();
        const [, update] = updateCall;
        // stopReason, stopCostUsd, and costLimitHit must all be cleared.
        expect(update.metadata).not.toHaveProperty('stopReason');
        expect(update.metadata).not.toHaveProperty('stopCostUsd');
        expect(update.metadata).not.toHaveProperty('costLimitHit');
        expect(update.metadata).toMatchObject({
          other: 'keep-me',
          effectiveCostLimitUsd: 10,
        });
        expect(update.status).toBeUndefined();
      });

      it('throws BadRequestException when current cost is still at or above limit', async () => {
        setupTriggerMocks();
        // stopCostUsd=6 is >= limit=5, so the guard must block the resume.
        const stoppedThread = makeStoppedThread({
          metadata: {
            stopReason: 'cost_limit',
            stopCostUsd: 6,
            other: 'keep-me',
          },
        });
        vi.mocked(threadsDao.getOne).mockResolvedValueOnce(stoppedThread);
        vi.mocked(costLimitResolver.resolveForThread).mockResolvedValue(5);

        const err = await service
          .executeTrigger(mockCtx, mockGraphId, triggerId, {
            messages: ['Continue'],
            threadSubId: 'my-thread',
          })
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(BadRequestException);
        expect(
          (err as BadRequestException & { errorCode?: string }).errorCode,
        ).toBe('THREAD_COST_LIMIT_REACHED');
        // H2: error message now uses metadataStopCost directly (not checkpoint value).
        expect((err as Error).message).toContain('6.00');

        expect(threadsDao.updateById).not.toHaveBeenCalled();
      });

      it('clears stopReason and proceeds when effective limit is null (all layers removed)', async () => {
        setupTriggerMocks();
        // H2: when effectiveCostLimitUsd === null, all checks are skipped —
        // resume is allowed unconditionally regardless of stopCostUsd.
        const stoppedThread = makeStoppedThread();
        vi.mocked(threadsDao.getOne)
          .mockResolvedValueOnce(stoppedThread)
          .mockResolvedValueOnce(stoppedThread);
        vi.mocked(costLimitResolver.resolveForThread).mockResolvedValue(null);

        const result = await service.executeTrigger(
          mockCtx,
          mockGraphId,
          triggerId,
          {
            messages: ['Continue'],
            threadSubId: 'my-thread',
          },
        );

        expect(result.externalThreadId).toBe(expectedThreadId);
        expect(costLimitResolver.resolveForThread).toHaveBeenCalledWith(
          mockUserId,
          mockGraphId,
        );
        // Checkpoint not consulted because effectiveCostLimitUsd=null skips both checks.
        expect(
          checkpointStateService.getThreadTokenUsage,
        ).not.toHaveBeenCalled();

        const updateCall = vi
          .mocked(threadsDao.updateById)
          .mock.calls.find(([id]) => id === 'stopped-thread-id') as [
          string,
          { metadata: Record<string, unknown> },
          unknown,
        ];
        expect(updateCall).toBeDefined();
        const [, update] = updateCall;
        // stopReason, stopCostUsd, and costLimitHit must all be cleared.
        expect(update.metadata).not.toHaveProperty('stopReason');
        expect(update.metadata).not.toHaveProperty('stopCostUsd');
        expect(update.metadata).not.toHaveProperty('costLimitHit');
        expect(update.metadata).toMatchObject({
          other: 'keep-me',
          effectiveCostLimitUsd: null,
        });
      });

      it('skips guard when thread is Stopped but stopReason is not cost_limit', async () => {
        setupTriggerMocks();
        const stoppedThread = makeStoppedThread({
          metadata: { stopReason: 'user_cancelled' },
        });
        vi.mocked(threadsDao.getOne)
          .mockResolvedValueOnce(stoppedThread)
          .mockResolvedValueOnce(stoppedThread);
        vi.mocked(costLimitResolver.resolveForThread).mockResolvedValue(null);

        await service.executeTrigger(mockCtx, mockGraphId, triggerId, {
          messages: ['Continue'],
          threadSubId: 'my-thread',
        });

        // Resolver is consulted once per user message to refresh metadata,
        // but the checkpoint lookup only happens on the cost_limit guard path.
        expect(
          checkpointStateService.getThreadTokenUsage,
        ).not.toHaveBeenCalled();
        // Metadata refresh still writes the effective limit — the stopReason is
        // preserved (not a cost_limit stop) alongside the new limit.
        const updateCall = vi
          .mocked(threadsDao.updateById)
          .mock.calls.find(([id]) => id === 'stopped-thread-id') as [
          string,
          { metadata: Record<string, unknown> },
          unknown,
        ];
        expect(updateCall).toBeDefined();
        const [, update] = updateCall;
        expect(update.metadata).toMatchObject({
          stopReason: 'user_cancelled',
          effectiveCostLimitUsd: null,
        });
      });

      it('skips guard when thread is not Stopped', async () => {
        setupTriggerMocks();
        const runningThread = makeStoppedThread({
          status: ThreadStatus.Running,
          metadata: { stopReason: 'cost_limit' },
        });
        vi.mocked(threadsDao.getOne)
          .mockResolvedValueOnce(runningThread)
          .mockResolvedValueOnce(runningThread);
        vi.mocked(costLimitResolver.resolveForThread).mockResolvedValue(null);

        await service.executeTrigger(mockCtx, mockGraphId, triggerId, {
          messages: ['Continue'],
          threadSubId: 'my-thread',
        });

        expect(
          checkpointStateService.getThreadTokenUsage,
        ).not.toHaveBeenCalled();
      });

      it('uses metadata.stopCostUsd over checkpoint when present and still above limit', async () => {
        // Covers the key resume-guard bug: when CostLimitExceededError fires, the
        // over-budget call's usage is NOT written to the checkpoint. The persisted
        // metadata.stopCostUsd is the authoritative source.
        setupTriggerMocks();
        const stoppedThread = makeStoppedThread({
          metadata: {
            stopReason: 'cost_limit',
            stopCostUsd: 1.03,
            other: 'keep-me',
          },
        });
        vi.mocked(threadsDao.getOne).mockResolvedValueOnce(stoppedThread);
        // Checkpoint still shows the PRE-call total that is BELOW the limit.
        vi.mocked(checkpointStateService.getThreadTokenUsage).mockResolvedValue(
          { totalPrice: 0.98 } as any,
        );
        vi.mocked(costLimitResolver.resolveForThread).mockResolvedValue(1);

        const err = await service
          .executeTrigger(mockCtx, mockGraphId, triggerId, {
            messages: ['Continue'],
            threadSubId: 'my-thread',
          })
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(BadRequestException);
        expect(
          (err as BadRequestException & { errorCode?: string }).errorCode,
        ).toBe('THREAD_COST_LIMIT_REACHED');
        // Message must reflect the metadata value, not the checkpoint value.
        expect((err as Error).message).toContain('1.03');
        // When metadata.stopCostUsd is present, checkpoint is NOT consulted.
        expect(
          checkpointStateService.getThreadTokenUsage,
        ).not.toHaveBeenCalled();
        expect(threadsDao.updateById).not.toHaveBeenCalled();
      });

      it('throws THREAD_COST_LIMIT_REACHED when metadata.stopCostUsd is absent (conservative block, H2)', async () => {
        // H2: the checkpoint fallback was removed because it underestimates cost.
        // When stopCostUsd is missing and the limit is non-null, we conservatively
        // block the resume rather than read a stale pre-call checkpoint value.
        setupTriggerMocks();
        const stoppedThread = makeStoppedThread({
          metadata: { stopReason: 'cost_limit', other: 'keep-me' },
        });
        vi.mocked(threadsDao.getOne).mockResolvedValueOnce(stoppedThread);
        vi.mocked(costLimitResolver.resolveForThread).mockResolvedValue(1);

        const err = await service
          .executeTrigger(mockCtx, mockGraphId, triggerId, {
            messages: ['Continue'],
            threadSubId: 'my-thread',
          })
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(BadRequestException);
        expect(
          (err as BadRequestException & { errorCode?: string }).errorCode,
        ).toBe('THREAD_COST_LIMIT_REACHED');
        // Checkpoint must NOT be consulted — we block conservatively.
        expect(
          checkpointStateService.getThreadTokenUsage,
        ).not.toHaveBeenCalled();
        expect(threadsDao.updateById).not.toHaveBeenCalled();
      });
    });

    describe('message conversion', () => {
      const triggerId = 'trigger-1';
      const agentId = 'agent-1';
      const threadSubId = 'test-thread';

      function makeTriggerSetup() {
        const mockGraph = createMockGraphEntity({
          status: GraphStatus.Running,
          schema: {
            nodes: [
              {
                id: triggerId,
                template: 'manual-trigger',
                config: { agentId },
              },
            ],
            edges: [],
          },
        });

        const capturedMessages: BaseMessage[] = [];
        const mockTrigger = {
          isStarted: true,
          invokeAgent: vi
            .fn()
            .mockImplementation(async (msgs: BaseMessage[], _opts: unknown) => {
              capturedMessages.push(...msgs);
              return {
                messages: [],
                threadId: `${mockGraphId}:${threadSubId}`,
                checkpointNs: `${mockGraphId}:${threadSubId}:${agentId}`,
              };
            }),
        };
        const mockTriggerNode = {
          id: triggerId,
          type: NodeKind.Trigger,
          template: 'manual-trigger',
          instance: mockTrigger,
          handle: {
            provide: async () => mockTrigger,
            configure: vi.fn().mockResolvedValue(undefined),
            destroy: vi.fn().mockResolvedValue(undefined),
          },
          getStatus: vi.fn().mockReturnValue(GraphNodeStatus.Idle),
        };
        const mockCompiledGraph = createMockCompiledGraph();

        vi.mocked(graphDao.getOne).mockResolvedValue(mockGraph);
        vi.mocked(graphRegistry.get).mockReturnValue(mockCompiledGraph);
        vi.mocked(graphRegistry.getNode).mockReturnValue(
          mockTriggerNode as unknown as CompiledGraphNode,
        );

        return { capturedMessages };
      }

      it('should convert plain string message to HumanMessage with string content', async () => {
        const { capturedMessages } = makeTriggerSetup();

        await service.executeTrigger(mockCtx, mockGraphId, triggerId, {
          messages: ['Hello world'],
          threadSubId,
        });

        expect(capturedMessages).toHaveLength(1);
        expect(capturedMessages[0]!.content).toBe('Hello world');
      });

      it('should convert structured message with content blocks to HumanMessage with content array', async () => {
        const { capturedMessages } = makeTriggerSetup();

        await service.executeTrigger(mockCtx, mockGraphId, triggerId, {
          messages: [
            {
              content: [
                { type: 'text', text: 'Describe this image' },
                {
                  type: 'image_url',
                  image_url: {
                    url: 'data:image/png;base64,abc123',
                    detail: 'auto',
                  },
                },
              ],
            },
          ],
          threadSubId,
        });

        expect(capturedMessages).toHaveLength(1);
        expect(Array.isArray(capturedMessages[0]!.content)).toBe(true);
        const blocks = capturedMessages[0]!.content as {
          type: string;
          text?: string;
        }[];
        expect(blocks[0]).toEqual({
          type: 'text',
          text: 'Describe this image',
        });
        expect(blocks[1]).toEqual({
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,abc123', detail: 'auto' },
        });
      });
    });
  });

  describe('integration scenarios', () => {
    it('should handle complete graph lifecycle', async () => {
      const createData: CreateGraphDto = {
        name: 'Lifecycle Graph',
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
        metadata: {
          graphId: 'lifecycle-graph',
          version: '1.0.0',
        },
      };

      const createdGraph = createMockGraphEntity({
        id: 'lifecycle-graph',
        name: 'Lifecycle Graph',
        status: GraphStatus.Created,
      });
      const runningGraph = createMockGraphEntity({
        id: 'lifecycle-graph',
        status: GraphStatus.Running,
      });
      const stoppedGraph = createMockGraphEntity({
        id: 'lifecycle-graph',
        status: GraphStatus.Stopped,
      });
      const compiledGraph = createMockCompiledGraph();

      vi.mocked(graphDao.create).mockResolvedValue(createdGraph);
      const created = await service.create(mockCtx, createData);
      expect(created.status).toBe(GraphStatus.Created);

      vi.mocked(graphDao.getOne)
        .mockResolvedValueOnce(createdGraph)
        .mockResolvedValueOnce(runningGraph);
      vi.mocked(graphRegistry.get).mockReturnValue(undefined);
      vi.mocked(graphCompiler.compile).mockResolvedValue(compiledGraph);
      vi.mocked(graphDao.updateById).mockResolvedValue(1);
      const running = await service.run(mockCtx, 'lifecycle-graph');
      expect(running.status).toBe(GraphStatus.Running);

      // Destroy
      vi.mocked(graphDao.getOne)
        .mockResolvedValueOnce(runningGraph)
        .mockResolvedValueOnce(stoppedGraph);
      vi.mocked(graphRegistry.get).mockReturnValue(compiledGraph);
      vi.mocked(graphRegistry.destroy).mockResolvedValue(undefined);
      vi.mocked(threadsDao.getAll).mockResolvedValue([]);
      const stopped = await service.destroy(mockCtx, 'lifecycle-graph');
      expect(stopped.status).toBe(GraphStatus.Stopped);

      vi.mocked(graphDao.getOne).mockResolvedValue(stoppedGraph);
      vi.mocked(graphDao.deleteById).mockResolvedValue(undefined);
      await service.delete(mockCtx, 'lifecycle-graph');
    });

    it('should handle error recovery scenarios', async () => {
      const graph = createMockGraphEntity({ status: GraphStatus.Created });
      const compiledGraph = createMockCompiledGraph();

      // Simulate compilation error with registry cleanup
      vi.mocked(graphDao.getOne).mockResolvedValue(graph);
      vi.mocked(graphRegistry.get).mockReturnValue(compiledGraph);
      vi.mocked(graphCompiler.compile).mockRejectedValue(
        new Error('Compilation failed'),
      );
      vi.mocked(graphRegistry.destroy).mockResolvedValue(undefined);
      vi.mocked(graphDao.updateById)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1);

      await expect(service.run(mockCtx, mockGraphId)).rejects.toThrow(
        'Compilation failed',
      );

      // Verify cleanup happened
      expect(graphRegistry.destroy).toHaveBeenCalledWith(mockGraphId);
      expect(graphDao.updateById).toHaveBeenNthCalledWith(
        2,
        mockGraphId,
        expect.objectContaining({
          status: GraphStatus.Error,
          error: 'Compilation failed',
        }),
      );
    });
  });
});
