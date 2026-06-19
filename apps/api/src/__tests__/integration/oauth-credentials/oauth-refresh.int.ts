import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplication } from '@nestjs/common';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { AppContextStorage } from '../../../auth/app-context-storage';
import { OAuthCredentialsDao } from '../../../v1/oauth-credentials/dao/oauth-credentials.dao';
import { OAuthCredentialEntity } from '../../../v1/oauth-credentials/entity/oauth-credential.entity';
import { OAuthProvider } from '../../../v1/oauth-credentials/oauth-credentials.types';
import { OAuthCredentialsService } from '../../../v1/oauth-credentials/services/oauth-credentials.service';
import { OAuthExchangeService } from '../../../v1/oauth-credentials/services/oauth-exchange.service';
import { SecretEntity } from '../../../v1/secrets/entity/secret.entity';
import { SecretsStoreService } from '../../../v1/secrets-store/services/secrets-store.service';
import { createTestProject } from '../helpers/test-context';
import { createTestModule } from '../setup';

const TOKEN_KEY = 'LINEAR_OAUTH_TOKEN';
const REFRESH_KEY = 'LINEAR_OAUTH_REFRESH';
const CLIENT_SECRET_KEY = 'LINEAR_OAUTH_CLIENT_SECRET';

// Toggleable OpenBao availability + an in-memory KV stand-in (mirrors
// oauth-credentials.int.ts so the refresh suite never reaches a real store).
const storeState = { available: true };
const kvStore = new Map<string, string>();

const mockStore = {
  isAvailable: vi.fn(() => storeState.available),
  putSecret: vi.fn(async (projectId: string, name: string, value: string) => {
    kvStore.set(`${projectId}:${name}`, value);
  }),
  getSecret: vi.fn(
    async (projectId: string, name: string) =>
      kvStore.get(`${projectId}:${name}`) ?? '',
  ),
  deleteSecret: vi.fn(async (projectId: string, name: string) => {
    kvStore.delete(`${projectId}:${name}`);
  }),
};

interface TokenResult {
  accessToken: string;
  scopes: string[] | null;
  expiresAt: Date | null;
  refreshToken: string | null;
  accountLabel: string | null;
}

// prepareAuthorization (discovery + DCR) / exchangeAuthorizationCode (token leg)
// / refreshAccessToken (refresh leg) are all stubbed so the suite is hermetic.
const mockExchange = {
  prepareAuthorization: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  refreshAccessToken: vi.fn(),
};

describe('OAuth refresh-token rotation (integration)', () => {
  let app: INestApplication;
  let service: OAuthCredentialsService;
  let projectId: string;
  let ctx: AppContextStorage;

  beforeAll(async () => {
    app = await createTestModule(async (builder) =>
      builder
        .overrideProvider(OAuthExchangeService)
        .useValue(mockExchange)
        .overrideProvider(SecretsStoreService)
        .useValue(mockStore)
        .compile(),
    );
    service = app.get(OAuthCredentialsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    storeState.available = true;
    kvStore.clear();
    mockStore.putSecret.mockClear();
    mockStore.deleteSecret.mockClear();
    mockStore.getSecret.mockClear();
    mockStore.isAvailable.mockClear();
    vi.restoreAllMocks();

    mockExchange.prepareAuthorization.mockReset();
    mockExchange.exchangeAuthorizationCode.mockReset();
    mockExchange.refreshAccessToken.mockReset();

    const created = await createTestProject(app);
    projectId = created.projectId;
    ctx = created.ctx;
  });

  afterEach(async () => {
    const em = app.get(EntityManager).fork();
    await em.nativeDelete(OAuthCredentialEntity, { projectId });
    await em.nativeDelete(SecretEntity, { projectId });
  });

  /** Run start() + exchange() with a given token result + DCR client. */
  const doExchange = async (
    token: TokenResult,
    client: { clientId: string; clientSecret: string | null } = {
      clientId: 'dcr-client-test',
      clientSecret: null,
    },
  ): Promise<void> => {
    mockExchange.prepareAuthorization.mockImplementation(
      async (_p: OAuthProvider, _r: string, state: string) => ({
        authorizeUrl: `https://mock.authorize.test/?state=${state}`,
        client,
      }),
    );
    mockExchange.exchangeAuthorizationCode.mockResolvedValueOnce(token);
    const { authorizeUrl } = await service.start(ctx, OAuthProvider.Linear, {});
    const state = new URL(authorizeUrl).searchParams.get('state') as string;
    await service.exchange(ctx, {
      provider: OAuthProvider.Linear,
      code: 'code-1',
      state,
    });
  };

  const loadCredential = async (): Promise<OAuthCredentialEntity | null> => {
    const em = app.get(EntityManager).fork();
    return await em.findOne(OAuthCredentialEntity, {
      projectId,
      provider: OAuthProvider.Linear,
    });
  };

  const futureDate = (ms: number): Date => new Date(Date.now() + ms);

  it('exchange() captures the refresh token + client_secret as sibling KV keys and persists the issuing client_id', async () => {
    await doExchange(
      {
        accessToken: 'access-v1',
        scopes: ['read'],
        expiresAt: futureDate(3_600_000),
        refreshToken: 'refresh-v1',
        accountLabel: 'Acme',
      },
      { clientId: 'dcr-client-1', clientSecret: 'client-shh' },
    );

    // The token + its two siblings live in OpenBao under the deterministic keys.
    expect(kvStore.get(`${projectId}:${TOKEN_KEY}`)).toBe('access-v1');
    expect(kvStore.get(`${projectId}:${REFRESH_KEY}`)).toBe('refresh-v1');
    expect(kvStore.get(`${projectId}:${CLIENT_SECRET_KEY}`)).toBe('client-shh');

    // The issuing client_id is durable on the row; a fresh exchange is not a
    // refresh, so lastRefreshedAt stays null.
    const cred = await loadCredential();
    expect(cred?.clientId).toBe('dcr-client-1');
    expect(cred?.lastRefreshedAt ?? null).toBeNull();
  });

  it('exchange() does not write the refresh / client_secret siblings when the grant carries none', async () => {
    await doExchange({
      accessToken: 'access-v1',
      scopes: ['read'],
      expiresAt: futureDate(3_600_000),
      refreshToken: null,
      accountLabel: 'Acme',
    });

    expect(kvStore.get(`${projectId}:${TOKEN_KEY}`)).toBe('access-v1');
    expect(kvStore.has(`${projectId}:${REFRESH_KEY}`)).toBe(false);
    expect(kvStore.has(`${projectId}:${CLIENT_SECRET_KEY}`)).toBe(false);
    const cred = await loadCredential();
    expect(cred?.clientId).toBe('dcr-client-test');
  });

  it('refreshIfNeeded() rotates a near-expiry token and updates expiresAt + lastRefreshedAt + scopes', async () => {
    await doExchange(
      {
        accessToken: 'access-v1',
        scopes: ['read'],
        expiresAt: futureDate(30_000), // within the 60s skew -> needs refresh
        refreshToken: 'refresh-v1',
        accountLabel: 'Acme',
      },
      { clientId: 'dcr-client-1', clientSecret: 'client-shh' },
    );

    mockExchange.refreshAccessToken.mockResolvedValueOnce({
      accessToken: 'access-v2',
      scopes: null, // refresh responses often omit scope -> prior kept
      expiresAt: futureDate(3_600_000),
      refreshToken: null, // non-rotating provider
      accountLabel: null,
    });

    const status = await service.refreshIfNeeded(ctx, OAuthProvider.Linear);
    expect(status.authenticated).toBe(true);

    // Refresh delegated with the STORED refresh token + the persisted client.
    expect(mockExchange.refreshAccessToken).toHaveBeenCalledWith(
      OAuthProvider.Linear,
      'refresh-v1',
      { clientId: 'dcr-client-1', clientSecret: 'client-shh' },
    );

    // Access token rotated in OpenBao; the refresh token is KEPT (none issued).
    expect(kvStore.get(`${projectId}:${TOKEN_KEY}`)).toBe('access-v2');
    expect(kvStore.get(`${projectId}:${REFRESH_KEY}`)).toBe('refresh-v1');

    const cred = await loadCredential();
    expect(cred?.lastRefreshedAt).toBeInstanceOf(Date);
    expect((cred?.expiresAt as Date).getTime()).toBeGreaterThan(
      Date.now() + 60_000,
    );
    expect(cred?.scopes).toEqual(['read']); // kept — refresh returned no scope
  });

  it('refreshIfNeeded() persists a rotated refresh token when the provider issues one', async () => {
    await doExchange({
      accessToken: 'access-v1',
      scopes: ['read'],
      expiresAt: futureDate(30_000),
      refreshToken: 'refresh-v1',
      accountLabel: 'Acme',
    });

    mockExchange.refreshAccessToken.mockResolvedValueOnce({
      accessToken: 'access-v2',
      scopes: ['read', 'write'],
      expiresAt: futureDate(3_600_000),
      refreshToken: 'refresh-v2', // rotated
      accountLabel: null,
    });

    await service.refreshIfNeeded(ctx, OAuthProvider.Linear);

    expect(kvStore.get(`${projectId}:${REFRESH_KEY}`)).toBe('refresh-v2');
    const cred = await loadCredential();
    expect(cred?.scopes).toEqual(['read', 'write']); // refresh returned scope
  });

  it('refreshIfNeeded() no-ops a still-fresh token', async () => {
    await doExchange({
      accessToken: 'access-v1',
      scopes: ['read'],
      expiresAt: futureDate(3_600_000), // far from expiry
      refreshToken: 'refresh-v1',
      accountLabel: 'Acme',
    });

    const status = await service.refreshIfNeeded(ctx, OAuthProvider.Linear);

    expect(mockExchange.refreshAccessToken).not.toHaveBeenCalled();
    expect(status.authenticated).toBe(true);
    expect(kvStore.get(`${projectId}:${TOKEN_KEY}`)).toBe('access-v1');
    const cred = await loadCredential();
    expect(cred?.lastRefreshedAt ?? null).toBeNull();
  });

  it('refreshIfNeeded() no-ops a credential with an unknown (null) expiry', async () => {
    // A null expiresAt means a non-expiring / unknown-expiry token; refreshing
    // blind could revoke a still-valid one, so it is left untouched.
    await doExchange({
      accessToken: 'access-v1',
      scopes: ['read'],
      expiresAt: null,
      refreshToken: 'refresh-v1',
      accountLabel: 'Acme',
    });

    const status = await service.refreshIfNeeded(ctx, OAuthProvider.Linear);

    expect(mockExchange.refreshAccessToken).not.toHaveBeenCalled();
    expect(status.authenticated).toBe(true); // null expiry reads as non-expiring
  });

  it('refreshIfNeeded() no-ops (stays unauthenticated) when no refresh token is stored', async () => {
    await doExchange({
      accessToken: 'access-v1',
      scopes: ['read'],
      expiresAt: new Date(Date.now() - 60_000), // already expired
      refreshToken: null, // nothing to refresh with
      accountLabel: 'Acme',
    });

    const status = await service.refreshIfNeeded(ctx, OAuthProvider.Linear);

    expect(mockExchange.refreshAccessToken).not.toHaveBeenCalled();
    // No refresh capability -> the credential stays past-expiry -> not authed
    // (it falls to re-auth, handled in M3.3), never a silent failure.
    expect(status.authenticated).toBe(false);
  });

  it('refreshIfNeeded() no-ops when the issuing client_id was not persisted', async () => {
    // A legacy M2 row: past-expiry, a stored refresh token, but NO durable
    // client. Seed it via the DAO with clientId already null (NOT via exchange,
    // which would persist a client), so the credential the service reads carries
    // no client — exactly the legacy-row shape this guard handles.
    await app.get(OAuthCredentialsDao).create({
      provider: OAuthProvider.Linear,
      accountLabel: 'Acme',
      secretName: TOKEN_KEY,
      scopes: ['read'],
      expiresAt: new Date(Date.now() - 60_000),
      clientId: null,
      lastRefreshedAt: null,
      createdBy: ctx.checkSub(),
      projectId,
    });
    kvStore.set(`${projectId}:${REFRESH_KEY}`, 'refresh-v1');

    const status = await service.refreshIfNeeded(ctx, OAuthProvider.Linear);

    expect(mockExchange.refreshAccessToken).not.toHaveBeenCalled();
    expect(status.authenticated).toBe(false);
  });

  it('refreshIfNeeded() returns not-authenticated when no credential exists', async () => {
    const status = await service.refreshIfNeeded(ctx, OAuthProvider.Linear);
    expect(status.authenticated).toBe(false);
    expect(mockExchange.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('refreshIfNeeded() rejects a header-unsafe refreshed token and does not overwrite OpenBao', async () => {
    await doExchange({
      accessToken: 'access-v1',
      scopes: ['read'],
      expiresAt: futureDate(30_000),
      refreshToken: 'refresh-v1',
      accountLabel: 'Acme',
    });

    // The AS returns a refreshed token carrying embedded whitespace — a value
    // that would be unsafe as an HTTP Authorization header.
    mockExchange.refreshAccessToken.mockResolvedValueOnce({
      accessToken: 'access v2 with space',
      scopes: null,
      expiresAt: futureDate(3_600_000),
      refreshToken: null,
      accountLabel: null,
    });

    await expect(
      service.refreshIfNeeded(ctx, OAuthProvider.Linear),
    ).rejects.toMatchObject({ errorCode: 'OAUTH_TOKEN_INVALID' });

    // The guard fires BEFORE any OpenBao write — the prior token is intact.
    expect(kvStore.get(`${projectId}:${TOKEN_KEY}`)).toBe('access-v1');
    expect(kvStore.get(`${projectId}:${REFRESH_KEY}`)).toBe('refresh-v1');
  });

  it('refreshIfNeeded() no-ops gracefully when the secrets store is unavailable', async () => {
    await doExchange(
      {
        accessToken: 'access-v1',
        scopes: ['read'],
        expiresAt: futureDate(30_000), // near expiry — would refresh if it could
        refreshToken: 'refresh-v1',
        accountLabel: 'Acme',
      },
      { clientId: 'dcr-client-1', clientSecret: 'client-shh' },
    );

    // OpenBao goes down between exchange and the run-start pre-flight.
    storeState.available = false;

    const status = await service.refreshIfNeeded(ctx, OAuthProvider.Linear);

    // Fail-soft: no refresh attempted; the credential is left as-is (still
    // authenticated by its not-yet-past expiry) to fall to re-auth later.
    expect(mockExchange.refreshAccessToken).not.toHaveBeenCalled();
    expect(status.authenticated).toBe(true);
    expect(kvStore.get(`${projectId}:${TOKEN_KEY}`)).toBe('access-v1');
  });

  it('exchange() rolls back the token + refresh + client_secret siblings when the DB upsert fails', async () => {
    // First exchange establishes prior values for all three sibling keys.
    await doExchange(
      {
        accessToken: 'access-v1',
        scopes: ['read'],
        expiresAt: futureDate(3_600_000),
        refreshToken: 'refresh-v1',
        accountLabel: 'Acme',
      },
      { clientId: 'dcr-client-1', clientSecret: 'client-shh-v1' },
    );
    expect(kvStore.get(`${projectId}:${TOKEN_KEY}`)).toBe('access-v1');
    expect(kvStore.get(`${projectId}:${REFRESH_KEY}`)).toBe('refresh-v1');
    expect(kvStore.get(`${projectId}:${CLIENT_SECRET_KEY}`)).toBe(
      'client-shh-v1',
    );

    // A re-auth rotating all three, but the DB transaction fails.
    mockExchange.prepareAuthorization.mockImplementation(
      async (_p: OAuthProvider, _r: string, state: string) => ({
        authorizeUrl: `https://mock.authorize.test/?state=${state}`,
        client: { clientId: 'dcr-client-2', clientSecret: 'client-shh-v2' },
      }),
    );
    mockExchange.exchangeAuthorizationCode.mockResolvedValueOnce({
      accessToken: 'access-v2',
      scopes: ['read', 'write'],
      expiresAt: futureDate(3_600_000),
      refreshToken: 'refresh-v2',
      accountLabel: 'Acme',
    });
    const txSpy = vi
      .spyOn(app.get(EntityManager), 'transactional')
      .mockRejectedValueOnce(new Error('db boom'));

    const { authorizeUrl } = await service.start(ctx, OAuthProvider.Linear, {});
    const state = new URL(authorizeUrl).searchParams.get('state') as string;
    await expect(
      service.exchange(ctx, {
        provider: OAuthProvider.Linear,
        code: 'code-2',
        state,
      }),
    ).rejects.toThrow(/db boom/);

    // All three OpenBao siblings restored to their pre-re-auth values — no
    // half-rotated secret set is left live.
    expect(kvStore.get(`${projectId}:${TOKEN_KEY}`)).toBe('access-v1');
    expect(kvStore.get(`${projectId}:${REFRESH_KEY}`)).toBe('refresh-v1');
    expect(kvStore.get(`${projectId}:${CLIENT_SECRET_KEY}`)).toBe(
      'client-shh-v1',
    );

    txSpy.mockRestore();
  });

  it('refreshIfNeeded() rolls the OpenBao writes back when the DB upsert fails', async () => {
    await doExchange(
      {
        accessToken: 'access-v1',
        scopes: ['read'],
        expiresAt: futureDate(30_000),
        refreshToken: 'refresh-v1',
        accountLabel: 'Acme',
      },
      { clientId: 'dcr-client-1', clientSecret: 'client-shh' },
    );

    mockExchange.refreshAccessToken.mockResolvedValueOnce({
      accessToken: 'access-v2',
      scopes: null,
      expiresAt: futureDate(3_600_000),
      refreshToken: 'refresh-v2', // rotated, so both KV keys are rewritten
      accountLabel: null,
    });

    // Inject a DB-transaction failure via the public em.transactional seam
    // (refactor-stable — mirrors the exchange-rollback adversarial test).
    const txSpy = vi
      .spyOn(app.get(EntityManager), 'transactional')
      .mockRejectedValueOnce(new Error('db boom'));

    await expect(
      service.refreshIfNeeded(ctx, OAuthProvider.Linear),
    ).rejects.toThrow(/db boom/);

    // The rollback restored OpenBao to its pre-refresh state — the still-valid
    // prior token + refresh token are intact, not left half-rotated.
    expect(kvStore.get(`${projectId}:${TOKEN_KEY}`)).toBe('access-v1');
    expect(kvStore.get(`${projectId}:${REFRESH_KEY}`)).toBe('refresh-v1');

    txSpy.mockRestore();
  });
});
