import { Injectable } from '@nestjs/common';
import { InternalException } from '@packages/common';

import { environment } from '../../../environments';
import { GitHubAuthMethod } from '../../graph-resources/graph-resources.types';

/**
 * Resolves the deployment-wide GitHub authentication mode and validates the
 * configured personal access token (PAT).
 *
 * The mode is selected by the `GITHUB_AUTH_MODE` env var (`app` | `pat`,
 * default `app`). In `pat` mode every GitHub operation resolves through
 * `GITHUB_PAT` instead of the GitHub App — the escape hatch for organisations
 * that will not install the App. The PAT is host-controlled deployment config:
 * it is resolved here host-side and injected through the token resolver only,
 * and is NEVER routed through `collectSecretNames`/`secretEnv` (sandbox-boundary
 * rule — that channel is for sandbox secrets, not a host-only deployment cred).
 */
@Injectable()
export class GitPatModeService {
  /**
   * The active deployment-wide auth mode. Any value other than `pat` (the
   * default `app`, an empty value, or a typo) resolves to `GithubApp` so the
   * existing GitHub App path is the fail-safe default.
   */
  mode(): GitHubAuthMethod {
    return environment.githubAuthMode === GitHubAuthMethod.Pat
      ? GitHubAuthMethod.Pat
      : GitHubAuthMethod.GithubApp;
  }

  isPatMode(): boolean {
    return this.mode() === GitHubAuthMethod.Pat;
  }

  /**
   * Non-throwing status check (for system-settings display): pat mode is active
   * AND a non-empty PAT is configured. Does NOT validate the token shape — use
   * getValidatedPat() (which fails closed) on the actual resolution path.
   */
  isPatConfigured(): boolean {
    return this.isPatMode() && (environment.githubPat || '').trim().length > 0;
  }

  /**
   * Resolve and validate the configured PAT. Fails CLOSED on every gap — mode
   * not `pat`, an empty/unset value, or a value carrying embedded whitespace
   * (header/URL-unsafe). There is deliberately NO fallback to anonymous git: a
   * misconfigured `pat`-mode deployment refuses to operate rather than silently
   * cloning/committing without credentials (the `gh-clone` anonymous-fallback
   * path must never be reached on a missing PAT).
   *
   * The token is a secret and is NEVER logged or echoed — only the env-var NAME
   * (`GITHUB_PAT`) appears in errors (sandbox-boundary.md). The trimmed value is
   * what callers inject as `GH_TOKEN` and as the `x-access-token:<token>@github`
   * clone-URL userinfo segment.
   */
  getValidatedPat(): string {
    if (!this.isPatMode()) {
      throw new InternalException(
        'GITHUB_PAT_MODE_NOT_ACTIVE',
        'getValidatedPat() was called while GITHUB_AUTH_MODE is not "pat"',
      );
    }
    // Trim first: env values copy-pasted or echo-piped commonly carry a trailing
    // newline, and a stray newline corrupts both the GH_TOKEN header value and
    // the clone-URL userinfo segment the PAT is injected into.
    const pat = (environment.githubPat || '').trim();
    if (!pat) {
      throw new InternalException(
        'GITHUB_PAT_MISSING',
        'GITHUB_AUTH_MODE is "pat" but GITHUB_PAT is empty or unset',
      );
    }
    // Reject embedded whitespace: a real PAT has none, and an internal
    // space/newline is header/URL-unsafe (.trim() above only strips the ends).
    if (/\s/.test(pat)) {
      throw new InternalException(
        'GITHUB_PAT_INVALID',
        'GITHUB_PAT contains embedded whitespace, which is not valid for a personal access token',
      );
    }
    return pat;
  }
}
