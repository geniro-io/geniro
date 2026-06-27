---
paths:
  - "apps/api/**/*.dao.ts"
  - "apps/api/**/*.service.ts"
---

# Database Query Patterns

## DAO Structure

DAOs extend `BaseDao<Entity>` from `@packages/mikroorm` and inject `EntityManager` from `@mikro-orm/postgresql`. Standard CRUD methods are inherited from `BaseDao`:

```typescript
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

@Injectable()
export class ItemDao extends BaseDao<ItemEntity> {
  protected readonly entityClass = ItemEntity;

  constructor(em: EntityManager) {
    super(em);
  }

  // Only add custom methods here -- standard CRUD is inherited from BaseDao
}
```

## FilterQuery Pattern

Use MikroORM's `FilterQuery<T>` for type-safe filtering:

```typescript
// Simple equality
await this.em.find(ItemEntity, { createdBy: userId, projectId });

// Array filter using $in operator
await this.em.find(ItemEntity, { id: { $in: ids } });

// Comparison operators
await this.em.find(ItemEntity, { lastUsedAt: { $lt: new Date() } });

// ILIKE search
await this.em.find(ItemEntity, { name: { $ilike: `%${query}%` } });

// OR conditions
await this.em.find(ItemEntity, { $or: [{ title: { $ilike: query } }, { summary: { $ilike: query } }] });

// Null checks
await this.em.find(ItemEntity, { deletedAt: null }); // IS NULL
await this.em.find(ItemEntity, { deletedAt: { $ne: null } }); // IS NOT NULL
```

## BaseDao Methods (inherited)

- `getAll(where, options?)` / `getOne(where, options?)` / `getById(id)` / `count(where)` -- reads
- `create(data, txEm?)` / `createMany(data, txEm?)` -- writes
- `updateById(id, data, txEm?)` -- updates (returns row count)
- `deleteById(id)` -- soft delete (sets `deletedAt`)
- `hardDeleteById(id)` / `hardDelete(where)` -- permanent delete

All accept an optional `txEm?: EntityManager` parameter for transaction support.

## Custom Queries

Always use MikroORM QueryBuilder (`em.createQueryBuilder()`) for queries that go beyond simple `find`/`findOne`/`count`. Use `raw()` from `@mikro-orm/core` for SQL expressions within QueryBuilder (e.g., atomic increments):

```typescript
// Aggregation with GROUP BY
const rows = await this.em
  .createQueryBuilder(ThreadEntity, 't')
  .select(['t.graphId', 't.status', 'count(*) as cnt'])
  .where({ graphId: { $in: graphIds } })
  .groupBy(['t.graphId', 't.status'])
  .execute<{ graphId: string; status: string; cnt: string }[]>();

// Atomic increment with raw expression
import { raw } from '@mikro-orm/core';
await this.em
  .createQueryBuilder(RepoIndexEntity)
  .update({ indexedTokens: raw(`indexed_tokens + ${amount}`) })
  .where({ id })
  .execute();

// Bulk upsert
await this.getRepo().upsertMany(data, {
  onConflictFields: ['owner', 'repo'],
  onConflictAction: 'merge',
  onConflictMergeFields: ['url', 'updatedAt'],
});
```

Raw SQL via `em.getConnection().execute()` is only acceptable for PostgreSQL-specific operators with no MikroORM equivalent (e.g., `?|` array overlap, `pg_advisory_lock`).

## Rules

- **No raw SQL** — always use QueryBuilder or EntityRepository methods. Raw SQL (`em.getConnection().execute()`) is only allowed for PostgreSQL-specific operators (array overlap `?|`, advisory locks) that have no MikroORM equivalent.
- **Soft delete via @Filter**: entities with `TimestampsEntity`/`AuditEntity` have a `softDelete` filter enabled by default. To include deleted rows: `{ filters: { softDelete: false } }`.
- **Prevent N+1**: use `populate` in FindOptions when you need related entities.
- **Pagination**: use `limit`, `offset`, `orderBy` in FindOptions. Always include `orderBy` with pagination.
- **Transactions**: use `em.transactional()` in services. Pass the transactional EM to DAO methods via `txEm` parameter. Never create standalone transactions in DAOs.
- **Naming**: MikroORM uses `UnderscoreNamingStrategy` -- camelCase in code maps to snake_case in DB automatically.

## Derived indexes (Qdrant / secondary stores)

When a feature mirrors a Postgres row into a Qdrant collection (or any secondary index), the Postgres row is the **source of truth** and the vector/index entry is a **derived index**. Handle the two paths with deliberately ASYMMETRIC failure semantics:

- **Write path is best-effort and must NEVER throw into the caller's transaction.** Embed/index-on-write (and index deletion) run AFTER the row commits; a vector/index failure must not roll back or block the committed row. Swallow + log (coordinates only, never the row's user content), and accept that the derived entry may lag — it is rebuilt on the next overwrite. (Document any row class that is never re-indexed, e.g. immutable append rows, as permanently index-invisible after a failed write.)
- **Read path is fail-loud and must propagate a backend failure.** A swallowed read that returns empty is indistinguishable from a genuine "no matches" and silently degrades recall — let the search throw so a degraded backend surfaces as an explicit error the caller can reason about.
- **Hydrate index hits with a single batched DAO read** keyed on the index payload (`getByKeys`-style, one `$or`/`$in` query — not an N+1 `getByKey` loop), re-order the rows back into the index's relevance order, and **drop hits whose row is gone** (a vector can outlive its row after a failed best-effort delete) so search never returns a key that `get` would 404 on.
- Cost: an index-on-write that embeds via a billed LLM call must attribute that cost even when the index write fails — see `.claude/rules/cost-accounting.md` (capture billed usage before the side-effect).

Exemplar: `AgentMemoryVectorService` (`embedEntry` best-effort write, `search` fail-loud read) + `AgentMemoryService.searchForProject` / `AgentMemoryDao.getByKeys` (batched hydration + orphan-drop).
