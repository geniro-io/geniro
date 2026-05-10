import { createRequire } from 'node:module';
import { join } from 'node:path';

import { Migrator } from '@mikro-orm/migrations';

const esmRequire = createRequire(__filename);
import { defineConfig, UnderscoreNamingStrategy } from '@mikro-orm/postgresql';
import { SeedManager } from '@mikro-orm/seeder';

import { environment } from '../environments';

const config = defineConfig({
  clientUrl: environment.postgresUrl || undefined,
  host: environment.postgresHost || undefined,
  port: environment.postgresPort ? Number(environment.postgresPort) : undefined,
  user: environment.postgresUsername || undefined,
  dbName: environment.postgresDatabase || undefined,
  password: environment.postgresPassword || undefined,
  schema: environment.postgresSchema || undefined,
  entities: [join(__dirname, '..', '**/*.entity.js')],
  entitiesTs: [join(__dirname, '..', '**/*.entity.ts')],
  // MikroORM v7 (ESM) uses dynamic import() for entity discovery. In dev,
  // @swc-node/register only hooks CJS require() for .ts files; Node's ESM
  // loader has no .ts hook, so import() of a .ts entity fails. This provider
  // falls back to require() for .ts files so SWC can compile them.

  dynamicImportProvider: async (id: string) => {
    // In vitest, import() is intercepted by the transform pipeline (SWC) which
    // handles decorators and TS syntax. CJS require() bypasses the pipeline and
    // hits Node's native parser which fails on decorators.
    // Outside vitest (dev start:dev), require() is needed because import() of
    // .ts files isn't hooked by @swc-node/register.
    const isVitest = typeof process !== 'undefined' && !!process.env['VITEST'];
    const path = id.startsWith('file://') ? new URL(id).pathname : id;
    if (!isVitest && (id.endsWith('.ts') || id.includes('.ts?'))) {
      return esmRequire(path);
    }
    // SWC's commonjs transform rewrites `import(id)` to `require(p)`, which
    // doesn't accept file:// URLs. MikroORM v7 emits file:// URLs for entity
    // discovery, so we strip the prefix above before forwarding.
    return import(path);
  },
  // Ignore undefined values in find queries instead of treating them as NULL.
  // This allows safely spreading optional DTO fields into FilterQuery without
  // generating unwanted IS NULL conditions.
  ignoreUndefinedInQuery: true,
  // MikroORM v7 disallows global EM by default. NestJS request-scoping via
  // middleware handles context isolation, so global access is safe here.
  allowGlobalContext: true,
  // MikroORM v7 tries to verify/create the DB on init via a separate connection.
  // The DB is managed by docker-compose, so skip this check.
  ensureDatabase: false,
  // TODO: Remove once all entities migrate from dual scalar+relation FK pattern
  // to MikroORM v7's single @ManyToOne pattern (e.g. threadId + thread -> thread only)
  discovery: {
    checkDuplicateFieldNames: false,
  },
  namingStrategy: UnderscoreNamingStrategy,
  extensions: [Migrator, SeedManager],
  migrations: {
    path: join(__dirname, 'migrations'),
    pathTs: join(__dirname, 'migrations'),
    tableName: 'mikro_orm_migrations',
    transactional: true,
    snapshot: false,
  },
  seeder: {
    path: join(__dirname, 'seeders'),
    pathTs: join(__dirname, 'seeders'),
  },
  driverOptions: environment.postgresSsl
    ? { connection: { ssl: true } }
    : undefined,
  schemaGenerator: environment.postgresSchema
    ? { ignoreSchema: [] }
    : undefined,
  debug: environment.lodDbQueries ?? false,
});

export default config;
