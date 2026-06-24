import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplication } from '@nestjs/common';
import { InternalException } from '@packages/common';
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
import { GitUserPatEntity } from '../../../v1/git-auth/entity/git-user-pat.entity';
import { GitUserPatService } from '../../../v1/git-auth/services/git-user-pat.service';
import { SecretsStoreService } from '../../../v1/secrets-store/services/secrets-store.service';
import { buildTestContext } from '../helpers/test-context';
import { createTestModule, TEST_USER_ID } from '../setup';

// Toggleable secrets-store with an in-memory KV stand-in (the house pattern from
// oauth-credentials.int.ts). `throwOnRead` simulates a TRANSIENT OpenBao failure
// so the Q2 resolve-fallback path can be exercised against the real DB row.
const storeState = { throwOnRead: false };
const kvStore = new Map<string, string>();
const key = (userId: string, name: string): string => `${userId}:${name}`;

const mockStore = {
  isAvailable: vi.fn(() => true),
  putUserSecret: vi.fn(async (userId: string, name: string, value: string) => {
    kvStore.set(key(userId, name), value);
  }),
  deleteUserSecret: vi.fn(async (userId: string, name: string) => {
    kvStore.delete(key(userId, name));
  }),
  readUserSecret: vi.fn(async (userId: string, name: string) => {
    if (storeState.throwOnRead) {
      throw new InternalException('SECRETS_STORE_GET_FAILED', 'transient');
    }
    const value = kvStore.get(key(userId, name));
    return value === undefined ? { found: false } : { found: true, value };
  }),
};

// validateAgainstGitHub hits GET https://api.github.com/user; stub it so the
// suite never reaches the network. Default: a valid classic-token response.
const stubGitHubUser = (login = 'octocat'): void => {
  vi.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ login }),
    headers: { get: () => null },
  } as unknown as Response);
};

describe('GitUserPat (integration)', () => {
  let app: INestApplication;
  let service: GitUserPatService;
  let ctx: AppContextStorage;

  beforeAll(async () => {
    app = await createTestModule(async (builder) =>
      builder
        .overrideProvider(SecretsStoreService)
        .useValue(mockStore)
        .compile(),
    );
    service = app.get(GitUserPatService);
    ctx = buildTestContext(TEST_USER_ID);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    storeState.throwOnRead = false;
    kvStore.clear();
    mockStore.putUserSecret.mockClear();
    mockStore.deleteUserSecret.mockClear();
    mockStore.readUserSecret.mockClear();
    mockStore.isAvailable.mockClear();
    vi.restoreAllMocks();
    stubGitHubUser();

    const em = app.get(EntityManager).fork();
    await em.nativeDelete(GitUserPatEntity, { userId: TEST_USER_ID });
  });

  afterEach(async () => {
    const em = app.get(EntityManager).fork();
    await em.nativeDelete(GitUserPatEntity, { userId: TEST_USER_ID });
    kvStore.clear();
  });

  const countRows = async (): Promise<number> => {
    const em = app.get(EntityManager).fork();
    return await em.count(GitUserPatEntity, { userId: TEST_USER_ID });
  };

  it('putPat writes the OpenBao value + a single pointer row, and getStatus reflects it', async () => {
    const result = await service.putPat(ctx, 'ghp_classic_token');

    expect(result).toMatchObject({
      configured: true,
      login: 'octocat',
      tokenType: 'classic',
    });
    expect(kvStore.get(key(TEST_USER_ID, 'github-pat'))).toBe(
      'ghp_classic_token',
    );
    expect(await countRows()).toBe(1);

    const status = await service.getStatus(ctx);
    expect(status).toMatchObject({
      configured: true,
      login: 'octocat',
      tokenType: 'classic',
    });
  });

  it('a second putPat upserts on the real UNIQUE(user_id) constraint — one row per user, metadata replaced', async () => {
    await service.putPat(ctx, 'ghp_classic_token');
    expect(await countRows()).toBe(1);

    // Re-save with a fine-grained token; the ON CONFLICT (user_id) upsert must
    // replace the metadata + secret in place, never insert a second row.
    await service.putPat(ctx, 'github_pat_finegrained_token');

    expect(await countRows()).toBe(1);
    expect(kvStore.get(key(TEST_USER_ID, 'github-pat'))).toBe(
      'github_pat_finegrained_token',
    );
    const status = await service.getStatus(ctx);
    expect(status.tokenType).toBe('fine-grained');
  });

  it('deletePat hard-deletes the row and purges the secret', async () => {
    await service.putPat(ctx, 'ghp_classic_token');
    expect(await countRows()).toBe(1);

    await service.deletePat(ctx);

    expect(await countRows()).toBe(0);
    expect(kvStore.has(key(TEST_USER_ID, 'github-pat'))).toBe(false);
    const status = await service.getStatus(ctx);
    expect(status.configured).toBe(false);
  });

  it('resolvePatToken returns the stored token when the row + value are present', async () => {
    await service.putPat(ctx, 'ghp_classic_token');
    expect(await service.resolvePatToken(TEST_USER_ID)).toBe(
      'ghp_classic_token',
    );
  });

  it('resolvePatToken returns null (App fallback) when the store fails TRANSIENTLY — never bricks git on a blip', async () => {
    await service.putPat(ctx, 'ghp_classic_token');
    storeState.throwOnRead = true;
    expect(await service.resolvePatToken(TEST_USER_ID)).toBeNull();
  });

  it('resolvePatToken throws (fail-CLOSED) when the row is present but the value is CONFIRMED-ABSENT', async () => {
    await service.putPat(ctx, 'ghp_classic_token');
    // Simulate the secret deleted out from under the pointer row (corrupt).
    kvStore.delete(key(TEST_USER_ID, 'github-pat'));
    await expect(service.resolvePatToken(TEST_USER_ID)).rejects.toThrow(
      InternalException,
    );
  });

  it('resolvePatToken returns null (no fail-closed) when the user has no PAT row at all', async () => {
    expect(await service.resolvePatToken(TEST_USER_ID)).toBeNull();
  });
});
