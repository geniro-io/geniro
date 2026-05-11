import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DefaultLogger } from '@packages/common';

import type { ProjectDeletedEvent } from '../projects/projects.events';
import { PROJECT_DELETED_EVENT } from '../projects/projects.events';
import { GraphDao } from './dao/graph.dao';

@Injectable()
export class GraphsListener {
  constructor(
    private readonly graphDao: GraphDao,
    private readonly logger: DefaultLogger,
  ) {}

  @OnEvent(PROJECT_DELETED_EVENT)
  async onProjectDeleted(event: ProjectDeletedEvent): Promise<void> {
    try {
      this.logger.log(
        `Deleting graphs for project ${event.projectId} by user ${event.userId}`,
      );
      await this.graphDao.delete({
        projectId: event.projectId,
        createdBy: event.userId,
      });
    } catch (error) {
      this.logger.error(
        error as Error,
        `Failed to delete graphs for project ${event.projectId} by user ${event.userId}`,
      );
      throw error;
    }
  }
}
