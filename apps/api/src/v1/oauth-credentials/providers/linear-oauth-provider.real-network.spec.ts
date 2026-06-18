import { DefaultLogger } from '@packages/common';
import { describe, expect, it } from 'vitest';

import { LinearOAuthProvider } from './linear-oauth-provider';

/**
 * Opt-in real-network verification of the DCR flow against the LIVE Linear MCP
 * authorization server. This is the path M2 never exercised end-to-end —
 * discovery -> Dynamic Client Registration -> authorize-URL build.
 *
 * It is OFF by default (it reaches a third-party host with rate-limited
 * `/register`, and CI has no network guarantee), per the spec's explicit opt-in
 * decision. Enable it deliberately:
 *
 *   RUN_LINEAR_DCR_E2E=1 pnpm test:unit \
 *     src/v1/oauth-credentials/providers/linear-oauth-provider.real-network.spec.ts
 *
 * When the gate is OFF, the always-on sanity test below still runs (no network),
 * so this file is never a silent no-op. When the gate is ON, any network or
 * shape failure fails LOUDLY — there is no try/catch that would swallow it.
 *
 * The full consent + token leg requires a human at the browser and is the
 * documented `live-dcr-flow-verification` approval point — not automatable here.
 */
const RUN_REAL = process.env.RUN_LINEAR_DCR_E2E === '1';

const noopLogger = {
  error: () => undefined,
  debug: () => undefined,
} as unknown as DefaultLogger;

const REDIRECT_URI = 'https://app.example.com/oauth/callback/linear';

describe('LinearOAuthProvider — real Linear MCP network (opt-in)', () => {
  const provider = new LinearOAuthProvider(noopLogger);

  it('exposes the expected static Linear MCP resource + scopes', () => {
    expect(provider.resourceUrl).toBe('https://mcp.linear.app/mcp');
    expect(provider.scopes).toEqual(['read', 'write']);
    expect(provider.scopeSeparator).toBe(' ');
  });

  it.runIf(RUN_REAL)(
    'discovers the AS and registers a per-flow DCR client against mcp.linear.app',
    async () => {
      const server = await provider.discover();
      expect(server.registrationEndpoint).toContain('mcp.linear.app');
      expect(server.authorizationEndpoint).toContain('mcp.linear.app');
      expect(server.tokenEndpoint).toContain('mcp.linear.app');
      expect(server.resource).toBe('https://mcp.linear.app/mcp');

      const client = await provider.register(server, REDIRECT_URI);
      expect(client.clientId).toBeTruthy();

      const authorizeUrl = new URL(
        provider.buildAuthorizeUrl(
          server,
          client.clientId,
          REDIRECT_URI,
          'real-state',
          'real-challenge',
        ),
      );
      expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe(
        'S256',
      );
      expect(authorizeUrl.searchParams.get('resource')).toBe(
        'https://mcp.linear.app/mcp',
      );
      expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    },
    30_000,
  );
});
