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
      sequence: { groupOrder: 1 },
      globalSetup: ['./src/__tests__/integration/global-setup.ts'],
    },
  }),
);
