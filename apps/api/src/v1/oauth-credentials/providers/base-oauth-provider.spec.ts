import { DefaultLogger } from '@packages/common';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  OAUTH_PROVIDER_CONFIGS,
  OAuthProvider,
} from '../oauth-credentials.types';
import { LinearOAuthProvider } from './linear-oauth-provider';
import { DiscoveredOAuthServer } from './oauth-provider.types';

// LinearOAuthProvider is the concrete strategy that exercises every
// BaseOAuthProvider method against the live Linear MCP endpoints (mocked here).
const ORIGIN = 'https://mcp.linear.app';
const PRM_PATH = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const PRM_ORIGIN = `${ORIGIN}/.well-known/oauth-protected-resource`;
const ASM_URL = `${ORIGIN}/.well-known/oauth-authorization-server`;
const REGISTER_URL = `${ORIGIN}/register`;
const TOKEN_URL = `${ORIGIN}/token`;
const AUTHORIZE_URL = `${ORIGIN}/authorize`;
const RESOURCE = 'https://mcp.linear.app/mcp';
const REDIRECT_URI = 'https://app.example.com/oauth/callback/linear';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { error: vi.fn(), debug: vi.fn() },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const jsonResponse = (
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): Response =>
  ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }) as unknown as Response;

const validPrm = {
  resource: RESOURCE,
  authorization_servers: [ORIGIN],
  scopes_supported: ['read', 'write'],
  bearer_methods_supported: ['header'],
};

const validAsm = {
  issuer: ORIGIN,
  authorization_endpoint: AUTHORIZE_URL,
  token_endpoint: TOKEN_URL,
  registration_endpoint: REGISTER_URL,
  code_challenge_methods_supported: ['S256'],
};

/** Capture the last request init seen for a given URL (to assert body shape). */
const lastInitFor = (url: string): RequestInit | undefined => {
  const call = [...fetchMock.mock.calls].reverse().find(([u]) => u === url) as
    | [string, RequestInit]
    | undefined;
  return call?.[1];
};

const discoveredServer: DiscoveredOAuthServer = {
  authorizationEndpoint: AUTHORIZE_URL,
  tokenEndpoint: TOKEN_URL,
  registrationEndpoint: REGISTER_URL,
  resource: RESOURCE,
};

describe('BaseOAuthProvider (via LinearOAuthProvider)', () => {
  let provider: LinearOAuthProvider;

  beforeEach(() => {
    fetchMock.mockReset();
    loggerMock.error.mockReset();
    loggerMock.debug.mockReset();
    provider = new LinearOAuthProvider(loggerMock as unknown as DefaultLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  describe('discover', () => {
    it('resolves the authorization-server endpoints and the RFC 8707 resource', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url === PRM_PATH) {
          return Promise.resolve(jsonResponse(validPrm));
        }
        if (url === ASM_URL) {
          return Promise.resolve(jsonResponse(validAsm));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      const server = await provider.discover();

      expect(server).toEqual({
        authorizationEndpoint: AUTHORIZE_URL,
        tokenEndpoint: TOKEN_URL,
        registrationEndpoint: REGISTER_URL,
        resource: RESOURCE,
      });
    });

    it('falls back to the origin-level protected-resource path when the path-aware one 404s', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url === PRM_PATH) {
          return Promise.resolve(jsonResponse({}, { ok: false, status: 404 }));
        }
        if (url === PRM_ORIGIN) {
          return Promise.resolve(jsonResponse(validPrm));
        }
        if (url === ASM_URL) {
          return Promise.resolve(jsonResponse(validAsm));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      const server = await provider.discover();
      expect(server.tokenEndpoint).toBe(TOKEN_URL);
      expect(fetchMock).toHaveBeenCalledWith(PRM_ORIGIN, expect.anything());
    });

    it('falls back to origin-level metadata when the path-aware response is OK but a non-object body', async () => {
      // A server can answer the path-aware PRM URL with HTTP 200 yet a body that
      // is valid JSON but not an object (a scalar / array / null) — e.g. a JSON
      // error page or a misrouted endpoint that 200s with `null`. The origin-level
      // fallback holds the real metadata. Discovery MUST try the fallback rather
      // than treating the first OK response's unusable body as final.
      fetchMock.mockImplementation((url: string) => {
        if (url === PRM_PATH) {
          // OK status, but the body is a bare scalar — not protected-resource
          // metadata. Must not short-circuit the origin-level candidate.
          return Promise.resolve(jsonResponse(42, { ok: true, status: 200 }));
        }
        if (url === PRM_ORIGIN) {
          return Promise.resolve(jsonResponse(validPrm));
        }
        if (url === ASM_URL) {
          return Promise.resolve(jsonResponse(validAsm));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      const server = await provider.discover();

      expect(server).toEqual({
        authorizationEndpoint: AUTHORIZE_URL,
        tokenEndpoint: TOKEN_URL,
        registrationEndpoint: REGISTER_URL,
        resource: RESOURCE,
      });
      expect(fetchMock).toHaveBeenCalledWith(PRM_ORIGIN, expect.anything());
    });

    it('fails closed when the protected-resource metadata is a non-object scalar', async () => {
      // Crafted untrusted JSON: a bare scalar is valid JSON but must not be
      // dereferenced as an object.
      fetchMock.mockImplementation((url: string) => {
        if (url === PRM_PATH || url === PRM_ORIGIN) {
          return Promise.resolve(jsonResponse(42));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      await expect(provider.discover()).rejects.toThrow(
        /OAUTH_DISCOVERY_FAILED/,
      );
    });

    it('fails closed when authorization_servers is missing or empty', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url === PRM_PATH || url === PRM_ORIGIN) {
          return Promise.resolve(
            jsonResponse({ resource: RESOURCE, authorization_servers: [] }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      await expect(provider.discover()).rejects.toThrow(
        /OAUTH_DISCOVERY_FAILED/,
      );
    });

    it('fails closed when the authorization-server metadata omits an endpoint', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url === PRM_PATH) {
          return Promise.resolve(jsonResponse(validPrm));
        }
        if (url === ASM_URL) {
          // Missing registration_endpoint (issuer present so the issuer-match
          // check passes and the missing-endpoint check is what fires).
          return Promise.resolve(
            jsonResponse({
              issuer: ORIGIN,
              authorization_endpoint: AUTHORIZE_URL,
              token_endpoint: TOKEN_URL,
            }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      await expect(provider.discover()).rejects.toThrow(
        /OAUTH_DISCOVERY_FAILED/,
      );
    });

    it('fails closed when the AS metadata issuer does not match the discovered issuer (RFC 8414 mix-up defense)', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url === PRM_PATH) {
          return Promise.resolve(jsonResponse(validPrm));
        }
        if (url === ASM_URL) {
          return Promise.resolve(
            jsonResponse({ ...validAsm, issuer: 'https://evil.example.com' }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      await expect(provider.discover()).rejects.toThrow(
        /OAUTH_DISCOVERY_FAILED/,
      );
    });

    it('fails closed when a discovered endpoint is not HTTPS', async () => {
      // The token endpoint carries the code + PKCE verifier + any client_secret;
      // a non-HTTPS endpoint must be rejected.
      fetchMock.mockImplementation((url: string) => {
        if (url === PRM_PATH) {
          return Promise.resolve(jsonResponse(validPrm));
        }
        if (url === ASM_URL) {
          return Promise.resolve(
            jsonResponse({
              ...validAsm,
              token_endpoint: 'http://mcp.linear.app/token',
            }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      await expect(provider.discover()).rejects.toThrow(
        /OAUTH_DISCOVERY_FAILED/,
      );
    });

    it('fails closed when authorization_servers[0] is not a valid URL', async () => {
      // asStringArray accepts any string; the malformed issuer surfaces one
      // level deeper at `new URL()` and must fail closed, not throw uncaught.
      fetchMock.mockImplementation((url: string) => {
        if (url === PRM_PATH || url === PRM_ORIGIN) {
          return Promise.resolve(
            jsonResponse({
              resource: RESOURCE,
              authorization_servers: ['http://[invalid'],
            }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      await expect(provider.discover()).rejects.toThrow(
        /OAUTH_DISCOVERY_FAILED/,
      );
    });

    it('fails closed when the discovered authorization-server issuer is a valid but non-HTTPS URL', async () => {
      // A plaintext `http://` issuer is a VALID URL, so it slips past the
      // malformed-issuer catch and must be rejected by the explicit non-HTTPS
      // issuer guard (RFC 8414 §3.3 downgrade defense). Valid HTTPS-endpoint AS
      // metadata is served at the plaintext issuer so the issuer-protocol check
      // is the ONLY thing between this and a successful discovery — deleting that
      // guard makes discover() resolve and flips this test red (distinct from the
      // endpoint-HTTPS case, which flips token_endpoint, and the malformed-URL
      // case, which throws at `new URL()`).
      const httpIssuer = 'http://mcp.linear.app';
      const httpAsmUrl = `${httpIssuer}/.well-known/oauth-authorization-server`;
      fetchMock.mockImplementation((url: string) => {
        if (url === PRM_PATH || url === PRM_ORIGIN) {
          return Promise.resolve(
            jsonResponse({
              resource: RESOURCE,
              authorization_servers: [httpIssuer],
            }),
          );
        }
        if (url === httpAsmUrl) {
          return Promise.resolve(
            jsonResponse({ ...validAsm, issuer: httpIssuer }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      await expect(provider.discover()).rejects.toThrow(
        /OAUTH_DISCOVERY_FAILED/,
      );
    });

    it('fails closed on a network error during discovery', async () => {
      fetchMock.mockImplementation(() =>
        Promise.reject(new Error('ECONNREFUSED')),
      );
      await expect(provider.discover()).rejects.toThrow(
        /OAUTH_DISCOVERY_FAILED/,
      );
    });
  });

  describe('register (Dynamic Client Registration)', () => {
    it('registers a public client and returns the client id (no secret)', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url === REGISTER_URL) {
          return Promise.resolve(jsonResponse({ client_id: 'dcr-client-1' }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      const client = await provider.register(discoveredServer, REDIRECT_URI);

      expect(client).toEqual({ clientId: 'dcr-client-1', clientSecret: null });
      const init = lastInitFor(REGISTER_URL);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.redirect_uris).toEqual([REDIRECT_URI]);
      expect(body.token_endpoint_auth_method).toBe('none');
      expect(body.grant_types).toEqual(['authorization_code']);
      expect(body.response_types).toEqual(['code']);
      expect(body.scope).toBe('read write');
    });

    it('captures a client_secret when the server returns a confidential client', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url === REGISTER_URL) {
          return Promise.resolve(
            jsonResponse({ client_id: 'dcr-client-2', client_secret: 'shh' }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      const client = await provider.register(discoveredServer, REDIRECT_URI);
      expect(client).toEqual({ clientId: 'dcr-client-2', clientSecret: 'shh' });
    });

    it('fails closed when registration returns no client_id', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ error: 'invalid_request' })),
      );
      await expect(
        provider.register(discoveredServer, REDIRECT_URI),
      ).rejects.toThrow(/OAUTH_REGISTRATION_FAILED/);
    });

    it('fails closed on a non-OK registration response', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({}, { ok: false, status: 429 })),
      );
      await expect(
        provider.register(discoveredServer, REDIRECT_URI),
      ).rejects.toThrow(/OAUTH_REGISTRATION_FAILED/);
    });
  });

  describe('buildAuthorizeUrl', () => {
    it('carries PKCE S256, the state, the scope, and the RFC 8707 resource indicator', () => {
      const url = new URL(
        provider.buildAuthorizeUrl(
          discoveredServer,
          'dcr-client-1',
          REDIRECT_URI,
          'state-xyz',
          'challenge-abc',
        ),
      );

      expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('dcr-client-1');
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(url.searchParams.get('scope')).toBe('read write');
      expect(url.searchParams.get('state')).toBe('state-xyz');
      expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('resource')).toBe(RESOURCE);
    });

    it('uses the SAME redirect_uri registered as redirect_uris[0] (byte-for-byte)', async () => {
      // The AS rejects the flow unless the registered redirect_uris[0], the
      // authorize redirect_uri, and the exchange redirect_uri are identical.
      fetchMock.mockImplementation((url: string) => {
        if (url === REGISTER_URL) {
          return Promise.resolve(jsonResponse({ client_id: 'dcr-client-1' }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      await provider.register(discoveredServer, REDIRECT_URI);
      const registerInit = lastInitFor(REGISTER_URL);
      const registeredRedirect = (
        JSON.parse(String(registerInit?.body)) as { redirect_uris: string[] }
      ).redirect_uris[0];

      const authorizeRedirect = new URL(
        provider.buildAuthorizeUrl(
          discoveredServer,
          'dcr-client-1',
          REDIRECT_URI,
          's',
          'c',
        ),
      ).searchParams.get('redirect_uri');

      expect(registeredRedirect).toBe(REDIRECT_URI);
      expect(authorizeRedirect).toBe(REDIRECT_URI);
      expect(authorizeRedirect).toBe(registeredRedirect);
    });
  });

  describe('exchangeCode', () => {
    it('posts the resource indicator + client_id + verifier and parses the token', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url === TOKEN_URL) {
          return Promise.resolve(
            jsonResponse({
              access_token: 'lin_tok',
              scope: 'read write',
              expires_in: 3600,
            }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      const before = Date.now();
      const result = await provider.exchangeCode(
        discoveredServer,
        { clientId: 'dcr-client-1', clientSecret: null },
        'auth-code',
        'verifier',
        REDIRECT_URI,
      );

      expect(result.accessToken).toBe('lin_tok');
      expect(result.scopes).toEqual(['read', 'write']);
      expect(result.accountLabel).toBeNull();
      expect(result.expiresAt).toBeInstanceOf(Date);
      const deltaMs = (result.expiresAt as Date).getTime() - before;
      expect(deltaMs).toBeGreaterThanOrEqual(3600 * 1000 - 1000);
      expect(deltaMs).toBeLessThanOrEqual(3600 * 1000 + 5000);

      const body = new URLSearchParams(String(lastInitFor(TOKEN_URL)?.body));
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('auth-code');
      expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(body.get('client_id')).toBe('dcr-client-1');
      expect(body.get('code_verifier')).toBe('verifier');
      expect(body.get('resource')).toBe(RESOURCE);
      expect(body.has('client_secret')).toBe(false);
    });

    it('includes client_secret only for a confidential client', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url === TOKEN_URL) {
          return Promise.resolve(jsonResponse({ access_token: 'lin_tok' }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      await provider.exchangeCode(
        discoveredServer,
        { clientId: 'dcr-client-2', clientSecret: 'shh' },
        'auth-code',
        'verifier',
        REDIRECT_URI,
      );
      const body = new URLSearchParams(String(lastInitFor(TOKEN_URL)?.body));
      expect(body.get('client_secret')).toBe('shh');
    });

    it('treats a non-positive expires_in as already-expired, not non-expiring', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ access_token: 'lin_tok', expires_in: 0 }),
        ),
      );
      const result = await provider.exchangeCode(
        discoveredServer,
        { clientId: 'c', clientSecret: null },
        'code',
        'verifier',
        REDIRECT_URI,
      );
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect((result.expiresAt as Date).getTime()).toBeLessThanOrEqual(
        Date.now(),
      );
    });

    it('yields a null expiry when expires_in is absent or non-numeric (expiry unknown)', async () => {
      // The third expiry branch: no `expires_in` -> null -> status() treats the
      // token as non-expiring, distinct from the dead-on-arrival case above.
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ access_token: 'lin_tok' })),
      );
      const result = await provider.exchangeCode(
        discoveredServer,
        { clientId: 'c', clientSecret: null },
        'code',
        'verifier',
        REDIRECT_URI,
      );
      expect(result.expiresAt).toBeNull();
      expect(result.scopes).toBeNull();
    });

    it('fails closed on a non-OK token response', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ error: 'invalid_grant' }, { ok: false, status: 400 }),
        ),
      );
      await expect(
        provider.exchangeCode(
          discoveredServer,
          { clientId: 'c', clientSecret: null },
          'code',
          'verifier',
          REDIRECT_URI,
        ),
      ).rejects.toThrow(/OAUTH_TOKEN_EXCHANGE_FAILED/);
    });

    it('fails closed on an OK response with no access_token', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ token_type: 'bearer' })),
      );
      await expect(
        provider.exchangeCode(
          discoveredServer,
          { clientId: 'c', clientSecret: null },
          'code',
          'verifier',
          REDIRECT_URI,
        ),
      ).rejects.toThrow(/OAUTH_TOKEN_EXCHANGE_FAILED/);
    });

    it('parses a refresh_token from the token response when present', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url === TOKEN_URL) {
          return Promise.resolve(
            jsonResponse({
              access_token: 'lin_tok',
              refresh_token: 'lin_refresh_tok',
              expires_in: 3600,
            }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      const result = await provider.exchangeCode(
        discoveredServer,
        { clientId: 'c', clientSecret: null },
        'code',
        'verifier',
        REDIRECT_URI,
      );
      expect(result.refreshToken).toBe('lin_refresh_tok');
    });

    it('yields a null refreshToken when the response omits one', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ access_token: 'lin_tok' })),
      );
      const result = await provider.exchangeCode(
        discoveredServer,
        { clientId: 'c', clientSecret: null },
        'code',
        'verifier',
        REDIRECT_URI,
      );
      expect(result.refreshToken).toBeNull();
    });
  });

  describe('refreshAccessToken', () => {
    it('posts grant_type=refresh_token with the resource indicator + client_id and parses the token', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url === TOKEN_URL) {
          return Promise.resolve(
            jsonResponse({
              access_token: 'lin_tok_refreshed',
              scope: 'read write',
              expires_in: 3600,
            }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      const before = Date.now();
      const result = await provider.refreshAccessToken(
        discoveredServer,
        { clientId: 'dcr-client-1', clientSecret: null },
        'refresh-tok-1',
      );

      expect(result.accessToken).toBe('lin_tok_refreshed');
      expect(result.scopes).toEqual(['read', 'write']);
      // No rotated refresh token in this response — the caller keeps the old one.
      expect(result.refreshToken).toBeNull();
      expect(result.accountLabel).toBeNull();
      expect(result.expiresAt).toBeInstanceOf(Date);
      const deltaMs = (result.expiresAt as Date).getTime() - before;
      expect(deltaMs).toBeGreaterThanOrEqual(3600 * 1000 - 1000);
      expect(deltaMs).toBeLessThanOrEqual(3600 * 1000 + 5000);

      const body = new URLSearchParams(String(lastInitFor(TOKEN_URL)?.body));
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('refresh-tok-1');
      expect(body.get('client_id')).toBe('dcr-client-1');
      expect(body.get('resource')).toBe(RESOURCE);
      expect(body.has('client_secret')).toBe(false);
    });

    it('includes client_secret only for a confidential client', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url === TOKEN_URL) {
          return Promise.resolve(jsonResponse({ access_token: 'lin_tok' }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      await provider.refreshAccessToken(
        discoveredServer,
        { clientId: 'dcr-client-2', clientSecret: 'shh' },
        'refresh-tok-1',
      );
      const body = new URLSearchParams(String(lastInitFor(TOKEN_URL)?.body));
      expect(body.get('client_secret')).toBe('shh');
    });

    it('surfaces a rotated refresh_token when the AS issues one on the grant', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            access_token: 'lin_tok_2',
            refresh_token: 'rotated-refresh-2',
          }),
        ),
      );
      const result = await provider.refreshAccessToken(
        discoveredServer,
        { clientId: 'c', clientSecret: null },
        'refresh-tok-1',
      );
      expect(result.accessToken).toBe('lin_tok_2');
      expect(result.refreshToken).toBe('rotated-refresh-2');
    });

    it('fails closed on a non-OK refresh response (e.g. a revoked refresh token)', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ error: 'invalid_grant' }, { ok: false, status: 400 }),
        ),
      );
      await expect(
        provider.refreshAccessToken(
          discoveredServer,
          { clientId: 'c', clientSecret: null },
          'refresh-tok-1',
        ),
      ).rejects.toThrow(/OAUTH_TOKEN_REFRESH_FAILED/);
    });

    it('fails closed on an OK refresh response with no access_token', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ token_type: 'bearer' })),
      );
      await expect(
        provider.refreshAccessToken(
          discoveredServer,
          { clientId: 'c', clientSecret: null },
          'refresh-tok-1',
        ),
      ).rejects.toThrow(/OAUTH_TOKEN_REFRESH_FAILED/);
    });

    it('does not echo the rotated refresh token into any log sink on a malformed response', async () => {
      const SECRET = 'ROTATED_REFRESH_DO_NOT_LOG';
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ refresh_token: SECRET }, { ok: false, status: 400 }),
        ),
      );
      await expect(
        provider.refreshAccessToken(
          discoveredServer,
          { clientId: 'c', clientSecret: null },
          'refresh-tok-1',
        ),
      ).rejects.toThrow(/OAUTH_TOKEN_REFRESH_FAILED/);

      const allLogged = [
        ...loggerMock.error.mock.calls,
        ...loggerMock.debug.mock.calls,
      ]
        .flat()
        .map((arg) => JSON.stringify(arg))
        .join(' ');
      expect(allLogged).not.toContain(SECRET);
    });
  });

  describe('trust boundary — never logs response bodies', () => {
    it('does not echo a returned secret into any log sink on a malformed response', async () => {
      const SECRET = 'SUPER_SECRET_DO_NOT_LOG';
      fetchMock.mockImplementation((url: string) => {
        if (url === REGISTER_URL) {
          // Non-OK, but the body still carries a secret-shaped value.
          return Promise.resolve(
            jsonResponse({ client_secret: SECRET }, { ok: false, status: 400 }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });

      await expect(
        provider.register(discoveredServer, REDIRECT_URI),
      ).rejects.toThrow(/OAUTH_REGISTRATION_FAILED/);

      const allLogged = [
        ...loggerMock.error.mock.calls,
        ...loggerMock.debug.mock.calls,
      ]
        .flat()
        .map((arg) => JSON.stringify(arg))
        .join(' ');
      expect(allLogged).not.toContain(SECRET);
    });
  });

  it('exposes the Linear provider identity + resource', () => {
    expect(provider.provider).toBe(OAuthProvider.Linear);
    expect(provider.resourceUrl).toBe(RESOURCE);
    // The inlined resourceUrl MUST stay identical to the central MCP-endpoint
    // registry the issued token is later injected against (agent-mcp/linear-mcp.ts)
    // — a drift would make the RFC 8707 audience-bound bearer get rejected at the
    // resource. Pin it here so any drift fails CI, not opaquely at run time.
    expect(provider.resourceUrl).toBe(
      OAUTH_PROVIDER_CONFIGS[OAuthProvider.Linear].mcpUrl,
    );
    expect(provider.scopes).toEqual(['read', 'write']);
    expect(provider.scopeSeparator).toBe(' ');
  });
});
