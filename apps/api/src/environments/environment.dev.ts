import { getEnv } from '@packages/common';

import { environment as prodEnvironment } from './environment.prod';

export const environment = () =>
  ({
    ...prodEnvironment(),
    env: getEnv('NODE_ENV', 'development'),
    logLevel: getEnv('LOG_LEVEL', 'debug'),
    prettyLog: getEnv('PRETTY_LOGS', true),
    sentryDsn: getEnv('SENTRY_DSN'),

    // server
    corsAllowedOrigins: getEnv('CORS_ALLOWED_ORIGINS', '*'),
    port: +getEnv('HTTP_PORT', '5000'),
    swaggerPath: getEnv('SWAGGER_PATH', '/swagger-api'),

    // connections
    postgresUrl: getEnv(
      'POSTGRES_URL',
      'postgresql://postgres:postgres@localhost:5439/geniro',
    ),
    llmBaseUrl: getEnv('LLM_BASE_URL', 'http://localhost:4000'),
    // LiteLLM URL reachable from INSIDE sandbox runtimes (Claude Agent bridge).
    // host.docker.internal resolves via the runtime container's host-gateway alias.
    litellmSandboxUrl: getEnv(
      'LITELLM_SANDBOX_URL',
      'http://host.docker.internal:4000',
    ),
    redisUrl: getEnv('REDIS_URL', 'redis://localhost:6380'),
    qdrantUrl: getEnv('QDRANT_URL', 'http://localhost:6333'),
    qdrantApiKey: getEnv('QDRANT_API_KEY'),

    // misc
    litellmMasterKey: getEnv('LITELLM_MASTER_KEY', 'master'),
    llmRequestTimeoutMs: +getEnv('LLM_REQUEST_TIMEOUT_MS', '600000'),

    // auth
    authProvider: getEnv('AUTH_PROVIDER', 'keycloak'),
    authDevMode: getEnv('AUTH_DEV_MODE', true),
    keycloakUrl: getEnv('KEYCLOAK_URL', 'http://localhost:8082'),
    keycloakRealm: getEnv('KEYCLOAK_REALM', 'geniro'),
    zitadelUrl: getEnv('ZITADEL_URL', 'http://localhost:8085'),
    zitadelIssuer: getEnv('ZITADEL_ISSUER', 'http://localhost:8085'),
    keycloakClientId: getEnv('KEYCLOAK_CLIENT_ID', 'geniro'),
    zitadelClientId: getEnv('ZITADEL_CLIENT_ID', 'geniro'),

    // docker registry mirror (for DinD)
    dockerRegistryMirror: getEnv(
      'DOCKER_REGISTRY_MIRROR',
      'http://registry-mirror:5000',
    ),
    dockerInsecureRegistry: getEnv(
      'DOCKER_INSECURE_REGISTRY',
      'registry-mirror:5000',
    ),
    knowledgeChunksCollection: getEnv(
      'KNOWLEDGE_CHUNKS_COLLECTION',
      'knowledge_chunks',
    ),
    // Daytona runtime (local docker-compose instance)
    daytonaApiUrl: getEnv('DAYTONA_API_URL', 'http://localhost:3986/api'),
    daytonaApiKey: getEnv('DAYTONA_API_KEY', 'geniro-dev-admin-key'),

    // K8s runtime (local kubeconfig, no gVisor)
    k8sInCluster: getEnv('K8S_IN_CLUSTER', false),
    k8sRuntimeClass: getEnv('K8S_RUNTIME_CLASS', ''),

    // --- GitHub Webhook ---
    githubWebhookSecret: getEnv('GITHUB_WEBHOOK_SECRET'),

    // --- Secrets store (OpenBao) ---
    openbaoAddr: getEnv('OPENBAO_ADDR', 'http://localhost:8200'),
    openbaoToken: getEnv('OPENBAO_TOKEN', 'dev-openbao-token'),
  }) as const satisfies Record<string, string | number | boolean>;
