import { Module } from '@nestjs/common';
import { registerEntities } from '@packages/mikroorm';

import { AgentMemoryController } from './controllers/agent-memory.controller';
import { AgentMemoryDao } from './dao/agent-memory.dao';
import { AgentMemoryEntryEntity } from './entity/agent-memory-entry.entity';
import { AgentMemoryService } from './services/agent-memory.service';

@Module({
  imports: [registerEntities([AgentMemoryEntryEntity])],
  controllers: [AgentMemoryController],
  providers: [AgentMemoryDao, AgentMemoryService],
  exports: [AgentMemoryService, AgentMemoryDao],
})
export class AgentMemoryModule {}
