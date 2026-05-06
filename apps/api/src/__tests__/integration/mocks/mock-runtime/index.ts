import type { INestApplication } from '@nestjs/common';

import { MockRuntimeService } from './mock-runtime.service';

export { MockRuntime } from './mock-runtime';
export { MockRuntimeModule } from './mock-runtime.module';
export { MockRuntimeService } from './mock-runtime.service';
export type {
  MockRuntimeExecFixture,
  MockRuntimeExecMatcher,
  MockRuntimeExecReply,
  MockRuntimeExecRequest,
} from './mock-runtime.types';
export { MockRuntimeProvider } from './mock-runtime-provider';

export const getMockRuntime = (app: INestApplication): MockRuntimeService =>
  app.get(MockRuntimeService);
