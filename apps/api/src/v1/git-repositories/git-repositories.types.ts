export enum GitRepositoryProvider {
  GITHUB = 'GITHUB',
}

/**
 * Synthetic `createdBy` for repositories synced under the deployment-wide PAT
 * (GITHUB_AUTH_MODE=pat). PAT mode is a single shared deployment identity, not a
 * per-user one: every user's `GET /user/repos` returns the same deployment
 * repos, so all PAT-synced rows share this fixed owner to avoid per-user
 * duplicate rows (the entity unique key is owner+repo+createdBy+provider). It is
 * deliberately NOT a UUID so it can never collide with a real Keycloak user id.
 */
export const PAT_DEPLOYMENT_OWNER = 'pat-deployment';

export enum RepoIndexStatus {
  Pending = 'pending',
  InProgress = 'in_progress',
  Completed = 'completed',
  Failed = 'failed',
}
