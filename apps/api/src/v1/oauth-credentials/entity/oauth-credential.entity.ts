import {
  Entity,
  Enum,
  Filter,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

import { AuditEntity } from '../../../auth/audit.entity';
import { OAuthProvider } from '../oauth-credentials.types';

/**
 * A per-project OAuth credential. The token VALUE is never stored here — it
 * lives in the `secrets` row + OpenBao KV named by `secretName` (so it appears
 * in the secret picker and is rotation-safe). This row carries only the OAuth
 * metadata needed to render the node auth-state and resolve the secret.
 */
@Entity({ tableName: 'oauth_credentials' })
@Filter({ name: 'softDelete', cond: { deletedAt: null }, default: true })
// One credential per (project, provider): the secret name is deterministic per
// provider, so `accountLabel` is mutable display metadata, not part of the key.
@Unique({ properties: ['projectId', 'provider'] })
export class OAuthCredentialEntity extends AuditEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Enum({ items: () => OAuthProvider })
  @Index()
  provider!: OAuthProvider;

  /** Human-readable account label (e.g. the Linear workspace/user name). */
  @Property({ type: 'string', length: 255 })
  accountLabel!: string;

  /** Name of the `secrets` row + OpenBao KV key holding the token value. */
  @Property({ type: 'string', length: 255 })
  secretName!: string;

  @Property({ type: 'array', columnType: 'text[]', nullable: true })
  scopes?: string[] | null;

  @Property({ type: 'timestamptz', nullable: true })
  expiresAt?: Date | null;
}
