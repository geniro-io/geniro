import { Injectable } from '@nestjs/common';
import {
  BadRequestException,
  DefaultLogger,
  InternalException,
} from '@packages/common';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { SecretsStoreService } from '../../secrets-store/services/secrets-store.service';
import { GitUserPatDao } from '../dao/git-user-pat.dao';
import type { GitUserPatStatusResponse } from '../dto/git-auth.dto';
import { GitPatType } from '../git-auth.types';
import { GitPatValidatorService } from './git-pat-validator.service';

/**
 * Per-user GitHub PAT lifecycle: validate-on-save (PUT), status-only (GET),
 * purge (DELETE), and resolve (for the token resolver + repo sync). The token
 * VALUE lives only in OpenBao under `secret/data/users/{userId}/{secretName}`
 * — never in the DB row, a log line, or a response body.
 */
@Injectable()
export class GitUserPatService {
  /**
   * Fixed OpenBao secret name within the per-user namespace
   * (`secret/data/users/{userId}/{name}`). The userId is the path discriminator
   * so the name is constant; the pointer row stores it for the resolver to read
   * (a future OAuth source could use a different name).
   */
  private static readonly SECRET_NAME = 'github-pat';

  constructor(
    private readonly gitUserPatDao: GitUserPatDao,
    private readonly secretsStore: SecretsStoreService,
    private readonly validator: GitPatValidatorService,
    private readonly logger: DefaultLogger,
  ) {}

  /**
   * Store a per-user PAT (validate-on-save): validate the FORMAT, prove the
   * token against GitHub `GET /user`, then write OpenBao-first-then-DB with a
   * snapshot rollback so a DB failure restores the store to its prior state.
   * The token VALUE is never logged or returned.
   *
   * Rollback-snapshot policy (single source for the DB-failure path): the prior
   * value is read via {@link SecretsStoreService.readUserSecret}, which is the
   * ONLY authority for "was there a prior value" and distinguishes three cases —
   *   - prior FOUND      → restore it (put the prior value back),
   *   - prior CONFIRMED-ABSENT (404) → delete the orphan we just wrote,
   *   - prior UNKNOWN (transient read failure) → leave the just-written value in
   *     place. We must NOT delete on a transient failure: a `.catch(() => null)`
   *     that collapses "absent" and "could-not-read" into one would delete a
   *     still-valid prior PAT on a compound (transient read + DB upsert) failure.
   *     An orphaned value with no pointer row is unreachable and harmless
   *     (overwritten on the next save), so leaving it is the safe choice.
   */
  async putPat(
    ctx: AppContextStorage,
    rawToken: string,
  ): Promise<GitUserPatStatusResponse> {
    const userId = ctx.checkSub();
    const token = this.validator.validate(rawToken);
    const { login, tokenType } = await this.validateAgainstGitHub(token);
    const validatedAt = new Date().toISOString();
    const secretName = GitUserPatService.SECRET_NAME;

    // Snapshot the prior value (see the rollback-snapshot policy above). A
    // transient read failure is captured as 'unknown' — NOT collapsed to
    // "absent" — so the rollback never deletes a prior it could not prove gone.
    let prior: { found: true; value: string } | { found: false } | 'unknown';
    try {
      prior = await this.secretsStore.readUserSecret(userId, secretName);
    } catch {
      prior = 'unknown';
    }

    // An unavailable store throws here BEFORE any DB write (assertAvailable in
    // putUserSecret), so the fail-closed save semantics are preserved even
    // though the snapshot read above swallowed the same unavailability.
    await this.secretsStore.putUserSecret(userId, secretName, token);
    try {
      await this.gitUserPatDao.upsertByUserId(userId, secretName, {
        login,
        tokenType,
        validatedAt,
      });
    } catch (error) {
      if (prior === 'unknown') {
        // Prior unknown (transient read) — leave the just-written orphan; never
        // delete a value we could not prove was absent.
      } else if (prior.found) {
        await this.secretsStore
          .putUserSecret(userId, secretName, prior.value)
          .catch(() => undefined);
      } else {
        await this.secretsStore
          .deleteUserSecret(userId, secretName)
          .catch(() => undefined);
      }
      throw error;
    }

    return { configured: true, login, tokenType, validatedAt };
  }

  /** Status only — never returns the token value. */
  async getStatus(ctx: AppContextStorage): Promise<GitUserPatStatusResponse> {
    const userId = ctx.checkSub();
    const row = await this.gitUserPatDao.getOne({ userId });
    if (!row) {
      return {
        configured: false,
        login: null,
        tokenType: null,
        validatedAt: null,
      };
    }
    return {
      configured: true,
      login: row.metadata.login,
      tokenType: row.metadata.tokenType,
      validatedAt: row.metadata.validatedAt,
    };
  }

  /**
   * Remove the user's PAT. Hard-deletes the pointer row FIRST, then purges the
   * OpenBao value best-effort. Order matters: the resolver keys off the row, so
   * once it is gone the user is cleanly "not configured" (git ops fall back to
   * the App) regardless of the purge. An orphaned secret with no pointer row is
   * unreachable and is overwritten on the next save. The reverse order would
   * brick git ops on a transient DB error (secret gone but row survives →
   * resolvePatToken fail-closes with an opaque unreadable-PAT error, and
   * getStatus still reports configured). Idempotent — a no-op when nothing is
   * configured.
   */
  async deletePat(ctx: AppContextStorage): Promise<void> {
    const userId = ctx.checkSub();
    const row = await this.gitUserPatDao.getOne({ userId });
    if (!row) {
      return;
    }
    await this.gitUserPatDao.hardDelete({ userId });
    // Best-effort: the row is already gone, so a failed purge leaves only an
    // unreachable orphan (overwritten on the next save), never a broken state.
    await this.secretsStore
      .deleteUserSecret(userId, row.secretName)
      .catch(() => undefined);
  }

  /**
   * Resolve the user's stored PAT for the token resolver / repo sync. Takes a
   * bare `userId` — a non-HTTP leaf with no request context. Three outcomes,
   * distinguished by {@link SecretsStoreService.readUserSecret}:
   *
   *   - NO PAT row → returns `null` (benign — the caller falls back to the App).
   *   - Row present, store TRANSIENTLY unreadable (unavailable / 5xx / network /
   *     timeout) → returns `null` (App fallback). A momentary OpenBao blip must
   *     not fail-close git for EVERY PAT user when the GitHub App can serve the
   *     request; the user's PAT is presumably valid, so degrade gracefully.
   *   - Row present, value CONFIRMED-ABSENT (404) or corrupt → throws
   *     `InternalException` (fail-CLOSED). The credential is genuinely broken
   *     (row says configured, store has nothing); the gh-tool swallow-point
   *     guards re-throw `InternalException`, so this surfaces to the user (who
   *     re-saves) rather than silently degrading to an anonymous/App clone that
   *     would mask the corruption indefinitely.
   */
  async resolvePatToken(userId: string): Promise<string | null> {
    const row = await this.gitUserPatDao.getOne({ userId });
    if (!row) {
      return null;
    }
    let result: { found: true; value: string } | { found: false };
    try {
      result = await this.secretsStore.readUserSecret(userId, row.secretName);
    } catch (error) {
      // Transient secrets-store failure — degrade to the App fallback rather
      // than bricking git for every PAT user on a blip. The error messages are
      // store-constructed (never carry the token), but keep the log terse.
      this.logger.warn(
        `Per-user GitHub PAT for user ${userId} is temporarily unreadable (transient secrets-store error); falling back to the GitHub App for this operation: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return null;
    }
    if (!result.found) {
      throw new InternalException(
        'GITHUB_USER_PAT_UNREADABLE',
        'A GitHub PAT is configured for the user but its value is absent from the secrets store. Re-save the token in Settings.',
      );
    }
    return result.value;
  }

  /**
   * Prove the token against GitHub `GET /user`. Resolves the account login and
   * the token class for display metadata; throws a `BadRequestException` (this
   * is the user-facing save path) when GitHub rejects or cannot validate it.
   * The response is treated as untrusted JSON; the token is never logged.
   */
  private async validateAgainstGitHub(
    token: string,
  ): Promise<{ login: string; tokenType: GitPatType }> {
    let response: Response;
    try {
      response = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new BadRequestException(
        'GITHUB_PAT_VALIDATION_FAILED',
        'Could not reach GitHub to validate the token. Please try again.',
      );
    }

    // A 429, or a 403 with the rate-limit budget exhausted, is GitHub
    // rate-limiting — NOT a bad token. Distinguish it before the 401/403
    // unauthorized branch so a valid token is not mislabeled "rejected" (which
    // would prompt the user to rotate a perfectly good credential).
    const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
    if (
      response.status === 429 ||
      (response.status === 403 && rateLimitRemaining === '0')
    ) {
      throw new BadRequestException(
        'GITHUB_PAT_VALIDATION_FAILED',
        'GitHub is rate-limiting the request right now; please try again shortly.',
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new BadRequestException(
        'GITHUB_PAT_UNAUTHORIZED',
        'GitHub rejected the token. Check that it is valid and has the required scopes (repo).',
      );
    }
    if (!response.ok) {
      throw new BadRequestException(
        'GITHUB_PAT_VALIDATION_FAILED',
        `GitHub returned ${response.status} while validating the token.`,
      );
    }

    const body = (await response.json().catch(() => null)) as unknown;
    const login =
      body != null &&
      typeof body === 'object' &&
      'login' in body &&
      typeof (body as Record<string, unknown>).login === 'string'
        ? ((body as Record<string, unknown>).login as string)
        : null;
    if (!login) {
      throw new BadRequestException(
        'GITHUB_PAT_VALIDATION_FAILED',
        'GitHub did not return a valid account for the token.',
      );
    }

    return { login, tokenType: this.validator.tokenType(token) };
  }
}
