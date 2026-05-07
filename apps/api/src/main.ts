import { INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { buildBootstrapper, LogLevel } from '@packages/common';
import {
  buildAuthExtension,
  buildHttpServerExtension,
  KeycloakProvider,
  ZitadelProvider,
} from '@packages/http-server';
import { buildMetricExtension } from '@packages/metrics';
import { buildMikroOrmExtension } from '@packages/mikroorm';

import { AppModule } from './app.module';
import { AppContextStorage } from './auth/app-context-storage';
import mikroOrmConfig from './db/mikro-orm.config';
import { environment } from './environments';
import { RedisIoAdapter } from './v1/notification-handlers/gateways/redis-io.adapter';

if (environment.authDevMode && environment.env === 'production') {
  console.error(
    'FATAL: AUTH_DEV_MODE=true is not allowed in production. Exiting.',
  );
  process.exit(1);
}

const bootstrapper = buildBootstrapper({
  environment: environment.env,
  appName: environment.appName,
  appVersion: environment.tag,
});

bootstrapper.addExtension(
  buildHttpServerExtension(
    {
      globalPrefix: environment.globalPrefix,
      apiDefaultVersion: '1',
      port: environment.port,
      swagger: {
        path: environment.swaggerPath,
      },
      corsOrigin: environment.corsAllowedOrigins,
      helmetOptions: {
        contentSecurityPolicy: false,
        crossOriginOpenerPolicy: {
          policy: 'unsafe-none',
        },
      },
      fastifyOptions: {
        trustProxy: 'loopback',
        bodyLimit: 50 * 1024 * 1024, // 50 MB — supports up to 5 base64-encoded images at 5 MB each
      },
    },
    (app: INestApplication) => {
      const adapter = new RedisIoAdapter(app, environment.redisUrl);
      // Redis connection happens asynchronously after server start.
      // This is intentional: the appChangeCb is synchronous, and single-instance
      // mode works correctly until the adapter connects.
      void adapter.connectToRedis();
      app.useWebSocketAdapter(adapter);

      return app;
    },
  ),
);

const authProviderInstance =
  environment.authProvider === 'zitadel'
    ? new ZitadelProvider({
        url: environment.zitadelUrl,
        issuer: environment.zitadelIssuer,
      })
    : new KeycloakProvider({
        url: environment.keycloakUrl,
        realms: [environment.keycloakRealm],
      });

bootstrapper.addExtension(
  buildAuthExtension({
    devMode: environment.authDevMode,
    provider: authProviderInstance,
    storage: AppContextStorage,
  }),
);

bootstrapper.addExtension(buildMetricExtension());
bootstrapper.addExtension(buildMikroOrmExtension(mikroOrmConfig));

bootstrapper.setupLogger({
  prettyPrint: environment.prettyLog,
  level: environment.logLevel as LogLevel,
  sentryDsn: environment.sentryDsn,
});

bootstrapper.addModules([AppModule]);

// Defense-in-depth: log but do not crash on unhandled promise rejections.
// The actual fixes in SubAgent and tool error handling should prevent these,
// but this safety net prevents process death from floating promises in
// third-party libraries (e.g. @langchain/openai).
process.on('unhandledRejection', (reason: unknown) => {
  console.error('Unhandled promise rejection (non-fatal):', reason);
});

type MetadataFn = () => Promise<Record<string, unknown>>;
type MetadataModule = { default: MetadataFn | { default: MetadataFn } };

void (async () => {
  // SwaggerModule.loadPluginMetadata expects `() => Promise<MetadataObject>` —
  // the metadata generator's default export is exactly that. Passing
  // `() => import('./metadata.js')` returns the module NAMESPACE instead, and
  // metadata-loader.js silently ignores it (looks for `metadata['@nestjs/swagger']`,
  // finds undefined, returns). Dereference the function from the CJS-ESM wrapper:
  // dynamic-importing a CJS module that exports `module.exports.default = fn`
  // gives `{ default: { default: fn, __esModule: true } }` under NodeNext.
  const metadataMod = (await import('./metadata.js')) as MetadataModule;
  const metadataFn: MetadataFn =
    typeof metadataMod.default === 'function'
      ? metadataMod.default
      : typeof metadataMod.default?.default === 'function'
        ? metadataMod.default.default
        : (() => {
            throw new Error(
              'Failed to resolve Swagger metadata default export — neither metadata.default nor metadata.default.default is a function.',
            );
          })();
  await SwaggerModule.loadPluginMetadata(metadataFn);
  await bootstrapper.init();
})().catch((err) => {
  console.error('Failed to bootstrap application', err);
  process.exit(1);
});
