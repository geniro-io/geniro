// Side-effect import: must run before any module that reads POSTGRES_URL
// (notably `environments/index.ts` reached via `../../db/mikro-orm.config`).
import './worker-env';

import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test, TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { buildBootstrapper, DefaultLogger, LogLevel } from '@packages/common';
import {
  AuthContextService,
  buildAuthExtension,
  buildHttpServerExtension,
  KeycloakProvider,
} from '@packages/http-server';
import { buildMetricExtension } from '@packages/metrics';
import { buildMikroOrmExtension } from '@packages/mikroorm';

import { AppModule } from '../../app.module';
import mikroOrmConfig from '../../db/mikro-orm.config';
import { environment, setInstanceFingerprint } from '../../environments';
import { GraphRestorationService } from '../../v1/graphs/services/graph-restoration.service';
import { LiteLlmClient } from '../../v1/litellm/services/litellm.client';
import { LitellmService } from '../../v1/litellm/services/litellm.service';
import { NotificationsService } from '../../v1/notifications/services/notifications.service';
import { OpenaiService } from '../../v1/openai/openai.service';
import { RuntimeInstanceDao } from '../../v1/runtime/dao/runtime-instance.dao';
import { RuntimeProvider } from '../../v1/runtime/services/runtime-provider';
import { mockLiteLlmClient } from './helpers/test-stubs';
import {
  installMockGithubPatch,
  MockGithubModule,
  MockGithubService,
  setMockGithubService,
} from './mocks/mock-github';
import {
  installBaseAgentPatch,
  MockLlmModule,
} from './mocks/mock-llm/mock-llm.module';
import { MockLlmService } from './mocks/mock-llm/mock-llm.service';
import { applyDefaults } from './mocks/mock-llm/mock-llm-defaults.utils';
import {
  getMockLlmService,
  setMockLlmService,
} from './mocks/mock-llm/mock-llm-singleton.utils';
import { MockOpenaiAdapter } from './mocks/mock-llm/mock-openai.adapter';
import { MockMcpModule } from './mocks/mock-mcp/mock-mcp.module';
import { MockMcpService } from './mocks/mock-mcp/mock-mcp.service';
import { applyDefaults as applyMockMcpDefaults } from './mocks/mock-mcp/mock-mcp-defaults.utils';
import { installMockMcpPatch } from './mocks/mock-mcp/mock-mcp-patch.utils';
import { setMockMcpService } from './mocks/mock-mcp/mock-mcp-singleton.utils';
import { MockRuntimeModule } from './mocks/mock-runtime/mock-runtime.module';
import { MockRuntimeService } from './mocks/mock-runtime/mock-runtime.service';
import { MockRuntimeProvider } from './mocks/mock-runtime/mock-runtime-provider';

/**
 * Returns a `MockLlmService`-shaped proxy that resolves method calls to the
 * singleton set by `setMockLlmService`. Using a proxy lets the factory create
 * `MockOpenaiAdapter` at compile time without needing `MockLlmService` to be
 * injected from a different DI scope — the real instance is accessed lazily.
 */
function getMockLlmServiceLazy(): MockLlmService {
  return new Proxy({} as MockLlmService, {
    get(_target, prop) {
      const svc = getMockLlmService();
      const value = (svc as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(svc);
      }
      return value;
    },
  });
}

export const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
export const TEST_ORG_ID = '00000000-0000-0000-0000-000000000001';

// Upper bound for app.close() in tests. See the teardown wrapper in
// createTestModule for the full rationale (knex/tarn pool-teardown deadlock).
const TEARDOWN_DEADLINE_MS = 15_000;

export interface CreateTestModuleOptions {
  /**
   * When `true` (default), `RuntimeProvider` is replaced with
   * `MockRuntimeProvider`, so requests for any runtime type (`Docker`,
   * `Daytona`, `K8s`) yield an in-process `MockRuntime` instead of a real
   * container. Set to `false` for the small number of tests that need a real
   * container (e.g. genuine shell-tool execution).
   */
  mockRuntime?: boolean;
  /**
   * When `true` (default), `BaseMcp.prototype.initialize` and `callTool` are
   * patched to route through `MockMcpService`, skipping the `npx` MCP
   * subprocess entirely. Set to `false` to use the real MCP plumbing.
   */
  mockMcp?: boolean;
  /**
   * When `true` (default), `globalThis.fetch` is patched so GitHub HTTP calls
   * (Octokit + the raw `fetch` in `GitHubAppService`) are served by
   * `MockGithubService` instead of hitting the network. Default per-request
   * reply is `404` (deterministic not-found); register fixtures via
   * `getMockGithub(app).onRequest(...)` for success paths. Set to `false` for
   * the rare test that needs real GitHub.
   */
  mockGithub?: boolean;
}

export const createTestModule = async (
  cb?: (testingModule: TestingModuleBuilder) => Promise<TestingModule>,
  options: CreateTestModuleOptions = {},
) => {
  const mockRuntimeEnabled = options.mockRuntime ?? true;
  const mockMcpEnabled = options.mockMcp ?? true;
  const mockGithubEnabled = options.mockGithub ?? true;

  // Assign a unique instance fingerprint per app so File A's queued jobs
  // don't get picked up by File B's worker via the shared Redis namespace.
  // randomUUID() guarantees global uniqueness across files, processes, and
  // re-runs. Read at queue-service construction time, so this must be set
  // BEFORE the testing module compiles.
  setInstanceFingerprint(`test-${process.pid}-${randomUUID().slice(0, 8)}`);

  // Patch BaseAgent.prototype.buildLLM to return MockChatOpenAI (idempotent).
  installBaseAgentPatch();
  if (mockMcpEnabled) {
    installMockMcpPatch();
  }
  if (mockGithubEnabled) {
    installMockGithubPatch();
  }

  const testBootstrapper = buildBootstrapper({
    environment: environment.env,
    appName: environment.appName,
    appVersion: environment.tag,
  });

  testBootstrapper.addExtension(
    buildHttpServerExtension({
      globalPrefix: environment.globalPrefix,
      apiDefaultVersion: '1',
      port: environment.port,
      swagger: {
        path: environment.swaggerPath,
      },
      helmetOptions: {
        contentSecurityPolicy: false,
        crossOriginOpenerPolicy: {
          policy: 'unsafe-none',
        },
      },
      fastifyOptions: {
        trustProxy: 'loopback',
      },
    }),
  );

  testBootstrapper.addExtension(
    buildAuthExtension({
      devMode: environment.authDevMode,
      provider: new KeycloakProvider({
        url: environment.keycloakUrl,
        realms: [environment.keycloakRealm],
      }),
    }),
  );

  testBootstrapper.addExtension(buildMetricExtension());

  testBootstrapper.addExtension(buildMikroOrmExtension(mikroOrmConfig));

  testBootstrapper.setupLogger({
    prettyPrint: environment.prettyLog,
    level: environment.logLevel as LogLevel,
    sentryDsn: environment.sentryDsn,
  });

  const moduleBuilder = Test.createTestingModule({
    imports: [
      testBootstrapper.buildModule([AppModule]),
      MockLlmModule,
      MockMcpModule,
      MockGithubModule,
      MockRuntimeModule,
    ],
  })
    .overrideProvider(AuthContextService)
    .useValue({
      checkSub: () => TEST_USER_ID,
      getSub: () => TEST_USER_ID,
      getOrganizationId: () => TEST_ORG_ID,
    })
    // Intercept all LLM calls via MockOpenaiAdapter — mock overrides run before
    // any user-supplied `cb` overrides so tests can still chain further overrides.
    // MockLlmService is injected from the global DI context (strict: false) after
    // compile, but the factory receives it via the LitellmService-only inject to
    // avoid cross-module scope resolution at compile time.
    .overrideProvider(OpenaiService)
    .useFactory({
      inject: [LitellmService],
      factory: (litellm: LitellmService) =>
        new MockOpenaiAdapter(getMockLlmServiceLazy(), litellm),
    })
    // GraphsModule.onModuleInit fires `void restoreRunningGraphs()` as a
    // fire-and-forget task. In tests this races with `app.close()` and, when
    // close wins, the still-pending DB query throws "driver has already been
    // destroyed". Replace the service with a no-op for every integration test.
    .overrideProvider(GraphRestorationService)
    .useValue({ restoreRunningGraphs: async () => {} })
    // LiteLlmClient hits the LiteLLM proxy (localhost:4000) for model-info
    // lookups (capability checks, cost rates, model listing). The proxy is not
    // booted by the integration setup, so leave the default in place would
    // surface as ECONNREFUSED noise in every test that touches an agent. The
    // mock returns no model info — production paths fall back to safe defaults.
    .overrideProvider(LiteLlmClient)
    .useValue(mockLiteLlmClient);

  const m = mockRuntimeEnabled
    ? moduleBuilder.overrideProvider(RuntimeProvider).useFactory({
        inject: [
          RuntimeInstanceDao,
          DefaultLogger,
          NotificationsService,
          MockRuntimeService,
        ],
        factory: (
          dao: RuntimeInstanceDao,
          logger: DefaultLogger,
          ns: NotificationsService,
          mockRuntimeSvc: MockRuntimeService,
        ) => new MockRuntimeProvider(dao, logger, ns, mockRuntimeSvc),
      })
    : moduleBuilder;

  const moduleRef = cb ? await cb(m) : await m.compile();

  // Bridge the DI instance to the prototype patch singleton and reset per-test state.
  const mockLlm = moduleRef.get(MockLlmService, { strict: false });
  mockLlm.reset();
  // Pre-register catch-all chat/finish/embeddings stubs so test files that
  // pre-date the per-test fixture-registration migration don't throw on every
  // LLM call. Migrated tests typically call `mockLlm.reset()` in a beforeEach
  // before registering specific fixtures, which clears these defaults.
  applyDefaults(mockLlm);
  setMockLlmService(mockLlm);

  if (mockMcpEnabled) {
    const mockMcp = moduleRef.get(MockMcpService, { strict: false });
    mockMcp.reset();
    applyMockMcpDefaults(mockMcp);
    setMockMcpService(mockMcp);
  }

  if (mockGithubEnabled) {
    // Bridge the DI instance to the global fetch patch. No defaults applied —
    // the hermetic baseline is "no fixture → 404"; tests register success
    // fixtures via getMockGithub(app).onRequest(...) as needed.
    const mockGithub = moduleRef.get(MockGithubService, { strict: false });
    mockGithub.reset();
    setMockGithubService(mockGithub);
  }

  if (mockRuntimeEnabled) {
    moduleRef.get(MockRuntimeService, { strict: false }).reset();
  }

  const adapter = new FastifyAdapter();

  const app = moduleRef.createNestApplication(adapter);
  await app.init();

  // Bound app.close() against a teardown deadlock that intermittently surfaces
  // when several integration workers tear down their NestJS app against the
  // SHARED Postgres testcontainer at once. Root-caused empirically: app.close()
  // stalls inside MikroORM's onApplicationShutdown (orm.close() -> knex/tarn
  // connection-pool teardown) — reproduced down to a single idle pg socket with
  // every other resource (BullMQ, Socket.IO, Redis cache) already closed. It is
  // a library-level pool-teardown deadlock: force orm.close(true), bounded
  // acquire/destroy pool timeouts, socket.destroy(), and lowering maxWorkers all
  // fail to unblock it. It is test-only (production runs one app per pool with no
  // cross-worker Postgres contention) and correctness-irrelevant (every assertion
  // has already passed; only resource teardown stalls). Time-box the close so the
  // deadlock cannot fail an otherwise-green run; the per-worker vitest process
  // exits after its files and reclaims the orphaned connection. The 15s deadline
  // clears the slowest legitimate teardown (real-runtime tests stop a Docker
  // container, ~5-10s) while staying under the 30s integration hookTimeout.
  const gracefulClose = app.close.bind(app);
  (app as unknown as { close: () => Promise<void> }).close = async () => {
    const closePromise = gracefulClose();
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      deadlineTimer = setTimeout(
        () => resolve('timeout'),
        TEARDOWN_DEADLINE_MS,
      );
    });
    let outcome: 'closed' | 'timeout';
    try {
      // A genuine teardown error still rejects here (preserved behaviour); only
      // an unbounded stall is converted into a bounded, logged abandon.
      outcome = await Promise.race([
        closePromise.then(() => 'closed' as const),
        deadline,
      ]);
    } finally {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
      }
    }
    if (outcome === 'timeout') {
      // Suppress the orphaned graceful-close promise so a late rejection from the
      // abandoned pool teardown does not surface as an unhandledRejection.
      void closePromise.catch(() => undefined);

      console.warn(
        '[integration] app.close() exceeded the 15s teardown deadline — known knex/tarn Postgres pool-teardown deadlock under shared-Postgres contention; abandoning the graceful close (test-only, all assertions already passed).',
      );
    }
  };

  return app;
};

export const getMockLlm = (app: INestApplication): MockLlmService =>
  app.get(MockLlmService);
