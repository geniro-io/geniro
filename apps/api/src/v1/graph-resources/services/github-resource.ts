import { Injectable, Scope } from '@nestjs/common';
import { DefaultLogger, InternalException } from '@packages/common';
import outdent from 'outdent';

import {
  GIT_CREDENTIAL_HELPER_CONFIG,
  GitProvider,
} from '../../git-auth/git-auth.types';
import {
  GitTokenResolverService,
  ResolvedToken,
} from '../../git-auth/services/git-token-resolver.service';
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
      let resolved: ResolvedToken | null;
      try {
        resolved =
          await this.gitTokenResolverService.resolveDefaultToken(userId);
      } catch (error) {
        // Fail CLOSED on a configured-but-broken credential: a present-but-
        // unreadable per-user PAT throws an InternalException, which MUST
        // propagate so the init script never runs unauthenticated on a broken
        // PAT (matching the gh-clone / gh-base swallow-point guards). A benign
        // "no token" returns null below and never throws.
        if (error instanceof InternalException) {
          throw error;
        }
        return {};
      }
      if (resolved?.token) {
        return { GH_TOKEN: resolved.token };
      }
      return {};
    };

    return {
      information: outdent`
        Purpose: Work with GitHub from shell via gh CLI (repos, branches, PRs, issues, workflows).
        Authentication: Resolved automatically from your configured GitHub credentials (a personal access token set in Settings if present, otherwise the GitHub App installation); no per-node setup is required. If GitHub commands fail with an auth error, GitHub authentication is not configured for your account.

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
