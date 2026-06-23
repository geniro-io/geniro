import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';

import { GitHubAuthMethod } from '../../graph-resources/graph-resources.types';
import { GitProviderConnectionDao } from '../dao/git-provider-connection.dao';
import { GitProvider } from '../git-auth.types';
import { GitPatModeService } from './git-pat-mode.service';
import { GitHubAppService } from './github-app.service';

export interface ResolvedToken {
  token: string;
  source: GitHubAuthMethod;
}

@Injectable()
export class GitTokenResolverService {
  constructor(
    private readonly gitHubAppService: GitHubAppService,
    private readonly gitPatModeService: GitPatModeService,
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

    // PAT mode (deployment-wide GITHUB_AUTH_MODE=pat): resolve through the
    // validated PAT, bypassing the GitHub App path entirely. Placed ABOVE the
    // isConfigured() gate so a pat-mode deployment with no GitHub App configured
    // still resolves — and fails CLOSED (getValidatedPat() throws on a
    // missing/invalid PAT) rather than returning null, which a caller like
    // gh-clone would otherwise swallow into a silent anonymous clone.
    if (this.gitPatModeService.isPatMode()) {
      return {
        token: this.gitPatModeService.getValidatedPat(),
        source: GitHubAuthMethod.Pat,
      };
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
    // PAT mode short-circuit (see resolveToken). Placed ABOVE the
    // !isConfigured() early-return so pat mode resolves regardless of GitHub App
    // config, and fails CLOSED via getValidatedPat() rather than returning null.
    if (this.gitPatModeService.isPatMode()) {
      return {
        token: this.gitPatModeService.getValidatedPat(),
        source: GitHubAuthMethod.Pat,
      };
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
