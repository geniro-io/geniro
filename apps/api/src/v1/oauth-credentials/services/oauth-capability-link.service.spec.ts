import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CacheService } from '../../cache/services/cache.service';
import {
  OAUTH_CAPLINK_CACHE_PREFIX,
  OAUTH_CAPLINK_TTL_SECONDS,
  OAuthCapabilityClaims,
  OAuthProvider,
} from '../oauth-credentials.types';
import { OAuthCapabilityLinkService } from './oauth-capability-link.service';

describe('OAuthCapabilityLinkService', () => {
  let store: Map<string, string>;
  let cache: CacheService;
  let service: OAuthCapabilityLinkService;

  const claims: OAuthCapabilityClaims = {
    projectId: 'proj-1',
    provider: OAuthProvider.Linear,
    threadId: 'graph-1:thread-1',
    createdBy: 'user-1',
  };

  beforeEach(() => {
    store = new Map();
    cache = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      del: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      // Atomic get-and-delete: the get+delete run synchronously within this
      // async body (no internal await), so a second concurrent caller observes
      // the already-deleted key — modelling Redis GETDEL's single-round-trip
      // atomicity.
      getDel: vi.fn(async (key: string) => {
        const value = store.get(key) ?? null;
        store.delete(key);
        return value;
      }),
    } as unknown as CacheService;
    service = new OAuthCapabilityLinkService(cache);
  });

  it('mints an opaque token and stores the claims under it with a TTL', async () => {
    const token = await service.mint(claims);

    expect(token).toMatch(/^[\w-]+$/);
    expect(cache.set).toHaveBeenCalledWith(
      `${OAUTH_CAPLINK_CACHE_PREFIX}${token}`,
      JSON.stringify(claims),
      OAUTH_CAPLINK_TTL_SECONDS,
    );
  });

  it('round-trips: redeem returns the exact minted claims', async () => {
    const token = await service.mint(claims);
    await expect(service.redeem(token)).resolves.toEqual(claims);
  });

  it('is single-use: redeem atomically consumes the key, a second redeem throws', async () => {
    const token = await service.mint(claims);

    await service.redeem(token);
    expect(cache.getDel).toHaveBeenCalledWith(
      `${OAUTH_CAPLINK_CACHE_PREFIX}${token}`,
    );

    await expect(service.redeem(token)).rejects.toMatchObject({
      errorCode: 'OAUTH_CAPABILITY_INVALID',
    });
  });

  it('throws on an unknown / expired token', async () => {
    await expect(service.redeem('does-not-exist')).rejects.toMatchObject({
      errorCode: 'OAUTH_CAPABILITY_INVALID',
    });
    expect(cache.getDel).toHaveBeenCalledWith(
      `${OAUTH_CAPLINK_CACHE_PREFIX}does-not-exist`,
    );
  });

  it('consumes then rejects a structurally-malformed stored value', async () => {
    const key = `${OAUTH_CAPLINK_CACHE_PREFIX}garbage`;
    store.set(key, '{ not json');

    await expect(service.redeem('garbage')).rejects.toMatchObject({
      errorCode: 'OAUTH_CAPABILITY_INVALID',
    });
    // Still consumed (single-use) even though it was malformed.
    expect(cache.getDel).toHaveBeenCalledWith(key);
    expect(store.has(key)).toBe(false);
  });

  it('rejects claims missing a required field', async () => {
    const key = `${OAUTH_CAPLINK_CACHE_PREFIX}partial`;
    store.set(key, JSON.stringify({ projectId: 'p', provider: 'linear' }));

    await expect(service.redeem('partial')).rejects.toMatchObject({
      errorCode: 'OAUTH_CAPABILITY_INVALID',
    });
  });

  it('rejects an unknown provider in the stored claims', async () => {
    const key = `${OAUTH_CAPLINK_CACHE_PREFIX}badprovider`;
    store.set(key, JSON.stringify({ ...claims, provider: 'not-a-provider' }));

    await expect(service.redeem('badprovider')).rejects.toMatchObject({
      errorCode: 'OAUTH_CAPABILITY_INVALID',
    });
  });

  it('returns only the four declared claim fields, dropping injected extra keys from a tampered/corrupted value', async () => {
    // A capability link is single-use and scoped to ONE paused run. If a stored
    // value carries extra keys beyond the four claims (a corrupted Redis value,
    // or a key crafted to smuggle fields downstream), redeem must hand back ONLY
    // the validated {projectId, provider, threadId, createdBy} shape — never a
    // wider object whose extra keys flow on to the resume / start logic.
    const key = `${OAUTH_CAPLINK_CACHE_PREFIX}extrakeys`;
    store.set(
      key,
      JSON.stringify({
        ...claims,
        createdBy: 'attacker-user',
        impersonateAs: 'admin-user',
        extra: { nested: true },
      }),
    );

    const redeemed = await service.redeem('extrakeys');

    expect(Object.keys(redeemed).sort()).toEqual([
      'createdBy',
      'projectId',
      'provider',
      'threadId',
    ]);
    expect(redeemed).not.toHaveProperty('impersonateAs');
    expect(redeemed).not.toHaveProperty('extra');
  });

  it('is atomically single-use under two concurrent redeems: exactly one resolves, the other throws OAUTH_CAPABILITY_INVALID', async () => {
    // Two requests presenting the SAME token race (e.g. a double-clicked link or
    // a replayed request). With the atomic GETDEL the first redeem consumes the
    // value and the second sees nothing — only one can succeed. (A non-atomic
    // get-then-del would let both observe the value and redeem twice.)
    const token = await service.mint(claims);

    const results = await Promise.allSettled([
      service.redeem(token),
      service.redeem(token),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      errorCode: 'OAUTH_CAPABILITY_INVALID',
    });
  });
});
