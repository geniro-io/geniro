import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';

import { GitHubAuthMethod } from '../../graph-resources/graph-resources.types';
import { GitProviderConnectionDao } from '../dao/git-provider-connection.dao';
import { GitProviderConnectionEntity } from '../entity/git-provider-connection.entity';
import { GitProvider } from '../git-auth.types';
import { GitUserPatService } from './git-user-pat.service';
import { GitHubAppService } from './github-app.service';

export interface ResolvedToken {
  token: string;
  source: GitHubAuthMethod;
}

@Injectable()
export class GitTokenResolverService {
  constructor(
    private readonly gitHubAppService: GitHubAppService,
    private readonly gitUserPatService: GitUserPatService,
    private readonly gitProviderConnectionDao: GitProviderConnectionDao,
    private readonly logger: DefaultLogger,
  ) {}

  /**
   * Resolves a Git token for a specific owner (org/user)
   * using the appropriate provider's authentication method.
   */
  async resolveToken(
    provider: GitProvider,
    owner: string,
    userId: string,
  ): Promise<ResolvedToken | null> {
    if (provider !== GitProvider.GitHub) {
      return null;
    }

    // Resolve the per-user PAT FIRST. resolvePatToken returns null when the user
    // has NO PAT (benign — fall through to the App), and throws an
    // InternalException when a PAT IS configured but unreadable (fail-CLOSED —
    // the gh-tool guards re-throw it rather than cloning anonymously on a broken
    // PAT). Resolved ABOVE the isConfigured() gate so a stored PAT works even
    // when no GitHub App is configured (the primary BYO use case).
    const userPatToken = await this.gitUserPatService.resolvePatToken(userId);

    // The App installation covering this owner, if any — computed up front so
    // both the no-PAT path and the per-owner PAT fallback can use it.
    const appConnection = this.gitHubAppService.isConfigured()
      ? await this.gitProviderConnectionDao.getOne({
          userId,
          provider,
          accountLogin: owner,
          isActive: true,
        })
      : null;

    if (userPatToken) {
      // PER-OWNER precedence: the PAT wins for owners it can actually reach. For
      // an owner the PAT could NOT reach (absent from its last sync's reachable
      // set) but a GitHub App installation DOES cover, prefer the App — a classic
      // PAT not SSO-authorized for that org would otherwise be used and 403 with
      // no fallback. With no App alternative the PAT is still returned (unchanged
      // default), and an empty/absent owner hint (pre-sync) is treated as "no
      // hint": a PAT-only owner (no App connection) skips this check and always
      // gets the PAT, so absence never silently downgrades it to the App.
      if (appConnection) {
        const reachableOwners =
          await this.gitUserPatService.getPatSyncedOwners(userId);
        if (!reachableOwners.has(owner.toLowerCase())) {
          const appToken = await this.tryGetInstallationToken(
            appConnection,
            owner,
          );
          if (appToken) {
            return appToken;
          }
          // App token fetch failed — fall through to the PAT (best available).
        }
      }
      return { token: userPatToken, source: GitHubAuthMethod.Pat };
    }

    if (appConnection) {
      const appToken = await this.tryGetInstallationToken(appConnection, owner);
      if (appToken) {
        return appToken;
      }
    }

    return null;
  }

  /**
   * Mint a GitHub App installation token for a resolved connection. Returns null
   * (and warns) on failure so callers can fall back. Never throws — a fail-closed
   * concern belongs to the PAT path (resolvePatToken), not the App fetch.
   */
  private async tryGetInstallationToken(
    connection: GitProviderConnectionEntity,
    owner: string,
  ): Promise<ResolvedToken | null> {
    try {
      const installationId = connection.metadata['installationId'] as number;
      const token =
        await this.gitHubAppService.getInstallationToken(installationId);
      return { token, source: GitHubAuthMethod.GithubApp };
    } catch (error) {
      this.logger.warn(
        `Failed to get GitHub App token for owner ${owner}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Resolves a default GitHub token for a user (any owner).
   * Used when the target repo is not yet known (e.g. init script auth).
   */
  async resolveDefaultToken(userId: string): Promise<ResolvedToken | null> {
    // Per-user PAT precedence (see resolveToken) — above the !isConfigured()
    // early return so a stored PAT resolves regardless of GitHub App config, and
    // fails CLOSED on a present-but-unreadable PAT (resolvePatToken throws an
    // InternalException) rather than returning null.
    const userPatToken = await this.gitUserPatService.resolvePatToken(userId);
    if (userPatToken) {
      return { token: userPatToken, source: GitHubAuthMethod.Pat };
    }

    if (!this.gitHubAppService.isConfigured()) {
      return null;
    }

    const connection = await this.gitProviderConnectionDao.getOne({
      userId,
      provider: GitProvider.GitHub,
      isActive: true,
    });

    if (!connection) {
      return null;
    }

    try {
      const installationId = connection.metadata['installationId'] as number;
      const token =
        await this.gitHubAppService.getInstallationToken(installationId);
      return { token, source: GitHubAuthMethod.GithubApp };
    } catch (error) {
      this.logger.warn(
        `Failed to get default GitHub App token for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
