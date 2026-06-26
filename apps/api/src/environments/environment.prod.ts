import { getEnv } from '@packages/common';

export const environment = () =>
  ({
    env: getEnv('NODE_ENV', 'production'),
    tag: getEnv('TF_IMAGE_TAG', 'none'),
    appName: getEnv('TF_APP_NAME', 'geniro-api'),
    logLevel: getEnv('LOG_LEVEL', 'error'),
    lodDbQueries: getEnv('LOG_DB_QUERIES', false),
    prettyLog: getEnv('PRETTY_LOGS', false),
    sentryDsn: getEnv('SENTRY_DSN'),

    // server
    corsAllowedOrigins: getEnv('CORS_ALLOWED_ORIGINS'),
    globalPrefix: getEnv('GLOBAL_PATH_PREFIX', 'api'),
    swaggerPath: getEnv('SWAGGER_PATH'),
    port: +getEnv('HTTP_PORT', '5000'),

    // auth
    authProvider: getEnv('AUTH_PROVIDER', 'keycloak'),
    authDevMode: getEnv('AUTH_DEV_MODE', false),
    keycloakUrl: getEnv('KEYCLOAK_URL'),
    keycloakRealm: getEnv('KEYCLOAK_REALM', 'geniro'),
    zitadelUrl: getEnv('ZITADEL_URL'),
    zitadelIssuer: getEnv('ZITADEL_ISSUER'),
    keycloakClientId: getEnv('KEYCLOAK_CLIENT_ID', 'geniro'),
    zitadelClientId: getEnv('ZITADEL_CLIENT_ID', 'geniro'),
    adminRole: getEnv('USER_ADMIN_ROLE', 'admin'),

    // connections
    postgresUrl: getEnv('POSTGRES_URL'),
    postgresHost: getEnv('POSTGRES_HOST'),
    postgresPort: getEnv('POSTGRES_PORT'),
    postgresUsername: getEnv('POSTGRES_USERNAME'),
    postgresPassword: getEnv('POSTGRES_PASSWORD'),
    postgresDatabase: getEnv('POSTGRES_DATABASE'),
    postgresSchema: getEnv('POSTGRES_SCHEMA'),
    postgresSsl: getEnv('POSTGRES_SSL', false),
    llmBaseUrl: getEnv('LLM_BASE_URL'),
    // LiteLLM URL reachable from INSIDE sandbox runtimes (Claude Agent bridge).
    // Unset = Claude Agent sessions fail with a clear error until configured.
    litellmSandboxUrl: getEnv('LITELLM_SANDBOX_URL'),
    // LiteLLM URL reachable from a REMOTE (Daytona) sandbox host. Unset =
    // Claude Agent sessions on a Daytona runtime fail with a clear error.
    litellmPublicUrl: getEnv('LITELLM_PUBLIC_URL'),
    redisUrl: getEnv('REDIS_URL'),
    qdrantUrl: getEnv('QDRANT_URL'),
    qdrantApiKey: getEnv('QDRANT_API_KEY'),

    // misc
    litellmMasterKey: getEnv('LITELLM_MASTER_KEY'),
    llmRequestTimeoutMs: +getEnv('LLM_REQUEST_TIMEOUT_MS', '600000'),
    llmLargeModel: getEnv('LLM_LARGE_MODEL', 'gpt-5.4'),
    llmLargeCodeModel: getEnv('LLM_LARGE_CODE_MODEL', 'gpt-5.2-codex'),
    llmMiniCodeModel: getEnv('LLM_MINI_CODE_MODEL', 'openrouter/minimax-m2.5'),
    llmCodeExplorerSubagentModel: getEnv('LLM_CODE_EXPLORER_SUBAGENT_MODEL'),
    llmMiniModel: getEnv('LLM_MINI_MODEL', 'gpt-5-mini'),
    llmEmbeddingModel: getEnv('LLM_EMBEDDING_MODEL', 'text-embedding-3-small'),
    // Fixed embedding vector size — passed to the OpenAI `dimensions` parameter
    // and used directly to build Qdrant collection names. Replaces the previous
    // runtime-probe logic. Must match a size the configured embedding model
    // supports: 1536 (default, full) or 512/768/1024 (smaller/faster) for
    // text-embedding-3-small, 3072 for text-embedding-3-large.
    llmEmbeddingDimensions: +getEnv('LLM_EMBEDDING_DIMENSIONS', '1536'),
    knowledgeChunkMaxTokens: +getEnv('KNOWLEDGE_CHUNK_MAX_TOKENS', '500'),
    knowledgeChunkMaxCount: +getEnv('KNOWLEDGE_CHUNK_MAX_COUNT', '100'),
    // Token overlap between adjacent knowledge-doc chunks. Overlap preserves
    // context across chunk boundaries — relevant sentences that span two
    // chunks would otherwise be split in half between both. Default 50 tokens
    // (≈ 10% of a 500-token chunk).
    knowledgeChunkOverlapTokens: +getEnv(
      'KNOWLEDGE_CHUNK_OVERLAP_TOKENS',
      '50',
    ),
    // Multiplier applied to topK when searching Qdrant for knowledge chunks.
    // A higher factor improves recall (more candidates considered) at the cost
    // of slightly more payload shipped back from Qdrant.
    knowledgeSearchOverfetchFactor: +getEnv(
      'KNOWLEDGE_SEARCH_OVERFETCH_FACTOR',
      '3',
    ),
    knowledgeChunksCollection: getEnv(
      'KNOWLEDGE_CHUNKS_COLLECTION',
      'knowledge_chunks',
    ),
    // --- Codebase indexing ---
    codebaseIndexTokenThreshold: +getEnv(
      'CODEBASE_INDEX_TOKEN_THRESHOLD',
      '50000',
    ),
    codebaseUuidNamespace: getEnv(
      'CODEBASE_UUID_NAMESPACE',
      '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
    ),
    codebaseEmbeddingMaxTokens: +getEnv(
      'CODEBASE_EMBEDDING_MAX_TOKENS',
      '30000',
    ),
    codebaseEmbeddingConcurrency: +getEnv(
      'CODEBASE_EMBEDDING_CONCURRENCY',
      '3',
    ),
    codebaseChunkTargetTokens: +getEnv('CODEBASE_CHUNK_TARGET_TOKENS', '200'),
    codebaseChunkOverlapTokens: +getEnv('CODEBASE_CHUNK_OVERLAP_TOKENS', '30'),
    codebaseMaxFileBytes: +getEnv('CODEBASE_MAX_FILE_BYTES', '1048576'),
    codebaseGitExecTimeoutMs: +getEnv('CODEBASE_GIT_EXEC_TIMEOUT_MS', '60000'),
    codebaseIndexMaxAgeDays: +getEnv('CODEBASE_INDEX_MAX_AGE_DAYS', '30'),
    // Staleness window for the in-path repair of Pending/InProgress
    // repo_indexes rows. When a row older than this is observed during a
    // getOrInitIndexForRepo call, the repair path consults BullMQ to confirm
    // the job is not actively being processed before force-failing and
    // re-enqueueing — guards against BullMQ jobs lost to Redis flushes or
    // worker evictions since recoverStuckJobs only runs on module init.
    // Default 2 minutes (in ms); the BullMQ active-state check is the
    // second-layer defense for slow embedding batches that can leave updatedAt
    // stagnant for >2 min while the worker is still alive.
    codebaseIndexStaleMs: +getEnv('CODEBASE_INDEX_STALE_MS', '120000'),
    // Multiplier applied to topK in codebase search to overfetch candidates
    // before filtering and slicing. Separate env vars cover the single-vector
    // path and the query-expansion path (where each variant already broadens
    // coverage, so a smaller per-variant factor stays reasonable).
    codebaseSearchOverfetchFactor: +getEnv(
      'CODEBASE_SEARCH_OVERFETCH_FACTOR',
      '6',
    ),
    codebaseSearchOverfetchFactorWithVariants: +getEnv(
      'CODEBASE_SEARCH_OVERFETCH_FACTOR_WITH_VARIANTS',
      '3',
    ),

    // LLM model defaults for tools (do not override per-call)
    // Explicit socket-path override only. Left unset, the runtime defers to
    // dockerode's standard env resolution (DOCKER_HOST, TLS, then the default
    // socket) via resolveDockerOptions — so Colima/Podman/Docker-Desktop work
    // with no app-specific config. A hardcoded default here would suppress it.
    dockerSocket: getEnv('DOCKER_SOCKET'),
    dockerRuntimeImage: getEnv(
      'DOCKER_RUNTIME_IMAGE',
      'razumru/geniro-runtime:latest',
    ),
    dockerRegistryMirror: getEnv('DOCKER_REGISTRY_MIRROR'),
    dockerInsecureRegistry: getEnv('DOCKER_INSECURE_REGISTRY'),

    // --- Runtime provider ---
    defaultRuntimeType: getEnv('DEFAULT_RUNTIME_TYPE', 'Docker'),

    // --- Daytona runtime ---
    daytonaApiKey: getEnv('DAYTONA_API_KEY'),
    daytonaApiUrl: getEnv('DAYTONA_API_URL'),
    daytonaTarget: getEnv('DAYTONA_TARGET'),

    // --- K8s runtime ---
    k8sRuntimeNamespace: getEnv('K8S_RUNTIME_NAMESPACE', 'geniro-runtimes'),
    k8sRuntimeClass: getEnv('K8S_RUNTIME_CLASS', 'gvisor'),
    k8sRuntimeServiceAccount: getEnv(
      'K8S_RUNTIME_SERVICE_ACCOUNT',
      'geniro-runtime',
    ),
    k8sRuntimeCpuRequest: getEnv('K8S_RUNTIME_CPU_REQUEST', '100m'),
    k8sRuntimeCpuLimit: getEnv('K8S_RUNTIME_CPU_LIMIT', '1000m'),
    k8sRuntimeMemoryRequest: getEnv('K8S_RUNTIME_MEMORY_REQUEST', '256Mi'),
    k8sRuntimeMemoryLimit: getEnv('K8S_RUNTIME_MEMORY_LIMIT', '2Gi'),
    k8sRuntimeReadyTimeoutMs: +getEnv('K8S_RUNTIME_READY_TIMEOUT_MS', '180000'),
    k8sWarmPoolSize: +getEnv('K8S_WARM_POOL_SIZE', '0'),
    k8sWarmPoolTtlMs: +getEnv('K8S_WARM_POOL_TTL_MS', '1800000'),
    k8sInCluster: getEnv('K8S_IN_CLUSTER', true),

    runtimeCleanupIntervalMs: +getEnv('RUNTIME_CLEANUP_INTERVAL_MS', '300000'),
    runtimeIdleThresholdMs: +getEnv('RUNTIME_IDLE_THRESHOLD_MS', '1800000'),

    // OAuth token-refresh watchdog: every interval, proactively refresh
    // credentials expiring within the threshold so a short-lived token never
    // goes stale overnight (lazy run-gate refresh only fires when a run starts).
    // Threshold > the 60s run-gate skew so the watchdog wins the race.
    oauthTokenRefreshIntervalMs: +getEnv(
      'OAUTH_TOKEN_REFRESH_INTERVAL_MS',
      '600000',
    ),
    oauthTokenRefreshThresholdMs: +getEnv(
      'OAUTH_TOKEN_REFRESH_THRESHOLD_MS',
      '1800000',
    ),

    // tool output limits
    toolMaxOutputTokens: +getEnv('TOOL_MAX_OUTPUT_TOKENS', '5000'),
    filesReadMaxLines: +getEnv('FILES_READ_MAX_LINES', '2000'),

    // agents
    agentsInstructionsFile: getEnv('AGENTS_INSTRUCTIONS_FILE', 'AGENTS.md'),

    // --- Agent memory (durable project-scoped store) ---
    // Per-entry value-size cap and the namespace/project entry quotas that drive
    // prune-oldest, plus the namespace/key/title length bounds the DTO enforces.
    agentMemoryMaxValueBytes: +getEnv('AGENT_MEMORY_MAX_VALUE_BYTES', '32768'),
    agentMemoryMaxEntriesPerNamespace: +getEnv(
      'AGENT_MEMORY_MAX_ENTRIES_PER_NAMESPACE',
      '500',
    ),
    agentMemoryMaxEntriesPerProject: +getEnv(
      'AGENT_MEMORY_MAX_ENTRIES_PER_PROJECT',
      '2000',
    ),
    agentMemoryMaxNamespaceLength: +getEnv(
      'AGENT_MEMORY_MAX_NAMESPACE_LENGTH',
      '128',
    ),
    agentMemoryMaxKeyLength: +getEnv('AGENT_MEMORY_MAX_KEY_LENGTH', '256'),
    agentMemoryMaxTitleLength: +getEnv('AGENT_MEMORY_MAX_TITLE_LENGTH', '256'),

    // --- Versions ---
    apiVersion: getEnv('API_VERSION', 'dev'),
    webVersion: getEnv('WEB_VERSION', 'dev'),

    // --- Feature flags ---
    litellmManagementEnabled: getEnv('LITELLM_MANAGEMENT_ENABLED', false),
    restoreGraphs: getEnv('RESTORE_GRAPHS', true),
    knowledgeReindexOnStartup: getEnv('KNOWLEDGE_REINDEX_ON_STARTUP', true),

    // --- GitHub App (optional — feature available when all are set) ---
    githubAppId: getEnv('GITHUB_APP_ID'),
    githubAppPrivateKey: getEnv('GITHUB_APP_PRIVATE_KEY'),
    githubAppClientId: getEnv('GITHUB_APP_CLIENT_ID'),
    githubAppClientSecret: getEnv('GITHUB_APP_CLIENT_SECRET'),

    // --- GitHub Webhook ---
    githubWebhookSecret: getEnv('GITHUB_WEBHOOK_SECRET'),
    webhookPollIntervalMs: +getEnv('WEBHOOK_POLL_INTERVAL_MS', '60000'),

    // --- Secrets store (OpenBao) ---
    openbaoAddr: getEnv('OPENBAO_ADDR'),
    openbaoToken: getEnv('OPENBAO_TOKEN'),

    // --- OAuth credentials (per-project; e.g. Linear) ---
    // Web base URL used to build the OAuth redirect_uri (the callback page).
    // No provider client id/secret: each MCP provider's OAuth client is
    // registered per flow via Dynamic Client Registration against the
    // provider's own authorization server, so the feature needs zero
    // deployment config.
    websiteUrl: getEnv('WEBSITE_URL'),
  }) as const satisfies Record<string, string | number | boolean>;
