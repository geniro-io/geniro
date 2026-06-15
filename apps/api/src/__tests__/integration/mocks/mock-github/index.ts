import type { INestApplication } from '@nestjs/common';

import { MockGithubService } from './mock-github.service';

export { MockGithubModule } from './mock-github.module';
export { MockGithubService } from './mock-github.service';
export type {
  MockGithubFixture,
  MockGithubMatcher,
  MockGithubReply,
  MockGithubRequest,
  MockGithubResponse,
} from './mock-github.types';
export { applyGithubDefaults } from './mock-github-defaults.utils';
export {
  installMockGithubPatch,
  uninstallMockGithubPatch,
} from './mock-github-patch.utils';
export {
  getMockGithubService,
  setMockGithubService,
} from './mock-github-singleton.utils';

export const getMockGithub = (app: INestApplication): MockGithubService =>
  app.get(MockGithubService);
