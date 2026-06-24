import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { GitUserPatEntity } from '../entity/git-user-pat.entity';
import type { GitUserPatMetadata } from '../git-auth.types';

@Injectable()
export class GitUserPatDao extends BaseDao<GitUserPatEntity> {
  constructor(em: EntityManager) {
    super(em, GitUserPatEntity);
  }

  /**
   * Atomic INSERT … ON CONFLICT (user_id) DO UPDATE — one PAT row per user.
   * Replaces the pointer + metadata on re-save; race-safe under concurrent
   * saves (a double-clicked Save) since it is a single statement.
   */
  async upsertByUserId(
    userId: string,
    secretName: string,
    metadata: GitUserPatMetadata,
  ): Promise<GitUserPatEntity> {
    return await this.getRepo().upsert(
      { userId, secretName, metadata, updatedAt: new Date() },
      {
        onConflictFields: ['userId'],
        onConflictAction: 'merge',
        onConflictMergeFields: ['secretName', 'metadata', 'updatedAt'],
      },
    );
  }
}
