---
paths:
  - "apps/api/src/db/migrations/**/*.ts"
---

# Database Migrations

## Migration files are MACHINE-GENERATED — never hand-author one

A migration file under `apps/api/src/db/migrations/` MUST be produced by the package.json script:

```bash
cd apps/api && pnpm run migration:generate   # → mikro-orm migration:create (diffs entities vs live DB)
```

The generator diffs the current entity metadata against the live database schema and emits the SQL. **Never write a migration file from scratch, and never hand-add or invent `addSql(...)` statements** that the generator did not produce. The `MigrationYYYYMMDDHHmmss` filename timestamp comes from the command's wall clock — never fabricate or edit it.

**Red flags that a file was hand-authored (regenerate it):**
- A round, zero-second timestamp (e.g. `...123800`) that looks typed rather than wall-clock.
- `addSql` statements that don't match a real entity diff, or SQL invented to "fix up" schema by hand.
- The file appears in a feature commit with no record of `migration:generate` having been run.

## The ONLY permitted manual edit: trimming unrelated drift

`migration:generate` sometimes also emits SQL **unrelated** to the intended entity change — pre-existing dev-schema drift (known families: `runtime_instances` enum/CHECK changes; `thread_store_entries` FK drops; `threads.total_running_ms` default normalization — but treat ANY unrelated statement as drift). When this happens, hand-edit the generated file to keep **ONLY** the intended statements and drop the unrelated ones — in **both** `up()` and `down()`. Leave a one-line comment noting the trim. This is the single sanctioned manual edit; you are removing generator output, never adding hand-written SQL.

## Regenerating when the change is already applied to the local DB

If the column/constraint already exists in the local DB, `migration:generate` produces an empty (or drift-only) diff because there is nothing new to generate. To regenerate cleanly:

```bash
cd apps/api
pnpm run migration:revert      # runs the migration's down(), reverting the schema change
rm src/db/migrations/<TheFile>.ts
pnpm run migration:generate    # fresh file, real timestamp, full diff
# ... hand-trim unrelated drift (above) ...
pnpm run migration:run         # re-apply
```

Confirm `migration:revert` targets the right file first — it reverts the **last-applied** migration (the top row of `mikro_orm_migrations`), which is not necessarily the newest file on disk.

## Conventions

- MikroORM uses `UnderscoreNamingStrategy` — all DB columns are snake_case.
- Enums map to `text` + a `CHECK (... in (...))` constraint, not a native PG enum.
- After generating, run `pnpm run migration:run` to apply; verify the schema object exists before committing.
