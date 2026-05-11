import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { LitellmService } from '../../../../v1/litellm/services/litellm.service';
import { MockLlmNoMatchError } from './mock-llm.errors';
import { MockLlmService } from './mock-llm.service';
import { MockOpenaiAdapter } from './mock-openai.adapter';

/**
 * Integration test for the strict no-match policy.
 *
 * Verifies that `MockOpenaiAdapter` (the DI-level drop-in for `OpenaiService`)
 * propagates `MockLlmNoMatchError` when no fixture covers the incoming request.
 * This ensures the policy stays wired up across refactors of the adapter or the
 * underlying `MockLlmService.match()` resolver.
 *
 * The test constructs the adapter directly (no NestJS app needed) — the same
 * instantiation pattern used by `mock-openai.adapter.spec.ts` — because the
 * no-match behaviour is entirely internal to `MockLlmService.match()` and
 * `MockOpenaiAdapter`, independent of the DI graph.
 */

describe('MockLlmService — strict no-match policy', () => {
  let mockLlm: MockLlmService;
  let adapter: MockOpenaiAdapter;

  beforeEach(() => {
    mockLlm = new MockLlmService();

    // Stub LitellmService — the adapter must never call it when no fixture is
    // registered (match() throws before any usage-extraction happens).
    const litellm = {
      extractTokenUsageFromResponse: vi.fn(),
    } as unknown as LitellmService;

    adapter = new MockOpenaiAdapter(mockLlm, litellm);
  });

  it('throws MockLlmNoMatchError when no chat fixture is registered', async () => {
    await expect(
      adapter.complete({
        model: 'gpt-4o',
        message: 'hello-no-match-prompt',
      }),
    ).rejects.toThrow(MockLlmNoMatchError);
  });

  it('error message contains the last user message content', async () => {
    let thrown: unknown;
    try {
      await adapter.complete({
        model: 'gpt-4o',
        message: 'hello-no-match-prompt',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MockLlmNoMatchError);
    const error = thrown as MockLlmNoMatchError;
    expect(error.message).toContain('hello-no-match-prompt');
  });

  it('error message contains the callIndex field', async () => {
    let thrown: unknown;
    try {
      await adapter.complete({
        model: 'gpt-4o',
        message: 'hello-no-match-prompt',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MockLlmNoMatchError);
    const error = thrown as MockLlmNoMatchError;
    expect(error.message).toContain('callIndex');
  });

  it('error message contains the callIndex value (0 for first call)', async () => {
    let thrown: unknown;
    try {
      await adapter.complete({
        model: 'gpt-4o',
        message: 'hello-no-match-prompt',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MockLlmNoMatchError);
    const error = thrown as MockLlmNoMatchError;
    // The first call index is 0 — confirm the value appears in the message.
    expect(error.message).toContain('0');
  });

  it('error.request records the exact prompt and callIndex', async () => {
    let thrown: unknown;
    try {
      await adapter.complete({
        model: 'gpt-4o',
        message: 'hello-no-match-prompt',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MockLlmNoMatchError);
    const error = thrown as MockLlmNoMatchError;
    expect(error.request.lastUserMessage).toBe('hello-no-match-prompt');
    expect(error.request.callIndex).toBe(0);
    expect(error.request.kind).toBe('chat');
  });

  it('error.registeredMatchers is empty when no fixtures were registered', async () => {
    let thrown: unknown;
    try {
      await adapter.complete({
        model: 'gpt-4o',
        message: 'hello-no-match-prompt',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MockLlmNoMatchError);
    const error = thrown as MockLlmNoMatchError;
    expect(error.registeredMatchers).toHaveLength(0);
  });

  it('throws MockLlmNoMatchError for jsonRequest when no json fixture is registered', async () => {
    await expect(
      adapter.jsonRequest({
        model: 'gpt-4o',
        message: 'hello-no-match-json-prompt',
        jsonSchema: z.object({ answer: z.string() }),
      }),
    ).rejects.toThrow(MockLlmNoMatchError);
  });

  it('json error message contains the prompt', async () => {
    let thrown: unknown;
    try {
      await adapter.jsonRequest({
        model: 'gpt-4o',
        message: 'hello-no-match-json-prompt',
        jsonSchema: z.object({ answer: z.string() }),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MockLlmNoMatchError);
    const error = thrown as MockLlmNoMatchError;
    expect(error.message).toContain('hello-no-match-json-prompt');
  });

  it('error message lists bound tool names when tools are recorded', async () => {
    // Register a chat fixture but bound tools are not matched — so the
    // fixture will NOT match the request (fixtures registered via onChat
    // only match kind:'chat', but the adapter records boundTools based on
    // request context). Here we directly call mockLlm.match() to verify the
    // error embeds the bound tool names.
    let thrown: unknown;
    try {
      mockLlm.match({
        kind: 'chat',
        model: 'gpt-4o',
        lastUserMessage: 'hello-bound-tools-prompt',
        callIndex: mockLlm.nextCallIndex(),
        boundTools: ['web_search', 'shell'],
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MockLlmNoMatchError);
    const error = thrown as MockLlmNoMatchError;
    expect(error.message).toContain('web_search');
    expect(error.message).toContain('shell');
  });

  it('callIndex increments monotonically across multiple failing calls', async () => {
    const errors: MockLlmNoMatchError[] = [];

    for (let i = 0; i < 3; i++) {
      try {
        await adapter.complete({
          model: 'gpt-4o',
          message: `prompt-${i}`,
        });
      } catch (err) {
        errors.push(err as MockLlmNoMatchError);
      }
    }

    expect(errors).toHaveLength(3);
    // callIndex must be 0, 1, 2 in order.
    expect(errors[0]!.request.callIndex).toBe(0);
    expect(errors[1]!.request.callIndex).toBe(1);
    expect(errors[2]!.request.callIndex).toBe(2);
  });

  it('reset() clears call state so callIndex restarts from 0', async () => {
    // Exhaust one call.
    try {
      await adapter.complete({ model: 'gpt-4o', message: 'before-reset' });
    } catch {
      // expected
    }

    mockLlm.reset();

    let thrown: unknown;
    try {
      await adapter.complete({ model: 'gpt-4o', message: 'after-reset' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MockLlmNoMatchError);
    const error = thrown as MockLlmNoMatchError;
    expect(error.request.callIndex).toBe(0);
  });

  it('getRequests() records the request even when no fixture matches', async () => {
    try {
      await adapter.complete({
        model: 'gpt-4o',
        message: 'recorded-even-on-error',
      });
    } catch {
      // expected
    }

    const requests = mockLlm.getRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.lastUserMessage).toBe('recorded-even-on-error');
  });
});
