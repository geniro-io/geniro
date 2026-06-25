import { type GraphQlQueryResponse } from '@octokit/graphql/types';

export enum GitProvider {
  GitHub = 'github',
  GitLab = 'gitlab',
}

export enum GitHubWebhookEvent {
  Issues = 'issues',
}

export enum GitHubIssueAction {
  Opened = 'opened',
  Reopened = 'reopened',
  Labeled = 'labeled',
  Edited = 'edited',
}

export interface RegisteredTrigger {
  triggerId: string;
  trigger: {
    handleWebhookPayload: (payload: GitHubIssuePayload) => Promise<void>;
    getWatchedRepoFullNames: () => string[];
  };
  installationId: number | null;
  repoFullNames: string[];
}

export interface GitHubIssueNode {
  id: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  labels: { nodes: { name: string }[] };
  repository: {
    nameWithOwner: string;
    name: string;
    owner: { login: string };
  };
}

export interface GitHubIssueListData {
  repository: {
    issues: {
      nodes: GitHubIssueNode[];
    };
    nameWithOwner: string;
    name: string;
    owner: { login: string };
  };
  rateLimit: {
    remaining: number;
    resetAt: string;
  };
}

export type GitHubIssueListResponse = GraphQlQueryResponse<GitHubIssueListData>;

export interface GitHubIssuePayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    updated_at: string;
    labels: { name: string }[];
    user: { login: string };
  };
  /** Present only for the `labeled` action. */
  label?: { name: string };
  repository: {
    full_name: string;
    owner: { login: string };
    name: string;
  };
  installation?: { id: number };
}

export interface InstallationUnlinkedEvent {
  userId: string;
  provider: GitProvider;
  connectionIds: string[];
  accountLogins: string[];
  githubInstallationIds: number[];
}

export const INSTALLATION_UNLINKED_EVENT = 'installation.unlinked';

/**
 * Git credential helper that feeds the session's `GH_TOKEN` to git over HTTPS
 * (username `x-access-token`). The helper resolves `${GH_TOKEN}` lazily at
 * git-invocation time, so the token is never baked into the configured command
 * — it lives only in the process/session env (and thus never in a log line).
 * Shared by every site that wires native git auth inside a sandbox
 * (`ClaudeBootstrapService.configureGitAuth`, the `GithubResource` init script)
 * so a hardening/escaping change lands in exactly one place instead of drifting
 * between byte-identical copies.
 */
export const GIT_CREDENTIAL_HELPER_CONFIG =
  'git config --global credential.helper \'!f() { test "$1" = get && echo "protocol=https" && echo "host=github.com" && echo "username=x-access-token" && echo "password=${GH_TOKEN}"; }; f\'';

/**
 * Personal-access-token class: `classic` (`ghp_`) or `fine-grained`
 * (`github_pat_`). Used for display metadata on a stored per-user PAT.
 */
export type GitPatType = 'classic' | 'fine-grained';

/**
 * Non-secret display metadata persisted alongside a per-user PAT pointer row.
 * The token VALUE never lives here (it is in OpenBao under
 * `secret/data/users/{userId}/...`); only descriptors the settings UI shows.
 */
export interface GitUserPatMetadata {
  /** GitHub login resolved from `GET /user` at validate-on-save time. */
  login: string;
  tokenType: GitPatType;
  /** ISO-8601 timestamp of the successful validate-on-save check. */
  validatedAt: string;
  /**
   * Lowercased owner logins the PAT's last `/user/repos` sync could reach.
   * Powers PER-OWNER token-resolution precedence (`GitTokenResolverService`):
   * the PAT wins for owners it can reach, but an owner it could NOT reach (so
   * it is absent here) which a GitHub App installation DOES cover falls back to
   * the App rather than using a PAT that 403s. A classic PAT that is not
   * SSO-authorized for an org never lists that org's repos, so the org is
   * absent here and resolves via the App. Absent on a pre-existing row or before
   * the first PAT sync — treated as "no per-owner hint" (PAT-wins default).
   */
  syncedOwners?: string[];
}
