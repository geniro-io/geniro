import { Module } from '@nestjs/common';

import { SubagentsService } from './subagents.service';

@Module({
  providers: [SubagentsService],
  exports: [SubagentsService],
})
export class SubagentsModule {}
