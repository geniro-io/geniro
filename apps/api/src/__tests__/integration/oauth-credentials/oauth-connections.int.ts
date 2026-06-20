import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplication } from '@nestjs/common';
import { NotFoundException } from '@packages/common';
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
import {
  OAuthProvider,
  OAuthTokenResult,
} from '../../../v1/oauth-credentials/oauth-credentials.types';
import { OAuthCredentialsService } from '../../../v1/oauth-credentials/services/oauth-credentials.service';
import { OAuthExchangeService } from '../../../v1/oauth-credentials/services/oauth-exchange.service';
import { SecretEntity } from '../../../v1/secrets/entity/secret.entity';
import { SecretsStoreService } from '../../../v1/secrets-store/services/secrets-store.service';
import { buildTestContext, createTestProject } from '../helpers/test-context';
import { createTestModule } from '../setup';

const OTHER_PROJECT_ID = '00000000-0000-0000-0000-0000000000bb';

// Toggleable OpenBao availability + an in-memory KV stand-in (mirrors
// oauth-credentials.int.ts). Keyed `${projectId}:${name}`.
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

// Exchange service is overridden so the suite never reaches the real provider.
// This variant registers a CONFIDENTIAL DCR client (so a client_secret sibling
// is written) and returns a refresh token, so disconnect has all three OpenBao
// keys to remove.
const mockExchange = {
  prepareAuthorization: vi.fn(
    async (_provider: OAuthProvider, _redirectUri: string, state: string) => ({
      authorizeUrl: `https://mock.authorize.test/?state=${state}`,
      client: { clientId: 'dcr-client-test', clientSecret: 'dcr-secret-test' },
    }),
  ),
  exchangeAuthorizationCode: vi.fn(
    async (): Promise<OAuthTokenResult> => ({
      accessToken: 'lin_oauth_token_123',
      scopes: ['read', 'write'],
      expiresAt: null,
      refreshToken: 'lin_refresh_123',
      accountLabel: 'Acme Workspace',
    }),
  ),
};

const connect = async (
  service: OAuthCredentialsService,
  ctx: AppContextStorage,
): Promise<void> => {
  const { authorizeUrl } = await service.start(ctx, OAuthProvider.Linear, {});
  const state = new URL(authorizeUrl).searchParams.get('state') as string;
  await service.exchange(ctx, {
    provider: OAuthProvider.Linear,
    code: 'code-1',
    state,
  });
};

describe('OAuth Connections — list + disconnect (integration)', () => {
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

    const created = await createTestProject(app);
    projectId = created.projectId;
    ctx = created.ctx;
  });

  afterEach(async () => {
    const em = app.get(EntityManager).fork();
    await em.nativeDelete(OAuthCredentialEntity, { projectId });
    await em.nativeDelete(SecretEntity, { projectId });
  });

  it('listCredentials() returns an empty array when the project has none', async () => {
    expect(await service.listCredentials(ctx)).toEqual([]);
  });

  it('listCredentials() reports a connected provider via the status projection', async () => {
    await connect(service, ctx);

    const list = await service.listCredentials(ctx);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      provider: OAuthProvider.Linear,
      authenticated: true,
      accountLabel: 'Acme Workspace',
      secretName: 'LINEAR_OAUTH_TOKEN',
    });
  });

  it('listCredentials() reports an expired credential as not-authenticated', async () => {
    mockExchange.exchangeAuthorizationCode.mockResolvedValueOnce({
      accessToken: 'lin_oauth_expired',
      scopes: ['read'],
      expiresAt: new Date(Date.now() - 60_000),
      refreshToken: null,
      accountLabel: 'Acme',
    });
    await connect(service, ctx);

    const list = await service.listCredentials(ctx);
    expect(list).toHaveLength(1);
    // buildStatus marks a stored-but-expired token not-authenticated (prompts
    // re-auth) but still surfaces the real expiry.
    expect(list[0]?.authenticated).toBe(false);
    expect(list[0]?.accountLabel).toBeNull();
    expect(list[0]?.expiresAt).not.toBeNull();
  });

  it('disconnect() soft-deletes the credential row + secrets row AND removes all three OpenBao keys', async () => {
    await connect(service, ctx);
    // All three sibling keys are present after a confidential-client exchange.
    expect(kvStore.get(`${projectId}:LINEAR_OAUTH_TOKEN`)).toBe(
      'lin_oauth_token_123',
    );
    expect(kvStore.get(`${projectId}:LINEAR_OAUTH_REFRESH`)).toBe(
      'lin_refresh_123',
    );
    expect(kvStore.get(`${projectId}:LINEAR_OAUTH_CLIENT_SECRET`)).toBe(
      'dcr-secret-test',
    );
    mockStore.deleteSecret.mockClear();

    await service.disconnect(ctx, OAuthProvider.Linear);

    // All three OpenBao sibling keys removed — no dangling secret.
    expect(mockStore.deleteSecret).toHaveBeenCalledWith(
      projectId,
      'LINEAR_OAUTH_TOKEN',
    );
    expect(mockStore.deleteSecret).toHaveBeenCalledWith(
      projectId,
      'LINEAR_OAUTH_REFRESH',
    );
    expect(mockStore.deleteSecret).toHaveBeenCalledWith(
      projectId,
      'LINEAR_OAUTH_CLIENT_SECRET',
    );
    expect(kvStore.has(`${projectId}:LINEAR_OAUTH_TOKEN`)).toBe(false);
    expect(kvStore.has(`${projectId}:LINEAR_OAUTH_REFRESH`)).toBe(false);
    expect(kvStore.has(`${projectId}:LINEAR_OAUTH_CLIENT_SECRET`)).toBe(false);

    // Credential row soft-deleted (excluded by the default filter, present with
    // a deletedAt when the filter is lifted).
    const em = app.get(EntityManager).fork();
    expect(
      await em.count(OAuthCredentialEntity, {
        projectId,
        provider: OAuthProvider.Linear,
      }),
    ).toBe(0);
    const allCreds = await em.find(
      OAuthCredentialEntity,
      { projectId, provider: OAuthProvider.Linear },
      { filters: { softDelete: false } },
    );
    expect(allCreds).toHaveLength(1);
    expect(allCreds[0]?.deletedAt).not.toBeNull();

    // The selectable `secrets` row is soft-deleted too — the secret-picker no
    // longer offers a credential whose backing value is gone.
    expect(
      await em.count(SecretEntity, { projectId, name: 'LINEAR_OAUTH_TOKEN' }),
    ).toBe(0);

    // listCredentials() no longer reports it.
    expect(await service.listCredentials(ctx)).toEqual([]);
  });

  it('disconnect() deletes the DB row before touching the store (no orphaned secret on a store error)', async () => {
    await connect(service, ctx);
    const dao = app.get(OAuthCredentialsDao);
    const deleteByIdSpy = vi.spyOn(dao, 'deleteById');
    mockStore.deleteSecret.mockClear();

    await service.disconnect(ctx, OAuthProvider.Linear);

    const rowOrder = deleteByIdSpy.mock.invocationCallOrder[0] ?? 0;
    const storeOrder = mockStore.deleteSecret.mock.invocationCallOrder[0] ?? 0;
    expect(rowOrder).toBeLessThan(storeOrder);
  });

  it('disconnect() throws NotFoundException when no credential exists', async () => {
    await expect(service.disconnect(ctx, OAuthProvider.Linear)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('disconnect() is project-scoped — a different project cannot disconnect this credential', async () => {
    await connect(service, ctx);
    // A context on a different project sees no credential → NotFound, and the
    // real credential is untouched.
    const otherProjectCtx = buildTestContext(ctx.checkSub(), OTHER_PROJECT_ID);
    await expect(
      service.disconnect(otherProjectCtx, OAuthProvider.Linear),
    ).rejects.toThrow(NotFoundException);
    expect(mockStore.deleteSecret).not.toHaveBeenCalled();

    const stillConnected = await service.listCredentials(ctx);
    expect(stillConnected).toHaveLength(1);
    expect(stillConnected[0]?.authenticated).toBe(true);
  });

  it('a provider can be re-connected after disconnect (rows resurrected)', async () => {
    await connect(service, ctx);
    await service.disconnect(ctx, OAuthProvider.Linear);
    expect(await service.listCredentials(ctx)).toEqual([]);

    await connect(service, ctx);

    const list = await service.listCredentials(ctx);
    expect(list).toHaveLength(1);
    expect(list[0]?.authenticated).toBe(true);
    // Exactly one row each — resurrected, not duplicated.
    const em = app.get(EntityManager).fork();
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
    // Resurrection must re-write the OpenBao token value too (disconnect deleted
    // it) — a row-only resurrection would list as connected but inject an empty
    // token at runtime.
    expect(kvStore.get(`${projectId}:LINEAR_OAUTH_TOKEN`)).toBe(
      'lin_oauth_token_123',
    );
  });

  it('disconnect() removes the refresh + client_secret keys even when the access-token key delete rejects', async () => {
    await connect(service, ctx);
    // The access-token metadata DELETE rejects (transient OpenBao 5xx) AFTER the
    // DB rows are soft-deleted. The DB rows are correctly gone, but the two
    // remaining sibling keys (refresh token + DCR client_secret) must STILL be
    // removed: a single transient fault on one of three idempotent deletes must
    // not strand live token material in OpenBao with no row pointing at it.
    mockStore.deleteSecret.mockImplementationOnce(async () => {
      throw new Error('SECRETS_STORE_DELETE_FAILED');
    });

    await service.disconnect(ctx, OAuthProvider.Linear).catch(() => undefined);

    // Primary invariant holds — the credential + selectable secret rows are gone.
    const em = app.get(EntityManager).fork();
    expect(
      await em.count(OAuthCredentialEntity, {
        projectId,
        provider: OAuthProvider.Linear,
      }),
    ).toBe(0);

    // The two sibling keys must NOT be stranded by the one rejected delete.
    expect(kvStore.has(`${projectId}:LINEAR_OAUTH_REFRESH`)).toBe(false);
    expect(kvStore.has(`${projectId}:LINEAR_OAUTH_CLIENT_SECRET`)).toBe(false);
  });
});
