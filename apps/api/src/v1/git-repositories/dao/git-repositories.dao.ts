import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

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
   * Upsert repos from a GitHub sync (App or PAT mode). On conflict, updates url,
   * defaultBranch, installationId, syncSource, and syncedAt without touching
   * other user-managed fields. `syncSource` is merged so a row's discriminator
   * stays accurate across re-syncs and the rare operator-driven mode flip.
   */
  async upsertGithubSyncRepos(repos: GithubSyncRepo[]): Promise<void> {
    if (!repos.length) {
      return;
    }

    await this.getRepo().upsertMany(repos, {
      onConflictFields: ['owner', 'repo', 'createdBy', 'provider'],
      onConflictAction: 'merge',
      onConflictMergeFields: [
        'url',
        'defaultBranch',
        'installationId',
        'syncSource',
        'syncedAt',
        'updatedAt',
      ],
    });
  }

  async restoreSoftDeleted(
    userId: string,
    ownerRepoPairs: { owner: string; repo: string }[],
  ): Promise<void> {
    if (!ownerRepoPairs.length) {
      return;
    }

    await this.em
      .createQueryBuilder(GitRepositoryEntity)
      .update({ deletedAt: null })
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
