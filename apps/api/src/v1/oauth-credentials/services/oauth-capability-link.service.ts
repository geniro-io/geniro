import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import { CacheService } from '../../cache/services/cache.service';
import {
  OAUTH_CAPLINK_CACHE_PREFIX,
  OAUTH_CAPLINK_TTL_SECONDS,
  OAuthCapabilityClaims,
  OAuthProvider,
} from '../oauth-credentials.types';

/**
 * Mints and redeems the opaque, single-use capability link that re-opens a
 * paused run's OAuth flow from ANY browser. The link is the cross-browser /
 * notification-driven path that decouples authentication from the editor tab
 * (which alone carries the `x-project-id` header): a background or trigger run
 * pauses awaiting a credential, emits `auth_required` carrying this token, and
 * the user clicks it wherever they are.
 *
 * The token is a 256-bit random value — the only thing that travels. Its claims
 * `(projectId, provider, threadId, createdBy)` live server-side in Redis under
 * the token, never on the wire, so there is nothing to forge and no signing
 * secret to provision (mirrors the existing `oauth:state:` pending-state). It is
 * consumed (deleted) on first redemption — a replay finds nothing — and
 * TTL-bound so a never-clicked link cannot linger indefinitely.
 */
@Injectable()
export class OAuthCapabilityLinkService {
  constructor(private readonly cache: CacheService) {}

  /**
   * Mint a capability token for a paused run's resume target and persist its
   * claims server-side under the token (TTL-bound). Returns the opaque token to
   * embed in the `auth_required` notification's link.
   */
  async mint(claims: OAuthCapabilityClaims): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.cache.set(
      `${OAUTH_CAPLINK_CACHE_PREFIX}${token}`,
      JSON.stringify(claims),
      OAUTH_CAPLINK_TTL_SECONDS,
    );
    return token;
  }

  /**
   * Redeem a capability token: load its claims and delete the key (single-use)
   * before returning, so a replay of the same token finds nothing. A missing /
   * malformed / already-consumed token throws `OAUTH_CAPABILITY_INVALID`. The
   * stored value is server-authored, but it is still structurally validated
   * (defense in depth — a corrupted Redis value must not crash the start flow,
   * and the provider is re-checked against the known enum).
   */
  async redeem(token: string): Promise<OAuthCapabilityClaims> {
    const key = `${OAUTH_CAPLINK_CACHE_PREFIX}${token}`;
    // Atomic get-and-delete so two concurrent redeems can't both observe the
    // value (a non-atomic get-then-del has a race window that breaks single-use,
    // the link's core security property). The consume happens before parsing, so
    // even a malformed stored value cannot be replayed.
    const raw = await this.cache.getDel(key);
    if (!raw) {
      throw new BadRequestException('OAUTH_CAPABILITY_INVALID');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('OAUTH_CAPABILITY_INVALID');
    }
    if (parsed == null || typeof parsed !== 'object') {
      throw new BadRequestException('OAUTH_CAPABILITY_INVALID');
    }
    const c = parsed as Record<string, unknown>;
    if (
      typeof c.projectId !== 'string' ||
      typeof c.threadId !== 'string' ||
      typeof c.createdBy !== 'string' ||
      typeof c.provider !== 'string' ||
      !Object.values(OAuthProvider).includes(c.provider as OAuthProvider)
    ) {
      throw new BadRequestException('OAUTH_CAPABILITY_INVALID');
    }
    // Reconstruct from the validated fields so extra/injected keys in the stored
    // value never flow downstream (the cast would otherwise widen the result).
    return {
      projectId: c.projectId,
      provider: c.provider as OAuthProvider,
      threadId: c.threadId,
      createdBy: c.createdBy,
    };
  }
}
