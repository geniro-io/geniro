// Generated for PR #27 review (drop partial unique index, use full). Runtime_instances drift removed per .geniro/knowledge/gotchas/instruction-assembly-gotchas.jsonl G4.
// FK drop/re-add and threads.total_running_ms default drift also removed (persist:false on @ManyToOne causes spurious FK diff; see entity comment and reference_mikroorm_v7_dual_property_bug.md).
// Safety guard added: hard-delete soft-deleted rows whose (thread_id, namespace, key) triple is already occupied by an active row before adding the full unique constraint. The previous partial unique index allowed (active + soft-deleted) pairs; the full unique cannot. Soft-deleted rows with an active counterpart are dead data — no consumer reads them.
import { Migration } from '@mikro-orm/migrations';

export class Migration20260512165600 extends Migration {
  override up(): void | Promise<void> {
    // Remove soft-deleted duplicates that would block the full unique constraint.
    // The previous partial unique index allowed (active + soft-deleted) pairs for the
    // same (thread_id, namespace, key); the full unique cannot. Soft-deleted rows
    // have no functional role once the active one exists, so hard-deleting them is safe.
    this.addSql(`DELETE FROM "thread_store_entries"
      WHERE "deleted_at" IS NOT NULL
        AND ("thread_id", "namespace", "key") IN (
          SELECT "thread_id", "namespace", "key" FROM "thread_store_entries"
          WHERE "deleted_at" IS NULL
        );`);
    this.addSql(
      `drop index if exists "thread_store_entries_thread_ns_key_uniq";`,
    );
    this.addSql(
      `alter table "thread_store_entries" add constraint "thread_store_entries_thread_id_namespace_key_unique" unique ("thread_id", "namespace", "key");`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `alter table "thread_store_entries" drop constraint "thread_store_entries_thread_id_namespace_key_unique";`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX thread_store_entries_thread_ns_key_uniq ON public.thread_store_entries USING btree (thread_id, namespace, key) WHERE (deleted_at IS NULL);`,
    );
  }
}
