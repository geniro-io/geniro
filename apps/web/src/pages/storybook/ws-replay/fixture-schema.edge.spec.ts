// Adversarial edge-case tests for fixture-schema.ts — authored by the F->P loop.
// These tests target real validation gaps; they MUST fail on current code.
//
// F->P invariant: each test was verified to fail 3x on today's code.

import { describe, expect, it } from 'vitest';

import { parseFixture } from './fixture-schema';

// ---------------------------------------------------------------------------
// Shared minimal valid fixture used as a base for mutations
// ---------------------------------------------------------------------------

const minimalValidEvent = {
  type: 'agent.message',
  internalThreadId: 'thread-1',
  threadId: 'thread-1',
  nodeId: 'supervisor',
  graphId: 'graph-1',
  data: {
    id: 'msg-1',
    threadId: 'thread-1',
    createdAt: '2026-04-24T00:00:00Z',
    nodeId: 'supervisor',
    message: { role: 'ai', content: 'hello' },
    requestTokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      totalPrice: 0.001,
    },
  },
};

const wrapInFixture = (event: unknown) => ({
  name: 'edge',
  description: 'adversarial',
  threadId: 'thread-1',
  graphId: 'graph-1',
  events: [{ delayMs: 0, event }],
});

// ---------------------------------------------------------------------------
// H4-schema: requestTokenUsage.totalPrice as a string passes parseFixture
//            but silently causes $0 cost display (addPriceField skips non-numbers).
//
// Root cause: AgentMessageEventSchema declares requestTokenUsage as
// z.record(z.string(), z.unknown()). The z.unknown() value type means Zod
// accepts any value — including a string '0.01'. The schema should use
// z.record(z.string(), z.number()) or an explicit z.object({...}) with typed
// numeric fields so that type-confused fixtures fail loudly at load time
// rather than silently producing $0 in the cost display.
//
// Impact: a fixture recorded with serialized cost as a string (e.g. from a
// JSON serializer that emits "0.01" for a Decimal field) loads successfully,
// plays back, and produces $0 display in the storybook — making it useless
// for reproducing cost-display regressions.
//
// Fix direction: replace z.record(z.string(), z.unknown()) with an explicit
// schema that validates numeric fields, or add a .superRefine() that verifies
// totalPrice is a finite number when present.
// ---------------------------------------------------------------------------
it('parseFixture rejects agent.message event with requestTokenUsage.totalPrice as string', () => {
  const fixture = wrapInFixture({
    ...minimalValidEvent,
    data: {
      ...minimalValidEvent.data,
      requestTokenUsage: {
        ...minimalValidEvent.data.requestTokenUsage,
        totalPrice: '0.001', // string instead of number — schema-invalid
      },
    },
  });

  // Expected: parseFixture throws because totalPrice must be a number.
  // Actual (current bug): parseFixture succeeds — z.record(z.string(), z.unknown())
  // accepts any value including strings.
  expect(() => parseFixture(fixture, 'string-price.json')).toThrow();
});

// ---------------------------------------------------------------------------
// H4-schema-b: requestTokenUsage with totalPrice = Infinity passes parseFixture
//              but produces a non-finite price in the cost display.
//
// z.record(z.string(), z.unknown()) accepts Infinity as a value.
// addPriceField guards with Number.isFinite() so Infinity is skipped — but
// the fixture loads without error. A fixture that accidentally has Infinity
// in a price field should fail validation rather than silently zero out.
//
// Fix direction: validate that totalPrice, when present, is a finite number
// via z.number().finite() in an explicit requestTokenUsage schema.
// ---------------------------------------------------------------------------
it('parseFixture rejects agent.message event with requestTokenUsage.totalPrice = Infinity', () => {
  const fixture = wrapInFixture({
    ...minimalValidEvent,
    data: {
      ...minimalValidEvent.data,
      requestTokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        totalPrice: Infinity, // non-finite — should fail schema
      },
    },
  });

  // Expected: parseFixture throws.
  // Actual (current bug): parseFixture succeeds — z.unknown() accepts Infinity.
  expect(() => parseFixture(fixture, 'infinity-price.json')).toThrow();
});
