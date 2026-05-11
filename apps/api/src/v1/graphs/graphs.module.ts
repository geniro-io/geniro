import './graphs.exceptions';

import { forwardRef, Module, OnModuleInit } from '@nestjs/common';
import { registerEntities } from '@packages/mikroorm';

import { environment } from '../../environments';
import { AgentsModule } from '../agents/agents.module';
import { GraphTemplatesModule } from '../graph-templates/graph-templates.module';
import { LitellmModule } from '../litellm/litellm.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProjectsModule } from '../projects/projects.module';
import { SecretsModule } from '../secrets/secrets.module';
import { ThreadsModule } from '../threads/threads.module';
import { UserPreferencesModule } from '../user-preferences/user-preferences.module';
import { GraphRevisionsController } from './controllers/graph-revisions.controller';
import { GraphsController } from './controllers/graphs.controller';
import { GraphDao } from './dao/graph.dao';
import { GraphRevisionDao } from './dao/graph-revision.dao';
import { GraphEntity } from './entity/graph.entity';
import { GraphRevisionEntity } from './entity/graph-revision.entity';
import { GraphsListener } from './graphs.listener';
import { CostLimitResolverService } from './services/cost-limit-resolver.service';
import { GraphCompiler } from './services/graph-compiler';
import { GraphMergeService } from './services/graph-merge.service';
import { GraphRegistry } from './services/graph-registry';
import { GraphRestorationService } from './services/graph-restoration.service';
import { GraphRevisionService } from './services/graph-revision.service';
import { GraphRevisionQueueService } from './services/graph-revision-queue.service';
import { GraphStateFactory } from './services/graph-state.factory';
import { GraphStateManager } from './services/graph-state.manager';
import { GraphsService } from './services/graphs.service';
import { MessageTransformerService } from './services/message-transformer.service';

@Module({
  imports: [
    registerEntities([GraphEntity, GraphRevisionEntity]),
    forwardRef(() => GraphTemplatesModule),
    LitellmModule,
    NotificationsModule,
    forwardRef(() => AgentsModule),
    forwardRef(() => ThreadsModule),
    ProjectsModule,
    SecretsModule,
    UserPreferencesModule,
  ],
  controllers: [GraphsController, GraphRevisionsController],
  providers: [
    GraphDao,
    GraphRevisionDao,
    GraphsService,
    GraphRevisionService,
    GraphRevisionQueueService,
    CostLimitResolverService,
    GraphCompiler,
    GraphRegistry,
    GraphRestorationService,
    GraphMergeService,
    MessageTransformerService,
    GraphStateManager,
    GraphStateFactory,
    GraphsListener,
  ],
  exports: [
    GraphDao,
    GraphRevisionDao,
    GraphCompiler,
    GraphsService,
    GraphRevisionService,
    GraphRevisionQueueService,
    GraphRegistry,
    GraphRestorationService,
    MessageTransformerService,
    GraphStateManager,
  ],
})
export class GraphsModule implements OnModuleInit {
  constructor(
    private readonly graphRestorationService: GraphRestorationService,
  ) {}

  onModuleInit(): void {
    if (environment.restoreGraphs) {
      void this.graphRestorationService.restoreRunningGraphs();
    }
  }
}
