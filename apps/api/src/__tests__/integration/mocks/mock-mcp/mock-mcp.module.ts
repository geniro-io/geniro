import { Global, Module } from '@nestjs/common';

import { MockMcpService } from './mock-mcp.service';

@Global()
@Module({
  providers: [MockMcpService],
  exports: [MockMcpService],
})
export class MockMcpModule {}
