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

import { OAuthProvider } from '../oauth-credentials.types';
import { OAuthExchangeService } from './oauth-exchange.service';

// `environment` runs dotenv + zod validation at import time and the service
// only reads the two Linear client fields from it — replace the whole module
// with a mutable stand-in so tests can toggle the configured/unconfigured path.
const { env, loggerMock } = vi.hoisted(() => ({
  env: {
    linearOAuthClientId: 'test-client-id',
    linearOAuthClientSecret: 'test-client-secret',
  },
  loggerMock: { error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../environments', () => ({ environment: env }));

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

const TOKEN_URL = 'https://api.linear.app/oauth/token';
const GRAPHQL_URL = 'https://api.linear.app/graphql';

const routeFetch = (handlers: {
  token: () => Promise<Response>;
  graphql?: () => Promise<Response>;
}): void => {
  fetchMock.mockImplementation((url: string) => {
    if (url === TOKEN_URL) {
      return handlers.token();
    }
    if (url === GRAPHQL_URL) {
      return (
        handlers.graphql?.() ??
        Promise.resolve(jsonResponse({ data: { viewer: { name: null } } }))
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
};

describe('OAuthExchangeService', () => {
  let service: OAuthExchangeService;

  beforeEach(() => {
    env.linearOAuthClientId = 'test-client-id';
    env.linearOAuthClientSecret = 'test-client-secret';
    fetchMock.mockReset();
    loggerMock.error.mockReset();
    loggerMock.debug.mockReset();
    service = new OAuthExchangeService(loggerMock as unknown as DefaultLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  describe('isProviderConfigured', () => {
    it('is true only when both client id and secret are set', () => {
      expect(service.isProviderConfigured(OAuthProvider.Linear)).toBe(true);

      env.linearOAuthClientId = '';
      expect(service.isProviderConfigured(OAuthProvider.Linear)).toBe(false);

      env.linearOAuthClientId = 'test-client-id';
      env.linearOAuthClientSecret = '';
      expect(service.isProviderConfigured(OAuthProvider.Linear)).toBe(false);
    });
  });

  describe('exchangeAuthorizationCode', () => {
    it('throws OAUTH_PROVIDER_NOT_CONFIGURED when client credentials are unset', async () => {
      env.linearOAuthClientId = '';
      env.linearOAuthClientSecret = '';
      await expect(
        service.exchangeAuthorizationCode(
          OAuthProvider.Linear,
          'code',
          'verifier',
          'https://app/callback/linear',
        ),
      ).rejects.toThrow(/OAUTH_PROVIDER_NOT_CONFIGURED/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws OAUTH_TOKEN_EXCHANGE_FAILED on a non-OK token response', async () => {
      routeFetch({
        token: async () =>
          jsonResponse({ error: 'invalid_grant' }, { ok: false, status: 400 }),
      });
      await expect(
        service.exchangeAuthorizationCode(
          OAuthProvider.Linear,
          'code',
          'verifier',
          'https://app/callback/linear',
        ),
      ).rejects.toThrow(/OAUTH_TOKEN_EXCHANGE_FAILED/);
      expect(loggerMock.error).toHaveBeenCalled();
    });

    it('throws OAUTH_TOKEN_EXCHANGE_FAILED on an OK response with no access_token', async () => {
      routeFetch({
        token: async () => jsonResponse({ token_type: 'bearer' }),
      });
      await expect(
        service.exchangeAuthorizationCode(
          OAuthProvider.Linear,
          'code',
          'verifier',
          'https://app/callback/linear',
        ),
      ).rejects.toThrow(/OAUTH_TOKEN_EXCHANGE_FAILED/);
    });

    it('splits the scope string, derives expiresAt, and resolves the account label', async () => {
      routeFetch({
        token: async () =>
          jsonResponse({
            access_token: 'lin_oauth_tok',
            token_type: 'bearer',
            scope: 'read write',
            expires_in: 3600,
          }),
        graphql: async () =>
          jsonResponse({ data: { viewer: { name: 'Ada Lovelace' } } }),
      });

      const before = Date.now();
      const result = await service.exchangeAuthorizationCode(
        OAuthProvider.Linear,
        'code',
        'verifier',
        'https://app/callback/linear',
      );

      expect(result.accessToken).toBe('lin_oauth_tok');
      expect(result.scopes).toEqual(['read', 'write']);
      expect(result.accountLabel).toBe('Ada Lovelace');
      expect(result.expiresAt).toBeInstanceOf(Date);
      // ~now + 3600s, allowing for test execution slack.
      const deltaMs = (result.expiresAt as Date).getTime() - before;
      expect(deltaMs).toBeGreaterThanOrEqual(3600 * 1000 - 1000);
      expect(deltaMs).toBeLessThanOrEqual(3600 * 1000 + 5000);
    });

    it('yields null scopes and null expiresAt when the provider omits them', async () => {
      routeFetch({
        token: async () => jsonResponse({ access_token: 'lin_oauth_tok' }),
        graphql: async () =>
          jsonResponse({ data: { viewer: { name: 'Ada' } } }),
      });

      const result = await service.exchangeAuthorizationCode(
        OAuthProvider.Linear,
        'code',
        'verifier',
        'https://app/callback/linear',
      );
      expect(result.scopes).toBeNull();
      expect(result.expiresAt).toBeNull();
    });

    it('treats a non-positive expires_in as already-expired, not non-expiring', async () => {
      // expires_in: 0 means the token is already dead on arrival. Mapping it to
      // a null expiresAt makes status() report the credential as a permanent,
      // non-expiring token — so the node never prompts re-auth and fails
      // opaquely at run time. A non-positive lifetime must yield an expiresAt
      // in the past (<= now), never null.
      routeFetch({
        token: async () =>
          jsonResponse({ access_token: 'lin_oauth_tok', expires_in: 0 }),
        graphql: async () =>
          jsonResponse({ data: { viewer: { name: 'Ada' } } }),
      });

      const result = await service.exchangeAuthorizationCode(
        OAuthProvider.Linear,
        'code',
        'verifier',
        'https://app/callback/linear',
      );

      expect(result.expiresAt).toBeInstanceOf(Date);
      expect((result.expiresAt as Date).getTime()).toBeLessThanOrEqual(
        Date.now(),
      );
    });

    it('never throws when the account-label fetch fails — returns null label', async () => {
      routeFetch({
        token: async () => jsonResponse({ access_token: 'lin_oauth_tok' }),
        graphql: async () => Promise.reject(new Error('network down')),
      });

      const result = await service.exchangeAuthorizationCode(
        OAuthProvider.Linear,
        'code',
        'verifier',
        'https://app/callback/linear',
      );
      expect(result.accessToken).toBe('lin_oauth_tok');
      expect(result.accountLabel).toBeNull();
    });
  });
});
