import { beforeEach, describe, expect, it } from 'vitest';

import { FinishToolSchema } from '../../../../v1/agent-tools/tools/core/finish.tool';
import { MockLlmService } from './mock-llm.service';
import type { MockLlmRequest } from './mock-llm.types';
import { applyDefaults } from './mock-llm-defaults.utils';

// Helper: build a minimal chat request that satisfies MockLlmRequest
const buildChatRequest = (
  overrides: Partial<MockLlmRequest> = {},
): MockLlmRequest => ({
  kind: 'chat',
  model: 'gpt-4',
  messages: [],
  systemMessage: '',
  lastUserMessage: '',
  lastToolResult: null,
  boundTools: [],
  callIndex: 0,
  ...overrides,
});

// Helper: build a minimal embeddings request that satisfies MockLlmRequest
const buildEmbeddingsRequest = (input: string): MockLlmRequest => ({
  kind: 'embeddings',
  model: 'text-embedding-3-small',
  embeddingInput: input,
  callIndex: 0,
});

describe('mock-llm-defaults.utils / applyDefaults', () => {
  let svc: MockLlmService;

  beforeEach(() => {
    svc = new MockLlmService();
    applyDefaults(svc);
  });

  it('(a) embeddings are deterministic: two calls with the same input return the same vector', () => {
    const req1 = buildEmbeddingsRequest('foo');
    const req2 = buildEmbeddingsRequest('foo');

    const reply1 = svc.match(req1);
    const reply2 = svc.match(req2);

    expect(reply1.kind).toBe('embeddings');
    expect(reply2.kind).toBe('embeddings');

    if (reply1.kind === 'embeddings' && reply2.kind === 'embeddings') {
      const vec1 =
        typeof reply1.vector === 'function'
          ? reply1.vector('foo')
          : reply1.vector;
      const vec2 =
        typeof reply2.vector === 'function'
          ? reply2.vector('foo')
          : reply2.vector;

      expect(vec1).toEqual(vec2);
      expect(vec1).toHaveLength(1536);
    }
  });

  it('(b) embeddings vector has exactly 1536 dimensions', () => {
    const reply = svc.match(buildEmbeddingsRequest('some-input'));

    expect(reply.kind).toBe('embeddings');

    if (reply.kind === 'embeddings') {
      const vec =
        typeof reply.vector === 'function'
          ? reply.vector('some-input')
          : reply.vector;
      expect(vec).toHaveLength(1536);
    }
  });

  it('(c) finish fixture returns a valid toolCall with args that satisfy FinishToolSchema', () => {
    // Match the finish-tool fixture by providing 'finish' in boundTools
    const reply = svc.match(
      buildChatRequest({ boundTools: ['finish'], callIndex: 0 }),
    );

    expect(reply.kind).toBe('toolCall');

    if (reply.kind === 'toolCall') {
      expect(reply.toolName).toBe('finish');

      // The args must satisfy the Zod schema — regression test for Wave 1 bug fix
      const parsed = FinishToolSchema.safeParse(reply.args);
      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(typeof parsed.data.purpose).toBe('string');
        expect(parsed.data.purpose.length).toBeGreaterThan(0);
        expect(typeof parsed.data.message).toBe('string');
        expect(parsed.data.message.length).toBeGreaterThan(0);
      }
    }
  });
});
