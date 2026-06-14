import { Injectable, Scope } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import outdent from 'outdent';

import {
  GIT_CREDENTIAL_HELPER_CONFIG,
  GitProvider,
} from '../../git-auth/git-auth.types';
import { GitTokenResolverService } from '../../git-auth/services/git-token-resolver.service';
import {
  IShellResourceOutput,
  ResourceKind,
  ResourceResolveContext,
} from '../graph-resources.types';
import { BaseResource } from './base-resource';

export interface GithubResourceConfig {
  name?: string;
  email?: string;
  auth?: boolean;
}

export interface IGithubResourceOutput extends IShellResourceOutput {
  resolveToken: (owner: string, userId?: string) => Promise<string | null>;
}

@Injectable({ scope: Scope.TRANSIENT })
export class GithubResource extends BaseResource<
  GithubResourceConfig,
  IGithubResourceOutput
> {
  constructor(
    logger: DefaultLogger,
    private readonly gitTokenResolverService: GitTokenResolverService,
  ) {
    super(logger);
  }

  public async getData(
    config: GithubResourceConfig,
  ): Promise<IGithubResourceOutput> {
    const resolveToken = async (
      owner: string,
      userId?: string,
    ): Promise<string | null> => {
      if (!userId) {
        return null;
      }
      const resolved = await this.gitTokenResolverService.resolveToken(
        GitProvider.GitHub,
        owner,
        userId,
      );
      return resolved?.token ?? null;
    };

    const resolveEnv = async (
      ctx?: ResourceResolveContext,
    ): Promise<Record<string, string>> => {
      const userId = ctx?.configurable?.thread_created_by;
      if (!userId) {
        return {};
      }
      const resolved =
        await this.gitTokenResolverService.resolveDefaultToken(userId);
      if (resolved?.token) {
        return { GH_TOKEN: resolved.token };
      }
      return {};
    };

    return {
      information: outdent`
        Purpose: Work with GitHub from shell via gh CLI (repos, branches, PRs, issues, workflows).
        Authentication: Uses GitHub App installation tokens. The GitHub App must be installed on the target organization/account and linked in Settings > Integrations.

        Discover commands:
          gh help
          gh <group> --help
          gh help <command>
          gh alias list
          gh extension list
          gh api --help
      `,
      kind: ResourceKind.Shell,
      resolveToken,
      data: {
        initScriptTimeout: 300000,
        initScript: [
          'set -eu',
          ...(config.auth !== false ? [GIT_CREDENTIAL_HELPER_CONFIG] : []),
          'gh config set git_protocol https',
          'git config --global pull.rebase false',
          `git config --global user.name "${config.name || 'Geniro Bot'}"`,
          `git config --global user.email "${config.email || 'bot@geniro.io'}"`,
        ].join(' && '),
        resolveEnv,
      },
    };
  }
}
