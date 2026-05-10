import swc from 'unplugin-swc';

export const defineBaseConfig = () => ({
  plugins: [
    swc.vite({
      jsc: {
        parser: {
          syntax: 'typescript',
          tsx: true,
          decorators: true,
        },
        transform: {
          react: {
            runtime: 'automatic',
          },
          legacyDecorator: true,
          decoratorMetadata: true,
        },
      },
      module: { type: 'es6' },
    }),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  oxc: false as const,
});
