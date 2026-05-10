import { getEnv } from '@packages/common';

import { environment as devEnvironment } from './environment.dev';

/**
 * Test-only environment defaults. Loaded automatically when `NODE_ENV=test`
 * (vitest sets this for us). Values here override `environment.dev.ts` so
 * tests get a known, hermetic baseline:
 *
 *  - `daytonaApi*` / `k8s*` / `dockerRegistryMirror` are blanked out so any
 *    test that bypasses the standard MockRuntime path and tries to reach a
 *    real backend fails loudly instead of silently dialing the dev defaults
 *    (e.g. `http://localhost:3986/api`).
 *  - `restoreGraphs` and `knowledgeReindexOnStartup` are off — fire-and-
 *    forget startup tasks race with `app.close()` in tests and produce
 *    "driver has already been destroyed" noise.
 *  - `knowledgeChunksCollection` uses a `_test` suffix so the dev Qdrant
 *    instance (when reused) keeps test vectors in a separate collection.
 *  - `runtimeCleanupIntervalMs` / `runtimeIdleThresholdMs` are large
 *    numbers so the periodic cleanup BullMQ worker doesn't fire mid-test
 *    and race with explicit teardown in `RuntimeProvider.stopAndDeleteInstances`.
 *
 * `devEnvironment()` is spread first so fields not explicitly overridden
 * here inherit the dev shape (additions to the dev env never break tests).
 * Explicit overrides come after the spread so later keys win.
 */
export const environment = () =>
  ({
    ...devEnvironment(),
    env: getEnv('NODE_ENV', 'test'),
    logLevel: getEnv('LOG_LEVEL', 'debug'),

    // Disable startup background tasks that race with app.close() in tests.
    restoreGraphs: getEnv('RESTORE_GRAPHS', false),
    knowledgeReindexOnStartup: getEnv('KNOWLEDGE_REINDEX_ON_STARTUP', false),

    // Isolate test vectors from any reused dev Qdrant instance.
    knowledgeChunksCollection: getEnv(
      'KNOWLEDGE_CHUNKS_COLLECTION',
      'knowledge_chunks_test',
    ),

    // Real-backend runtime providers are intentionally unconfigured. Tests use
    // MockRuntime via createTestModule(); any code path that bypasses the mock
    // and reads these values should fail loudly rather than silently dial the
    // dev defaults baked into environment.dev.ts.
    daytonaApiUrl: getEnv('DAYTONA_API_URL', ''),
    daytonaApiKey: getEnv('DAYTONA_API_KEY', ''),
    daytonaTarget: getEnv('DAYTONA_TARGET', ''),
    k8sInCluster: getEnv('K8S_IN_CLUSTER', false),
    k8sRuntimeNamespace: getEnv('K8S_RUNTIME_NAMESPACE', ''),
    k8sRuntimeClass: getEnv('K8S_RUNTIME_CLASS', ''),

    // Push the periodic runtime-cleanup BullMQ tick well past any test
    // duration so it doesn't race with explicit teardown.
    runtimeCleanupIntervalMs: +getEnv('RUNTIME_CLEANUP_INTERVAL_MS', '3600000'),
    runtimeIdleThresholdMs: +getEnv('RUNTIME_IDLE_THRESHOLD_MS', '3600000'),
  }) as const satisfies Record<string, string | number | boolean>;
