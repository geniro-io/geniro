import { Migration } from '@mikro-orm/migrations';

export class Migration20260626110841 extends Migration {
  override up(): void | Promise<void> {
    this.addSql(
      `create table "agent_memory_entries" ("id" uuid not null default gen_random_uuid(), "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, "created_by" varchar(255) not null, "project_id" uuid not null, "namespace" varchar(128) not null, "key" varchar(256) not null, "title" varchar(256) null, "value" jsonb not null, "mode" text not null, "author_agent_id" varchar(128) null, "tags" text[] null, primary key ("id"));`,
    );
    this.addSql(
      `create index "agent_memory_entries_created_by_index" on "agent_memory_entries" ("created_by");`,
    );
    this.addSql(
      `create index "agent_memory_entries_project_id_index" on "agent_memory_entries" ("project_id");`,
    );
    this.addSql(
      `create index "agent_memory_entries_project_ns_idx" on "agent_memory_entries" ("project_id", "namespace");`,
    );
    this.addSql(
      `alter table "agent_memory_entries" add constraint "agent_memory_entries_project_id_namespace_key_unique" unique ("project_id", "namespace", "key");`,
    );
    this.addSql(
      `alter table "agent_memory_entries" add constraint "agent_memory_entries_mode_check" check ("mode" in ('kv', 'append'));`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "agent_memory_entries" cascade;`);
  }
}
