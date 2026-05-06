import { defineProject, mergeConfig } from 'vitest/config';

import { defineBaseConfig } from '../../vitest.base';
import pkg from './package.json';

export default mergeConfig(
  defineBaseConfig(),
  defineProject({
    test: {
      name: pkg.name,
      disableConsoleIntercept: true,
      include: ['src/**/*.spec.ts'],
      projects: undefined,
      fileParallelism: true,
      maxWorkers: 5,
      sequence: { groupOrder: 1 },
    },
  }),
);
