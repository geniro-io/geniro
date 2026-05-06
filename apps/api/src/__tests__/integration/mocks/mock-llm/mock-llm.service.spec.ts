import { beforeEach, describe, expect, it } from 'vitest';

import { MockLlmNoMatchError } from './mock-llm.errors';
import { MockLlmService } from './mock-llm.service';
import type { MockLlmRequest } from './mock-llm.types';
import { applyDefaults } from './mock-llm-defaults.utils';

const buildRequest = (
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

describe('MockLlmService', () => {
  let svc: MockLlmService;

  beforeEach(() => {
    svc = new MockLlmService();
  });

  it('(a) onChat with specific matcher returns its reply', () => {
    svc.onChat(
      { lastUserMessage: 'hello' },
      { kind: 'text', content: 'world' },
    );
    const reply = svc.match(buildRequest({ lastUserMessage: 'hello' }));
    expect(reply).toEqual({ kind: 'text', content: 'world' });
  });

  it('(b) most-specific matcher wins among overlapping fixtures', () => {
    // Register general first — without specificity-based resolution, registration
    // order alone would cause the general matcher to win. Registering specific
    // second proves that higher specificity overrides registration order.
    svc.onChat({}, { kind: 'text', content: 'general' });
    svc.onChat({ hasTools: ['shell'] }, { kind: 'text', content: 'specific' });
    const reply = svc.match(buildRequest({ boundTools: ['shell'] }));
    expect(reply).toMatchObject({ content: 'specific' });
  });

  it('(c) FIFO queueChat entries are consumed before fixtures', () => {
    svc.onChat({}, { kind: 'text', content: 'fixture' });
    svc.queueChat({ kind: 'text', content: 'queued' });

    // First call drains the queue entry.
    expect(svc.match(buildRequest({ callIndex: 0 }))).toMatchObject({
      content: 'queued',
    });

    // Queue is now empty — second call falls through to the registered fixture.
    expect(svc.match(buildRequest({ callIndex: 1 }))).toMatchObject({
      content: 'fixture',
    });
  });

  it('(d) queueCost(0.6) yields a text reply with totalPrice === 0.6', () => {
    svc.queueCost(0.6);
    const reply = svc.match(buildRequest());
    expect(reply.kind).toBe('text');
    if (reply.kind === 'text') {
      expect(reply.usage?.totalPrice).toBe(0.6);
    }
  });

  it('(e) getRequests returns recorded requests in call order', () => {
    svc.onChat({}, { kind: 'text', content: 'OK' });
    svc.match(buildRequest({ lastUserMessage: 'first', callIndex: 0 }));
    svc.match(buildRequest({ lastUserMessage: 'second', callIndex: 1 }));

    const reqs = svc.getRequests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.lastUserMessage).toBe('first');
    expect(reqs[1]!.lastUserMessage).toBe('second');
  });

  it('(f) reset clears fixtures, queue, and request log', () => {
    svc.onChat({}, { kind: 'text', content: 'OK' });
    svc.queueChat({ kind: 'text', content: 'queued' });
    svc.match(buildRequest({ callIndex: 0 }));
    expect(svc.getRequests()).toHaveLength(1);

    svc.reset();

    expect(svc.getRequests()).toHaveLength(0);
    // No fixtures and no queue after reset — match must throw.
    expect(() => svc.match(buildRequest({ callIndex: 0 }))).toThrow(
      MockLlmNoMatchError,
    );
  });

  it('(g) no match throws MockLlmNoMatchError with diagnostic context', () => {
    expect.assertions(3);
    try {
      svc.match(
        buildRequest({ lastUserMessage: 'unmatched', boundTools: ['shell'] }),
      );
    } catch (err) {
      expect(err).toBeInstanceOf(MockLlmNoMatchError);
      expect((err as Error).message).toContain('unmatched');
      expect((err as Error).message).toContain('shell');
    }
  });

  it('(h) applyDefaults does not override a previously-registered specific fixture', () => {
    // Register the specific fixture first, then let applyDefaults add its catch-alls.
    svc.onChat(
      { lastUserMessage: 'specific' },
      { kind: 'text', content: 'won' },
    );
    applyDefaults(svc);

    const reply = svc.match(buildRequest({ lastUserMessage: 'specific' }));
    expect(reply).toMatchObject({ content: 'won' });
  });

  // ---------------------------------------------------------------------------
  // Adversarial edge-case regression tests.
  // These document specificity bugs that were fixed in Stage D (see PR #31).
  // Each test asserts the post-fix behavior; the comments describe the original
  // bug and the fix that resolved it.
  // ---------------------------------------------------------------------------

  it('(adv-1) hasTools:[] scores 0 specificity and loses to a catch-all {} when both match', () => {
    // Original bug: specificity() counted every Object.values entry that was not
    // undefined. An empty array [] is not undefined, so hasTools:[] scored 1 —
    // incorrectly beating a plain {} catch-all (score 0).
    //
    // Fix (Stage D): specificity() now uses `score += value.length` for arrays,
    // so hasTools:[] contributes 0 to the score, matching the semantics of "no
    // tool constraint". Registration order then decides between two score-0
    // matchers, and the first-registered catch-all {} wins.
    svc.onChat({}, { kind: 'text', content: 'catch-all' });
    svc.onChat({ hasTools: [] }, { kind: 'text', content: 'empty-tools' });

    // Both matchers score 0. The catch-all was registered first, so it wins.
    const replyWithTools = svc.match(
      buildRequest({ boundTools: ['shell', 'finish'] }),
    );
    expect(replyWithTools).toMatchObject({ content: 'catch-all' });
  });

  it('(adv-2) hasTools:[a,b] scores 2 and beats hasTools:[a] (score 1) when both match a request', () => {
    // Original bug: specificity() treated the entire hasTools array as one
    // Object.values entry worth 1, so hasTools:['shell'] and
    // hasTools:['shell','finish'] both scored 1. Registration order decided the
    // tie, causing the less-constraining first-registered fixture to win.
    //
    // Fix (Stage D): specificity() now uses `score += value.length` for arrays,
    // so each tool name adds 1 to the score. hasTools:['shell'] scores 1 and
    // hasTools:['shell','finish'] scores 2 — the stricter fixture wins.
    svc.onChat({ hasTools: ['shell'] }, { kind: 'text', content: 'one-tool' });
    svc.onChat(
      { hasTools: ['shell', 'finish'] },
      { kind: 'text', content: 'two-tools' },
    );

    // Request carries both tools. The two-tool fixture (score 2) outranks the
    // one-tool fixture (score 1) and wins regardless of registration order.
    const reply = svc.match(buildRequest({ boundTools: ['shell', 'finish'] }));
    expect(reply).toMatchObject({ content: 'two-tools' });
  });

  it('(adv-3) hasTools:[] only matches requests where boundTools is also empty', () => {
    // Original bug: hasTools:[] was evaluated as [].every(...) which is
    // vacuously true for any request, including those with non-empty boundTools.
    // Combined with its old specificity of 1, it silently intercepted tool-call
    // requests that should have been handled by a specific-tool fixture.
    //
    // Fix (Stage D): fixtureMatches() now treats hasTools:[] as "bound tools
    // must be empty" — it returns false when bound.length !== 0. This makes
    // hasTools:[] an explicit "no-tool" constraint rather than a wildcard.
    svc.onChat(
      { hasTools: ['shell'] },
      { kind: 'text', content: 'shell-fixture' },
    );
    svc.onChat(
      { hasTools: [] },
      { kind: 'text', content: 'no-tools-intended' },
    );
    svc.onChat({}, { kind: 'text', content: 'catch-all' });

    // Request with ['shell']: hasTools:['shell'] matches (score 1). hasTools:[]
    // does NOT match because bound is non-empty. Catch-all {} (score 0) loses.
    const replyWithShell = svc.match(buildRequest({ boundTools: ['shell'] }));
    expect(replyWithShell).toMatchObject({ content: 'shell-fixture' });

    // Request with ['finish']: hasTools:['shell'] does NOT match (shell absent).
    // hasTools:[] does NOT match (bound is non-empty). Only catch-all {} matches.
    const replyWithFinish = svc.match(buildRequest({ boundTools: ['finish'] }));
    expect(replyWithFinish).toMatchObject({ content: 'catch-all' });
  });
});
