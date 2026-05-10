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
      maxWorkers: 5,
      sequence: { groupOrder: 1 },
      globalSetup: ['./src/__tests__/integration/global-setup.ts'],
    },
  }),
);
