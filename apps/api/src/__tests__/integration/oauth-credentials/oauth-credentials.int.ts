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
import { CacheService } from '../../../v1/cache/services/cache.service';
import { NotificationEvent } from '../../../v1/notifications/notifications.types';
import { NotificationsService } from '../../../v1/notifications/services/notifications.service';
import { OAuthCredentialEntity } from '../../../v1/oauth-credentials/entity/oauth-credential.entity';
import {
  OAUTH_STATE_CACHE_PREFIX,
  OAUTH_STATE_TTL_SECONDS,
  OAuthProvider,
} from '../../../v1/oauth-credentials/oauth-credentials.types';
import { OAuthCapabilityLinkService } from '../../../v1/oauth-credentials/services/oauth-capability-link.service';
import { OAuthCredentialsService } from '../../../v1/oauth-credentials/services/oauth-credentials.service';
import { OAuthExchangeService } from '../../../v1/oauth-credentials/services/oauth-exchange.service';
import { SecretEntity } from '../../../v1/secrets/entity/secret.entity';
import { SecretsStoreService } from '../../../v1/secrets-store/services/secrets-store.service';
import { buildTestContext, createTestProject } from '../helpers/test-context';
import { createTestModule, TEST_USER_ID } from '../setup';

const OTHER_USER_ID = '00000000-0000-0000-0000-0000000000aa';

// Toggleable OpenBao availability + an in-memory KV stand-in.
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

// The exchange service is overridden so the integration suite never reaches the
// real provider over the network. start() -> prepareAuthorization (discovery +
// DCR), exchange() -> exchangeAuthorizationCode. The mock authorize URL embeds
// the `state` passed in so the startState() helper can recover it.
const defaultPrepareAuthorization = async (
  _provider: OAuthProvider,
  _redirectUri: string,
  state: string,
): Promise<{
  authorizeUrl: string;
  client: { clientId: string; clientSecret: string | null };
}> => ({
  authorizeUrl: `https://mock.authorize.test/?state=${state}`,
  client: { clientId: 'dcr-client-test', clientSecret: null },
});

const mockExchange = {
  prepareAuthorization: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
};

const startState = async (
  service: OAuthCredentialsService,
  ctx: AppContextStorage,
  query: { graphId?: string; nodeId?: string } = {},
): Promise<string> => {
  const { authorizeUrl } = await service.start(
    ctx,
    OAuthProvider.Linear,
    query,
  );
  return new URL(authorizeUrl).searchParams.get('state') as string;
};

describe('OAuthCredentials (integration)', () => {
  let app: INestApplication;
  let service: OAuthCredentialsService;
  let capabilityLink: OAuthCapabilityLinkService;
  let cache: CacheService;
  let notifications: NotificationsService;
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
    capabilityLink = app.get(OAuthCapabilityLinkService);
    cache = app.get(CacheService);
    notifications = app.get(NotificationsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    storeState.available = true;
    kvStore.clear();
    // These are module-scope vi.fn() stubs — restoreAllMocks does NOT clear
    // their call history, so clear it explicitly for per-test isolation.
    mockStore.putSecret.mockClear();
    mockStore.deleteSecret.mockClear();
    mockStore.getSecret.mockClear();
    mockStore.isAvailable.mockClear();
    vi.restoreAllMocks();

    // Re-establish the exchange-service mock defaults AFTER restoreAllMocks so
    // they survive into the test body.
    mockExchange.prepareAuthorization.mockReset();
    mockExchange.prepareAuthorization.mockImplementation(
      defaultPrepareAuthorization,
    );
    mockExchange.exchangeAuthorizationCode.mockReset();

    const created = await createTestProject(app);
    projectId = created.projectId;
    ctx = created.ctx;
  });

  afterEach(async () => {
    const em = app.get(EntityManager).fork();
    await em.nativeDelete(OAuthCredentialEntity, { projectId });
    await em.nativeDelete(SecretEntity, { projectId });
  });

  it('start() registers a per-flow DCR client and persists the verifier + client + state server-side', async () => {
    const state = await startState(service, ctx, {
      graphId: 'g1',
      nodeId: 'n1',
    });

    // Discovery + DCR happen via the exchange service, keyed on the same
    // redirect_uri the exchange will use later.
    expect(mockExchange.prepareAuthorization).toHaveBeenCalledWith(
      OAuthProvider.Linear,
      expect.stringContaining('/oauth/callback/linear'),
      state,
      expect.any(String),
    );

    const cached = await cache.get(`${OAUTH_STATE_CACHE_PREFIX}${state}`);
    expect(cached).toBeTruthy();
    const pending = JSON.parse(cached as string);
    expect(pending.projectId).toBe(projectId);
    expect(pending.provider).toBe(OAuthProvider.Linear);
    expect(typeof pending.codeVerifier).toBe('string');
    // The DCR-registered client is carried in the pending-state.
    expect(pending.clientId).toBe('dcr-client-test');
    expect(pending.clientSecret).toBeNull();
    expect(pending.graphId).toBe('g1');
    expect(pending.nodeId).toBe('n1');
  });

  it('start() fails CLOSED on a discovery/registration failure — no pending-state written', async () => {
    mockExchange.prepareAuthorization.mockRejectedValueOnce(
      new Error('OAUTH_DISCOVERY_FAILED'),
    );
    const setSpy = vi.spyOn(cache, 'set');

    await expect(service.start(ctx, OAuthProvider.Linear, {})).rejects.toThrow(
      /OAUTH_DISCOVERY_FAILED/,
    );

    // No partial pending-state is persisted when discovery/registration throws.
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('exchange() fails CLOSED when the secrets store is unavailable', async () => {
    storeState.available = false;
    const state = await startState(service, ctx);
    await expect(
      service.exchange(ctx, {
        provider: OAuthProvider.Linear,
        code: 'code-1',
        state,
      }),
    ).rejects.toThrow(/SECRETS_STORE_UNAVAILABLE|OpenBao/i);
    // Nothing persisted, exchange never attempted.
    expect(mockExchange.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('exchange() rejects an unknown state', async () => {
    await expect(
      service.exchange(ctx, {
        provider: OAuthProvider.Linear,
        code: 'code-1',
        state: 'does-not-exist',
      }),
    ).rejects.toThrow(/OAUTH_STATE_INVALID/);
  });

  it('exchange() rejects a state minted by a different user', async () => {
    // The project is taken from the server-stored state; ownership is enforced
    // by the same-user (createdBy) check, so a different authenticated user
    // cannot complete this flow.
    const state = await startState(service, ctx);
    const otherUserCtx = buildTestContext(OTHER_USER_ID, projectId);
    await expect(
      service.exchange(otherUserCtx, {
        provider: OAuthProvider.Linear,
        code: 'code-1',
        state,
      }),
    ).rejects.toThrow(/OAUTH_STATE_MISMATCH/);
  });

  it('exchange() stores the token, upserts the credential, and emits credential.acquired', async () => {
    mockExchange.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'lin_oauth_token_123',
      scopes: ['read', 'write'],
      expiresAt: null,
      accountLabel: 'Acme Workspace',
    });
    const emitSpy = vi.spyOn(notifications, 'emit');

    const state = await startState(service, ctx, {
      graphId: 'g1',
      nodeId: 'n1',
    });
    const result = await service.exchange(ctx, {
      provider: OAuthProvider.Linear,
      code: 'code-1',
      state,
    });

    expect(result.accountLabel).toBe('Acme Workspace');
    expect(result.secretName).toBe('LINEAR_OAUTH_TOKEN');

    // exchange() delegates with the stored DCR client and the SAME redirect_uri
    // start() used (byte-exact across the two service methods, both derived from
    // redirectUri(provider)); this pins the positional contract against drift.
    expect(mockExchange.exchangeAuthorizationCode).toHaveBeenCalledWith(
      OAuthProvider.Linear,
      'code-1',
      expect.any(String),
      expect.stringContaining('/oauth/callback/linear'),
      { clientId: 'dcr-client-test', clientSecret: null },
    );

    // Token written to OpenBao + a selectable secrets row created.
    expect(mockStore.putSecret).toHaveBeenCalledWith(
      projectId,
      'LINEAR_OAUTH_TOKEN',
      'lin_oauth_token_123',
    );
    const em = app.get(EntityManager).fork();
    const secretRow = await em.findOne(SecretEntity, {
      projectId,
      name: 'LINEAR_OAUTH_TOKEN',
    });
    expect(secretRow).toBeTruthy();
    const credRow = await em.findOne(OAuthCredentialEntity, {
      projectId,
      provider: OAuthProvider.Linear,
    });
    expect(credRow?.accountLabel).toBe('Acme Workspace');
    expect(credRow?.secretName).toBe('LINEAR_OAUTH_TOKEN');

    // Authoritative server-side completion signal.
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: NotificationEvent.CredentialAcquired,
        projectId,
        graphId: 'g1',
        nodeId: 'n1',
        data: expect.objectContaining({
          provider: OAuthProvider.Linear,
          accountLabel: 'Acme Workspace',
        }),
      }),
    );

    // State is single-use — consumed on exchange.
    expect(await cache.get(`${OAUTH_STATE_CACHE_PREFIX}${state}`)).toBeNull();

    // /status now reflects the credential.
    const status = await service.status(ctx, OAuthProvider.Linear);
    expect(status.authenticated).toBe(true);
    expect(status.accountLabel).toBe('Acme Workspace');
    expect(status.secretName).toBe('LINEAR_OAUTH_TOKEN');
  });

  it('exchange() falls back to the provider name when the token carries no account label', async () => {
    // An MCP-scoped DCR token does not authenticate an identity probe, so the
    // provider returns accountLabel: null — the service supplies the provider
    // name as the single source of truth.
    mockExchange.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'lin_oauth_token_nolabel',
      scopes: ['read'],
      expiresAt: null,
      accountLabel: null,
    });
    const state = await startState(service, ctx);
    const result = await service.exchange(ctx, {
      provider: OAuthProvider.Linear,
      code: 'code-1',
      state,
    });

    expect(result.accountLabel).toBe(OAuthProvider.Linear);
    const em = app.get(EntityManager).fork();
    const cred = await em.findOne(OAuthCredentialEntity, {
      projectId,
      provider: OAuthProvider.Linear,
    });
    expect(cred?.accountLabel).toBe(OAuthProvider.Linear);
  });

  it('status() reports not-authenticated when no credential exists', async () => {
    const status = await service.status(ctx, OAuthProvider.Linear);
    expect(status.authenticated).toBe(false);
    expect(status.accountLabel).toBeNull();
    expect(status.secretName).toBeNull();
  });

  it('exchange() is idempotent on rotation — one row, rotated value + scopes', async () => {
    mockExchange.exchangeAuthorizationCode
      .mockResolvedValueOnce({
        accessToken: 'token-v1',
        scopes: ['read'],
        expiresAt: null,
        accountLabel: 'Acme',
      })
      .mockResolvedValueOnce({
        accessToken: 'token-v2',
        scopes: ['read', 'write'],
        expiresAt: null,
        accountLabel: 'Acme',
      });

    const s1 = await startState(service, ctx);
    await service.exchange(ctx, {
      provider: OAuthProvider.Linear,
      code: 'c1',
      state: s1,
    });
    const s2 = await startState(service, ctx);
    await service.exchange(ctx, {
      provider: OAuthProvider.Linear,
      code: 'c2',
      state: s2,
    });

    const em = app.get(EntityManager).fork();
    const creds = await em.find(OAuthCredentialEntity, {
      projectId,
      provider: OAuthProvider.Linear,
    });
    expect(creds).toHaveLength(1);
    expect(creds[0]?.scopes).toEqual(['read', 'write']);

    const secrets = await em.find(SecretEntity, {
      projectId,
      name: 'LINEAR_OAUTH_TOKEN',
    });
    expect(secrets).toHaveLength(1);

    // The OpenBao value rotated to the latest token.
    expect(kvStore.get(`${projectId}:LINEAR_OAUTH_TOKEN`)).toBe('token-v2');
  });

  it('exchange() rejects a header-unsafe token BEFORE writing to OpenBao', async () => {
    // A token carrying embedded whitespace is header-unsafe — the guard fires
    // before any secret is persisted.
    mockExchange.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'lin oauth token with space',
      scopes: ['read'],
      expiresAt: null,
      accountLabel: 'Acme',
    });
    const state = await startState(service, ctx);
    // The code is on `errorCode`; the message is the human description.
    await expect(
      service.exchange(ctx, {
        provider: OAuthProvider.Linear,
        code: 'code-1',
        state,
      }),
    ).rejects.toMatchObject({ errorCode: 'OAUTH_TOKEN_INVALID' });
    // Token never reached the store; no credential/secret rows written.
    expect(mockStore.putSecret).not.toHaveBeenCalled();
    const em = app.get(EntityManager).fork();
    expect(
      await em.count(OAuthCredentialEntity, {
        projectId,
        provider: OAuthProvider.Linear,
      }),
    ).toBe(0);
  });

  it('exchange() rejects malformed or partial server-stored state', async () => {
    // Seed the cache directly so the state survives the existence check but
    // fails the JSON / shape validation in loadPendingState.
    const malformed = 'malformed-state';
    await cache.set(
      `${OAUTH_STATE_CACHE_PREFIX}${malformed}`,
      'not-json{',
      OAUTH_STATE_TTL_SECONDS,
    );
    await expect(
      service.exchange(ctx, {
        provider: OAuthProvider.Linear,
        code: 'code-1',
        state: malformed,
      }),
    ).rejects.toThrow(/OAUTH_STATE_INVALID/);

    const partial = 'partial-state';
    await cache.set(
      `${OAUTH_STATE_CACHE_PREFIX}${partial}`,
      JSON.stringify({ projectId: 'p', provider: OAuthProvider.Linear }),
      OAUTH_STATE_TTL_SECONDS,
    );
    await expect(
      service.exchange(ctx, {
        provider: OAuthProvider.Linear,
        code: 'code-1',
        state: partial,
      }),
    ).rejects.toThrow(/OAUTH_STATE_INVALID/);
    expect(mockExchange.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('exchange() resurrects soft-deleted secret + credential rows on re-auth', async () => {
    mockExchange.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'token-1',
      scopes: ['read'],
      expiresAt: null,
      accountLabel: 'Acme',
    });
    const s1 = await startState(service, ctx);
    await service.exchange(ctx, {
      provider: OAuthProvider.Linear,
      code: 'c1',
      state: s1,
    });

    // Simulate the user deleting the stored secret + credential (soft delete).
    const delEm = app.get(EntityManager).fork();
    await delEm.nativeUpdate(
      SecretEntity,
      { projectId, name: 'LINEAR_OAUTH_TOKEN' },
      { deletedAt: new Date() },
    );
    await delEm.nativeUpdate(
      OAuthCredentialEntity,
      { projectId, provider: OAuthProvider.Linear },
      { deletedAt: new Date() },
    );

    // Re-auth must resurrect the soft-deleted rows, not collide with the plain
    // UNIQUE constraint (the regression this guards is a 500 on re-auth).
    const s2 = await startState(service, ctx);
    await service.exchange(ctx, {
      provider: OAuthProvider.Linear,
      code: 'c2',
      state: s2,
    });

    const em = app.get(EntityManager).fork();
    const activeCreds = await em.find(OAuthCredentialEntity, {
      projectId,
      provider: OAuthProvider.Linear,
    });
    expect(activeCreds).toHaveLength(1);
    expect(activeCreds[0]?.deletedAt).toBeNull();
    // Including soft-deleted rows: still exactly one — resurrected, not duplicated.
    const allCreds = await em.find(
      OAuthCredentialEntity,
      { projectId, provider: OAuthProvider.Linear },
      { filters: { softDelete: false } },
    );
    expect(allCreds).toHaveLength(1);
    const allSecrets = await em.find(
      SecretEntity,
      { projectId, name: 'LINEAR_OAUTH_TOKEN' },
      { filters: { softDelete: false } },
    );
    expect(allSecrets).toHaveLength(1);
  });

  it('exchange() keys the credential on (project, provider) — account-label drift updates one row', async () => {
    mockExchange.exchangeAuthorizationCode
      .mockResolvedValueOnce({
        accessToken: 'token-a',
        scopes: ['read'],
        expiresAt: null,
        accountLabel: 'Acme Workspace',
      })
      .mockResolvedValueOnce({
        accessToken: 'token-b',
        scopes: ['read'],
        expiresAt: null,
        accountLabel: 'Acme Renamed',
      });

    const s1 = await startState(service, ctx);
    await service.exchange(ctx, {
      provider: OAuthProvider.Linear,
      code: 'c1',
      state: s1,
    });
    const s2 = await startState(service, ctx);
    await service.exchange(ctx, {
      provider: OAuthProvider.Linear,
      code: 'c2',
      state: s2,
    });

    const em = app.get(EntityManager).fork();
    const creds = await em.find(OAuthCredentialEntity, {
      projectId,
      provider: OAuthProvider.Linear,
    });
    // A different account label on re-auth must NOT create a second row.
    expect(creds).toHaveLength(1);
    expect(creds[0]?.accountLabel).toBe('Acme Renamed');
  });

  it('status() reports not-authenticated for an expired credential', async () => {
    mockExchange.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'token-expired',
      scopes: ['read'],
      expiresAt: new Date(Date.now() - 60_000),
      accountLabel: 'Acme',
    });
    const state = await startState(service, ctx);
    await service.exchange(ctx, {
      provider: OAuthProvider.Linear,
      code: 'code-1',
      state,
    });

    const status = await service.status(ctx, OAuthProvider.Linear);
    expect(status.authenticated).toBe(false);
    expect(status.accountLabel).toBeNull();
    expect(status.secretName).toBeNull();
  });

  it('exchange() is concurrency-safe — two racing exchanges converge to one row', async () => {
    // The atomic INSERT … ON CONFLICT upsert means two exchanges racing for the
    // same (projectId, provider) — a double-clicked Authenticate or two tabs —
    // converge on one row; neither hits a UNIQUE-constraint 500.
    mockExchange.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'token-concurrent',
      scopes: ['read'],
      expiresAt: null,
      accountLabel: 'Acme',
    });
    const s1 = await startState(service, ctx);
    const s2 = await startState(service, ctx);

    const results = await Promise.allSettled([
      service.exchange(ctx, {
        provider: OAuthProvider.Linear,
        code: 'c1',
        state: s1,
      }),
      service.exchange(ctx, {
        provider: OAuthProvider.Linear,
        code: 'c2',
        state: s2,
      }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const em = app.get(EntityManager).fork();
    expect(
      await em.count(OAuthCredentialEntity, {
        projectId,
        provider: OAuthProvider.Linear,
      }),
    ).toBe(1);
    expect(
      await em.count(SecretEntity, { projectId, name: 'LINEAR_OAUTH_TOKEN' }),
    ).toBe(1);
  });

  describe('start() capability-link redemption gate', () => {
    // The `?cap=` path re-opens a paused run's OAuth flow from ANY browser. The
    // opaque single-use token is the capability, but start() additionally
    // requires the authenticated user to match the run initiator (claims
    // `createdBy`) and the route provider to match the claims — a leaked link
    // can't be redeemed by a different logged-in user. NOTE: the wrong-PROVIDER
    // half of that gate isn't independently reachable today — `OAuthProvider`
    // has a single member (Linear) and `redeem()` re-validates the claim provider
    // against the enum, so `claims.provider` always equals the only route. It
    // becomes testable when a 2nd provider lands; the wrong-user half below is
    // the security-load-bearing case and is fully exercised.

    it('rejects a cap minted for another user, writing no pending-state', async () => {
      // Mint a REAL cap (claims resolve to TEST_USER_ID), so the rejection is
      // load-bearing: the gate rejects on the authenticated user, not on a
      // missing/empty claim (api-testing.md exclusion-test rule).
      const cap = await capabilityLink.mint({
        projectId,
        provider: OAuthProvider.Linear,
        threadId: `${projectId}:thread-cap`,
        createdBy: TEST_USER_ID,
      });
      const otherUserCtx = buildTestContext(OTHER_USER_ID, projectId);
      const setSpy = vi.spyOn(cache, 'set');

      await expect(
        service.start(otherUserCtx, OAuthProvider.Linear, { cap }),
      ).rejects.toThrow(/OAUTH_CAPABILITY_MISMATCH/);

      // The gate throws BEFORE discovery/registration and BEFORE any pending-state
      // write — a leaked link redeemed by the wrong user persists nothing.
      expect(mockExchange.prepareAuthorization).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('redeems a cap for the right user and binds project + thread from the claims', async () => {
      // The matching-user path recovers project + thread from the server-side
      // claims (the notification link is opened outside the editor tab, which
      // alone carries x-project-id). This is the contrast that makes the
      // wrong-user "no pending-state" assertion above meaningful.
      const threadId = `${projectId}:thread-cap`;
      const cap = await capabilityLink.mint({
        projectId,
        provider: OAuthProvider.Linear,
        threadId,
        createdBy: TEST_USER_ID,
      });

      const { authorizeUrl } = await service.start(ctx, OAuthProvider.Linear, {
        cap,
      });
      const state = new URL(authorizeUrl).searchParams.get('state') as string;

      const cached = await cache.get(`${OAUTH_STATE_CACHE_PREFIX}${state}`);
      expect(cached).toBeTruthy();
      const pending = JSON.parse(cached as string);
      expect(pending.projectId).toBe(projectId);
      expect(pending.threadId).toBe(threadId);
      expect(pending.createdBy).toBe(TEST_USER_ID);
    });

    it('rejects a replayed (single-use) cap', async () => {
      // The cap is consumed on first redeem (getDel) — a second start() with the
      // same token finds nothing.
      const cap = await capabilityLink.mint({
        projectId,
        provider: OAuthProvider.Linear,
        threadId: `${projectId}:thread-cap`,
        createdBy: TEST_USER_ID,
      });
      await service.start(ctx, OAuthProvider.Linear, { cap });
      await expect(
        service.start(ctx, OAuthProvider.Linear, { cap }),
      ).rejects.toThrow(/OAUTH_CAPABILITY_INVALID/);
    });
  });
});
