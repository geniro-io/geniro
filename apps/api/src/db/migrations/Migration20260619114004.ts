import { Migration } from '@mikro-orm/migrations';

export class Migration20260619114004 extends Migration {
  override up(): void | Promise<void> {
    this.addSql(
      `alter table "oauth_credentials" add "client_id" varchar(255) null, add "last_refreshed_at" timestamptz null;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `alter table "oauth_credentials" drop column "client_id", drop column "last_refreshed_at";`,
    );
  }
}
