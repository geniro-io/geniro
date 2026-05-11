/* eslint-disable @typescript-eslint/naming-convention -- internal counter needs leading underscore */
import { Injectable } from '@nestjs/common';

import type { RequestTokenUsage } from '../../../../v1/litellm/litellm.types';
import { MockLlmNoMatchError } from './mock-llm.errors';
import {
  MockLlmFixture,
  MockLlmMatcher,
  MockLlmReply,
  MockLlmRequest,
} from './mock-llm.types';

/**
 * In-memory mock for LLM calls in integration tests.
 *
 * ### Matcher resolution order
 * 1. **Queue** (`queueChat` / `queueCost`): entries are consumed FIFO and
 *    returned regardless of matcher configuration or request kind.
 * 2. **Registered fixtures** (`onChat` / `onJsonRequest` / `onEmbeddings`):
 *    evaluated in registration order. All fixtures that pass every defined
 *    field are candidates. The most-specific candidate wins (highest count of
 *    non-undefined matcher fields). Ties are broken by registration order
 *    (earlier registration wins).
 * 3. If no match is found a `MockLlmNoMatchError` is thrown with diagnostic
 *    context listing the request shape and all registered matchers.
 *
 * ### Call-index counter
 * Adapters/chat-model wrappers call `nextCallIndex()` exactly once per LLM
 * call to obtain a monotonically increasing 0-based index. They include that
 * value in the `MockLlmRequest` passed to `match()`. The counter advances with
 * every call to `nextCallIndex()`, across all request kinds.
 *
 * ### Request log
 * Every call to `match()` appends the request to the internal log before any
 * resolution attempt. This means failed matches (those that throw) are still
 * visible via `getRequests()` for post-mortem inspection.
 */

@Injectable()
export class MockLlmService {
  private chatFixtures: MockLlmFixture[] = [];
  private jsonFixtures: MockLlmFixture[] = [];
  private embeddingsFixtures: MockLlmFixture[] = [];
  private queue: MockLlmReply[] = [];
  private requestLog: MockLlmRequest[] = [];
  private _callIndex = 0;

  // ---------------------------------------------------------------------------
  // Public registration API
  // ---------------------------------------------------------------------------

  /** Register a fixture for `kind: 'chat'` requests. */
  public onChat(matcher: MockLlmMatcher, reply: MockLlmReply): void {
    this.chatFixtures.push({ matcher, reply });
  }

  /** Register a fixture for `kind: 'json'` (structured output) requests. */
  public onJsonRequest(matcher: MockLlmMatcher, reply: MockLlmReply): void {
    this.jsonFixtures.push({ matcher, reply });
  }

  /** Register a fixture for `kind: 'embeddings'` requests. */
  public onEmbeddings(matcher: MockLlmMatcher, reply: MockLlmReply): void {
    this.embeddingsFixtures.push({ matcher, reply });
  }

  /**
   * Push a reply directly onto the FIFO queue.
   * Queued entries are consumed before any registered fixture is consulted,
   * and the `req.kind` is ignored.
   */
  public queueChat(reply: MockLlmReply): void {
    this.queue.push(reply);
  }

  /**
   * Convenience sugar: push a text reply that carries a cost annotation.
   * Equivalent to:
   *   `queueChat({ kind: 'text', content: 'OK', usage: { totalPrice: usd, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 } })`
   */
  public queueCost(usd: number): void {
    const usage: Partial<RequestTokenUsage> = {
      totalPrice: usd,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
    };
    this.queueChat({ kind: 'text', content: 'OK', usage });
  }

  // ---------------------------------------------------------------------------
  // Call-index counter
  // ---------------------------------------------------------------------------

  /** Returns the current call index (0-based) and increments the counter. Call once per LLM invocation. */
  public nextCallIndex(): number {
    return this._callIndex++;
  }

  // ---------------------------------------------------------------------------
  // Request log access
  // ---------------------------------------------------------------------------

  /** Returns all recorded requests in call order (including failed matches). */
  public getRequests(): MockLlmRequest[] {
    return [...this.requestLog];
  }

  /** Returns the most recently recorded request, or `undefined` if none. */
  public getLastRequest(): MockLlmRequest | undefined {
    return this.requestLog.at(-1);
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  /**
   * Clear all fixtures, the queue, the request log, and reset the call-index
   * counter to 0. Call this in `beforeEach` / `afterEach` to isolate tests.
   */
  public reset(): void {
    this.chatFixtures = [];
    this.jsonFixtures = [];
    this.embeddingsFixtures = [];
    this.queue = [];
    this.requestLog = [];
    this._callIndex = 0;
  }

  // ---------------------------------------------------------------------------
  // Core resolver
  // ---------------------------------------------------------------------------

  /** Resolve a reply for the given request. See class-level comment for resolution order. */
  public match(request: MockLlmRequest): MockLlmReply {
    this.requestLog.push(request);

    // Queue is for chat replies (text/toolCall). JSON / embedding requests
    // can fire opportunistically (thread-name generation, summarisation,
    // embeddings) and shouldn't drain the queue meant to drive a chat agent.
    if (this.queue.length > 0 && request.kind === 'chat') {
      return this.queue.shift()!;
    }

    const fixtures = this.fixturesFor(request.kind);
    const candidates = fixtures.filter((f) =>
      this.fixtureMatches(f.matcher, request),
    );

    if (candidates.length === 0) {
      const allMatchers = [
        ...this.chatFixtures,
        ...this.jsonFixtures,
        ...this.embeddingsFixtures,
      ].map((f) => f.matcher);

      throw new MockLlmNoMatchError({
        request,
        registeredMatchers: allMatchers,
      });
    }

    // Sort descending by specificity (count of defined fields); stable sort
    // keeps registration order for ties.
    const best = candidates.reduce((winner, current) => {
      const winnerScore = this.specificity(winner.matcher);
      const currentScore = this.specificity(current.matcher);
      return currentScore > winnerScore ? current : winner;
    });

    return best.reply;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private fixturesFor(kind: MockLlmRequest['kind']): MockLlmFixture[] {
    const map: Record<MockLlmRequest['kind'], MockLlmFixture[]> = {
      chat: this.chatFixtures,
      json: this.jsonFixtures,
      embeddings: this.embeddingsFixtures,
    };
    return map[kind];
  }

  private specificity(matcher: MockLlmMatcher): number {
    let score = 0;
    for (const value of Object.values(matcher)) {
      if (value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        // Empty array contributes 0 (no real constraint); each element adds 1.
        score += value.length;
      } else {
        score += 1;
      }
    }
    return score;
  }

  private fixtureMatches(
    matcher: MockLlmMatcher,
    request: MockLlmRequest,
  ): boolean {
    if (matcher.model !== undefined) {
      if (!this.matchStringField(matcher.model, request.model)) {
        return false;
      }
    }

    if (matcher.lastUserMessage !== undefined) {
      if (
        !this.matchStringField(
          matcher.lastUserMessage,
          request.lastUserMessage,
          true,
        )
      ) {
        return false;
      }
    }

    if (matcher.systemMessage !== undefined) {
      if (
        !this.matchStringField(
          matcher.systemMessage,
          request.systemMessage,
          true,
        )
      ) {
        return false;
      }
    }

    if (matcher.hasTools !== undefined) {
      const bound = request.boundTools ?? [];
      if (matcher.hasTools.length === 0) {
        // hasTools:[] means "no tools bound" — only match when bound is also empty.
        if (bound.length !== 0) {
          return false;
        }
      } else {
        const allPresent = matcher.hasTools.every((name) =>
          bound.includes(name),
        );
        if (!allPresent) {
          return false;
        }
      }
    }

    if (matcher.hasToolResult !== undefined) {
      if (request.lastToolResult?.name !== matcher.hasToolResult) {
        return false;
      }
    }

    if (matcher.callIndex !== undefined) {
      if (request.callIndex !== matcher.callIndex) {
        return false;
      }
    }

    return true;
  }

  /**
   * Match a single string field.
   * - `string` pattern with `substring = true` → `request.includes(pattern)`
   * - `string` pattern with `substring = false` → strict equality
   * - `RegExp` → `.test(requestValue)`
   * Returns `false` if `requestValue` is undefined and the matcher is defined.
   */
  private matchStringField(
    pattern: string | RegExp,
    requestValue: string | undefined,
    substring = false,
  ): boolean {
    if (requestValue === undefined) {
      return false;
    }
    if (pattern instanceof RegExp) {
      return pattern.test(requestValue);
    }
    return substring
      ? requestValue.includes(pattern)
      : requestValue === pattern;
  }
}
