import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

import parentConfig from '../../eslint.config.mjs';

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  ...parentConfig,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-refresh/only-export-components': 'warn',
      // Web overrides from root
      '@typescript-eslint/no-empty-object-type': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
    },
  },
  {
    // shadcn UI primitives co-locate their `cva` variant maps and helper
    // exports alongside the component itself by convention. The fast-refresh
    // ergonomics rule isn't applicable here — the cost of splitting every
    // primitive into two files outweighs the HMR benefit.
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: [
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/__tests__/**/*.ts',
      '**/__tests__/**/*.tsx',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];
