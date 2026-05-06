import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LitellmService } from '../litellm/services/litellm.service';
import { OpenaiService } from './openai.service';

// ---------------------------------------------------------------------------
// Adversarial edge-case tests for extractProviderCost — F→P loop authored.
//
// These tests MUST fail on current code (extractProviderCost does not guard
// against non-finite numbers). A correct fix would add Number.isFinite()
// before forwarding cost to extractTokenUsageFromResponse.
// ---------------------------------------------------------------------------

describe('OpenaiService — extractProviderCost non-finite values', () => {
  let service: OpenaiService;
  let litellmService: {
    extractTokenUsageFromResponse: ReturnType<typeof vi.fn>;
    supportsResponsesApi: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    litellmService = {
      extractTokenUsageFromResponse: vi.fn().mockResolvedValue(undefined),
      supportsResponsesApi: vi.fn().mockResolvedValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenaiService,
        { provide: LitellmService, useValue: litellmService },
      ],
    }).compile();

    service = module.get<OpenaiService>(OpenaiService);
  });

  // -------------------------------------------------------------------------
  // H-A1: usage.cost = Infinity in complete() response
  //
  // `typeof Infinity === 'number'` is true, so extractProviderCost returns
  // Infinity unchecked. The payload { cost: Infinity } is then forwarded to
  // extractTokenUsageFromResponse.
  //
  // In litellm.service.ts, extractTokenUsageFromResponse reads providerCost
  // as `typeof usageMetadata?.cost === 'number' ? usageMetadata.cost : null`
  // → Infinity, and assigns totalPrice = Infinity. This poisons the
  // accumulated state.totalPrice permanently: any subsequent arithmetic
  // `prev.totalPrice + change.totalPrice` = Infinity + anything = Infinity,
  // causing cost-limit enforcement to always fire for the rest of the session.
  //
  // Fix direction: in extractProviderCost, change the guard to
  // `Number.isFinite(raw?.cost)` before returning it.
  // -------------------------------------------------------------------------
  it('complete() does NOT forward Infinity as cost to extractTokenUsageFromResponse', async () => {
    vi.spyOn(service['client'].chat.completions, 'create').mockResolvedValue({
      id: 'chat-inf',
      choices: [{ message: { content: 'hello' } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        // LiteLLM theoretically could return Infinity if it has a pricing bug
        cost: Infinity,
      },
    } as never);

    await service.complete({ model: 'gpt-4o', message: 'test' });

    const callArgs = litellmService.extractTokenUsageFromResponse.mock.calls[0];
    if (!callArgs) {
      // extractTokenUsageFromResponse was not called at all — cost was skipped
      // entirely, which is also acceptable. Test passes (no forwarding happened).
      return;
    }
    const payload = callArgs[1] as Record<string, unknown>;

    // CURRENT BEHAVIOR (bug): payload.cost === Infinity because extractProviderCost
    // returns typeof-number Infinity without a Number.isFinite() guard.
    // The test asserts the fixed behavior: non-finite costs must NOT be forwarded.
    expect(
      payload.cost === undefined || Number.isFinite(payload.cost as number),
      `expected cost to be undefined or finite, got: ${String(payload.cost)}`,
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // H-A2: usage.cost = NaN in embeddings() response
  //
  // Same root cause as H-A1: `typeof NaN === 'number'` is true. extractProviderCost
  // returns NaN. The payload { cost: NaN } flows to extractTokenUsageFromResponse.
  //
  // In litellm.service, NaN propagates as totalPrice = NaN ?? 0 → NaN
  // (because `NaN ?? 0` is NaN — nullish coalescing only catches null/undefined,
  // not NaN). Any arithmetic involving NaN produces NaN, permanently corrupting
  // the totalPrice accumulator: NaN + 0.01 = NaN.
  //
  // Fix direction: same as H-A1 — guard with Number.isFinite().
  // -------------------------------------------------------------------------
  it('embeddings() does NOT forward NaN as cost to extractTokenUsageFromResponse', async () => {
    vi.spyOn(service['client'].embeddings, 'create').mockResolvedValue({
      object: 'list',
      model: 'text-embedding-3-small',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
      usage: {
        prompt_tokens: 10,
        total_tokens: 10,
        cost: NaN,
      },
    } as never);

    await service.embeddings({
      model: 'text-embedding-3-small',
      input: 'test',
    });

    const callArgs = litellmService.extractTokenUsageFromResponse.mock.calls[0];
    if (!callArgs) {
      return;
    }
    const payload = callArgs[1] as Record<string, unknown>;

    // CURRENT BEHAVIOR (bug): payload.cost === NaN because extractProviderCost
    // returns NaN without a finite-number guard.
    // Fixed behavior: NaN must not be forwarded.
    expect(
      payload.cost === undefined || Number.isFinite(payload.cost as number),
      `expected cost to be undefined or finite, got: ${String(payload.cost)}`,
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // H-A3: usage.cost = -Infinity in response() API path
  //
  // Negative Infinity is also typeof 'number'. extractProviderCost returns it.
  // In the accumulator: prev.totalPrice + (-Infinity) = -Infinity. Cost limit
  // enforcement becomes `(-Infinity >= effectiveLimit)` = always false, meaning
  // the limit is silently NEVER enforced after one negative-Infinity call.
  //
  // Fix direction: Number.isFinite() check in extractProviderCost.
  // -------------------------------------------------------------------------
  it('response() does NOT forward -Infinity as cost to extractTokenUsageFromResponse', async () => {
    vi.spyOn(service['client'].responses, 'create').mockResolvedValue({
      id: 'resp-neg-inf',
      output_text: 'hello',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cost: -Infinity,
      },
    } as never);

    await service.response({ model: 'o3', message: 'test' });

    const callArgs = litellmService.extractTokenUsageFromResponse.mock.calls[0];
    if (!callArgs) {
      return;
    }
    const payload = callArgs[1] as Record<string, unknown>;

    // CURRENT BEHAVIOR (bug): payload.cost === -Infinity.
    // Fixed behavior: negative Infinity must not be forwarded.
    expect(
      payload.cost === undefined || Number.isFinite(payload.cost as number),
      `expected cost to be undefined or finite, got: ${String(payload.cost)}`,
    ).toBe(true);
  });
});
