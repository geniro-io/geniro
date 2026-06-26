import { afterEach, describe, expect, it } from 'vitest';

import { extractErrorMessage, getEnvPositiveInt } from './utils';

describe('extractErrorMessage', () => {
  it('returns the message from an Error instance', () => {
    expect(extractErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns a string value as-is', () => {
    expect(extractErrorMessage('nope')).toBe('nope');
  });

  it('extracts message from a plain object with `message`', () => {
    expect(extractErrorMessage({ message: 'connection reset' })).toBe(
      'connection reset',
    );
  });

  it('extracts message from nested `body.message` (k8s ApiException shape)', () => {
    expect(extractErrorMessage({ body: { message: 'pod terminated' } })).toBe(
      'pod terminated',
    );
  });

  it('extracts message from `response.body.message`', () => {
    expect(
      extractErrorMessage({
        response: { body: { message: 'forbidden' } },
      }),
    ).toBe('forbidden');
  });

  it('falls back to JSON serialization when no string message is present', () => {
    expect(extractErrorMessage({ statusCode: 500 })).toBe('{"statusCode":500}');
  });

  it('never returns the literal "[object Object]" for a plain object', () => {
    expect(extractErrorMessage({ foo: 'bar' })).not.toBe('[object Object]');
  });

  it('handles null and undefined', () => {
    expect(extractErrorMessage(null)).toBe('null');
    expect(extractErrorMessage(undefined)).toBe('undefined');
  });

  it('uses the Error name when the message is empty', () => {
    const err = new Error('');
    expect(extractErrorMessage(err)).toBe('Error');
  });

  it('extracts the underlying Error from a Symbol-keyed property (ws ErrorEvent shape)', () => {
    const wsErrorEvent = Object.create(null) as Record<symbol, unknown>;
    wsErrorEvent[Symbol('kError')] = new Error(
      'Unexpected server response: 403',
    );
    wsErrorEvent[Symbol('kMessage')] = 'Unexpected server response: 403';
    expect(extractErrorMessage(wsErrorEvent)).toBe(
      'Unexpected server response: 403',
    );
  });
});

describe('getEnvPositiveInt', () => {
  const KEY = 'TEST_ENV_POSITIVE_INT';

  afterEach(() => {
    delete process.env[KEY];
  });

  it('parses a valid positive integer string', () => {
    process.env[KEY] = '500';
    expect(getEnvPositiveInt(KEY, 32768)).toBe(500);
  });

  it('falls back when the env var is unset', () => {
    delete process.env[KEY];
    expect(getEnvPositiveInt(KEY, 32768)).toBe(32768);
  });

  // The fail-open the guard exists to close: a non-numeric override must NOT
  // become NaN (which would silently disable a `> cap` limit). A finite-only
  // fixture would pass with or without the guard, so this case is load-bearing.
  it('falls back on a non-numeric value instead of returning NaN', () => {
    process.env[KEY] = 'not-a-number';
    expect(getEnvPositiveInt(KEY, 500)).toBe(500);
  });

  // getEnv would coerce '0' to boolean false -> +false === 0 -> a zero cap
  // prunes a namespace to empty on every write. The guard rejects it.
  it("falls back on '0' rather than disabling/zeroing the cap", () => {
    process.env[KEY] = '0';
    expect(getEnvPositiveInt(KEY, 500)).toBe(500);
  });

  it('falls back on a boolean token that getEnv would coerce', () => {
    process.env[KEY] = 'on';
    expect(getEnvPositiveInt(KEY, 500)).toBe(500);
  });

  it('falls back on a negative value', () => {
    process.env[KEY] = '-5';
    expect(getEnvPositiveInt(KEY, 500)).toBe(500);
  });

  it('falls back on a non-integer value', () => {
    process.env[KEY] = '500.5';
    expect(getEnvPositiveInt(KEY, 500)).toBe(500);
  });
});
