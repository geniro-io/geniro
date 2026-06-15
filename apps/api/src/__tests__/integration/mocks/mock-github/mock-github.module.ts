import { Global, Module } from '@nestjs/common';

import { MockGithubService } from './mock-github.service';

@Global()
@Module({
  providers: [MockGithubService],
  exports: [MockGithubService],
})
export class MockGithubModule {}
