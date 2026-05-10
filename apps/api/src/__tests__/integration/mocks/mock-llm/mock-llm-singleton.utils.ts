// patch lives in test code, BaseAgent is unaware
import type { MockLlmService } from './mock-llm.service';

let _instance: MockLlmService | null = null;

export function setMockLlmService(svc: MockLlmService): void {
  _instance = svc;
}

export function getMockLlmService(): MockLlmService {
  if (_instance === null) {
    throw new Error(
      'MockLlmService singleton not set. The integration test must go through createTestModule() in apps/api/src/__tests__/integration/setup.ts, which calls setMockLlmService().',
    );
  }
  return _instance;
}

export function clearMockLlmService(): void {
  _instance = null;
}
