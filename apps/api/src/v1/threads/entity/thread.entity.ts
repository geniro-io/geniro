import { Collection } from '@mikro-orm/core';
import {
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

import { AuditEntity } from '../../../auth/audit.entity';
import { GraphEntity } from '../../graphs/entity/graph.entity';
import { ThreadStatus } from '../threads.types';
import { MessageEntity } from './message.entity';

@Entity({ tableName: 'threads' })
export class ThreadEntity extends AuditEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ type: 'uuid' })
  @Index()
  graphId!: string;

  // `persist: false` here is load-bearing. ThreadEntity has both the scalar
  // `graphId` @Property and this @ManyToOne mapping to the same `graph_id`
  // column. Without persist:false on one of them, MikroORM v7's comparator
  // emits a spurious `graph: undefined` diff on every flush of a stale-loaded
  // thread (entity.graph: undefined vs originalEntity.graph: <fk-string> from
  // the load-time snapshot), which Knex translates to `SET graph_id = NULL`.
  //
  // MikroORM supports two valid configurations:
  //   1. persist:false on the SCALAR — the relation owns writes, scalar is a
  //      read-only view. `migration:generate` emits proper FK schema.
  //   2. persist:false on the RELATION (this) — the scalar owns writes.
  //      `migration:generate` would not emit the FK constraint from this
  //      entity (the DB schema must be the source of truth).
  //
  // We use (2) because every `threadsDao.create({graphId: ...})` call site
  // passes the scalar; flipping to (1) requires updating every caller to use
  // `{ graph: ref }`. Do NOT run `pnpm migration:generate` against this
  // entity until the pattern is flipped to (1).
  @ManyToOne(() => GraphEntity, {
    deleteRule: 'cascade',
    nullable: true,
    persist: false,
  })
  graph?: GraphEntity;

  @OneToMany(() => MessageEntity, (m) => m.thread)
  messages?: Collection<MessageEntity>;

  @Property({ type: 'varchar' })
  @Unique()
  externalThreadId!: string;

  @Property({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Property({ type: 'varchar', nullable: true })
  source?: string;

  @Property({ type: 'varchar', nullable: true })
  name?: string;

  @Property({ type: 'varchar', default: ThreadStatus.Running })
  @Index()
  status!: ThreadStatus;

  @Property({ type: 'uuid', nullable: true })
  lastRunId?: string;
}
