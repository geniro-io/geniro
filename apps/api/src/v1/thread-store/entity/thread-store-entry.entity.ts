import {
  Entity,
  Enum,
  Filter,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { PgTextArrayType } from '@packages/mikroorm';

import { AuditEntity } from '../../../auth/audit.entity';
import { ThreadEntity } from '../../threads/entity/thread.entity';
import { ThreadStoreEntryMode } from '../thread-store.types';

@Entity({ tableName: 'thread_store_entries' })
@Filter({ name: 'softDelete', cond: { deletedAt: null }, default: true })
@Index({
  name: 'thread_store_entries_thread_ns_idx',
  properties: ['threadId', 'namespace'],
})
@Unique({ properties: ['threadId', 'namespace', 'key'] })
export class ThreadStoreEntryEntity extends AuditEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  // `persist: false` here is load-bearing. ThreadStoreEntryEntity has both the
  // scalar `threadId` @Property and this @ManyToOne mapping to the same
  // `thread_id` column. Without persist:false on one of them, MikroORM v7's
  // comparator emits a spurious `thread: undefined` diff on every flush of a
  // stale-loaded entry (entity.thread: undefined vs originalEntity.thread:
  // <fk-string> from the load-time snapshot), which Knex translates to
  // `SET thread_id = NULL`.
  //
  // MikroORM supports two valid configurations:
  //   1. persist:false on the SCALAR — the relation owns writes, scalar is a
  //      read-only view. `migration:generate` emits proper FK schema.
  //   2. persist:false on the RELATION (this) — the scalar owns writes.
  //      `migration:generate` would not emit the FK constraint from this
  //      entity (the DB schema must be the source of truth).
  //
  // We use option (2): scalar `threadId` owns writes, relation is read-only.
  // Every call site already passes `threadId`; flipping to (1) would require
  // updating every caller to use a `{ thread: ref }` shape instead.
  // Do NOT run `pnpm migration:generate` against this entity until the pattern
  // is flipped to (1). See reference_mikroorm_v7_dual_property_bug.md in
  // project memory for full context.
  @ManyToOne(() => ThreadEntity, { deleteRule: 'cascade', persist: false })
  thread!: ThreadEntity;

  @Property({ type: 'uuid' })
  threadId!: string;

  @Property({ type: 'string', length: 128 })
  namespace!: string;

  @Property({ type: 'string', length: 256 })
  key!: string;

  @Property({ type: 'jsonb' })
  value!: unknown;

  @Enum({ items: () => ThreadStoreEntryMode })
  mode!: ThreadStoreEntryMode;

  @Property({ type: 'string', length: 128, nullable: true })
  authorAgentId!: string | null;

  @Property({ type: PgTextArrayType, columnType: 'text[]', nullable: true })
  tags!: string[] | null;
}
