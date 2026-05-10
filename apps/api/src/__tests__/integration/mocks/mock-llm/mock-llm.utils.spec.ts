import { describe, expect, it } from 'vitest';

import { padOrTruncate, splitIntoChunks } from './mock-llm.utils';

describe('mock-llm.utils / padOrTruncate', () => {
  it('(adv-pad-1) negative dimensions silently returns wrong-length vector instead of zero elements', () => {
    // Bug: padOrTruncate(vec, -1) takes the truncation branch (vec.length > -1 is always true),
    // then returns vec.slice(0, -1) which is NOT "return the first -1 elements" — it removes
    // the last element. A 3-element input yields [1, 2] (length 2), violating the postcondition
    // that the output length equals `dimensions`.
    // Expected (correct contract): return [] (0 elements) or throw for dimensions < 0.
    // The concrete bug: result.length is 2, not Math.max(0, -1) === 0.
    const vec = [1, 2, 3];
    const result = padOrTruncate(vec, -1);
    // The contract says result must have exactly `dimensions` elements.
    // For dimensions=-1 the only safe outputs are [] (clamped to 0) or a thrown error.
    // Currently returns [1, 2] — length 2, which is neither.
    // We assert length 0 (the correct clamped-to-zero behavior) to pin the bug.
    expect(result).toHaveLength(0);
  });
});

describe('mock-llm.utils / splitIntoChunks', () => {
  it('(adv-split-1) zero count returns one chunk instead of zero chunks', () => {
    // Bug: splitIntoChunks('hello', 0) computes chunkSize = Math.ceil(5 / 0) = Infinity.
    // The for-loop runs exactly once: i=0 < 5 → push text.slice(0, Infinity)='hello'; i += Infinity.
    // The loop exits and returns ['hello'] — one chunk, despite count=0 meaning "no chunks".
    // The contract says "split into up to `count` approximately equal chunks".
    // Returning 1 chunk when count=0 violates that contract.
    // Expected (correct): [] — zero chunks for count=0.
    const result = splitIntoChunks('hello', 0);
    // Currently returns ['hello'] — length 1, not 0.
    expect(result).toHaveLength(0);
  });
});
