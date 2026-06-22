import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LinearOAuthProvider } from './linear-oauth-provider';
import { DiscoveredOAuthServer } from './oauth-provider.types';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const RESOURCE = 'https://mcp.linear.app/mcp';
const TOKEN_URL = 'https://auth.linear.app/oauth/token';
const REDIRECT_URI = 'https://app.geniro.io/oauth/linear/callback';

const server: DiscoveredOAuthServer = {
  authorizationEndpoint: 'https://auth.linear.app/oauth/authorize',
  tokenEndpoint: TOKEN_URL,
  registrationEndpoint: 'https://auth.linear.app/oauth/register',
  resource: RESOURCE,
};

/** A token-endpoint reply for the authorization-code exchange. */
function tokenResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        access_token: 'lin_tok',
        scope: 'read write',
        expires_in: 3600,
      }),
  } as unknown as Response;
}

/** Wrap a JSON-RPC envelope in Linear's Streamable-HTTP SSE framing. */
function sse(envelope: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`),
  } as unknown as Response;
}

/** Deliver the same envelope as a plain application/json body (no SSE frame). */
function plainJson(envelope: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(envelope)),
  } as unknown as Response;
}

/** The MCP `tools/call get_user` result shape: a JSON-string user in content[]. */
function getUserEnvelope(user: unknown): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(user) }] },
  };
}

describe('LinearOAuthProvider account-label probe', () => {
  let provider: LinearOAuthProvider;

  beforeEach(() => {
    fetchMock.mockReset();
    provider = new LinearOAuthProvider({
      error: vi.fn(),
      debug: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    } as unknown as DefaultLogger);
  });

  const exchange = () =>
    provider.exchangeCode(
      server,
      { clientId: 'c', clientSecret: null },
      'code',
      'verifier',
      REDIRECT_URI,
    );

  /** Route the token endpoint to a token reply and the MCP resource to `probe`. */
  function routeProbe(probe: () => Response | Promise<Response>): void {
    fetchMock.mockImplementation((url: string) => {
      if (url === TOKEN_URL) {
        return Promise.resolve(tokenResponse());
      }
      if (url === RESOURCE) {
        return Promise.resolve(probe());
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
  }

  it('labels the credential "<name> (<email>)" from the MCP get_user(me) probe', async () => {
    routeProbe(() =>
      sse(
        getUserEnvelope({
          name: 'Sergei Razumovskii',
          email: 's.razumovskii@manifestlabs.com',
          displayName: 's.razumovskii',
        }),
      ),
    );

    const result = await exchange();

    expect(result.accountLabel).toBe(
      'Sergei Razumovskii (s.razumovskii@manifestlabs.com)',
    );
    expect(result.accessToken).toBe('lin_tok');
  });

  it('sends a get_user(me) tools/call bearing the freshly issued token', async () => {
    let probeInit: RequestInit | undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === TOKEN_URL) {
        return Promise.resolve(tokenResponse());
      }
      if (url === RESOURCE) {
        probeInit = init;
        return Promise.resolve(
          sse(getUserEnvelope({ name: 'N', email: 'n@example.com' })),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    await exchange();

    const headers = probeInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer lin_tok');
    const body = JSON.parse(String(probeInit?.body)) as Record<string, unknown>;
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({
      name: 'get_user',
      arguments: { query: 'me' },
    });
  });

  it('parses a plain application/json envelope (no SSE framing)', async () => {
    routeProbe(() =>
      plainJson(getUserEnvelope({ name: 'Ada Lovelace', email: 'ada@x.io' })),
    );

    const result = await exchange();

    expect(result.accountLabel).toBe('Ada Lovelace (ada@x.io)');
  });

  it('falls back name -> displayName -> email when fields are partial', async () => {
    const cases: [unknown, string | null][] = [
      [{ name: 'Only Name' }, 'Only Name'],
      [{ displayName: 'handle' }, 'handle'],
      [{ email: 'only@email.io' }, 'only@email.io'],
      [{ name: 'N', displayName: 'dn' }, 'N'],
      [{}, null],
    ];
    for (const [user, expected] of cases) {
      fetchMock.mockReset();
      routeProbe(() => sse(getUserEnvelope(user)));
      const result = await exchange();
      expect(result.accountLabel).toBe(expected);
    }
  });

  it('fails soft to a null label on a 401 probe — acquisition is unaffected', async () => {
    routeProbe(
      () =>
        ({
          ok: false,
          status: 401,
          text: () => Promise.resolve('Unauthorized'),
        }) as unknown as Response,
    );

    const result = await exchange();

    expect(result.accountLabel).toBeNull();
    expect(result.accessToken).toBe('lin_tok');
  });

  it('fails soft to a null label on a probe network error', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === TOKEN_URL) {
        return Promise.resolve(tokenResponse());
      }
      return Promise.reject(new Error('ECONNRESET'));
    });

    const result = await exchange();

    expect(result.accountLabel).toBeNull();
    expect(result.accessToken).toBe('lin_tok');
  });

  // Trust boundary: every MCP frame is untrusted external JSON. A crafted /
  // garbage frame must never throw and must yield a null label (not a partial
  // dereference crash). See .claude/rules/sandbox-boundary.md.
  it('survives crafted/garbage frames without throwing, yielding null', async () => {
    const craftedBodies: unknown[] = [
      null,
      42,
      'a scalar string',
      [],
      { result: 5 },
      { result: { content: 'not-an-array' } },
      { result: { content: [42, null, 'x'] } },
      { result: { content: [{ type: 'image' }] } },
      { result: { content: [{ type: 'text', text: 'not-json' }] } },
      { result: { content: [{ type: 'text', text: '[1,2,3]' }] } },
    ];
    for (const body of craftedBodies) {
      fetchMock.mockReset();
      routeProbe(() => sse(body));
      const result = await exchange();
      expect(result.accountLabel).toBeNull();
      expect(result.accessToken).toBe('lin_tok');
    }
  });
});
