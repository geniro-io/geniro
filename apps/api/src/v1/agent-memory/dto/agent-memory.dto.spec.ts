import { describe, expect, it } from 'vitest';

import { namespaceSchema, SaveEntryBodySchema } from './agent-memory.dto';

describe('namespaceSchema', () => {
  it('accepts a normal namespace', () => {
    expect(namespaceSchema.safeParse('conventions').success).toBe(true);
    expect(namespaceSchema.safeParse('facts.v2').success).toBe(true);
  });

  it('rejects the reserved "search" namespace (shadowed by GET /memory/search)', () => {
    // A `search` namespace would be unreachable via GET /memory/:namespace, so it
    // must be rejected at every write path that shares this schema.
    expect(namespaceSchema.safeParse('search').success).toBe(false);
  });

  it('rejects "search" case-insensitively', () => {
    // Reserved regardless of the router's case-sensitivity setting.
    expect(namespaceSchema.safeParse('Search').success).toBe(false);
    expect(namespaceSchema.safeParse('SEARCH').success).toBe(false);
  });

  it('still rejects namespaces that violate the character rule', () => {
    expect(namespaceSchema.safeParse('has space').success).toBe(false);
    expect(namespaceSchema.safeParse('_leading').success).toBe(false);
    expect(namespaceSchema.safeParse('').success).toBe(false);
  });
});

describe('SaveEntryBodySchema', () => {
  it('rejects a save whose namespace is the reserved "search" (write path is wired to namespaceSchema)', () => {
    // Proves the reserve actually reaches the user-facing write path, not just the
    // isolated schema — a future refactor swapping in a looser inline string would
    // fail this even if the namespaceSchema unit test stayed green.
    const result = SaveEntryBodySchema.safeParse({
      namespace: 'search',
      key: 'k',
      value: 'v',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a save with a normal namespace', () => {
    const result = SaveEntryBodySchema.safeParse({
      namespace: 'conventions',
      key: 'k',
      value: 'v',
    });
    expect(result.success).toBe(true);
  });
});
