import { describe, expect, it } from 'vitest';

import { validateOperationIdUniqueness } from './setup';

describe('validateOperationIdUniqueness', () => {
  it('passes for an empty paths object', () => {
    expect(() => validateOperationIdUniqueness({ paths: {} })).not.toThrow();
  });

  it('passes when paths is undefined', () => {
    expect(() => validateOperationIdUniqueness({})).not.toThrow();
  });

  it('passes when all operationIds are unique across paths and verbs', () => {
    expect(() =>
      validateOperationIdUniqueness({
        paths: {
          '/things': {
            get: { operationId: 'listThings' },
            post: { operationId: 'createThing' },
          },
          '/things/{id}': {
            get: { operationId: 'getThingById' },
            put: { operationId: 'updateThing' },
            delete: { operationId: 'deleteThing' },
          },
        },
      }),
    ).not.toThrow();
  });

  it('throws when two GET handlers on different paths share the same operationId', () => {
    expect(() =>
      validateOperationIdUniqueness({
        paths: {
          '/widgets': {
            get: { operationId: 'getAll' },
          },
          '/gadgets': {
            get: { operationId: 'getAll' },
          },
        },
      }),
    ).toThrow(/Duplicate operationIds detected/);
  });

  it('includes both conflicting refs in the error message', () => {
    let caught: Error | undefined;
    try {
      validateOperationIdUniqueness({
        paths: {
          '/widgets': {
            get: { operationId: 'getAll' },
          },
          '/gadgets': {
            get: { operationId: 'getAll' },
          },
        },
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toContain('GET /widgets');
    expect(caught?.message).toContain('GET /gadgets');
    expect(caught?.message).toContain('"getAll"');
  });

  it('throws and lists all three refs for a three-way collision', () => {
    let caught: Error | undefined;
    try {
      validateOperationIdUniqueness({
        paths: {
          '/a': { get: { operationId: 'getAll' } },
          '/b': { get: { operationId: 'getAll' } },
          '/c': { get: { operationId: 'getAll' } },
        },
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toContain('GET /a');
    expect(caught?.message).toContain('GET /b');
    expect(caught?.message).toContain('GET /c');
  });

  it('includes a Fix: hint in the error message', () => {
    let caught: Error | undefined;
    try {
      validateOperationIdUniqueness({
        paths: {
          '/x': { post: { operationId: 'create' } },
          '/y': { post: { operationId: 'create' } },
        },
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).toContain('Fix:');
    expect(caught?.message).toContain('@ApiOperation');
  });

  it('handles a path entry whose value is null without false positive', () => {
    expect(() =>
      validateOperationIdUniqueness({
        paths: {
          '/fine': {
            get: { operationId: 'getFine' },
          },
          // null value — malformed but must not crash or produce false positive
          '/bad': null as unknown as Record<string, unknown>,
        },
      }),
    ).not.toThrow();
  });

  it('handles a path entry whose value is a non-object primitive without false positive', () => {
    expect(() =>
      validateOperationIdUniqueness({
        paths: {
          '/fine': { get: { operationId: 'getFine' } },
          '/also-bad': 'not-an-object' as unknown as Record<string, unknown>,
        },
      }),
    ).not.toThrow();
  });

  it('handles operations without an operationId field gracefully', () => {
    expect(() =>
      validateOperationIdUniqueness({
        paths: {
          '/no-id': {
            get: { summary: 'no operationId here' },
          },
        },
      }),
    ).not.toThrow();
  });
});
