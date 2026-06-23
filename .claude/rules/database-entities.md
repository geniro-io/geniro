---
paths:
  - "apps/api/**/*.entity.ts"
---

# Entity Conventions

## Base Classes

- **`AuditEntity`** (extends `TimestampsEntity`): adds `createdBy: string` and `projectId: string` (both indexed). Use for all user-owned resources.
- **`TimestampsEntity`**: provides `createdAt`, `updatedAt` (timestamptz), `deletedAt` (soft delete via `@Filter`). Use for system-owned resources without user ownership.

```typescript
import { Entity, Filter, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { AuditEntity } from '../../../auth/audit.entity';

@Entity({ tableName: 'items' })
@Filter({ name: 'softDelete', cond: { deletedAt: null }, default: true })
export class ItemEntity extends AuditEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ length: 255 })
  name!: string;
}
```

## Column Patterns

- Primary key: always `@PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })` with `id!: string`.
- String columns: `@Property({ length: N })` for bounded strings, `@Property({ type: 'text' })` for unbounded.
- Nullable columns: use `@Property({ nullable: true })` with TypeScript type using `?`. MikroORM's `UnderscoreNamingStrategy` maps camelCase properties to snake_case DB columns automatically.
- Boolean: `@Property({ type: 'boolean', default: false })`.
- Enum: `@Enum({ items: () => MyEnum, default: MyEnum.Default })` with `@Index()`.
- JSONB: `@Property({ type: 'jsonb' })` for structured data, `@Property({ type: 'jsonb', nullable: true })` when optional.
- Arrays: `@Property({ type: 'array', columnType: 'text[]', nullable: true })` for PostgreSQL array types.
- Binary: `@Property({ columnType: 'bytea' })` for binary data.

## Relations

- Use lambda-based relation targets: `@OneToMany(() => ThreadEntity, (t) => t.graph)`.
- Mark relation properties with `?` (optional): `threads?: Collection<ThreadEntity>`. Relations are only populated when explicitly joined.
- Index foreign key columns: `@Index()` on any column used as a foreign key.
- Use `@ManyToOne(() => Entity, { deleteRule: 'cascade' })` for cascading deletes.

## Soft Delete

Entities extending `TimestampsEntity`/`AuditEntity` must add `@Filter({ name: 'softDelete', cond: { deletedAt: null }, default: true })` at the class level. The filter is enabled by default — to include soft-deleted rows, pass `{ filters: { softDelete: false } }` in query options. DAO's `deleteById()` sets `deletedAt`. Use `hardDeleteById()` for permanent deletion.

## Migrations

- Always generate: `cd apps/api && pnpm run migration:generate`.
- Never hand-write migration files. Full rules (the drift-trim exception, regenerating an already-applied change, red flags for hand-authored files) live in `.claude/rules/migrations.md`.
- MikroORM uses `UnderscoreNamingStrategy` — all DB columns are snake_case.
