import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertHeaderSafeToken,
  generateOAuthState,
  generatePkcePair,
} from './oauth-credentials.utils';

const base64url = (buf: Buffer): string =>
  buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

describe('generatePkcePair', () => {
  it('produces a base64url verifier and an S256 challenge derived from it', () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();

    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // S256: challenge MUST be base64url(sha256(verifier)).
    const expected = base64url(
      createHash('sha256').update(codeVerifier).digest(),
    );
    expect(codeChallenge).toBe(expected);
  });

  it('produces a fresh pair on each call', () => {
    expect(generatePkcePair().codeVerifier).not.toBe(
      generatePkcePair().codeVerifier,
    );
  });
});

describe('generateOAuthState', () => {
  it('produces a 64-char hex string that is unique per call', () => {
    const a = generateOAuthState();
    const b = generateOAuthState();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('assertHeaderSafeToken', () => {
  it('trims surrounding whitespace and returns the clean value', () => {
    expect(assertHeaderSafeToken('  abc123\n', 'token')).toBe('abc123');
  });

  it('accepts a normal token unchanged', () => {
    expect(assertHeaderSafeToken('lin_oauth_TOKEN-123', 'token')).toBe(
      'lin_oauth_TOKEN-123',
    );
  });

  it('rejects an empty / whitespace-only value', () => {
    expect(() => assertHeaderSafeToken('', 'token')).toThrow();
    expect(() => assertHeaderSafeToken('   ', 'token')).toThrow();
  });

  it('rejects embedded whitespace and CR/LF (header-unsafe)', () => {
    expect(() => assertHeaderSafeToken('a b', 'token')).toThrow();
    expect(() => assertHeaderSafeToken('a\nb', 'token')).toThrow();
    expect(() => assertHeaderSafeToken('a\r\nInjected: x', 'token')).toThrow();
  });
});
