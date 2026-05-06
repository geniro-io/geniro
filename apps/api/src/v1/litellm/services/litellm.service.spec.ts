import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiteLLMModelInfo } from '../litellm.types';
import { LitellmService } from './litellm.service';

const buildModelInfo = (
  overrides: Partial<LiteLLMModelInfo['model_info']> = {},
): LiteLLMModelInfo => ({
  model_name: 'gpt-4',
  litellm_params: { model: 'openai/gpt-4' },
  model_info: {
    key: 'gpt-4',
    input_cost_per_token: 0.00003,
    output_cost_per_token: 0.00006,
    ...overrides,
  },
});

const createSvc = (
  modelInfo: LiteLLMModelInfo | null = null,
  fetchModelList?: LiteLLMModelInfo[],
) => {
  return new LitellmService({
    listModels: vi.fn(),
    getModelInfo: vi.fn().mockResolvedValue(modelInfo),
    fetchModelList: vi.fn().mockResolvedValue(fetchModelList ?? []),
  } as unknown as never);
};

describe('LitellmService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('extractTokenUsageFromResponse', () => {
    it('returns a zeroed usage object when usage_metadata is missing', async () => {
      const svc = createSvc(null);
      await expect(svc.extractTokenUsageFromResponse('gpt-4')).resolves.toEqual(
        {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          currentContext: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          totalPrice: 0,
        },
      );
    });

    it('extracts token usage from usage_metadata', async () => {
      const svc = createSvc(buildModelInfo());

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 },
      });

      expect(result).toBeDefined();
      expect(result!.inputTokens).toBe(10);
      expect(result!.outputTokens).toBe(5);
      expect(result!.totalTokens).toBe(15); // 10 input + 5 output (cached and reasoning are subsets, not additive)
      expect(result!.cachedInputTokens).toBe(3);
      expect(result!.reasoningTokens).toBe(2);
    });

    it('extracts token usage with cached tokens', async () => {
      const svc = createSvc(buildModelInfo());

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 0 },
      });

      expect(result).toBeDefined();
      expect(result!.inputTokens).toBe(10);
      expect(result!.outputTokens).toBe(5);
      expect(result!.cachedInputTokens).toBe(3);
    });

    it('calculates price with cached tokens correctly', async () => {
      const svc = createSvc(
        buildModelInfo({ input_cost_per_token_cache_hit: 0.00001 }),
      );

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_details: { cached_tokens: 80 },
        output_tokens_details: { reasoning_tokens: 0 },
      });

      expect(result).toBeDefined();
      expect(result!.cachedInputTokens).toBe(80);
      // Should calculate: (20 * 0.00003) + (80 * 0.00001) + (50 * 0.00006)
      // = 0.0006 + 0.0008 + 0.003 = 0.0044
      expect(result!.totalPrice).toBeCloseTo(0.0044, 10);
    });

    it('calculates price when no cached/reasoning tokens', async () => {
      const svc = createSvc(buildModelInfo());

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      });

      expect(result).toBeDefined();
      expect(result!.totalPrice).toBeGreaterThan(0);
    });

    it('falls back to provider-reported cost when model rates are unavailable', async () => {
      // Simulate an OpenRouter model not in LiteLLM pricing database
      const svc = createSvc(null);

      const result = await svc.extractTokenUsageFromResponse(
        'openrouter/minimax-m2.5',
        {
          prompt_tokens: 3612,
          completion_tokens: 272,
          total_tokens: 3884,
          prompt_tokens_details: { cached_tokens: 3493 },
          completion_tokens_details: { reasoning_tokens: 106 },
          cost: 0.00046689,
        },
      );

      expect(result).toBeDefined();
      expect(result!.inputTokens).toBe(3612);
      expect(result!.outputTokens).toBe(272);
      expect(result!.totalTokens).toBe(3884); // 3612 input + 272 output (cached/reasoning are subsets, not additive)
      expect(result!.cachedInputTokens).toBe(3493);
      expect(result!.reasoningTokens).toBe(106);
      expect(result!.totalPrice).toBe(0.00046689);
    });

    it('prefers provider-reported cost over calculated price when both available', async () => {
      const svc = createSvc(buildModelInfo());

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
        cost: 0.00075, // Provider cost takes precedence (actual upstream charge)
      });

      expect(result).toBeDefined();
      // Should use provider-reported cost, as it reflects the actual upstream charge
      expect(result!.totalPrice).toBe(0.00075);
    });

    it('falls back to calculated price when provider cost is absent', async () => {
      const svc = createSvc(buildModelInfo());

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
        // No cost field — should use calculated price
      });

      expect(result).toBeDefined();
      expect(result!.totalPrice).toBeGreaterThan(0);
      // (10 * 0.00003) + (5 * 0.00006) = 0.0003 + 0.0003 = 0.0006
      expect(result!.totalPrice).toBeCloseTo(0.0006, 10);
    });

    it('extracts tokens from OpenRouter prompt_tokens/completion_tokens format', async () => {
      const svc = createSvc(null);

      const result = await svc.extractTokenUsageFromResponse(
        'openrouter/some-model',
        {
          prompt_tokens: 3612,
          completion_tokens: 272,
          total_tokens: 3884,
          prompt_tokens_details: {
            cached_tokens: 3493,
            audio_tokens: 0,
          },
          completion_tokens_details: {
            reasoning_tokens: 106,
            audio_tokens: 0,
          },
          cost: 0.00046689,
        },
      );

      expect(result).toBeDefined();
      expect(result!.inputTokens).toBe(3612);
      expect(result!.outputTokens).toBe(272);
      expect(result!.totalTokens).toBe(3884); // 3612 input + 272 output (cached/reasoning are subsets, not additive)
      expect(result!.cachedInputTokens).toBe(3493);
      expect(result!.reasoningTokens).toBe(106);
      expect(result!.totalPrice).toBe(0.00046689);
    });

    // Scenario 4.4 (regression guard): priced happy-path — provider-reported cost wins
    // This scenario must remain GREEN at all times.
    it('4.4 (regression guard): provider-reported cost is returned as-is when present', async () => {
      const svc = createSvc(null);

      const result = await svc.extractTokenUsageFromResponse(
        'openrouter/minimax-m2.5',
        {
          prompt_tokens: 3612,
          completion_tokens: 272,
          total_tokens: 3884,
          prompt_tokens_details: { cached_tokens: 3493 },
          completion_tokens_details: { reasoning_tokens: 106 },
          cost: 0.00046689,
        },
      );

      expect(result).toBeDefined();
      expect(result!.totalPrice).toBe(0.00046689);
    });

    // Scenario 4.1 (unpriced): no registered rates + no provider cost
    // Architecture: totalPrice coerces to 0 when pricing is unavailable.
    // Mitigation: YAML alias pattern ensures real costs are populated upstream.
    it('4.1 (unpriced): returns 0 totalPrice when model has no rates and provider reports no cost', async () => {
      // createSvc(null) → getModelInfo returns null → estimateThreadTotalPriceFromModelRates returns null
      const svc = createSvc(null);

      const result = await svc.extractTokenUsageFromResponse(
        'unregistered/model',
        {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
          // No cost field — provider did not report a cost
        },
      );

      expect(result).toBeDefined();
      // Coerced to 0 when both providerCost and calculatedPrice are unavailable.
      expect(result!.totalPrice).toBe(0);
    });

    // Scenario 4.2 (providerCost=0 explicit): provider explicitly reports zero cost
    // Zero is a legitimate value (e.g. free-tier model); it must be preserved as 0, not null.
    it('4.2 (providerCost=0 explicit): preserves zero when provider explicitly reports cost=0', async () => {
      // Model has rates so calculatedPrice would be non-zero, but provider overrides with 0
      const svc = createSvc(buildModelInfo());

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
        cost: 0, // Explicit zero from provider — must be preserved
      });

      expect(result).toBeDefined();
      expect(result!.totalPrice).toBe(0);
    });

    it('singular output_token_details with reasoning field is extracted', async () => {
      const svc = createSvc(null);

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        output_token_details: { reasoning: 7 },
      });

      expect(result).toBeDefined();
      expect(result!.reasoningTokens).toBe(7);
    });

    it('singular output_token_details with reasoning_tokens field alias is extracted', async () => {
      const svc = createSvc(null);

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        output_token_details: { reasoning_tokens: 5 },
      });

      expect(result).toBeDefined();
      expect(result!.reasoningTokens).toBe(5);
    });

    it('plural output_tokens_details regression guard: reasoning_tokens still extracted', async () => {
      const svc = createSvc(null);

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        output_tokens_details: { reasoning_tokens: 9 },
      });

      expect(result).toBeDefined();
      expect(result!.reasoningTokens).toBe(9);
    });

    it('returns 0 reasoningTokens when no output details are present', async () => {
      const svc = createSvc(null);

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
      });

      expect(result).toBeDefined();
      expect(result!.reasoningTokens).toBe(0);
    });

    it('plural output_tokens_details takes precedence over singular output_token_details', async () => {
      const svc = createSvc(null);

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        output_tokens_details: { reasoning_tokens: 11 },
        output_token_details: { reasoning: 7 },
      });

      expect(result).toBeDefined();
      expect(result!.reasoningTokens).toBe(11);
    });

    it('returns 0 reasoningTokens when output_token_details is empty object', async () => {
      const svc = createSvc(null);

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        output_token_details: {},
      });

      expect(result).toBeDefined();
      expect(result!.reasoningTokens).toBe(0);
    });

    it('returns 0 reasoningTokens when output_token_details.reasoning is null', async () => {
      const svc = createSvc(null);

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        output_token_details: { reasoning: null as unknown as number },
      });

      expect(result).toBeDefined();
      expect(result!.reasoningTokens).toBe(0);
    });

    it('adversarial: empty plural output_tokens_details still allows the new singular output_token_details to feed reasoningTokens via the field-level ?? chain', async () => {
      // The `??` operator only short-circuits on null/undefined, NOT on `{}`.
      // So the field-level chain:
      //   output_tokens_details?.reasoning_tokens ??
      //   output_tokens_details?.reasoning ??
      //   completion_tokens_details?.reasoning_tokens ??
      //   completion_tokens_details?.reasoning ??
      //   output_token_details?.reasoning_tokens ??
      //   output_token_details?.reasoning ??
      //   0
      // evaluates each field individually. `output_tokens_details?.reasoning_tokens` on an
      // empty object `{}` returns `undefined` (the field does not exist), so `??` advances
      // to the next step. Eventually `output_token_details?.reasoning` returns 9.
      // This test pins the field-level (NOT object-level) `??` chain semantic.
      const svc = createSvc(null);

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        output_tokens_details: {} as never, // empty plural — field accesses return undefined, so ?? advances
        output_token_details: { reasoning: 9 }, // reached because all earlier ?? steps returned undefined
      });

      expect(result).toBeDefined();
      // `{}` fields return undefined; `??` is not short-circuited by `{}`; output_token_details.reasoning is read.
      expect(result!.reasoningTokens).toBe(9);
    });

    it('adversarial: explicit zero on output_tokens_details.reasoning_tokens does NOT allow the next ?? step; reasoningTokens is 0 not 9', async () => {
      // The `??` operator short-circuits on any defined value including `0`.
      // `0 ?? 9` returns `0` — it does NOT advance past the first defined result.
      // This is the semantic difference from `||`: `0 || 9` would return 9.
      // This paired test pins the actual `??` semantic: explicit zero is preserved,
      // not overwritten by a later field with a higher value.
      // Any future `??` → `||` refactor on the reasoningTokens chain would cause this test
      // to fail (since `0 || 9 === 9`, but the correct answer is 0).
      const svc = createSvc(null);

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        output_tokens_details: { reasoning_tokens: 0 }, // explicit zero — ?? stops here
        output_token_details: { reasoning: 9 }, // never reached because 0 is defined (not null/undefined)
      });

      expect(result).toBeDefined();
      // `0 ?? 9` returns 0; the explicit zero from output_tokens_details is preserved.
      expect(result!.reasoningTokens).toBe(0);
    });

    // Scenario 4.3 (calculatedPrice=0, providerCost=null): model rates are zero (free model)
    // calculatedPrice resolves to 0 (not null) because rates exist but are zero-valued.
    // Result must be 0, not null — the pricing is known (zero), just cheap.
    it('4.3 (calculatedPrice=0, providerCost=null): returns 0 when model rates are zero and no provider cost', async () => {
      const svc = createSvc(
        buildModelInfo({
          input_cost_per_token: 0,
          output_cost_per_token: 0,
        }),
      );

      const result = await svc.extractTokenUsageFromResponse('gpt-4', {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
        // No cost field — calculated price is 0 because rates are 0
      });

      expect(result).toBeDefined();
      // Pricing is known (zero-rate model): result must be 0, not null
      expect(result!.totalPrice).toBe(0);
    });
  });

  describe('estimateThreadTotalPriceFromModelRates', () => {
    it('calculates price with cached tokens correctly', async () => {
      const svc = createSvc(
        buildModelInfo({ input_cost_per_token_cache_hit: 0.000015 }),
      );

      const price = await svc.estimateThreadTotalPriceFromModelRates({
        model: 'gpt-4',
        inputTokens: 1000,
        cachedInputTokens: 800,
        outputTokens: 100,
        reasoningTokens: 0,
      });

      // (200 * 0.00003) + (800 * 0.000015) + (100 * 0.00006)
      // = 0.006 + 0.012 + 0.006 = 0.024
      expect(price).toBeCloseTo(0.024, 10);
    });
  });

  describe('getTokenCostRatesForModel', () => {
    it('returns cost rates for a model', async () => {
      const svc = createSvc(
        buildModelInfo({ input_cost_per_token_cache_hit: 0.000015 }),
      );

      const rates = await svc.getTokenCostRatesForModel('gpt-4');

      expect(rates).toEqual({
        inputCostPerToken: 0.00003,
        outputCostPerToken: 0.00006,
        inputCostPerCachedToken: 0.000015,
      });
    });

    it('returns null for unknown model', async () => {
      const svc = createSvc(null);

      const rates = await svc.getTokenCostRatesForModel('unknown-model');

      expect(rates).toBeNull();
    });
  });

  describe('listModels', () => {
    it('marks a model with mode=embedding as embedding', async () => {
      const embeddingModel: LiteLLMModelInfo = {
        model_name: 'text-embedding-3-small',
        litellm_params: { model: 'openai/text-embedding-3-small' },
        model_info: {
          key: 'text-embedding-3-small',
          mode: 'embedding',
        },
      };
      const svc = createSvc(null, [embeddingModel]);

      const result = await svc.listModels();

      expect(result).toHaveLength(1);
      expect(result[0]!.supportsEmbedding).toBe(true);
    });

    it('marks a model with mode=chat as non-embedding', async () => {
      const llmModel: LiteLLMModelInfo = {
        model_name: 'gpt-4',
        litellm_params: { model: 'openai/gpt-4' },
        model_info: {
          key: 'gpt-4',
          mode: 'chat',
        },
      };
      const svc = createSvc(null, [llmModel]);

      const result = await svc.listModels();

      expect(result).toHaveLength(1);
      expect(result[0]!.supportsEmbedding).toBe(false);
    });

    it('falls back to name-based detection when mode is absent', async () => {
      const embeddingModel: LiteLLMModelInfo = {
        model_name: 'qwen3-embedding:4b',
        litellm_params: { model: 'openai/qwen3-embedding:4b' },
        model_info: {
          key: 'qwen3-embedding-4b',
        },
      };
      const svc = createSvc(null, [embeddingModel]);

      const result = await svc.listModels();

      expect(result).toHaveLength(1);
      expect(result[0]!.supportsEmbedding).toBe(true);
    });

    it('returns false for supportsEmbedding when model_info is missing and name has no embed', async () => {
      const noInfoModel = {
        model_name: 'unknown-model',
        litellm_params: { model: 'unknown-model' },
      } as LiteLLMModelInfo;
      const svc = createSvc(null, [noInfoModel]);

      const result = await svc.listModels();

      expect(result).toHaveLength(1);
      expect(result[0]!.supportsEmbedding).toBe(false);
    });
  });

  describe('supportsResponsesApi', () => {
    it('returns false when no model info is found', async () => {
      const svc = createSvc(null);
      await expect(svc.supportsResponsesApi('unknown-model')).resolves.toBe(
        false,
      );
    });

    it('returns false when supports_response_schema is false', async () => {
      const svc = createSvc(
        buildModelInfo({
          litellm_provider: 'openai',
          supports_response_schema: false,
        }),
      );
      await expect(svc.supportsResponsesApi('gpt-4')).resolves.toBe(false);
    });

    it('returns true for openai provider with supports_response_schema', async () => {
      const svc = createSvc(
        buildModelInfo({
          litellm_provider: 'openai',
          supports_response_schema: true,
        }),
      );
      await expect(svc.supportsResponsesApi('gpt-4')).resolves.toBe(true);
    });

    it('returns true for azure provider with supports_response_schema', async () => {
      const svc = createSvc(
        buildModelInfo({
          litellm_provider: 'azure',
          supports_response_schema: true,
        }),
      );
      await expect(svc.supportsResponsesApi('azure/gpt-4')).resolves.toBe(true);
    });

    it('returns true for azure_ai provider with supports_response_schema', async () => {
      const svc = createSvc(
        buildModelInfo({
          litellm_provider: 'azure_ai',
          supports_response_schema: true,
        }),
      );
      await expect(svc.supportsResponsesApi('azure_ai/gpt-4')).resolves.toBe(
        true,
      );
    });

    it('returns false for gemini provider even with supports_response_schema', async () => {
      const svc = createSvc(
        buildModelInfo({
          litellm_provider: 'gemini',
          supports_response_schema: true,
        }),
      );
      await expect(svc.supportsResponsesApi('gemini/gemini-pro')).resolves.toBe(
        false,
      );
    });

    it('returns false for minimax provider even with supports_response_schema', async () => {
      const svc = createSvc(
        buildModelInfo({
          litellm_provider: 'minimax',
          supports_response_schema: true,
        }),
      );
      await expect(
        svc.supportsResponsesApi('minimax/minimax-m2.5'),
      ).resolves.toBe(false);
    });

    it('returns false for anthropic provider even with supports_response_schema', async () => {
      const svc = createSvc(
        buildModelInfo({
          litellm_provider: 'anthropic',
          supports_response_schema: true,
        }),
      );
      await expect(
        svc.supportsResponsesApi('anthropic/claude-3'),
      ).resolves.toBe(false);
    });

    it('returns false for unknown provider even with supports_response_schema', async () => {
      const svc = createSvc(
        buildModelInfo({
          litellm_provider: 'some_new_provider',
          supports_response_schema: true,
        }),
      );
      await expect(
        svc.supportsResponsesApi('some_new_provider/model'),
      ).resolves.toBe(false);
    });

    it('returns false when provider is missing from model_info', async () => {
      const svc = createSvc(
        buildModelInfo({
          supports_response_schema: true,
        }),
      );
      await expect(svc.supportsResponsesApi('gpt-4')).resolves.toBe(false);
    });
  });

  describe('supportsReasoning', () => {
    it('returns false when no model info is found', async () => {
      const svc = createSvc(null);
      await expect(svc.supportsReasoning('unknown-model')).resolves.toBe(false);
    });

    it('returns false when supports_reasoning is false', async () => {
      const svc = createSvc(buildModelInfo({ supports_reasoning: false }));
      await expect(svc.supportsReasoning('gpt-4')).resolves.toBe(false);
    });

    it('returns true when supports_reasoning is true', async () => {
      const svc = createSvc(buildModelInfo({ supports_reasoning: true }));
      await expect(svc.supportsReasoning('gpt-4')).resolves.toBe(true);
    });

    it('returns false when supports_reasoning is absent', async () => {
      const svc = createSvc(buildModelInfo());
      await expect(svc.supportsReasoning('gpt-4')).resolves.toBe(false);
    });
  });

  describe('sumTokenUsages', () => {
    it('sums multiple token usages', () => {
      const svc = createSvc();
      const result = svc.sumTokenUsages([
        {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          totalPrice: 0.001,
          currentContext: 10,
        },
        {
          inputTokens: 20,
          cachedInputTokens: 15,
          outputTokens: 10,
          totalTokens: 30,
          totalPrice: 0.002,
          currentContext: 20,
        },
      ]);

      expect(result).toEqual({
        inputTokens: 30,
        cachedInputTokens: 15,
        outputTokens: 15,
        totalTokens: 45,
        totalPrice: 0.003,
        currentContext: 20, // Max of all contexts
      });
    });

    it('ignores durationMs (per-message metadata, not aggregatable)', () => {
      const svc = createSvc();
      const result = svc.sumTokenUsages([
        {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          durationMs: 1500,
        },
        {
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
          durationMs: 2300,
        },
      ]);

      expect(result).not.toHaveProperty('durationMs');
      expect(result).toEqual({
        inputTokens: 30,
        outputTokens: 15,
        totalTokens: 45,
        totalPrice: 0,
      });
    });
  });
});
