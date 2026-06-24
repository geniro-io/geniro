import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';

import { GitHubAuthMethod } from '../../graph-resources/graph-resources.types';
import { GitProviderConnectionDao } from '../dao/git-provider-connection.dao';
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

    // Per-user PAT takes precedence over the GitHub App. Resolved ABOVE the
    // isConfigured() gate so a user with a stored PAT resolves even when no
    // GitHub App is configured (the primary BYO use case). resolvePatToken
    // returns null when the user has NO PAT (benign — fall through to the App),
    // and throws an InternalException when a PAT IS configured but unreadable
    // (fail-CLOSED — the gh-tool guards re-throw it rather than cloning
    // anonymously on a broken PAT).
    const userPatToken = await this.gitUserPatService.resolvePatToken(userId);
    if (userPatToken) {
      return { token: userPatToken, source: GitHubAuthMethod.Pat };
    }

    if (this.gitHubAppService.isConfigured()) {
      // 1. Try exact match by owner (org/user that owns the repo)
      const connection = await this.gitProviderConnectionDao.getOne({
        userId,
        provider,
        accountLogin: owner,
        isActive: true,
      });

      if (connection) {
        try {
          const installationId = connection.metadata[
            'installationId'
          ] as number;
          const token =
            await this.gitHubAppService.getInstallationToken(installationId);
          return { token, source: GitHubAuthMethod.GithubApp };
        } catch (error) {
          this.logger.warn(
            `Failed to get GitHub App token for owner ${owner}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    return null;
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
