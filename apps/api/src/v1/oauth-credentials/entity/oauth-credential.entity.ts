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

  /**
   * The `client_id` of the per-flow DCR client that issued this credential.
   * Persisted because a `refresh_token` grant is bound to its issuing client,
   * and M2's per-flow client rode the (now-consumed) Redis pending-state. The
   * paired `client_secret` (when the AS issued a confidential client) lives in
   * OpenBao alongside the token, never in this row. Nullable: legacy M2 rows and
   * any credential acquired without a durable client have none. This durable
   * client storage is the documented M3.1 reversal of the M2 "no durable client"
   * rule — see `.claude/rules/oauth-mcp.md`.
   */
  @Property({ type: 'string', length: 255, nullable: true })
  clientId?: string | null;

  /** Last time the access token was rotated via a `refresh_token` grant — `null` until the first refresh. */
  @Property({ type: 'timestamptz', nullable: true })
  lastRefreshedAt?: Date | null;
}
