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
   * How this row was populated, for mode-scoped sync/prune:
   * - `GithubApp` — synced from a GitHub App installation (also carries installationId).
   * - `Pat`       — synced from the deployment-wide PAT (GITHUB_AUTH_MODE=pat); installationId is null.
   * - `null`      — manually added or a legacy row that predates this column.
   *
   * The PAT-mode orphan-prune targets `Pat` rows ONLY, so flipping
   * GITHUB_AUTH_MODE never deletes App-synced or manually-added repositories
   * (whose Qdrant collections + BullMQ jobs are hard-deleted outside any
   * transaction — an irreversible cross-mode data loss this column prevents).
   */
  @Enum({ items: () => GitHubAuthMethod, nullable: true })
  @Index()
  syncSource!: GitHubAuthMethod | null;

  @Property({ type: 'timestamptz', nullable: true })
  syncedAt!: Date | null;
}
