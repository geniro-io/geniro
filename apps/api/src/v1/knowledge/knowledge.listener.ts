import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DefaultLogger } from '@packages/common';

import type { ProjectDeletedEvent } from '../projects/projects.events';
import { PROJECT_DELETED_EVENT } from '../projects/projects.events';
import { KnowledgeDocDao } from './dao/knowledge-doc.dao';

@Injectable()
export class KnowledgeListener {
  constructor(
    private readonly knowledgeDocDao: KnowledgeDocDao,
    private readonly logger: DefaultLogger,
  ) {}

  @OnEvent(PROJECT_DELETED_EVENT)
  async onProjectDeleted(event: ProjectDeletedEvent): Promise<void> {
    try {
      this.logger.log(
        `Deleting knowledge docs for project ${event.projectId} by user ${event.userId}`,
      );
      await this.knowledgeDocDao.delete({
        projectId: event.projectId,
        createdBy: event.userId,
      });
    } catch (error) {
      this.logger.error(
        error as Error,
        `Failed to delete knowledge docs for project ${event.projectId} by user ${event.userId}`,
      );
      throw error;
    }
  }
}
