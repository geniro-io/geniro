import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { GitUserPatMetadata } from '../git-auth.types';

/**
 * Per-user GitHub Personal Access Token pointer row — one row per user
 * (`userId` UNIQUE). The token VALUE is NOT stored here: it lives in OpenBao
 * under `secret/data/users/{userId}/{secretName}`; this row carries only the
 * pointer (`secretName`) plus non-secret display metadata. Kept deliberately
 * separate from `git_provider_connections` (the App-installation table) so the
 * PAT feature is droppable with zero blast radius on GitHub App auth.
 */
@Entity({ tableName: 'git_user_pat' })
export class GitUserPatEntity extends TimestampsEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ type: 'varchar' })
  @Unique()
  userId!: string;

  @Property({ type: 'varchar' })
  secretName!: string;

  @Property({ type: 'jsonb' })
  metadata!: GitUserPatMetadata;
}
