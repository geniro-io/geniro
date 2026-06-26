import { Module } from '@nestjs/common';
import { registerEntities } from '@packages/mikroorm';

import { LitellmModule } from '../litellm/litellm.module';
import { OpenaiModule } from '../openai/openai.module';
import { QdrantModule } from '../qdrant/qdrant.module';
import { AgentMemoryController } from './controllers/agent-memory.controller';
import { AgentMemoryDao } from './dao/agent-memory.dao';
import { AgentMemoryEntryEntity } from './entity/agent-memory-entry.entity';
import { AgentMemoryService } from './services/agent-memory.service';
import { AgentMemoryVectorService } from './services/agent-memory-vector.service';

@Module({
  imports: [
    registerEntities([AgentMemoryEntryEntity]),
    // M2 semantic recall: embed-on-write + project-filtered vector search.
    QdrantModule,
    OpenaiModule,
    LitellmModule,
  ],
  controllers: [AgentMemoryController],
  providers: [AgentMemoryDao, AgentMemoryService, AgentMemoryVectorService],
  exports: [AgentMemoryService, AgentMemoryDao],
})
export class AgentMemoryModule {}
