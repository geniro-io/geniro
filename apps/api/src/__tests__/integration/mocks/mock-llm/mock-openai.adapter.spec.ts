import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { LitellmService } from '../../../../v1/litellm/services/litellm.service';
import { MockLlmService } from './mock-llm.service';
import { MockOpenaiAdapter } from './mock-openai.adapter';

describe('MockOpenaiAdapter', () => {
  let mockLlm: MockLlmService;
  let litellm: LitellmService;
  let adapter: MockOpenaiAdapter;
  let extractSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLlm = new MockLlmService();

    // Stub only the methods the adapter actually touches.
    // extractTokenUsageFromResponse is spied on to prove it is NEVER called
    // (offline pricing guarantee — adapter reads reply.usage.totalPrice directly).
    litellm = {
      extractTokenUsageFromResponse: vi.fn(),
    } as unknown as LitellmService;

    extractSpy = vi.mocked(litellm.extractTokenUsageFromResponse);

    adapter = new MockOpenaiAdapter(mockLlm, litellm);
  });

  it('(a) complete text path returns { content, conversationId, usage } with totalPrice', async () => {
    mockLlm.queueChat({
      kind: 'text',
      content: 'reply',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        totalPrice: 0.05,
      },
    });

    // CompleteData shape: { model, message, systemMessage?, reasoning? }
    const result = await adapter.complete({
      model: 'gpt-4',
      message: 'hi',
    });

    expect(result.content).toBe('reply');
    expect(result.conversationId).toBeTruthy();
    expect(result.usage?.totalPrice).toBe(0.05);
  });

  it('(b) embeddings returns deterministic vectors of correct dimension', async () => {
    mockLlm.onEmbeddings({}, { kind: 'embeddings', vector: [0.1, 0.2, 0.3] });

    // EmbeddingsInput shape: { model, input, dimensions? }
    const result = await adapter.embeddings({
      model: 'text-embedding-3-small',
      input: 'test',
    });

    expect(result.embeddings).toHaveLength(1);
    // Adapter pads/truncates to environment.llmEmbeddingDimensions (default 1536)
    expect(result.embeddings[0]).toHaveLength(1536);
    // The first three values come from the fixture; the rest are zero-padded
    expect(result.embeddings[0]?.slice(0, 3)).toEqual([0.1, 0.2, 0.3]);
  });

  it('(c) jsonRequest returns typed content', async () => {
    mockLlm.onJsonRequest(
      {},
      { kind: 'json', content: { key: 'value', n: 42 } },
    );

    interface Shape {
      key: string;
      n: number;
    }

    // JsonRequestData = Omit<ResponseJsonData, 'json'> & { maxOutputTokens? }
    // ResponseJsonData = BaseData & JsonEnabled, so requires: model, message, jsonSchema
    const result = await adapter.jsonRequest<Shape>({
      model: 'gpt-4',
      message: 'extract',
      jsonSchema: z.object({ key: z.string(), n: z.number() }),
    });

    expect(result.content).toEqual({ key: 'value', n: 42 });
    expect(result.conversationId).toBeTruthy();
  });

  it('(c) response() happy path returns { content, conversationId, usage } with totalPrice', async () => {
    mockLlm.queueChat({
      kind: 'text',
      content: 'response output',
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        totalPrice: 0.2,
      },
    });

    const result = await adapter.response({
      model: 'gpt-4o',
      message: 'hello',
    });

    expect(result.content).toBe('response output');
    expect(result.conversationId).toBeTruthy();
    expect(result.usage?.totalPrice).toBe(0.2);
    expect(result.usage?.inputTokens).toBe(1);
    expect(result.usage?.outputTokens).toBe(2);
    expect(result.usage?.totalTokens).toBe(3);
  });

  it('(d) totalPrice delivered offline — extractTokenUsageFromResponse never called', async () => {
    mockLlm.queueCost(0.6);

    const result = await adapter.complete({
      model: 'gpt-4',
      message: 'hi',
    });

    expect(result.usage?.totalPrice).toBe(0.6);
    // Offline guarantee: adapter reads totalPrice directly from reply.usage.totalPrice
    // and never delegates to LitellmService.extractTokenUsageFromResponse
    expect(extractSpy).not.toHaveBeenCalled();
  });

  it('(e) multi-input embeddings: array input yields one padded vector per element', async () => {
    mockLlm.onEmbeddings({}, { kind: 'embeddings', vector: [0.1, 0.2, 0.3] });

    const result = await adapter.embeddings({
      model: 'text-embedding-3-small',
      input: ['a', 'b', 'c'],
    });

    // One embedding per input string
    expect(result.embeddings).toHaveLength(3);

    // Each embedding is padded to 1536 dimensions
    for (const vec of result.embeddings) {
      expect(vec).toHaveLength(1536);
      // The fixture values appear at the start; the rest are zero-padded
      expect(vec.slice(0, 3)).toEqual([0.1, 0.2, 0.3]);
    }
  });
});
