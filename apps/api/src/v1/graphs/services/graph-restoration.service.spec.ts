import { Test, TestingModule } from '@nestjs/testing';
import { DefaultLogger } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphCheckpointsDao } from '../../agents/dao/graph-checkpoints.dao';
import { RuntimeInstanceDao } from '../../runtime/dao/runtime-instance.dao';
import { RuntimeProvider } from '../../runtime/services/runtime-provider';
import { ThreadsDao } from '../../threads/dao/threads.dao';
import { ThreadStatusTransitionService } from '../../threads/services/thread-status-transition.service';
import { ThreadStatus } from '../../threads/threads.types';
import { GraphDao } from '../dao/graph.dao';
import { GraphEntity } from '../entity/graph.entity';
import { GraphStatus } from '../graphs.types';
import { GraphCompiler } from './graph-compiler';
import { GraphRegistry } from './graph-registry';
import { GraphRestorationService } from './graph-restoration.service';
import { GraphsService } from './graphs.service';

// Mock DockerRuntime static method
vi.mock('../../runtime/services/docker-runtime', () => ({
  DockerRuntime: {
    getByName: vi.fn().mockResolvedValue(null),
  },
}));

describe('GraphRestorationService', () => {
  let service: GraphRestorationService;
  let graphDao: any;
  let graphCompiler: any;
  let graphRegistry: any;
  let threadsDao: any;
  let graphCheckpointsDao: any;
  let graphsService: any;
  let transitionService: ThreadStatusTransitionService;

  const mockGraphDaoLists = (statusGraphs: GraphEntity[] = []) => {
    vi.mocked(graphDao.getAll).mockResolvedValueOnce(statusGraphs);
  };

  const mockGraph = {
    id: 'test-graph-id',
    name: 'Test Graph',
    description: 'Test Description',
    version: '1.0.0',
    targetVersion: '1.0.0',
    schema: {
      nodes: [
        {
          id: 'agent-1',
          template: 'simple-agent',
          config: {
            name: 'Test Agent',
            instructions: 'You are a helpful test agent.',
            invokeModelName: 'gpt-5-mini',
          },
        },
        {
          id: 'trigger-1',
          template: 'manual-trigger',
          config: {},
        },
      ],
      edges: [
        {
          from: 'trigger-1',
          to: 'agent-1',
        },
      ],
    },
    status: GraphStatus.Running,
    createdBy: 'test-user',
    projectId: 'project-123',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    temporary: false,
  } as unknown as GraphEntity;

  const mockCompiledGraph = {
    metadata: {
      graphId: 'graph-1',
      version: '1.0.0',
      graph_created_by: 'user-1',
      graph_project_id: 'project-1',
    },
    nodes: new Map(),
    edges: [],
    destroy: vi.fn(),
  };

  beforeEach(async () => {
    const mockGraphDao = {
      getAll: vi.fn(),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      delete: vi.fn(),
      hardDelete: vi.fn(),
    };

    const mockGraphCompiler = {
      compile: vi.fn(),
    };

    const mockGraphRegistry = {
      get: vi.fn(),
      register: vi.fn(),
      getNodeInstance: vi.fn(),
    };

    const mockThreadsDao = {
      getAll: vi.fn(),
      updateById: vi.fn(),
    };

    const mockGraphCheckpointsDao = {
      getAll: vi.fn(),
    };

    const mockRuntimeInstanceDao = {
      getAll: vi.fn().mockResolvedValue([]),
      deleteById: vi.fn(),
    };

    const mockRuntimeProvider = {
      stopRuntime: vi.fn(),
    };

    const mockLogger = {
      log: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const mockGraphsService = {
      run: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GraphRestorationService,
        {
          provide: GraphDao,
          useValue: mockGraphDao,
        },
        {
          provide: GraphCompiler,
          useValue: mockGraphCompiler,
        },
        {
          provide: GraphRegistry,
          useValue: mockGraphRegistry,
        },
        {
          provide: ThreadsDao,
          useValue: mockThreadsDao,
        },
        {
          provide: RuntimeInstanceDao,
          useValue: mockRuntimeInstanceDao,
        },
        {
          provide: RuntimeProvider,
          useValue: mockRuntimeProvider,
        },
        {
          provide: GraphCheckpointsDao,
          useValue: mockGraphCheckpointsDao,
        },
        {
          provide: GraphsService,
          useValue: mockGraphsService,
        },
        {
          provide: DefaultLogger,
          useValue: mockLogger,
        },
        {
          provide: ThreadStatusTransitionService,
          useValue: {
            computeTransition: vi.fn().mockReturnValue({
              status: ThreadStatus.Stopped,
              runningStartedAt: null,
              totalRunningMs: 0,
            }),
          },
        },
      ],
    }).compile();

    service = module.get<GraphRestorationService>(GraphRestorationService);
    graphDao = module.get(GraphDao);
    graphCompiler = module.get(GraphCompiler);
    graphRegistry = module.get(GraphRegistry);
    threadsDao = module.get(ThreadsDao);
    graphCheckpointsDao = module.get(GraphCheckpointsDao);
    graphsService = mockGraphsService;
    transitionService = module.get(ThreadStatusTransitionService);

    vi.mocked(graphCheckpointsDao.getAll).mockResolvedValue([]);
    vi.mocked(graphsService.run).mockReset();
    vi.mocked(graphsService.run).mockResolvedValue({
      id: mockGraph.id,
      status: GraphStatus.Running,
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('restoreRunningGraphs', () => {
    it('should restore running graphs successfully', async () => {
      // Arrange
      mockGraphDaoLists([mockGraph]);
      vi.mocked(graphRegistry.get)
        .mockReturnValueOnce(undefined)
        .mockReturnValue(mockCompiledGraph);

      // Act
      await service.restoreRunningGraphs();

      expect(graphDao.hardDelete).toHaveBeenCalledWith({ temporary: true });
      expect(graphDao.getAll).toHaveBeenCalledWith({
        status: { $in: [GraphStatus.Running, GraphStatus.Compiling] },
      });
      expect(graphsService.run).toHaveBeenCalledWith(
        expect.anything(),
        mockGraph.id,
      );
    });

    it('should handle no running graphs', async () => {
      // Arrange
      mockGraphDaoLists([]);

      // Act
      await service.restoreRunningGraphs();

      expect(graphDao.hardDelete).toHaveBeenCalledWith({ temporary: true });
      expect(graphDao.getAll).toHaveBeenCalledWith({
        status: { $in: [GraphStatus.Running, GraphStatus.Compiling] },
      });
      expect(graphCompiler.compile).not.toHaveBeenCalled();
      expect(graphRegistry.register).not.toHaveBeenCalled();
    });

    it('should handle run errors gracefully', async () => {
      // Arrange
      const compilationError = new Error('Compilation failed');
      mockGraphDaoLists([mockGraph]);
      vi.mocked(graphRegistry.get).mockReturnValue(undefined);
      vi.mocked(graphsService.run).mockRejectedValue(compilationError);

      // Act
      await service.restoreRunningGraphs();

      expect(graphDao.hardDelete).toHaveBeenCalledWith({ temporary: true });
      expect(graphDao.getAll).toHaveBeenCalledWith({
        status: { $in: [GraphStatus.Running, GraphStatus.Compiling] },
      });
      expect(graphsService.run).toHaveBeenCalledWith(
        expect.anything(),
        mockGraph.id,
      );
    });

    it('should skip already registered graphs', async () => {
      // Arrange
      mockGraphDaoLists([mockGraph]);
      vi.mocked(graphRegistry.get).mockReturnValue(mockCompiledGraph);

      // Act
      await service.restoreRunningGraphs();

      expect(graphDao.hardDelete).toHaveBeenCalledWith({ temporary: true });
      expect(graphDao.getAll).toHaveBeenCalledWith({
        status: { $in: [GraphStatus.Running, GraphStatus.Compiling] },
      });
      expect(graphCompiler.compile).not.toHaveBeenCalled();
      expect(graphRegistry.register).not.toHaveBeenCalled();
    });

    it('should handle multiple graphs with mixed results', async () => {
      // Arrange
      const mockGraph2 = {
        ...mockGraph,
        id: 'test-graph-id-2',
        name: 'Test Graph 2',
      };
      const compilationError = new Error('Compilation failed');

      vi.mocked(graphDao.getAll).mockResolvedValueOnce([mockGraph, mockGraph2]);
      const registryGetMock = vi.mocked(graphRegistry.get);
      let firstGraphFirstCall = true;
      registryGetMock.mockImplementation((graphId: string) => {
        if (graphId === mockGraph.id) {
          if (firstGraphFirstCall) {
            firstGraphFirstCall = false;
            return undefined;
          }
          return mockCompiledGraph;
        }
        return undefined;
      });
      vi.mocked(graphsService.run)
        .mockResolvedValueOnce({
          id: mockGraph.id,
          status: GraphStatus.Running,
        } as any)
        .mockRejectedValueOnce(compilationError);

      // Act
      await service.restoreRunningGraphs();

      expect(graphDao.hardDelete).toHaveBeenCalledWith({ temporary: true });
      expect(graphDao.getAll).toHaveBeenCalledWith({
        status: { $in: [GraphStatus.Running, GraphStatus.Compiling] },
      });
      expect(graphsService.run).toHaveBeenCalledWith(
        expect.anything(),
        mockGraph.id,
      );
      expect(graphsService.run).toHaveBeenCalledWith(
        expect.anything(),
        mockGraph2.id,
      );
    });

    it('should delete temporary graphs before restoring', async () => {
      // Arrange
      vi.mocked(graphDao.getAll).mockResolvedValueOnce([]);

      // Act
      await service.restoreRunningGraphs();

      expect(graphDao.hardDelete).toHaveBeenCalledWith({ temporary: true });
      expect(graphDao.getAll).toHaveBeenCalledWith({
        status: { $in: [GraphStatus.Running, GraphStatus.Compiling] },
      });
      expect(graphsService.run).not.toHaveBeenCalled();
    });

    it('should restore permanent graphs after deleting temporary ones', async () => {
      // Arrange
      const permanentGraph: GraphEntity = {
        ...mockGraph,
        id: 'permanent-graph-id',
        name: 'Permanent Graph',
        temporary: false,
      };

      vi.mocked(graphDao.getAll).mockResolvedValueOnce([permanentGraph]);
      vi.mocked(graphRegistry.get).mockReturnValueOnce(undefined);
      vi.mocked(graphsService.run).mockResolvedValueOnce({
        id: permanentGraph.id,
        status: GraphStatus.Running,
      } as any);

      // Act
      await service.restoreRunningGraphs();

      expect(graphDao.hardDelete).toHaveBeenCalledWith({ temporary: true });
      expect(graphDao.getAll).toHaveBeenCalledWith({
        status: { $in: [GraphStatus.Running, GraphStatus.Compiling] },
      });
      expect(graphsService.run).toHaveBeenCalledWith(
        expect.anything(),
        permanentGraph.id,
      );
    });

    it('should handle errors when deleting temporary graphs', async () => {
      // Arrange
      const deletionError = new Error('Deletion failed');

      vi.mocked(graphDao.hardDelete).mockRejectedValueOnce(deletionError);
      vi.mocked(graphDao.getAll).mockResolvedValueOnce([]);

      // Act
      await expect(service.restoreRunningGraphs()).rejects.toThrow(
        deletionError,
      );
    });

    it('should allow restore to continue without temporary graphs', async () => {
      // Arrange
      vi.mocked(graphDao.getAll).mockResolvedValueOnce([]);

      // Act
      await service.restoreRunningGraphs();

      expect(graphDao.hardDelete).toHaveBeenCalledWith({ temporary: true });
      expect(graphDao.getAll).toHaveBeenCalledWith({
        status: { $in: [GraphStatus.Running, GraphStatus.Compiling] },
      });
    });

    it('should stop interrupted threads after restoring a graph', async () => {
      // Arrange
      const mockThread = {
        id: 'thread-uuid-1',
        graphId: 'test-graph-id',
        externalThreadId: 'test-graph-id:thread-1',
        createdBy: 'test-user',
        status: ThreadStatus.Running,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockGraphDaoLists([mockGraph]);
      vi.mocked(graphRegistry.get)
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(mockCompiledGraph);
      vi.mocked(graphsService.run).mockResolvedValueOnce({
        id: mockGraph.id,
        status: GraphStatus.Running,
      } as any);
      vi.mocked(threadsDao.getAll).mockResolvedValue([mockThread]);
      vi.mocked(threadsDao.updateById).mockResolvedValue(1 as any);

      // Act
      await service.restoreRunningGraphs();

      // Assert
      expect(graphDao.hardDelete).toHaveBeenCalledWith({ temporary: true });
      expect(graphDao.getAll).toHaveBeenCalledWith({
        status: { $in: [GraphStatus.Running, GraphStatus.Compiling] },
      });
      expect(threadsDao.getAll).toHaveBeenCalledWith({
        graphId: 'test-graph-id',
        status: { $in: [ThreadStatus.Running, ThreadStatus.Waiting] },
      });
      expect(threadsDao.updateById).toHaveBeenCalledWith(
        mockThread.id,
        expect.objectContaining({ status: ThreadStatus.Stopped }),
      );
    });

    it('should handle no interrupted threads gracefully', async () => {
      // Arrange
      mockGraphDaoLists([mockGraph]);
      vi.mocked(graphRegistry.get)
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(mockCompiledGraph);
      vi.mocked(graphsService.run).mockResolvedValueOnce({
        id: mockGraph.id,
        status: GraphStatus.Running,
      } as any);
      vi.mocked(threadsDao.getAll).mockResolvedValue([]);

      // Act
      await service.restoreRunningGraphs();

      // Assert
      expect(graphDao.hardDelete).toHaveBeenCalledWith({ temporary: true });
      expect(graphDao.getAll).toHaveBeenCalledWith({
        status: { $in: [GraphStatus.Running, GraphStatus.Compiling] },
      });
      expect(threadsDao.getAll).toHaveBeenCalledWith({
        graphId: 'test-graph-id',
        status: { $in: [ThreadStatus.Running, ThreadStatus.Waiting] },
      });
      expect(threadsDao.updateById).not.toHaveBeenCalled();
    });

    it('recovers Waiting threads stuck after restart', async () => {
      // Arrange — a thread that was Waiting when the server crashed;
      // its BullMQ resume job was lost, so boot recovery must stop it.
      const waitingThread = {
        id: 'thread-uuid-waiting',
        graphId: 'test-graph-id',
        externalThreadId: 'test-graph-id:thread-waiting',
        createdBy: 'test-user',
        status: ThreadStatus.Waiting,
        runningStartedAt: null,
        totalRunningMs: 5000,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockGraphDaoLists([mockGraph]);
      vi.mocked(graphRegistry.get)
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(mockCompiledGraph);
      vi.mocked(graphsService.run).mockResolvedValueOnce({
        id: mockGraph.id,
        status: GraphStatus.Running,
      } as any);
      vi.mocked(threadsDao.getAll).mockResolvedValue([waitingThread]);
      vi.mocked(threadsDao.updateById).mockResolvedValue(1 as any);
      // Override computeTransition for this test to return a non-zero totalRunningMs
      // so we can assert that the value is forwarded into the DB patch (not silently dropped).
      vi.mocked(transitionService.computeTransition).mockReturnValueOnce({
        status: ThreadStatus.Stopped,
        runningStartedAt: null,
        totalRunningMs: 12345,
      });

      // Act — must not throw even though runningStartedAt is null
      await expect(service.restoreRunningGraphs()).resolves.not.toThrow();

      // Assert — filter includes Waiting, and the helper is called with the Waiting thread
      expect(threadsDao.getAll).toHaveBeenCalledWith({
        graphId: 'test-graph-id',
        status: { $in: [ThreadStatus.Running, ThreadStatus.Waiting] },
      });
      expect(threadsDao.updateById).toHaveBeenCalledWith(
        waitingThread.id,
        expect.objectContaining({
          status: ThreadStatus.Stopped,
          totalRunningMs: 12345,
        }),
      );
    });

    it('should stop multiple interrupted threads', async () => {
      // Arrange
      const mockThread1 = {
        id: 'thread-uuid-1',
        graphId: 'test-graph-id',
        externalThreadId: 'test-graph-id:thread-1',
        createdBy: 'test-user',
        status: ThreadStatus.Running,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockThread2 = {
        id: 'thread-uuid-2',
        graphId: 'test-graph-id',
        externalThreadId: 'test-graph-id:thread-2',
        createdBy: 'test-user',
        status: ThreadStatus.Running,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockGraphDaoLists([mockGraph]);
      vi.mocked(graphRegistry.get)
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(mockCompiledGraph);
      vi.mocked(graphsService.run).mockResolvedValueOnce({
        id: mockGraph.id,
        status: GraphStatus.Running,
      } as any);
      vi.mocked(threadsDao.getAll).mockResolvedValue([
        mockThread1,
        mockThread2,
      ]);
      vi.mocked(threadsDao.updateById).mockResolvedValue(1 as any);

      // Act
      await service.restoreRunningGraphs();

      // Assert
      expect(threadsDao.updateById).toHaveBeenCalledTimes(2);
      expect(threadsDao.updateById).toHaveBeenCalledWith(
        mockThread1.id,
        expect.objectContaining({ status: ThreadStatus.Stopped }),
      );
      expect(threadsDao.updateById).toHaveBeenCalledWith(
        mockThread2.id,
        expect.objectContaining({ status: ThreadStatus.Stopped }),
      );
    });

    it('should handle thread stopping errors gracefully', async () => {
      // Arrange
      const mockThread = {
        id: 'thread-uuid-1',
        graphId: 'test-graph-id',
        externalThreadId: 'test-graph-id:thread-1',
        createdBy: 'test-user',
        status: ThreadStatus.Running,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockGraphDaoLists([mockGraph]);
      vi.mocked(graphRegistry.get)
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(mockCompiledGraph);
      vi.mocked(graphsService.run).mockResolvedValueOnce({
        id: mockGraph.id,
        status: GraphStatus.Running,
      } as any);
      vi.mocked(threadsDao.getAll).mockResolvedValue([mockThread]);
      vi.mocked(threadsDao.updateById).mockRejectedValue(
        new Error('Database error'),
      );

      // Act & Assert - should not throw, but handle error gracefully
      await expect(service.restoreRunningGraphs()).resolves.not.toThrow();
      expect(threadsDao.updateById).toHaveBeenCalledWith(
        mockThread.id,
        expect.objectContaining({ status: ThreadStatus.Stopped }),
      );
    });

    it('logs an error for each interrupted thread that fails to stop during boot recovery', async () => {
      // G7 boot-recovery path: stopInterruptedThreads uses Promise.allSettled
      // over per-thread updateById calls. Per-thread DB failures must be
      // surfaced via logger.error so the operator can find the stuck threads —
      // otherwise interrupted threads stay Running/Waiting forever after a
      // server restart with no trace in the logs.
      // The outer try/catch in stopInterruptedThreads CANNOT catch these
      // because Promise.allSettled never rejects; it always resolves with a
      // results array. The loop after Promise.allSettled checks each result
      // and logs rejected entries.
      const mockLogger = (service as any).logger as {
        error: ReturnType<typeof vi.fn>;
      };
      const threadA = {
        id: 'thread-uuid-a',
        graphId: 'test-graph-id',
        externalThreadId: 'test-graph-id:thread-a',
        createdBy: 'test-user',
        status: ThreadStatus.Running,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const threadB = {
        id: 'thread-uuid-b',
        graphId: 'test-graph-id',
        externalThreadId: 'test-graph-id:thread-b',
        createdBy: 'test-user',
        status: ThreadStatus.Waiting,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockGraphDaoLists([mockGraph]);
      vi.mocked(graphRegistry.get)
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(mockCompiledGraph);
      vi.mocked(graphsService.run).mockResolvedValueOnce({
        id: mockGraph.id,
        status: GraphStatus.Running,
      } as any);
      vi.mocked(threadsDao.getAll).mockResolvedValue([threadA, threadB]);

      const failureForB = new Error('DB write failed for thread-uuid-b');
      vi.mocked(threadsDao.updateById).mockImplementation(
        async (threadId: string) => {
          if (threadId === 'thread-uuid-b') {
            throw failureForB;
          }
          return 1 as any;
        },
      );

      // Must not throw — Promise.allSettled absorbs rejections
      await expect(service.restoreRunningGraphs()).resolves.not.toThrow();

      // Both threads attempted (partial failure must not short-circuit)
      expect(threadsDao.updateById).toHaveBeenCalledTimes(2);

      // The DB error for thread-uuid-b must be surfaced via logger.error.
      const errorMock = vi.mocked(mockLogger.error);
      const sawRejectionInLogger = errorMock.mock.calls.some((call) =>
        call.some(
          (arg) =>
            arg === failureForB ||
            (arg instanceof Error && arg.message === failureForB.message),
        ),
      );
      expect(sawRejectionInLogger).toBe(true);
    });
  });
});
