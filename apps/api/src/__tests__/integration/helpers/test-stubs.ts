// Shared stubs for integration tests that override DI providers.
//
// These prevent real network calls: LiteLlmClient never contacts the LiteLLM proxy,
// and ThreadNameGeneratorService does not fire a JSON LLM request that would race
// with per-test chat fixtures.

export const mockLiteLlmClient = {
  fetchModelList: async () => [],
  getModelInfo: async () => null,
  invalidateCache: () => undefined,
  // Per-thread virtual keys for Claude Agent sessions: issue/revoke/update are
  // in-memory no-ops so a full ClaudeAgent.run() exercises its key lifecycle
  // without contacting the LiteLLM proxy. The mock bridge handles cost frames.
  generateKey: async (params?: { keyAlias?: string }) => ({
    key: `sk-mock-${params?.keyAlias ?? 'vkey'}`,
  }),
  deleteKeys: async () => undefined,
  updateKeyBudget: async () => undefined,
};

export const mockThreadNameGenerator = {
  generateFromFirstUserMessage: async () => undefined,
};
