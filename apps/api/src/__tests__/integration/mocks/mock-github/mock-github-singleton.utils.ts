import { MockGithubService } from './mock-github.service';

/**
 * Process-wide singleton bridge. The DI-resolved MockGithubService is published
 * here in `setup.ts` after the testing module compiles, so the global `fetch`
 * patch (which has no DI scope) can read fixtures from the current app's
 * service. Mirrors `mock-mcp-singleton.utils.ts`.
 */
let mockGithubService: MockGithubService | undefined;

export const setMockGithubService = (svc: MockGithubService): void => {
  mockGithubService = svc;
};

export const getMockGithubService = (): MockGithubService | undefined =>
  mockGithubService;
