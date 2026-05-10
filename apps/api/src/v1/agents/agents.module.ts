import { forwardRef, Module } from '@nestjs/common';
import { registerEntities } from '@packages/mikroorm';

import { AgentToolsModule } from '../agent-tools/agent-tools.module';
import { LitellmModule } from '../litellm/litellm.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RuntimeModule } from '../runtime/runtime.module';
import { ThreadsModule } from '../threads/threads.module';
import { GraphCheckpointsDao } from './dao/graph-checkpoints.dao';
import { GraphCheckpointsWritesDao } from './dao/graph-checkpoints-writes.dao';
import { GraphCheckpointEntity } from './entity/graph-chekpoints.entity';
import { GraphCheckpointWritesEntity } from './entity/graph-chekpoints-writes.entity';
import { SimpleAgent } from './services/agents/simple-agent';
import { SubAgent } from './services/agents/sub-agent';
import { CheckpointStateService } from './services/checkpoint-state.service';
import { PgCheckpointSaver } from './services/pg-checkpoint-saver';

@Module({
  imports: [
    registerEntities([GraphCheckpointEntity, GraphCheckpointWritesEntity]),
    RuntimeModule,
    AgentToolsModule,
    NotificationsModule,
    LitellmModule,
    forwardRef(() => ThreadsModule),
  ],
  controllers: [],
  providers: [
    SimpleAgent,
    SubAgent,
    PgCheckpointSaver,
    CheckpointStateService,
    GraphCheckpointsDao,
    GraphCheckpointsWritesDao,
  ],
  exports: [
    SubAgent,
    PgCheckpointSaver,
    CheckpointStateService,
    GraphCheckpointsDao,
    GraphCheckpointsWritesDao,
    LitellmModule,
  ],
})
export class AgentsModule {}
