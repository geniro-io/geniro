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
import { OAuthCredentialEntity } from '../../../v1/oauth-credentials/entity/oauth-credential.entity';
import { OAuthProvider } from '../../../v1/oauth-credentials/oauth-credentials.types';
import { OAuthCredentialsService } from '../../../v1/oauth-credentials/services/oauth-credentials.service';
import { OAuthExchangeService } from '../../../v1/oauth-credentials/services/oauth-exchange.service';
import { SecretEntity } from '../../../v1/secrets/entity/secret.entity';
import { SecretsStoreService } from '../../../v1/secrets-store/services/secrets-store.service';
import { createTestProject } from '../helpers/test-context';
import { createTestModule } from '../setup';

const SECRET_KEY = (projectId: string): string =>
  `${projectId}:LINEAR_OAUTH_TOKEN`;

// Toggleable OpenBao availability + an in-memory KV stand-in (mirrors the
// canonical oauth-credentials.int.ts harness so behaviour matches production).
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

const mockExchange = {
  isProviderConfigured: vi.fn().mockReturnValue(true),
  resolveClientCredentials: vi.fn().mockReturnValue({
    clientId: 'test-client-id',
    clientSecret: 'test-secret',
  }),
  exchangeAuthorizationCode: vi.fn(),
};

const startState = async (
  service: OAuthCredentialsService,
  ctx: AppContextStorage,
): Promise<string> => {
  const { authorizeUrl } = await service.start(ctx, OAuthProvider.Linear, {});
  return new URL(authorizeUrl).searchParams.get('state') as string;
};

describe('OAuthCredentials exchange rollback/concurrency (adversarial)', () => {
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
    mockExchange.isProviderConfigured.mockReturnValue(true);
    mockExchange.exchangeAuthorizationCode.mockReset();
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

  it('preserves the prior token value when a RE-AUTH transaction fails after the OpenBao overwrite', async () => {
    // First exchange succeeds: token-v1 is stored in OpenBao and a live
    // credential row references LINEAR_OAUTH_TOKEN.
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
    expect(kvStore.get(SECRET_KEY(projectId))).toBe('token-v1');

    // Second exchange (re-auth): putSecret overwrites OpenBao with token-v2,
    // THEN the DB transaction fails. The rollback leaves the prior credential
    // row active and still pointing at LINEAR_OAUTH_TOKEN — so the OpenBao
    // value MUST NOT be destroyed by the compensation path, otherwise the live
    // credential references an empty secret (silent auth breakage at run time).
    const em = app.get(EntityManager);
    const txSpy = vi
      .spyOn(em, 'transactional')
      .mockRejectedValueOnce(new Error('simulated tx failure'));

    const s2 = await startState(service, ctx);
    await expect(
      service.exchange(ctx, {
        provider: OAuthProvider.Linear,
        code: 'c2',
        state: s2,
      }),
    ).rejects.toThrow();
    txSpy.mockRestore();

    // The credential row from the first exchange is still active...
    const liveEm = app.get(EntityManager).fork();
    const cred = await liveEm.findOne(OAuthCredentialEntity, {
      projectId,
      provider: OAuthProvider.Linear,
    });
    expect(cred?.secretName).toBe('LINEAR_OAUTH_TOKEN');

    // ...so the token it references MUST still resolve. Current code deletes it
    // unconditionally in the catch block — this assertion goes RED.
    expect(kvStore.get(SECRET_KEY(projectId))).toBeTruthy();
  });
});
