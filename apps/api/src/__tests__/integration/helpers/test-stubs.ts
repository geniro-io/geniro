// Shared stubs for integration tests that override DI providers.
//
// These prevent real network calls: LiteLlmClient never contacts the LiteLLM proxy,
// and ThreadNameGeneratorService does not fire a JSON LLM request that would race
// with per-test chat fixtures.

export const mockLiteLlmClient = {
  fetchModelList: async () => [],
  getModelInfo: async () => null,
  invalidateCache: () => undefined,
};

export const mockThreadNameGenerator = {
  generateFromFirstUserMessage: async () => undefined,
};
