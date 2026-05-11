/**
 * Injection tokens for the threads module. Use string tokens (with `import type`
 * on the service class) to break file-level circular imports between
 * ThreadsService and other services that ThreadsService itself depends on
 * (e.g. GraphsService). The module-level `forwardRef(() => GraphsModule)` /
 * `forwardRef(() => ThreadsModule)` pair handles the NestJS DI graph; the
 * token avoids the TypeScript-emitted runtime reference that triggers a TDZ
 * on the partially-loaded import.
 */
export const THREADS_SERVICE_TOKEN = 'THREADS_SERVICE_TOKEN';
