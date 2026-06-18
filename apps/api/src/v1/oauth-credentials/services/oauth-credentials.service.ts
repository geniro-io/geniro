import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
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
  OAUTH_PROVIDER_CONFIGS,
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
import { OAuthExchangeService } from './oauth-exchange.service';

@Injectable()
export class OAuthCredentialsService {
  constructor(
    private readonly dao: OAuthCredentialsDao,
    private readonly exchangeService: OAuthExchangeService,
    private readonly secretsStore: SecretsStoreService,
    private readonly cache: CacheService,
    private readonly notifications: NotificationsService,
    private readonly em: EntityManager,
  ) {}

  /**
   * Begin an authorization-code + PKCE flow. Persists the verifier + a random
   * CSRF state (carrying the project + resume target) server-side in Redis, and
   * returns the provider authorize URL for the new tab to navigate to.
   */
  async start(
    ctx: AppContextStorage,
    provider: OAuthProvider,
    query: OAuthStartQueryDto,
  ): Promise<OAuthStartResponse> {
    const projectId = ctx.checkProjectId();
    const userId = ctx.checkSub();

    if (!this.exchangeService.isProviderConfigured(provider)) {
      throw new BadRequestException('OAUTH_PROVIDER_NOT_CONFIGURED');
    }

    const { codeVerifier, codeChallenge } = generatePkcePair();
    const state = generateOAuthState();
    const pending: OAuthPendingState = {
      projectId,
      provider,
      codeVerifier,
      createdBy: userId,
      graphId: query.graphId,
      nodeId: query.nodeId,
    };
    await this.cache.set(
      `${OAUTH_STATE_CACHE_PREFIX}${state}`,
      JSON.stringify(pending),
      OAUTH_STATE_TTL_SECONDS,
    );

    const config = OAUTH_PROVIDER_CONFIGS[provider];
    const { clientId } =
      this.exchangeService.resolveClientCredentials(provider);
    const authorizeUrl = new URL(config.authorizeUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', this.redirectUri(provider));
    authorizeUrl.searchParams.set(
      'scope',
      config.scopes.join(config.scopeSeparator),
    );
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    return { authorizeUrl: authorizeUrl.toString() };
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
    // A stored-but-expired token is NOT "authenticated" — surface it so the
    // node prompts re-auth instead of failing opaquely at run time. A null
    // expiry means the provider issues non-expiring tokens (or expiry unknown).
    const expired =
      credential?.expiresAt != null &&
      credential.expiresAt.getTime() <= Date.now();
    const authenticated = Boolean(credential) && !expired;
    return {
      provider,
      authenticated,
      accountLabel: authenticated ? (credential?.accountLabel ?? null) : null,
      secretName: authenticated ? (credential?.secretName ?? null) : null,
    };
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
    const pending = await this.loadPendingState(cacheKey);
    if (pending.createdBy !== userId || pending.provider !== provider) {
      throw new BadRequestException('OAUTH_STATE_MISMATCH');
    }
    const projectId = pending.projectId;
    // Single-use: consume the state before exchanging so a replay cannot reuse it.
    await this.cache.del(cacheKey);

    const result = await this.exchangeService.exchangeAuthorizationCode(
      provider,
      code,
      pending.codeVerifier,
      this.redirectUri(provider),
    );

    const token = assertHeaderSafeToken(result.accessToken, 'OAuth token');
    const accountLabel = result.accountLabel ?? provider;
    const secretName = this.secretName(provider);

    // Snapshot the prior stored value (if any) BEFORE overwriting it, so a
    // failed write can restore the store to its pre-exchange state. getSecret
    // throws (or returns '') when absent — either way priorValue is falsy.
    const priorValue = await this.secretsStore
      .getSecret(projectId, secretName)
      .catch(() => null);

    // OpenBao first — an unavailable store throws here, before any DB write.
    await this.secretsStore.putSecret(projectId, secretName, token);

    try {
      await this.em.transactional(async (em) => {
        await this.upsertSecretRow(em, projectId, userId, secretName);
        await this.upsertCredentialRow(em, projectId, userId, {
          provider,
          accountLabel,
          secretName,
          scopes: result.scopes,
          expiresAt: result.expiresAt,
        });
      });
    } catch (error) {
      // The DB rows didn't commit — restore OpenBao to its pre-exchange state.
      // On a FIRST auth (no prior value) this deletes the orphan; on a RE-AUTH
      // it restores the prior token, so a transient DB failure never destroys a
      // still-valid existing credential — the rolled-back credential row keeps
      // referencing this deterministic secret name. Best-effort.
      if (priorValue) {
        await this.secretsStore
          .putSecret(projectId, secretName, priorValue)
          .catch(() => undefined);
      } else {
        await this.secretsStore
          .deleteSecret(projectId, secretName)
          .catch(() => undefined);
      }
      throw error;
    }

    // Authoritative server-side completion signal (forward-compat seam for M3).
    await this.notifications.emit({
      type: NotificationEvent.CredentialAcquired,
      data: { provider, accountLabel },
      projectId,
      graphId: pending.graphId,
      nodeId: pending.nodeId,
      threadId: pending.threadId,
    });

    return { provider, accountLabel, secretName };
  }

  private async loadPendingState(cacheKey: string): Promise<OAuthPendingState> {
    const raw = await this.cache.get(cacheKey);
    if (!raw) {
      throw new BadRequestException('OAUTH_STATE_INVALID');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('OAUTH_STATE_INVALID');
    }
    if (
      parsed == null ||
      typeof parsed !== 'object' ||
      typeof (parsed as OAuthPendingState).projectId !== 'string' ||
      typeof (parsed as OAuthPendingState).codeVerifier !== 'string' ||
      typeof (parsed as OAuthPendingState).createdBy !== 'string' ||
      typeof (parsed as OAuthPendingState).provider !== 'string'
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
          'deletedAt',
          'updatedAt',
        ],
      },
    );
  }

  private secretName(provider: OAuthProvider): string {
    return `${provider.toUpperCase()}_OAUTH_TOKEN`;
  }

  private redirectUri(provider: OAuthProvider): string {
    // Provider-specific so the new-tab callback can recover the provider from
    // its route (the redirect carries only `code` + `state`). Must match the
    // value registered with the provider's OAuth app.
    return `${environment.websiteUrl}/oauth/callback/${provider}`;
  }
}
