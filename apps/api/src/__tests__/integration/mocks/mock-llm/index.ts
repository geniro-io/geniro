import type { INestApplication } from '@nestjs/common';

import { MockLlmService } from './mock-llm.service';

export { MockLlmNoMatchError } from './mock-llm.errors';
export { MockLlmModule } from './mock-llm.module';
export { MockLlmService } from './mock-llm.service';
export type {
  MockLlmFixture,
  MockLlmMatcher,
  MockLlmReply,
  MockLlmRequest,
} from './mock-llm.types';
export { applyDefaults } from './mock-llm-defaults.utils';
export {
  installBaseAgentPatch,
  uninstallBaseAgentPatch,
} from './mock-llm-patch.utils';

export const getMockLlm = (app: INestApplication): MockLlmService =>
  app.get(MockLlmService);
