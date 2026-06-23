import { Migration } from '@mikro-orm/migrations';

export class Migration20260623153258 extends Migration {
  override up(): void | Promise<void> {
    // Hand-trimmed per CLAUDE.md drift exception: `pnpm migration:generate`
    // also emitted unrelated pre-existing dev-schema drift — a
    // thread_store_entries FK drop and a threads.total_running_ms default
    // normalization — that this migration must not carry. Only the intended
    // git_repositories.sync_source change is kept.
    this.addSql(`alter table "git_repositories" add "sync_source" text null;`);
    this.addSql(
      `create index "git_repositories_sync_source_index" on "git_repositories" ("sync_source");`,
    );
    this.addSql(
      `alter table "git_repositories" add constraint "git_repositories_sync_source_check" check ("sync_source" in ('github_app', 'pat'));`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "git_repositories_sync_source_index";`);
    this.addSql(
      `alter table "git_repositories" drop constraint "git_repositories_sync_source_check";`,
    );
    this.addSql(`alter table "git_repositories" drop column "sync_source";`);
  }
}
