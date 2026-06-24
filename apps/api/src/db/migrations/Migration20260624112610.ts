import { Migration } from '@mikro-orm/migrations';

export class Migration20260624112610 extends Migration {
  override up(): void | Promise<void> {
    // Hand-trimmed: the generator also emitted unrelated pre-existing dev-schema
    // drift (thread_store_entries FK-drop + threads.total_running_ms default
    // normalization) — removed here per .claude/rules/migrations.md so this file
    // carries ONLY the git_user_pat change it was generated for.
    this.addSql(
      `create table "git_user_pat" ("id" uuid not null default gen_random_uuid(), "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, "user_id" varchar(255) not null, "secret_name" varchar(255) not null, "metadata" jsonb not null, primary key ("id"));`,
    );
    this.addSql(
      `alter table "git_user_pat" add constraint "git_user_pat_user_id_unique" unique ("user_id");`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "git_user_pat" cascade;`);
  }
}
