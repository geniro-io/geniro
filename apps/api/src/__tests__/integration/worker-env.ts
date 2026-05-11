/**
 * Side-effect module: rewrites `POSTGRES_URL` to the per-worker database name
 * before any other module reads `process.env`.
 *
 * Imported at the top of `setup.ts` (must come before any import that
 * transitively pulls `environments`/`mikro-orm.config`). Each vitest worker
 * gets a unique slot in `INTEGRATION_WORKER_DB_NAMES` keyed by
 * `VITEST_POOL_ID`. Falls back to the base DB if pool ID is absent or worker
 * names weren't seeded by `globalSetup` (e.g. running an .int.ts file via
 * the base monorepo `vitest.config.ts` instead of the api project config).
 *
 * BullMQ queue isolation is handled separately by `setInstanceFingerprint()`
 * called in `createTestModule()` — no env-var dance needed here.
 */
const baseUrl =
  process.env.INTEGRATION_BASE_POSTGRES_URL ?? process.env.POSTGRES_URL;
if (baseUrl) {
  const namesEnv = process.env.INTEGRATION_WORKER_DB_NAMES;
  const poolIdRaw = process.env.VITEST_POOL_ID;
  if (namesEnv && poolIdRaw) {
    const names = namesEnv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const poolId = Number(poolIdRaw);
    if (Number.isFinite(poolId) && names.length > 0) {
      // VITEST_POOL_ID starts at 1; map onto worker DBs round-robin so
      // pools that exceed the provisioned worker count still get *a*
      // worker DB rather than colliding on the base.
      const index = (Math.max(1, Math.floor(poolId)) - 1) % names.length;
      const dbName = names[index];
      const url = new URL(baseUrl);
      url.pathname = `/${dbName}`;
      process.env.POSTGRES_URL = url.toString();
    }
  }
}
