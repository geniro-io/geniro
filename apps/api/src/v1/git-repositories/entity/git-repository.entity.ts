import {
  Entity,
  Enum,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import { GitHubAuthMethod } from '../../graph-resources/graph-resources.types';
import { GitRepositoryProvider } from '../git-repositories.types';

@Entity({ tableName: 'git_repositories' })
@Unique({ properties: ['owner', 'repo', 'createdBy', 'provider'] })
export class GitRepositoryEntity extends TimestampsEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ type: 'varchar' })
  @Index()
  createdBy!: string;

  @Property({ type: 'uuid', nullable: true })
  @Index()
  projectId!: string | null;

  @Property({ type: 'varchar' })
  @Index()
  owner!: string;

  @Property({ type: 'varchar' })
  @Index()
  repo!: string;

  @Property({ type: 'varchar' })
  url!: string;

  @Enum({ items: () => GitRepositoryProvider })
  provider!: GitRepositoryProvider;

  @Property({ type: 'varchar', default: 'main' })
  defaultBranch!: string;

  @Property({ type: 'int', nullable: true })
  installationId!: number | null;

  /**
   * How this row was populated, for source-scoped sync/prune:
   * - `GithubApp` — synced from a GitHub App installation (also carries installationId).
   * - `Pat`       — synced from the owning user's personal access token; installationId is null.
   * - `null`      — manually added or a legacy row that predates this column.
   *
   * The per-user PAT orphan-prune targets `(createdBy = userId AND Pat)` rows
   * ONLY, so a user switching between PAT and App auth never deletes App-synced
   * or manually-added repositories (whose Qdrant collections + BullMQ jobs are
   * hard-deleted outside any transaction — an irreversible data loss this
   * column prevents).
   */
  @Enum({ items: () => GitHubAuthMethod, nullable: true })
  @Index()
  syncSource!: GitHubAuthMethod | null;

  @Property({ type: 'timestamptz', nullable: true })
  syncedAt!: Date | null;
}
