import {
  Entity,
  Enum,
  Filter,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { PgTextArrayType } from '@packages/mikroorm';

import { AuditEntity } from '../../../auth/audit.entity';
import { AgentMemoryEntryMode } from '../agent-memory.types';

/**
 * Durable, project-scoped agent memory entry. Unlike thread-store (which is keyed
 * on a thread and dies with it), an agent_memory row lives at the project level and
 * is shared by every agent that runs in the project, across threads and sessions.
 *
 * `projectId` and `createdBy` are inherited scalars from {@link AuditEntity}. Scoping
 * on the scalar `projectId` (NO `@ManyToOne` relation) is deliberate: it keeps this
 * entity clear of the MikroORM v7 dual scalar+relation FK comparator bug, so a plain
 * `migration:generate` emits a clean FK-free table (see
 * reference_mikroorm_v7_dual_property_bug.md). Do NOT add a project/agent relation.
 */
@Entity({ tableName: 'agent_memory_entries' })
@Filter({ name: 'softDelete', cond: { deletedAt: null }, default: true })
@Index({
  name: 'agent_memory_entries_project_ns_idx',
  properties: ['projectId', 'namespace'],
})
@Unique({ properties: ['projectId', 'namespace', 'key'] })
export class AgentMemoryEntryEntity extends AuditEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ type: 'string', length: 128 })
  namespace!: string;

  @Property({ type: 'string', length: 256 })
  key!: string;

  /** Short human-readable label surfaced in the live index (memory_list / UI). */
  @Property({ type: 'string', length: 256, nullable: true })
  title?: string | null;

  @Property({ type: 'jsonb' })
  value!: unknown;

  @Enum({ items: () => AgentMemoryEntryMode })
  mode!: AgentMemoryEntryMode;

  /** Provenance: which agent wrote this entry. Reads are not filtered by it (shared brain). */
  @Property({ type: 'string', length: 128, nullable: true })
  authorAgentId?: string | null;

  @Property({ type: PgTextArrayType, columnType: 'text[]', nullable: true })
  tags?: string[] | null;
}
