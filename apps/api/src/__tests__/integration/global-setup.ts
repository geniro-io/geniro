import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import Docker from 'dockerode';
import { Client } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

import mikroOrmConfig from '../../db/mikro-orm.config';

const WORKER_COUNT = 5;
const CONTAINER_LABELS = { 'io.geniro.test': 'true' };
const RUNTIME_TYPE_LABEL = 'geniro.io/type=runtime';

/**
 * Boot ephemeral Postgres / Redis / Qdrant containers, run MikroORM migrations
 * against the base DB once, then clone that DB into one DB per vitest worker so
 * workers can run in parallel without state collisions.
 *
 * The setup is intentionally synchronous-ish: every step that mutates env vars
 * or schema state happens before vitest spawns its workers, so the worker-side
 * `setup.ts` can read deterministic values from `process.env`.
 */
/**
 * macOS Colima exposes no host-side `/var/run/docker.sock`, and testcontainers
 * v12 only auto-detects Docker Desktop — so on a Colima box Ryuk tries to
 * bind-mount the host socket path into its VM and dies with `operation not
 * supported`. Detect Colima here and set the two env vars the suite needs,
 * unless the developer already exported their own. This runs before any
 * container boots — and `globalSetup` mutations land before vitest spawns its
 * workers (see the env-propagation note in `globalSetup`), so the worker-side
 * Dockerode in the NestJS app sees `DOCKER_HOST` too. CI (Linux, native
 * `/var/run/docker.sock`, no `~/.colima`) never trips the socket-existence
 * guard, so it is untouched and needs no override.
 */
function ensureColimaDockerEnv(): void {
  const colimaSocket = join(homedir(), '.colima', 'default', 'docker.sock');
  if (!existsSync(colimaSocket)) {
    return;
  }
  const applied: string[] = [];
  if (!process.env.DOCKER_HOST) {
    process.env.DOCKER_HOST = `unix://${colimaSocket}`;
    applied.push('DOCKER_HOST');
  }
  if (!process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE) {
    process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = '/var/run/docker.sock';
    applied.push('TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE');
  }
  if (applied.length > 0) {
    process.stdout.write(
      `[integration] Colima detected — auto-configured ${applied.join(' + ')}\n`,
    );
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  ensureColimaDockerEnv();
  const startedAt = Date.now();
  const sessionStartedAtUnixSec = Math.floor(startedAt / 1000);
  const [postgresContainer, redisContainer, qdrantContainer] =
    await Promise.all([
      new GenericContainer('pgvector/pgvector:pg17')
        .withLabels(CONTAINER_LABELS)
        .withEnvironment({
          POSTGRES_USER: 'postgres',
          POSTGRES_PASSWORD: 'postgres',
          POSTGRES_DB: 'geniro',
        })
        .withExposedPorts(5432)
        .withWaitStrategy(
          Wait.forLogMessage(
            /database system is ready to accept connections/,
            2,
          ),
        )
        .start(),
      new GenericContainer('redis:7-alpine')
        .withLabels(CONTAINER_LABELS)
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start(),
      new GenericContainer('qdrant/qdrant:latest')
        .withLabels(CONTAINER_LABELS)
        .withExposedPorts(6333)
        .withWaitStrategy(Wait.forLogMessage(/Qdrant HTTP listening/))
        .start(),
    ]);
  const containers: StartedTestContainer[] = [
    postgresContainer,
    redisContainer,
    qdrantContainer,
  ];

  const postgresUrl = `postgresql://postgres:postgres@${postgresContainer.getHost()}:${postgresContainer.getMappedPort(
    5432,
  )}/geniro`;
  const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  const qdrantUrl = `http://${qdrantContainer.getHost()}:${qdrantContainer.getMappedPort(6333)}`;

  process.stdout.write(
    `[integration] containers ready in ${Date.now() - startedAt}ms\n`,
  );

  process.env.POSTGRES_URL = postgresUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.QDRANT_URL = qdrantUrl;

  await runMigrations(postgresUrl);

  const workerDbNames = await cloneDatabasePerWorker(postgresUrl, WORKER_COUNT);

  process.env.INTEGRATION_BASE_POSTGRES_URL = postgresUrl;
  process.env.INTEGRATION_WORKER_DB_NAMES = workerDbNames.join(',');

  return async () => {
    await sweepRuntimeContainers(sessionStartedAtUnixSec);
    // Networks can only be removed after their containers have stopped.
    await sweepRuntimeNetworks(sessionStartedAtUnixSec);
    await dropWorkerDatabases(postgresUrl, workerDbNames);
    await Promise.allSettled(containers.map((c) => c.stop()));
  };
}

/**
 * Force-remove any runtime containers spawned via RuntimeProvider during
 * this test session. Filtering by Created >= sessionStart avoids touching
 * containers from a developer's concurrent `pnpm start:dev` session that
 * happened to be running before tests started.
 */
const sweepRuntimeContainers = async (
  sessionStartedAtUnixSec: number,
): Promise<void> => {
  let docker: Docker;
  try {
    docker = new Docker();
  } catch (err) {
    process.stdout.write(
      `[integration] runtime sweep skipped — dockerode init failed: ${(err as Error).message}\n`,
    );
    return;
  }

  let candidates: Awaited<ReturnType<Docker['listContainers']>>;
  try {
    candidates = await docker.listContainers({
      all: true,
      filters: { label: [RUNTIME_TYPE_LABEL] },
    });
  } catch (err) {
    process.stdout.write(
      `[integration] runtime sweep skipped — listContainers failed: ${(err as Error).message}\n`,
    );
    return;
  }

  const testEra = candidates.filter(
    (c) => c.Created >= sessionStartedAtUnixSec,
  );
  if (testEra.length === 0) {
    return;
  }

  process.stdout.write(
    `[integration] sweeping ${testEra.length} runtime container(s) spawned during tests\n`,
  );

  await Promise.allSettled(
    testEra.map(async (info) => {
      try {
        await docker.getContainer(info.Id).remove({ force: true });
      } catch {
        // best-effort: container may have been removed by its own cleanup
      }
    }),
  );
};

/**
 * Force-remove any bridge networks created by DockerRuntime during this test
 * session. Must run after sweepRuntimeContainers so containers have already
 * been removed — Docker refuses to delete a network that has active endpoints.
 */
const sweepRuntimeNetworks = async (
  sessionStartedAtUnixSec: number,
): Promise<void> => {
  let docker: Docker;
  try {
    docker = new Docker();
  } catch (err) {
    process.stdout.write(
      `[integration] network sweep skipped — dockerode init failed: ${(err as Error).message}\n`,
    );
    return;
  }

  let candidates: Awaited<ReturnType<Docker['listNetworks']>>;
  try {
    candidates = await docker.listNetworks({
      filters: {
        label: ['geniro/managed=true', 'geniro/created-by=docker-runtime'],
      },
    });
  } catch (err) {
    process.stdout.write(
      `[integration] network sweep skipped — listNetworks failed: ${(err as Error).message}\n`,
    );
    return;
  }

  const testEra = candidates.filter(
    (net) => new Date(net.Created).getTime() / 1000 >= sessionStartedAtUnixSec,
  );
  if (testEra.length === 0) {
    return;
  }

  process.stdout.write(
    `[integration] sweeping ${testEra.length} runtime network(s) spawned during tests\n`,
  );

  await Promise.allSettled(
    testEra.map(async (info) => {
      try {
        await docker.getNetwork(info.Id).remove();
      } catch {
        // best-effort: network may already be removed or still have endpoints
      }
    }),
  );
};

const runMigrations = async (postgresUrl: string): Promise<void> => {
  const previous = process.env.POSTGRES_URL;
  process.env.POSTGRES_URL = postgresUrl;
  try {
    const { MikroORM } = await import('@mikro-orm/postgresql');
    const { Migrator } = await import('@mikro-orm/migrations');
    const orm = await MikroORM.init({
      ...mikroOrmConfig,
      extensions: [Migrator],
      clientUrl: postgresUrl,
      entities: [],
      entitiesTs: [],
      discovery: { ...mikroOrmConfig.discovery, warnWhenNoEntities: false },
      migrations: {
        ...mikroOrmConfig.migrations,
        snapshot: false,
      },
    });
    try {
      await orm.migrator.up();
    } finally {
      await orm.close(true);
    }
  } finally {
    if (previous === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = previous;
    }
  }
};

const cloneDatabasePerWorker = async (
  baseUrl: string,
  workerCount: number,
): Promise<string[]> => {
  if (workerCount === 1) {
    return [extractDatabaseName(baseUrl)];
  }
  const adminUrl = withDatabase(baseUrl, 'postgres');
  const baseDbName = extractDatabaseName(baseUrl);
  const names: string[] = [];

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (let i = 1; i <= workerCount; i++) {
      const dbName = `${baseDbName}_w${i}`;
      names.push(dbName);
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await client.query(
        `CREATE DATABASE "${dbName}" TEMPLATE "${baseDbName}"`,
      );
    }
  } finally {
    await client.end();
  }

  return names;
};

const dropWorkerDatabases = async (
  baseUrl: string,
  workerDbNames: string[],
): Promise<void> => {
  if (workerDbNames.length <= 1) {
    return;
  }
  const adminUrl = withDatabase(baseUrl, 'postgres');
  const client = new Client({ connectionString: adminUrl });
  try {
    await client.connect();
  } catch {
    return;
  }
  try {
    for (const dbName of workerDbNames) {
      try {
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        );
        await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } catch {
        // best-effort teardown
      }
    }
  } finally {
    await client.end();
  }
};

const extractDatabaseName = (url: string): string => {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\//, '');
  if (!path) {
    throw new Error(`Postgres URL has no database segment: ${url}`);
  }
  return path;
};

const withDatabase = (url: string, dbName: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
};
