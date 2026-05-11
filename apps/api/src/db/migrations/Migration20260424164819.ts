// Known-drift stripped: runtime_instances enum/CHECK and thread_store_entries unique index; see .geniro/knowledge/gotchas/instruction-assembly-gotchas.jsonl#G4
import { Migration } from '@mikro-orm/migrations';

export class Migration20260424164819 extends Migration {
  override up(): void | Promise<void> {
    this.addSql(
      `alter table "threads" add "running_started_at" timestamptz null, add "total_running_ms" bigint not null default 0;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `alter table "threads" drop column "running_started_at", drop column "total_running_ms";`,
    );
  }
}
