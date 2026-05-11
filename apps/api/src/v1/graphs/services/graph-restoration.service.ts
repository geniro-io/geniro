import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import type { FastifyRequest } from 'fastify';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { ThreadsDao } from '../../threads/dao/threads.dao';
import { ThreadStatusTransitionService } from '../../threads/services/thread-status-transition.service';
import { ThreadStatus } from '../../threads/threads.types';
import { GraphDao } from '../dao/graph.dao';
import { GraphEntity } from '../entity/graph.entity';
import { GraphStatus } from '../graphs.types';
import { GraphRegistry } from './graph-registry';
import { GraphsService } from './graphs.service';

@Injectable()
export class GraphRestorationService {
  constructor(
    private readonly graphDao: GraphDao,
    private readonly graphRegistry: GraphRegistry,
    private readonly threadsDao: ThreadsDao,
    private readonly graphsService: GraphsService,
    private readonly logger: DefaultLogger,
    private readonly transitionService: ThreadStatusTransitionService,
  ) {}

  async restoreRunningGraphs(): Promise<void> {
    this.logger.log('Starting graph restoration process...');

    await this.graphDao.hardDelete({ temporary: true });

    // Restore permanent graphs (both running and compiling)
    const graphsToRestore = await this.graphDao.getAll({
      status: { $in: [GraphStatus.Running, GraphStatus.Compiling] },
    });

    this.logger.debug('Restoring graphs after restart', {
      runningCount: graphsToRestore.filter(
        (graph) => graph.status === GraphStatus.Running,
      ).length,
      compilingCount: graphsToRestore.filter(
        (graph) => graph.status === GraphStatus.Compiling,
      ).length,
      total: graphsToRestore.length,
    });

    const restorationPromises = graphsToRestore.map((graph) =>
      this.restoreGraph(graph),
    );
    await Promise.allSettled(restorationPromises);
  }

  private async restoreGraph(graph: GraphEntity): Promise<void> {
    const { id, name } = graph;

    try {
      if (this.graphRegistry.get(id)) {
        return;
      }

      const contextDataStorage = new AppContextStorage(
        { sub: graph.createdBy },
        { headers: {} } as unknown as FastifyRequest,
      );
      await this.graphsService.run(contextDataStorage, id);

      await this.stopInterruptedThreads(id);

      this.logger.log(`Successfully restored graph ${id}`);
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error : new Error(String(error)),
        `Failed to restore graph ${id}`,
        {
          graphId: id,
          graphName: name,
        },
      );
      // Don't re-throw - allow other graphs to be restored
    }
  }

  private async stopInterruptedThreads(graphId: string): Promise<void> {
    try {
      const runningThreads = await this.threadsDao.getAll({
        graphId,
        status: { $in: [ThreadStatus.Running, ThreadStatus.Waiting] },
      });

      if (runningThreads.length === 0) {
        return;
      }

      // token usage is in checkpoint state only — no need to read it here
      const results = await Promise.allSettled(
        runningThreads.map((thread) => {
          const patch = this.transitionService.computeTransition(
            thread,
            ThreadStatus.Stopped,
          );
          return this.threadsDao.updateById(thread.id, patch);
        }),
      );
      for (const [idx, result] of results.entries()) {
        if (result.status === 'rejected') {
          const thread = runningThreads[idx]!;
          const reason =
            result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason));
          this.logger.error(
            reason,
            'Failed to stop interrupted thread during boot recovery',
            {
              threadId: thread.id,
              externalThreadId: thread.externalThreadId,
              graphId,
            },
          );
        }
      }
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error : new Error(String(error)),
        `Failed to stop interrupted threads for graph ${graphId}`,
      );
    }
  }
}
