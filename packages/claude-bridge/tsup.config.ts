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
  // zod must ride inside bridge.mjs: the sandbox only ever installs the SDK
  // next to the script, so any other runtime dependency has to be bundled.
  noExternal: ['zod'],
});
