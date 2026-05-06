import { defineConfig, mergeConfig } from 'vitest/config';

import { defineBaseConfig } from '../../vitest.base';
import pkg from './package.json';

export default mergeConfig(
  defineBaseConfig(),
  defineConfig({
    test: {
      name: pkg.name,
      include: ['src/**/*.spec.ts'],
    },
  }),
);
