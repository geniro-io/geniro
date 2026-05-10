import { Module } from '@nestjs/common';

import { MockLlmService } from './mock-llm.service';

@Module({
  providers: [MockLlmService],
  exports: [MockLlmService],
})
export class MockLlmModule {}

export {
  installBaseAgentPatch,
  uninstallBaseAgentPatch,
} from './mock-llm-patch.utils';
