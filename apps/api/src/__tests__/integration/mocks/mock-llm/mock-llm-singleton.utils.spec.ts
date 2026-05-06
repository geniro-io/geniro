import { beforeEach, describe, expect, it } from 'vitest';

import { MockLlmService } from './mock-llm.service';
import {
  clearMockLlmService,
  getMockLlmService,
  setMockLlmService,
} from './mock-llm-singleton.utils';

describe('mock-llm-singleton.utils', () => {
  // Ensure each test starts with a clean slate — no leftover singleton.
  beforeEach(() => {
    clearMockLlmService();
  });

  it('(a) getMockLlmService() throws before setMockLlmService() is called', () => {
    expect(() => getMockLlmService()).toThrow(/MockLlmService/i);
  });

  it('(b) getMockLlmService() returns the same instance after setMockLlmService()', () => {
    const svc = new MockLlmService();
    setMockLlmService(svc);

    const retrieved = getMockLlmService();
    expect(retrieved).toBe(svc);
  });

  it('(c) clearMockLlmService() causes subsequent getMockLlmService() to throw again', () => {
    const svc = new MockLlmService();
    setMockLlmService(svc);

    // Sanity check: works before clear
    expect(() => getMockLlmService()).not.toThrow();

    clearMockLlmService();

    // Must throw after clear
    expect(() => getMockLlmService()).toThrow(/MockLlmService/i);
  });
});
