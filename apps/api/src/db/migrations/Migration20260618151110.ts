import { Migration } from '@mikro-orm/migrations';

export class Migration20260618151110 extends Migration {
  override up(): void | Promise<void> {
    this.addSql(
      `create table "oauth_credentials" ("id" uuid not null default gen_random_uuid(), "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, "created_by" varchar(255) not null, "project_id" uuid not null, "provider" text not null, "account_label" varchar(255) not null, "secret_name" varchar(255) not null, "scopes" text[] null, "expires_at" timestamptz null, primary key ("id"));`,
    );
    this.addSql(
      `create index "oauth_credentials_created_by_index" on "oauth_credentials" ("created_by");`,
    );
    this.addSql(
      `create index "oauth_credentials_project_id_index" on "oauth_credentials" ("project_id");`,
    );
    this.addSql(
      `create index "oauth_credentials_provider_index" on "oauth_credentials" ("provider");`,
    );
    this.addSql(
      `alter table "oauth_credentials" add constraint "oauth_credentials_project_id_provider_unique" unique ("project_id", "provider");`,
    );

    this.addSql(
      `alter table "oauth_credentials" add constraint "oauth_credentials_provider_check" check ("provider" in ('linear'));`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "oauth_credentials" cascade;`);
  }
}
