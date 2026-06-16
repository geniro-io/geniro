import { Module } from '@nestjs/common';

import { SubagentSuspendService } from './subagent-suspend.service';
import { SubagentsService } from './subagents.service';

@Module({
  providers: [SubagentsService, SubagentSuspendService],
  exports: [SubagentsService, SubagentSuspendService],
})
export class SubagentsModule {}
