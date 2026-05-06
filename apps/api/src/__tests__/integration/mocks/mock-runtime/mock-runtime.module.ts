import { Global, Module } from '@nestjs/common';

import { MockRuntimeService } from './mock-runtime.service';

@Global()
@Module({
  providers: [MockRuntimeService],
  exports: [MockRuntimeService],
})
export class MockRuntimeModule {}
