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
import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import { GraphEntity } from '../../../v1/graphs/entity/graph.entity';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { GraphRegistry } from '../../../v1/graphs/services/graph-registry';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { OAuthCredentialsDao } from '../../../v1/oauth-credentials/dao/oauth-credentials.dao';
import { OAuthCredentialEntity } from '../../../v1/oauth-credentials/entity/oauth-credential.entity';
import { OAuthProvider } from '../../../v1/oauth-credentials/oauth-credentials.types';
import { OAuthCredentialsService } from '../../../v1/oauth-credentials/services/oauth-credentials.service';
import { SecretsStoreService } from '../../../v1/secrets-store/services/secrets-store.service';
import { createTestProject } from '../helpers/test-context';
import { createTestModule, TEST_USER_ID } from '../setup';

// In-memory OpenBao stand-in. The expired-credential case bails in
// refreshIfNeeded before it ever reads the store (clientId is null). The gate's
// token-VALUE check (getValidatedAccessToken) DOES read the store via getSecret
// for an authenticated provider — getSecret returns '' for an unstored key, so
// the empty-token case rejects and the valid case must seed a real token.
const kvStore = new Map<string, string>();
const mockStore = {
  isAvailable: vi.fn(() => true),
  putSecret: vi.fn(async (p: string, n: string, v: string) => {
    kvStore.set(`${p}:${n}`, v);
  }),
  getSecret: vi.fn(
    async (p: string, n: string) => kvStore.get(`${p}:${n}`) ?? '',
  ),
  deleteSecret: vi.fn(async (p: string, n: string) => {
    kvStore.delete(`${p}:${n}`);
  }),
};

const OAUTH_ERROR = /Connect the following OAuth provider/i;

describe('OAuth deploy pre-flight gate (integration)', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let oauthService: OAuthCredentialsService;
  let oauthDao: OAuthCredentialsDao;
  let graphDao: GraphDao;
  let graphRegistry: GraphRegistry;
  let em: EntityManager;
  let projectId: string;
  let ctx: AppContextStorage;
  const createdGraphIds: string[] = [];

  beforeAll(async () => {
    app = await createTestModule(async (builder) =>
      builder
        .overrideProvider(SecretsStoreService)
        .useValue(mockStore)
        .compile(),
    );
    graphsService = app.get(GraphsService);
    oauthService = app.get(OAuthCredentialsService);
    oauthDao = app.get(OAuthCredentialsDao);
    graphDao = app.get(GraphDao);
    graphRegistry = app.get(GraphRegistry);
    em = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    kvStore.clear();
    // Reset call history so per-test assertions (e.g. "the store was never
    // consulted") are not polluted by a prior test's store access.
    mockStore.getSecret.mockClear();
    mockStore.putSecret.mockClear();
    mockStore.deleteSecret.mockClear();
    const created = await createTestProject(app);
    projectId = created.projectId;
    ctx = created.ctx;
  });

  afterEach(async () => {
    for (const id of createdGraphIds) {
      try {
        await graphRegistry.destroy(id);
      } catch {
        // Not all graphs reach a registered/running state.
      }
    }
    createdGraphIds.length = 0;
    const forked = em.fork();
    await forked.nativeDelete(GraphEntity, { projectId });
    await forked.nativeDelete(OAuthCredentialEntity, { projectId });
  });

  // Seed a graph (bypassing create()'s schema validation, which would reject a
  // Linear-MCP node without a Runtime edge) carrying a single OAuth-MCP node.
  const seedLinearGraph = async (): Promise<string> => {
    const graph = await graphDao.create({
      name: 'Linear MCP graph',
      version: '1.0.0',
      targetVersion: '1.0.0',
      status: GraphStatus.Created,
      createdBy: TEST_USER_ID,
      projectId,
      settings: {},
      temporary: true,
      schema: {
        nodes: [
          {
            id: 'linear-1',
            template: 'linear-mcp',
            config: { token: 'LINEAR_OAUTH_TOKEN' },
          },
        ],
        edges: [],
      },
    });
    createdGraphIds.push(graph.id);
    return graph.id;
  };

  const seedCredential = async (
    overrides: Partial<OAuthCredentialEntity>,
  ): Promise<void> => {
    await oauthDao.create({
      provider: OAuthProvider.Linear,
      accountLabel: 'Acme',
      secretName: 'LINEAR_OAUTH_TOKEN',
      scopes: ['read'],
      createdBy: TEST_USER_ID,
      projectId,
      ...overrides,
    });
  };

  it('rejects a deploy with a clean error and lands GraphStatus.Error when the OAuth credential is missing', async () => {
    const graphId = await seedLinearGraph();

    await expect(graphsService.run(ctx, graphId)).rejects.toThrow(OAUTH_ERROR);

    const row = await graphDao.getOne({ id: graphId });
    expect(row?.status).toBe(GraphStatus.Error);
    expect(row?.error ?? '').toMatch(OAUTH_ERROR);
  });

  it('rejects a deploy when the credential row is authenticated but the stored token is empty', async () => {
    const graphId = await seedLinearGraph();
    // Authenticated row (far-future expiry) but NO stored token value — the
    // degenerate state that previously injected an empty `Authorization: Bearer `
    // header and hung the MCP. The gate must catch it via the token-VALUE check,
    // not just the credential-row status.
    await seedCredential({
      expiresAt: new Date(Date.now() + 3_600_000),
      clientId: 'dcr-client-test',
    });
    // kvStore intentionally has no LINEAR_OAUTH_TOKEN -> getSecret returns ''.

    await expect(graphsService.run(ctx, graphId)).rejects.toThrow(OAUTH_ERROR);

    const row = await graphDao.getOne({ id: graphId });
    expect(row?.status).toBe(GraphStatus.Error);
    expect(row?.error ?? '').toMatch(OAUTH_ERROR);
  });

  it('rejects a deploy when the credential is expired and not refreshable (no issuing client)', async () => {
    const graphId = await seedLinearGraph();
    // Past expiry + null clientId -> refreshIfNeeded cannot rotate and returns
    // an unauthenticated status without touching the secrets store.
    await seedCredential({
      expiresAt: new Date(Date.now() - 60_000),
      clientId: null,
    });

    await expect(graphsService.run(ctx, graphId)).rejects.toThrow(OAUTH_ERROR);

    const row = await graphDao.getOne({ id: graphId });
    expect(row?.status).toBe(GraphStatus.Error);
    expect(row?.error ?? '').toMatch(OAUTH_ERROR);

    // The store was never consulted (no refresh attempted for a clientless cred).
    expect(mockStore.getSecret).not.toHaveBeenCalled();

    // expiresAt is surfaced even for an expired/unauthenticated credential (the
    // field sits OUTSIDE the authenticated-gated ternary so the client can show
    // "expired"); accountLabel/secretName are nulled when unauthenticated.
    const status = await oauthService.status(ctx, OAuthProvider.Linear);
    expect(status.authenticated).toBe(false);
    expect(status.expiresAt).not.toBeNull();
    expect(status.secretName).toBeNull();
  });

  it(
    'does NOT block the deploy on the OAuth gate when a valid credential exists',
    { timeout: 30000 },
    async () => {
      const graphId = await seedLinearGraph();
      // Far-future expiry -> refreshIfNeeded short-circuits as fresh; status is
      // authenticated, so the gate passes. The run may still fail downstream
      // (this lone Linear-MCP node has no Runtime edge) — that is NOT the gate.
      await seedCredential({
        expiresAt: new Date(Date.now() + 3_600_000),
        clientId: 'dcr-client-test',
      });
      // A genuinely valid credential is a row PLUS a non-empty stored token —
      // the gate now verifies the token VALUE (an empty stored token would
      // inject an empty Bearer and hang the MCP), so seed the secret too.
      kvStore.set(
        `${projectId}:LINEAR_OAUTH_TOKEN`,
        'lin_oauth_valid-token-123',
      );

      // Spy (call-through) so "the gate actually executed and saw the node"
      // is load-bearing — without this, the test would pass vacuously if
      // collectOAuthNodes regressed to returning [] and the gate never ran.
      const refreshSpy = vi.spyOn(oauthService, 'refreshIfNeeded');

      let caught: unknown;
      try {
        await graphsService.run(ctx, graphId);
      } catch (error) {
        caught = error;
      }
      const message = caught instanceof Error ? caught.message : '';
      expect(message).not.toMatch(OAUTH_ERROR);

      // The gate identified the OAuth node and rotated/checked the provider.
      expect(refreshSpy).toHaveBeenCalledWith(ctx, OAuthProvider.Linear);
      refreshSpy.mockRestore();

      // Confirm the seeded credential is what the gate saw as valid.
      const status = await oauthService.status(ctx, OAuthProvider.Linear);
      expect(status.authenticated).toBe(true);
      expect(status.expiresAt).not.toBeNull();
    },
  );
});
