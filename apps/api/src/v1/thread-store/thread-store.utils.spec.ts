import { describe, expect, it } from 'vitest';

import { toPostgresArrayLiteral } from './thread-store.utils';

describe('toPostgresArrayLiteral', () => {
  it('returns null for null or undefined input', () => {
    expect(toPostgresArrayLiteral(null)).toBeNull();
    expect(toPostgresArrayLiteral(undefined)).toBeNull();
  });

  it('produces an empty array literal for an empty input array', () => {
    expect(toPostgresArrayLiteral([])).toBe('{}');
  });

  it('preserves a single empty-string element as a quoted empty element', () => {
    // PostgreSQL distinguishes the empty array literal `{}` (zero elements)
    // from a one-element array containing an empty string `{""}`. The current
    // implementation does not quote `""` because its needsQuoting regex
    // `/[,{}\\"'\s]/` does not match the empty string, so a `['']` input is
    // serialized as `{}` (an EMPTY array). After the DAO upsert this silently
    // collapses one tag into zero tags — a data-loss path for callers that
    // pass through an empty-string tag (e.g. trimmed user input upstream of
    // the agent-tool Zod guards, or any caller using the lower-level service
    // path where the per-element `.min(1)` constraint is not enforced).
    expect(toPostgresArrayLiteral([''])).toBe('{""}');
  });

  it('does not lose an empty-string element when other non-empty elements are present', () => {
    // Same root cause as above, observable as a length regression: a 3-element
    // input becomes a 2-element PostgreSQL array.
    const literal = toPostgresArrayLiteral(['a', '', 'b']);
    expect(literal).toBe('{a,"",b}');
  });
});
