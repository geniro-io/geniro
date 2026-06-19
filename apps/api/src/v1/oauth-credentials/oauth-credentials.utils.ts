import { createHash, randomBytes } from 'node:crypto';

import { BadRequestException } from '@packages/common';

const base64url = (buf: Buffer): string =>
  buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * Generate an RFC 7636 PKCE pair (S256). The verifier stays server-side (Redis,
 * under the CSRF state); only the challenge travels in the authorize URL.
 */
export const generatePkcePair = (): PkcePair => {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(
    createHash('sha256').update(codeVerifier).digest(),
  );
  return { codeVerifier, codeChallenge };
};

/** Unguessable CSRF/anti-forgery state value, looked up server-side on callback. */
export const generateOAuthState = (): string => randomBytes(32).toString('hex');

/**
 * Validate a token destined for an HTTP Authorization header — a generalisation
 * of `resolveByoApiKey`'s guard. Trims surrounding whitespace (store/provider
 * values commonly carry a trailing newline), requires a non-empty body, and
 * rejects embedded whitespace or CR/LF (header-unsafe). Returns the cleaned
 * value; throws `OAUTH_TOKEN_INVALID` on failure.
 */
export const assertHeaderSafeToken = (value: string, label: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException('OAUTH_TOKEN_INVALID', `${label} is empty`);
  }
  if (/\s/.test(trimmed)) {
    throw new BadRequestException(
      'OAUTH_TOKEN_INVALID',
      `${label} contains embedded whitespace`,
    );
  }
  return trimmed;
};
