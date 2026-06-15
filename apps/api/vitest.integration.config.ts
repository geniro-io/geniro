import { defineProject, mergeConfig } from 'vitest/config';

import { defineBaseConfig } from '../../vitest.base';
import pkg from './package.json';

export default mergeConfig(
  defineBaseConfig(),
  defineProject({
    test: {
      name: `${pkg.name}/integration`,
      disableConsoleIntercept: true,
      include: ['src/**/*.int.ts'],
      projects: undefined,
      fileParallelism: true,
      // GitHub-hosted runners have 4 vCPUs; 5 workers (each a NestJS app +
      // Docker runtime containers for the real-runtime tests) oversubscribe
      // the CPU and produce load-dependent flakes (runtime execs returning
      // empty output, indexing races). Keep 5 locally for speed.
      maxWorkers: process.env.CI ? 3 : 5,
      // Integration teardown closes a full NestJS app with three BullMQ queue
      // services, each gracefully draining a blocking Redis connection
      // (worker.close()). With several workers tearing down against the shared
      // Redis testcontainer at once, that legitimate drain can exceed vitest's
      // default 10s hookTimeout in an `afterAll` — confirmed NOT a leak (the
      // workers always close; a single-file rerun is green in ~5s; the failing
      // file rotates run-to-run). 30s gives the correct-but-slow drain headroom
      // without masking a hang. Mirrors the per-file override already in
      // thread-runtime-timer.int.ts.
      hookTimeout: 30_000,
      sequence: { groupOrder: 1 },
      globalSetup: ['./src/__tests__/integration/global-setup.ts'],
    },
  }),
);
