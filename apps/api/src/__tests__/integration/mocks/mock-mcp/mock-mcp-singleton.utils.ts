import { MockMcpService } from './mock-mcp.service';

/**
 * Process-wide singleton bridge. The DI-resolved MockMcpService is published
 * here in `setup.ts` after the testing module compiles, so the prototype
 * patch on `BaseMcp` (which has no DI scope) can read fixtures from it.
 */
let mockMcpService: MockMcpService | undefined;

export const setMockMcpService = (svc: MockMcpService): void => {
  mockMcpService = svc;
};

export const getMockMcpService = (): MockMcpService => {
  if (!mockMcpService) {
    throw new Error(
      'MockMcpService not initialized. Call setMockMcpService() first.',
    );
  }
  return mockMcpService;
};
