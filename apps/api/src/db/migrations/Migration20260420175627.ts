import { Migration } from '@mikro-orm/migrations';

export class Migration20260420175627 extends Migration {
  // Hand-edited per .geniro/knowledge/gotchas/instruction-assembly-gotchas.jsonl#G4:
  //   1. Inserted partial unique index `thread_store_entries_thread_ns_key_uniq`
  //      with `WHERE deleted_at IS NULL` (MikroORM decorator form for partial
  //      expression indexes has no project precedent; manual SQL is safer).
  //   2. Stripped unrelated `runtime_instances` CHECK-constraint drift emitted
  //      by the generator.

  override up(): void | Promise<void> {
    this.addSql(
      `create table "thread_store_entries" ("id" uuid not null default gen_random_uuid(), "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, "created_by" varchar(255) not null, "project_id" uuid not null, "thread_id" uuid not null, "namespace" varchar(128) not null, "key" varchar(256) not null, "value" jsonb not null, "mode" text not null, "author_agent_id" varchar(128) null, "tags" text[] null, primary key ("id"));`,
    );
    this.addSql(
      `create index "thread_store_entries_created_by_index" on "thread_store_entries" ("created_by");`,
    );
    this.addSql(
      `create index "thread_store_entries_project_id_index" on "thread_store_entries" ("project_id");`,
    );
    this.addSql(
      `create index "thread_store_entries_thread_ns_idx" on "thread_store_entries" ("thread_id", "namespace");`,
    );

    this.addSql(
      `alter table "thread_store_entries" add constraint "thread_store_entries_thread_id_foreign" foreign key ("thread_id") references "threads" ("id") on delete cascade;`,
    );
    this.addSql(
      `alter table "thread_store_entries" add constraint "thread_store_entries_mode_check" check ("mode" in ('kv', 'append'));`,
    );

    this.addSql(
      'CREATE UNIQUE INDEX "thread_store_entries_thread_ns_key_uniq" ON "thread_store_entries" ("thread_id", "namespace", "key") WHERE "deleted_at" IS NULL;',
    );
  }

  override down(): void | Promise<void> {
    this.addSql('DROP INDEX "thread_store_entries_thread_ns_key_uniq";');

    this.addSql(`drop table if exists "thread_store_entries" cascade;`);
  }
}
