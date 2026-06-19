import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, InternalException } from '@packages/common';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { environment } from '../../../environments';
import { CacheService } from '../../cache/services/cache.service';
import { NotificationEvent } from '../../notifications/notifications.types';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { SecretEntity } from '../../secrets/entity/secret.entity';
import { SecretsStoreService } from '../../secrets-store/services/secrets-store.service';
import { OAuthCredentialsDao } from '../dao/oauth-credentials.dao';
import {
  OAuthExchangeRequest,
  OAuthStartQueryDto,
  OAuthStartResponse,
  OAuthStatusResponse,
} from '../dto/oauth-credentials.dto';
import { OAuthCredentialEntity } from '../entity/oauth-credential.entity';
import {
  CREDENTIAL_ACQUIRED_EVENT,
  CredentialAcquiredEvent,
} from '../oauth-credentials.events';
import {
  OAUTH_STATE_CACHE_PREFIX,
  OAUTH_STATE_TTL_SECONDS,
  OAuthPendingState,
  OAuthProvider,
} from '../oauth-credentials.types';
import {
  assertHeaderSafeToken,
  generateOAuthState,
  generatePkcePair,
} from '../oauth-credentials.utils';
import { OAuthCapabilityLinkService } from './oauth-capability-link.service';
import { OAuthExchangeService } from './oauth-exchange.service';

/**
 * Refresh proactively when the access token is within this window of expiry (or
 * already past it) — so a token that would expire between a run-start pre-flight
 * and the actual MCP call is rotated up front rather than dying mid-request.
 */
const REFRESH_EXPIRY_SKEW_MS = 60_000;

@Injectable()
export class OAuthCredentialsService {
  constructor(
    private readonly dao: OAuthCredentialsDao,
    private readonly exchangeService: OAuthExchangeService,
    private readonly secretsStore: SecretsStoreService,
    private readonly cache: CacheService,
    private readonly notifications: NotificationsService,
    private readonly capabilityLink: OAuthCapabilityLinkService,
    private readonly eventEmitter: EventEmitter2,
    private readonly em: EntityManager,
  ) {}

  /**
   * Begin an authorization-code + PKCE flow. Discovers the provider's MCP
   * authorization server and registers a per-flow client via Dynamic Client
   * Registration (RFC 7591), then persists the PKCE verifier + the registered
   * client under a random CSRF state (carrying the project + resume target)
   * server-side in Redis, and returns the discovered authorize URL for the new
   * tab to navigate to.
   *
   * Discovery + registration are two external round-trips that run BEFORE the
   * pending-state write, so any failure fails CLOSED — it throws and leaves no
   * orphaned pending-state. (`start()` was always async; it now actually awaits
   * network I/O — callers already await it.)
   */
  async start(
    ctx: AppContextStorage,
    provider: OAuthProvider,
    query: OAuthStartQueryDto,
  ): Promise<OAuthStartResponse> {
    const userId = ctx.checkSub();

    // A capability token (`?cap=`) re-opens a paused run's flow from any browser:
    // the project + thread context is recovered from the server-side claims, not
    // the `x-project-id` header (the notification link is opened outside the
    // editor tab, which alone carries it). The opaque single-use token is the
    // capability, but require the authenticated user to match the run initiator
    // (a leaked link can't be redeemed by a different logged-in user) and the
    // route provider to match the claims. Absent `cap`, this is the in-editor
    // flow: project from the header, optional `threadId` from the query.
    let projectId: string;
    let threadId: string | undefined;
    if (query.cap) {
      const claims = await this.capabilityLink.redeem(query.cap);
      if (claims.createdBy !== userId || claims.provider !== provider) {
        throw new BadRequestException('OAUTH_CAPABILITY_MISMATCH');
      }
      projectId = claims.projectId;
      threadId = claims.threadId;
    } else {
      projectId = ctx.checkProjectId();
      threadId = query.threadId;
    }

    const { codeVerifier, codeChallenge } = generatePkcePair();
    const state = generateOAuthState();

    // Discover + register (DCR) + build the consent URL BEFORE any pending-state
    // write. A discovery/registration failure throws here, so no orphaned
    // pending-state is ever persisted — the flow fails closed. The redirect_uri
    // is registered as `redirect_uris[0]` and echoed in the authorize URL; the
    // same value is used at exchange() (see redirectUri()).
    const { authorizeUrl, client } =
      await this.exchangeService.prepareAuthorization(
        provider,
        this.redirectUri(provider),
        state,
        codeChallenge,
      );

    const pending: OAuthPendingState = {
      projectId,
      provider,
      codeVerifier,
      createdBy: userId,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      graphId: query.graphId,
      nodeId: query.nodeId,
      threadId,
    };
    await this.cache.set(
      `${OAUTH_STATE_CACHE_PREFIX}${state}`,
      JSON.stringify(pending),
      OAUTH_STATE_TTL_SECONDS,
    );

    return { authorizeUrl };
  }

  /** Report whether a valid credential exists for the current project + provider. */
  async status(
    ctx: AppContextStorage,
    provider: OAuthProvider,
  ): Promise<OAuthStatusResponse> {
    const projectId = ctx.checkProjectId();
    const credential = await this.dao.getOne(
      { projectId, provider },
      { orderBy: { updatedAt: 'desc' } },
    );
    return this.buildStatus(provider, credential);
  }

  /**
   * Map a loaded credential (or its absence) to the public status DTO. A
   * stored-but-expired token is NOT "authenticated" — surface it so the node
   * prompts re-auth instead of failing opaquely at run time; a null expiry means
   * the provider issues non-expiring tokens (or expiry unknown). Side-effect-free
   * (no DB read), so a caller that already holds the row (refreshIfNeeded's
   * no-op paths) reuses it without a second read.
   */
  private buildStatus(
    provider: OAuthProvider,
    credential: OAuthCredentialEntity | null,
  ): OAuthStatusResponse {
    const expired =
      credential?.expiresAt != null &&
      credential.expiresAt.getTime() <= Date.now();
    const authenticated = Boolean(credential) && !expired;
    return {
      provider,
      authenticated,
      accountLabel: authenticated ? (credential?.accountLabel ?? null) : null,
      secretName: authenticated ? (credential?.secretName ?? null) : null,
      // Surface the real expiry whenever a credential exists (even when expired),
      // so the client pre-flight can show expiry / "expired" without a second call.
      expiresAt: credential?.expiresAt?.toISOString() ?? null,
    };
  }

  /**
   * Lazily rotate the (project, provider) access token when it is near or past
   * expiry and a stored refresh token + issuing client exist, so a valid token
   * is available at run-start with no user interaction. A no-op returning the
   * current status when: there is no credential; the expiry is unknown (`null` —
   * staleness can't be proven, and a blind refresh could revoke a still-valid
   * long-lived token); the token is still fresh; or no refresh token / client is
   * stored (the credential then stays near/past expiry and falls to re-auth in
   * M3.3 — never a silent failure). The rotated access token (and any rotated
   * refresh token) is re-persisted through the same rollback-safe path as
   * exchange(); the refreshed token re-passes the header-safety guard. Returns
   * the post-refresh status.
   *
   * This is the service method only — the run-start CALL SITE that invokes it
   * (background / trigger / resume pre-flight) lands in M3.2 / M3.3.
   */
  async refreshIfNeeded(
    ctx: AppContextStorage,
    provider: OAuthProvider,
  ): Promise<OAuthStatusResponse> {
    const projectId = ctx.checkProjectId();
    const credential = await this.dao.getOne(
      { projectId, provider },
      { orderBy: { updatedAt: 'desc' } },
    );

    // No credential, or expiry unknown -> nothing to refresh (or no provable
    // need). A null expiresAt means a non-expiring / unknown-expiry token;
    // refreshing blind risks revoking a still-valid one, so leave it.
    if (!credential || credential.expiresAt == null) {
      return this.buildStatus(provider, credential);
    }
    const needsRefresh =
      credential.expiresAt.getTime() <= Date.now() + REFRESH_EXPIRY_SKEW_MS;
    if (!needsRefresh) {
      return this.buildStatus(provider, credential);
    }

    // A refresh grant is bound to its issuing client; absent the persisted
    // client_id, the stored refresh token, or the secrets store, the credential
    // simply stays near/past expiry (re-auth handled in M3.3).
    if (!credential.clientId || !this.secretsStore.isAvailable()) {
      return this.buildStatus(provider, credential);
    }
    // Capture the narrowed client_id in a local — control-flow narrowing of a
    // property access does not survive into the async transactional callback
    // below (the property is mutable), so the closure would see it as nullable.
    const clientId = credential.clientId;
    const refreshToken = await this.secretsStore
      .getSecret(projectId, this.refreshSecretName(provider))
      .catch(() => null);
    if (!refreshToken) {
      return this.buildStatus(provider, credential);
    }
    const clientSecret = await this.secretsStore
      .getSecret(projectId, this.clientSecretName(provider))
      .catch(() => null);

    const result = await this.exchangeService.refreshAccessToken(
      provider,
      refreshToken,
      { clientId, clientSecret: clientSecret || null },
    );
    const token = assertHeaderSafeToken(
      result.accessToken,
      'OAuth refresh token',
    );

    const restores: (() => Promise<void>)[] = [];
    try {
      restores.push(
        await this.applySecretRollbackable(
          projectId,
          this.secretName(provider),
          token,
        ),
      );
      // A rotating provider issues a new refresh token on this grant — persist
      // it. A non-rotating provider returns none -> keep the existing one (do
      // NOT clear it; it is still valid for the next refresh).
      if (result.refreshToken) {
        restores.push(
          await this.applySecretRollbackable(
            projectId,
            this.refreshSecretName(provider),
            result.refreshToken,
          ),
        );
      }
      await this.em.transactional(async (em) => {
        await this.upsertCredentialRow(em, projectId, credential.createdBy, {
          provider,
          accountLabel: credential.accountLabel,
          secretName: this.secretName(provider),
          // A refresh response often omits scope (unchanged) — keep the prior.
          scopes: result.scopes ?? credential.scopes ?? null,
          // A refresh response without expires_in yields a null expiry
          // (non-expiring / unknown) — deliberately NOT the prior near/past
          // value: preserving the stale expiry would re-trip the near-expiry
          // guard on the very next call and refresh-storm. A token whose new
          // lifetime the AS did not state rides until it hard-expires, then
          // M3.3 surfaces auth_required.
          expiresAt: result.expiresAt,
          clientId,
          lastRefreshedAt: new Date(),
        });
      });
    } catch (error) {
      for (const restore of restores.reverse()) {
        await restore();
      }
      throw error;
    }

    return await this.status(ctx, provider);
  }

  /**
   * Validate the CSRF state, exchange the code for a token, store the token
   * (OpenBao + a selectable `secrets` row), upsert the credential metadata, and
   * emit the authoritative `credential.acquired` signal. Fails CLOSED when the
   * secrets store is unavailable — nothing is persisted.
   *
   * The project is taken from the SERVER-STORED state (bound at `start()` time
   * when the user was in the project context) — the new-tab callback's URL has
   * no project segment, so it cannot send `x-project-id`. CSRF/ownership is
   * enforced by the unguessable state plus a same-user (`createdBy`) check.
   */
  async exchange(
    ctx: AppContextStorage,
    dto: OAuthExchangeRequest,
  ): Promise<{
    provider: OAuthProvider;
    accountLabel: string;
    secretName: string;
  }> {
    const userId = ctx.checkSub();
    const { provider, code, state } = dto;

    if (!this.secretsStore.isAvailable()) {
      throw new InternalException(
        'SECRETS_STORE_UNAVAILABLE',
        'OpenBao is not configured; cannot store the OAuth token.',
      );
    }

    const cacheKey = `${OAUTH_STATE_CACHE_PREFIX}${state}`;
    // loadPendingState consumes the state ATOMICALLY (GETDEL), so two concurrent
    // exchanges presenting the same `state` can't both observe it — only one
    // proceeds, the other gets OAUTH_STATE_INVALID. (A non-atomic get-then-del
    // would let both pass the load and double-exchange.)
    const pending = await this.loadPendingState(cacheKey);
    if (pending.createdBy !== userId || pending.provider !== provider) {
      throw new BadRequestException('OAUTH_STATE_MISMATCH');
    }
    const projectId = pending.projectId;

    const result = await this.exchangeService.exchangeAuthorizationCode(
      provider,
      code,
      pending.codeVerifier,
      this.redirectUri(provider),
      { clientId: pending.clientId, clientSecret: pending.clientSecret },
    );

    const token = assertHeaderSafeToken(result.accessToken, 'OAuth token');
    // Account-label single source of truth: the provider name. The former
    // `api.linear.app/graphql { viewer }` identity probe was removed — an
    // MCP-scoped DCR token does not authenticate it, so there is nothing to
    // reconcile against. `result.accountLabel` is always null today (no
    // provider's exchangeCode parses an identity field), so the `?? provider`
    // fallback is the sole producer; a future provider that surfaces a real
    // label populates it in its own exchangeCode and it flows through here.
    const accountLabel = result.accountLabel ?? provider;
    const secretName = this.secretName(provider);

    // Write the token + its sibling KV keys (the refresh token, and the issuing
    // DCR client_secret when the AS registered a confidential client) to OpenBao
    // FIRST — an unavailable store throws here, before any DB write. Each write
    // snapshots its prior value so a later DB-transaction failure restores the
    // store to its pre-exchange state: on a FIRST auth the orphan is deleted, on
    // a RE-AUTH the prior value is restored, so a transient DB failure never
    // destroys a still-valid existing credential. A fresh authorization-code
    // grant supersedes any stale sibling from a prior grant — a `null` refresh
    // token / client_secret CLEARS the sibling key rather than leaving it stale.
    const restores: (() => Promise<void>)[] = [];
    try {
      restores.push(
        await this.applySecretRollbackable(projectId, secretName, token),
      );
      restores.push(
        await this.applySecretRollbackable(
          projectId,
          this.refreshSecretName(provider),
          result.refreshToken ?? null,
        ),
      );
      restores.push(
        await this.applySecretRollbackable(
          projectId,
          this.clientSecretName(provider),
          pending.clientSecret,
        ),
      );
      await this.em.transactional(async (em) => {
        await this.upsertSecretRow(em, projectId, userId, secretName);
        await this.upsertCredentialRow(em, projectId, userId, {
          provider,
          accountLabel,
          secretName,
          scopes: result.scopes,
          expiresAt: result.expiresAt,
          // Persist the issuing per-flow DCR client so a later refresh grant can
          // re-present it (the client_secret rode the sibling KV key above).
          clientId: pending.clientId,
          // A fresh exchange is not a refresh — reset the rotation marker.
          lastRefreshedAt: null,
        });
      });
    } catch (error) {
      // The DB rows didn't commit — roll every OpenBao write back (newest
      // first), restoring the store to its pre-exchange state. Best-effort.
      for (const restore of restores.reverse()) {
        await restore();
      }
      throw error;
    }

    // Authoritative server-side completion signal, on the NotificationsService
    // subscriber bus → WebSocket fan-out.
    await this.notifications.emit({
      type: NotificationEvent.CredentialAcquired,
      data: { provider, accountLabel },
      projectId,
      graphId: pending.graphId,
      nodeId: pending.nodeId,
      threadId: pending.threadId,
    });

    // EventEmitter2 bridge — the NotificationsService bus above is DISJOINT from
    // the EventEmitter2 bus that `@OnEvent` listens on, so a paused-run resume
    // handler (`ThreadResumeService.@OnEvent(CREDENTIAL_ACQUIRED_EVENT)`) only
    // fires because of this explicit emit. Load-bearing for M3.3.
    this.eventEmitter.emit(CREDENTIAL_ACQUIRED_EVENT, {
      projectId,
      provider,
      threadId: pending.threadId,
    } satisfies CredentialAcquiredEvent);

    return { provider, accountLabel, secretName };
  }

  private async loadPendingState(cacheKey: string): Promise<OAuthPendingState> {
    // Atomic get-and-delete: single-use consumption with no get-then-del race.
    const raw = await this.cache.getDel(cacheKey);
    if (!raw) {
      throw new BadRequestException('OAUTH_STATE_INVALID');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('OAUTH_STATE_INVALID');
    }
    if (parsed == null || typeof parsed !== 'object') {
      throw new BadRequestException('OAUTH_STATE_INVALID');
    }
    const p = parsed as Record<string, unknown>;
    if (
      typeof p.projectId !== 'string' ||
      typeof p.codeVerifier !== 'string' ||
      typeof p.createdBy !== 'string' ||
      typeof p.provider !== 'string' ||
      typeof p.clientId !== 'string' ||
      (p.clientSecret !== null && typeof p.clientSecret !== 'string')
    ) {
      throw new BadRequestException('OAUTH_STATE_INVALID');
    }
    return parsed as OAuthPendingState;
  }

  /** Ensure a selectable `secrets` row exists for the token (rotation-safe). */
  private async upsertSecretRow(
    em: EntityManager,
    projectId: string,
    userId: string,
    name: string,
  ): Promise<void> {
    // Atomic INSERT … ON CONFLICT (project_id, name) DO UPDATE. The `secrets`
    // UNIQUE(project_id, name) is NOT partial on deleted_at, so the merge branch
    // clears `deletedAt` (resurrecting a previously-deleted row) and bumps
    // `updatedAt` instead of colliding. Being a single statement, it is also
    // race-safe under concurrent exchanges — no read-then-write window. The
    // token VALUE lives in OpenBao, not this row.
    await em.upsert(
      SecretEntity,
      {
        name,
        description: 'OAuth access token',
        createdBy: userId,
        projectId,
        deletedAt: null,
        updatedAt: new Date(),
      },
      {
        onConflictFields: ['projectId', 'name'],
        onConflictAction: 'merge',
        onConflictMergeFields: ['deletedAt', 'updatedAt'],
      },
    );
  }

  private async upsertCredentialRow(
    em: EntityManager,
    projectId: string,
    userId: string,
    fields: {
      provider: OAuthProvider;
      accountLabel: string;
      secretName: string;
      scopes: string[] | null;
      expiresAt: Date | null;
      clientId: string | null;
      lastRefreshedAt: Date | null;
    },
  ): Promise<void> {
    // One credential per (project, provider): the secret name is deterministic
    // per provider, so multiple account labels alias one stored secret. Atomic
    // INSERT … ON CONFLICT (project_id, provider) DO UPDATE — accountLabel +
    // secret metadata are mutable; the merge clears `deletedAt` (resurrecting a
    // re-auth after a delete) and bumps `updatedAt`. Being a single statement,
    // two exchanges racing for the same (projectId, provider) — a double-clicked
    // Authenticate or two tabs — converge on one row instead of one INSERT
    // losing on the plain UNIQUE constraint. `createdBy` is preserved on
    // conflict (not in the merge set).
    await em.upsert(
      OAuthCredentialEntity,
      {
        provider: fields.provider,
        accountLabel: fields.accountLabel,
        secretName: fields.secretName,
        scopes: fields.scopes,
        expiresAt: fields.expiresAt,
        clientId: fields.clientId,
        lastRefreshedAt: fields.lastRefreshedAt,
        createdBy: userId,
        projectId,
        deletedAt: null,
        updatedAt: new Date(),
      },
      {
        onConflictFields: ['projectId', 'provider'],
        onConflictAction: 'merge',
        onConflictMergeFields: [
          'accountLabel',
          'secretName',
          'scopes',
          'expiresAt',
          'clientId',
          'lastRefreshedAt',
          'deletedAt',
          'updatedAt',
        ],
      },
    );
  }

  private secretName(provider: OAuthProvider): string {
    return `${provider.toUpperCase()}_OAUTH_TOKEN`;
  }

  /** Sibling OpenBao KV key holding the refresh token — never a plain DB column. */
  private refreshSecretName(provider: OAuthProvider): string {
    return `${provider.toUpperCase()}_OAUTH_REFRESH`;
  }

  /**
   * Sibling OpenBao KV key holding the issuing DCR `client_secret`, when the AS
   * registered a confidential client (a public PKCE client has none).
   */
  private clientSecretName(provider: OAuthProvider): string {
    return `${provider.toUpperCase()}_OAUTH_CLIENT_SECRET`;
  }

  /**
   * Apply one OpenBao KV write (or clear) with a snapshot-based undo. Reads the
   * prior value first, then writes `newValue` (non-null) or deletes the key
   * (`newValue === null` AND a prior value exists). Returns a best-effort
   * `restore` closure that puts the prior value back — or deletes the key when
   * there was none — so a caller persisting several keys can roll the store back
   * to its pre-write state if a later step fails. `getSecret` throws (real store)
   * or returns '' (absent) for a missing key; the `.catch(() => null)` below
   * normalizes both (and any read error) to a falsy `prior`, so the `if (prior)`
   * branches are exhaustive.
   */
  private async applySecretRollbackable(
    projectId: string,
    name: string,
    newValue: string | null,
  ): Promise<() => Promise<void>> {
    const prior = await this.secretsStore
      .getSecret(projectId, name)
      .catch(() => null);
    if (newValue !== null) {
      await this.secretsStore.putSecret(projectId, name, newValue);
    } else if (prior) {
      await this.secretsStore.deleteSecret(projectId, name);
    }
    return async () => {
      if (prior) {
        await this.secretsStore
          .putSecret(projectId, name, prior)
          .catch(() => undefined);
      } else {
        await this.secretsStore
          .deleteSecret(projectId, name)
          .catch(() => undefined);
      }
    };
  }

  private redirectUri(provider: OAuthProvider): string {
    // Provider-specific so the new-tab callback can recover the provider from
    // its route (the redirect carries only `code` + `state`). MUST equal the
    // DCR-registered `redirect_uris[0]` and the authorize `redirect_uri`
    // byte-for-byte — and it does, because start()/exchange() both derive it
    // from this one method — or the AS rejects the exchange.
    return `${environment.websiteUrl}/oauth/callback/${provider}`;
  }
}
