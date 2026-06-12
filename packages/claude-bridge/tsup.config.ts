import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/bridge.ts'],
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({
    js: format === 'esm' ? '.mjs' : '.js',
  }),
  dts: true,
  clean: true,
  sourcemap: true,
  shims: true,
  // The bridge script is shipped into sandboxes as one self-contained file
  // (plus the externally installed SDK) — never emit shared chunks.
  splitting: false,
});
