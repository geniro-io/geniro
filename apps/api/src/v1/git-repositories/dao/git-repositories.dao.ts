import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { GitHubAuthMethod } from '../../graph-resources/graph-resources.types';
import { GitRepositoryEntity } from '../entity/git-repository.entity';

export type GithubSyncRepo = Pick<
  GitRepositoryEntity,
  | 'owner'
  | 'repo'
  | 'url'
  | 'provider'
  | 'defaultBranch'
  | 'createdBy'
  | 'projectId'
  | 'installationId'
  | 'syncSource'
  | 'syncedAt'
>;

@Injectable()
export class GitRepositoriesDao extends BaseDao<GitRepositoryEntity> {
  constructor(em: EntityManager) {
    super(em, GitRepositoryEntity);
  }

  /**
   * Upsert repos from a GitHub sync. On conflict (owner, repo, createdBy,
   * provider) it always refreshes url / defaultBranch / syncedAt.
   *
   * `mergeSource` controls whether the row's SOURCE identity (installationId +
   * syncSource) is also overwritten on conflict:
   * - App sync passes the default (`true`): an App row's installationId can
   *   change when a repo moves installations, so the source is merged.
   * - PAT sync passes `false`: a PAT sync that hits a repo ALSO visible via an
   *   existing App installation (same owner/repo/createdBy now that App and PAT
   *   rows share the per-user `createdBy`) must NOT relabel that App row to
   *   `(syncSource=Pat, installationId=null)` — doing so would expose it to the
   *   per-user PAT orphan-prune and irreversibly destroy an App repo's index.
   *   Leaving the source intact preserves the "PAT sync never deletes
   *   App-synced repos" invariant; a genuinely PAT-only row is unaffected (it
   *   inserts with syncSource=Pat / installationId=null and those never change).
   */
  async upsertGithubSyncRepos(
    repos: GithubSyncRepo[],
    options: { mergeSource?: boolean } = {},
  ): Promise<void> {
    if (!repos.length) {
      return;
    }

    const { mergeSource = true } = options;
    const onConflictMergeFields: (keyof GitRepositoryEntity)[] = mergeSource
      ? [
          'url',
          'defaultBranch',
          'installationId',
          'syncSource',
          'syncedAt',
          'updatedAt',
        ]
      : ['url', 'defaultBranch', 'syncedAt', 'updatedAt'];

    await this.getRepo().upsertMany(repos, {
      onConflictFields: ['owner', 'repo', 'createdBy', 'provider'],
      onConflictAction: 'merge',
      onConflictMergeFields,
    });
  }

  /**
   * Un-delete soft-deleted rows for a user that match the given owner/repo pairs
   * AND the given `syncSource`. Scoping to `syncSource` keeps the two sync
   * sources isolated: a PAT sync only resurrects rows it previously owned, never
   * a repo the user removed under the App (installationId set) or manually
   * (syncSource = null).
   */
  async restoreSoftDeleted(
    userId: string,
    ownerRepoPairs: { owner: string; repo: string }[],
    syncSource: GitHubAuthMethod,
  ): Promise<void> {
    if (!ownerRepoPairs.length) {
      return;
    }

    await this.em
      .createQueryBuilder(GitRepositoryEntity)
      .update({ deletedAt: null })
      .where({
        createdBy: userId,
        syncSource,
        $or: ownerRepoPairs.map((pair) => ({
          owner: pair.owner,
          repo: pair.repo,
        })),
        deletedAt: { $ne: null },
      })
      .execute();
  }

  /**
   * PAT-sync resurrection: for every SOFT-DELETED row matching the user's
   * owner/repo pairs — REGARDLESS of its prior source — un-delete it AND claim
   * it as a PAT row (`syncSource = Pat`, `installationId = null`).
   *
   * Under PAT-exclusive precedence (a stored PAT shadows the GitHub App), a repo
   * the PAT lists is PAT-owned. The source-scoped `restoreSoftDeleted(…, Pat)`
   * only un-deletes prior Pat rows, so a soft-deleted GitHub-App row (or a
   * manually-removed `syncSource = null` row) that the PAT now lists would
   * otherwise stay hidden forever while the `mergeSource: false` upsert churns
   * its `syncedAt` every run (the F6 zombie). Claiming it as Pat makes the row
   * fully PAT-governed: visible again AND subject to the PAT orphan-prune.
   *
   * Only SOFT-DELETED rows (`deletedAt IS NOT NULL`) are claimed. A LIVE App row
   * (`deletedAt = null`) the PAT also lists is NOT matched here and keeps its App
   * source (the `mergeSource: false` upsert leaves it intact), so no live
   * App-synced repo is ever relabeled into the PAT prune's blast radius.
   */
  async restoreAndClaimForPat(
    userId: string,
    ownerRepoPairs: { owner: string; repo: string }[],
  ): Promise<void> {
    if (!ownerRepoPairs.length) {
      return;
    }

    await this.em
      .createQueryBuilder(GitRepositoryEntity)
      .update({
        deletedAt: null,
        syncSource: GitHubAuthMethod.Pat,
        installationId: null,
      })
      .where({
        createdBy: userId,
        $or: ownerRepoPairs.map((pair) => ({
          owner: pair.owner,
          repo: pair.repo,
        })),
        deletedAt: { $ne: null },
      })
      .execute();
  }
}
