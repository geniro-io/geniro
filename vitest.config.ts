import { defineConfig } from 'vitest/config';

import { defineBaseConfig } from './vitest.base';

export default defineConfig({
  ...defineBaseConfig(),
  test: {
    globals: true,
    silent: false,
    projects: [
      'packages/*',
      'apps/*',
      'apps/api/vitest.integration.config.ts',
    ],
    fileParallelism: false,
    maxWorkers: 5,
    coverage: {
      enabled: false,
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      clean: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/generated/**'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 80,
        statements: 90,
      },
    },
    environment: 'node',
  },
});
