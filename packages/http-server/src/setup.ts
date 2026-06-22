import compress, { type FastifyCompressOptions } from '@fastify/compress';
import multipart from '@fastify/multipart';
import {
  ClassSerializerInterceptor,
  type DynamicModule,
  type INestApplication,
  RequestMethod,
  VersioningType,
} from '@nestjs/common';
import { ContextIdFactory, NestFactory, Reflector } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  DocumentBuilder,
  type OpenAPIObject,
  type SwaggerCustomOptions,
  SwaggerModule,
} from '@nestjs/swagger';
import {
  AppBootstrapperConfigService,
  BaseLogger,
  DefaultLogger,
  type IAppBootstrapperExtension,
  Logger,
} from '@packages/common';
import { apiReference } from '@scalar/nestjs-api-reference';
import rTracer from 'cls-rtracer';
import type { FastifyInstance } from 'fastify';
import qs from 'fastify-qs';
import helmet from 'helmet';
import { cleanupOpenApiDoc } from 'nestjs-zod';

import { RequestContextLogger } from './context';
import { ExceptionsFilter } from './exceptions.filter';
import { HttpServerModule } from './http-server.module';
import type { IHttpServerParams } from './http-server.types';
import { ZodResponseInterceptor } from './interceptors/zod-response.interceptor';

const HTTP_VERBS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
] as const;

/**
 * Throws at swagger-setup time if any two operations share the same operationId.
 * The default operationIdFactory uses only the method name, so two controllers
 * with e.g. `getAll()` produce identical IDs. openapi-generator-cli (used by
 * `pnpm generate:api` in apps/web) requires globally unique operationIds.
 *
 * This guard runs only during setupSwagger (dev/test). Production skips swagger
 * entirely, so this has zero runtime cost in prod.
 */
export const validateOperationIdUniqueness = (
  doc: Pick<OpenAPIObject, 'paths'>,
): void => {
  const seen = new Map<string, string[]>();

  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    if (!methods || typeof methods !== 'object') {
      continue;
    }
    for (const verb of HTTP_VERBS) {
      const op = (
        methods as Record<string, { operationId?: string } | undefined>
      )[verb];
      if (!op || typeof op !== 'object' || typeof op.operationId !== 'string') {
        continue;
      }
      const id = op.operationId;
      const ref = `${verb.toUpperCase()} ${path}`;
      const list = seen.get(id);
      if (list) {
        list.push(ref);
      } else {
        seen.set(id, [ref]);
      }
    }
  }

  const duplicates = [...seen.entries()].filter(([, refs]) => refs.length > 1);
  if (duplicates.length === 0) {
    return;
  }

  const summary = duplicates
    .map(([id, refs]) => `  "${id}" used by: ${refs.join(', ')}`)
    .join('\n');

  throw new Error(
    `Duplicate operationIds detected in OpenAPI spec:\n${summary}\n\n` +
      `openapi-generator-cli (used by 'pnpm generate:api' in apps/web) ` +
      `requires every operationId to be globally unique. The default ` +
      `operationIdFactory in setup.ts uses only the method name, so two ` +
      `controllers with the same method name (e.g. getAll, getById) collide.\n\n` +
      `Fix: add @ApiOperation({ operationId: 'unique-name' }) to one of the ` +
      `conflicting methods. Use a descriptive verb+resource form (e.g. ` +
      `'listInstructionBlocks', 'getInstructionBlockById').`,
  );
};

export const getVersion = (v?: string) =>
  `${v ? `v${v}` : ``}`
    .replace(/\/$/, '')
    .replace(/^\//, '')
    .replace(/\/{1,}/g, '/');

export const setupSwagger = (
  app: INestApplication,
  {
    path = '/swagger-api',
    appName,
    version,
    description,
    securitySchemas,
    options,
  }: {
    path?: string;
    appName: string;
    version: string;
    description?: string;
    securitySchemas?: Record<string, unknown>;
    options?: SwaggerCustomOptions;
  },
) => {
  const builder = new DocumentBuilder().setTitle(appName).setVersion(version);

  if (!securitySchemas) {
    builder.addBearerAuth();
  } else {
    Object.entries(securitySchemas).forEach(([name, schema]) => {
      builder.addSecurity(
        name,
        schema as Parameters<typeof builder.addSecurity>[1],
      );
    });
  }

  if (description) {
    builder.setDescription(description);
  }

  const openapiDocumentBase = builder.build();

  const openapiDocument = SwaggerModule.createDocument(
    app,
    openapiDocumentBase,
    {
      operationIdFactory: (controllerKey: string, methodKey: string) =>
        methodKey,
    },
  );
  validateOperationIdUniqueness(openapiDocument);
  openapiDocument.openapi = '3.1.0';

  const swp = [path].join('/').replace(/\/{1,}/g, '/');

  SwaggerModule.setup(swp, app, cleanupOpenApiDoc(openapiDocument), options);

  app.use(
    `${swp}/reference`,
    apiReference({
      content: openapiDocument,
      layout: 'modern',
      withFastify: true,
      showSidebar: true,
      darkMode: true,
    }),
  );
};

/**
 * Parse a comma-separated CORS origin string into the value accepted by enableCors().
 * '*' → '*' (allow all), empty/undefined → false (disabled), otherwise → string[].
 */
const parseCorsOrigin = (raw?: string): boolean | string | string[] => {
  if (!raw || raw.trim() === '') {
    return false;
  }
  if (raw.trim() === '*') {
    return '*';
  }
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
};

export const setupMiddlewares = (
  app: INestApplication,
  {
    helmetOptions,
    compression,
    stripResponse = true,
    corsOrigin,
  }: {
    helmetOptions?: Parameters<typeof helmet>[0];
    compression?: FastifyCompressOptions;
    stripResponse?: boolean;
    corsOrigin?: string;
  },
) => {
  const serverApp = app as NestFastifyApplication;
  const fastifyInstance: FastifyInstance = serverApp
    .getHttpAdapter()
    .getInstance() as unknown as FastifyInstance;

  // if (sentryService.isSentryInit && param.logger?.sentry?.enabledHttpTracing) {
  //   app.use(Sentry.Handlers.requestHandler());
  // }

  fastifyInstance.register(
    qs as unknown as (
      instance: FastifyInstance,
      opts: { comma: boolean },
      done: (err?: Error) => void,
    ) => void,
    { comma: true },
  );

  serverApp.useGlobalFilters(new ExceptionsFilter(serverApp));

  //serverApp.useGlobalPipes(new ValidationPipe());
  serverApp.useGlobalInterceptors(
    new ClassSerializerInterceptor(app.get(Reflector)),
  );

  if (stripResponse) {
    serverApp.useGlobalInterceptors(
      new ZodResponseInterceptor(app.get(Reflector)),
    );
  }

  const resolvedOrigin = parseCorsOrigin(corsOrigin ?? '*');
  serverApp.enableCors({
    methods: '*',
    origin: resolvedOrigin,
  });
  serverApp.use(helmet(helmetOptions || { contentSecurityPolicy: false }));

  if (compression) {
    fastifyInstance.register(compress, compression);
  }

  fastifyInstance.register(multipart);
  app.use(
    rTracer.fastifyMiddleware({
      useHeader: true,
      echoHeader: true,
      headerName: 'X-Request-Id',
    }),
  );

  fastifyInstance.addHook('preHandler', async (req) => {
    const contextId = ContextIdFactory.create();
    app.registerRequestByContextId(req, contextId);
    const logger = await app.resolve<BaseLogger>(Logger, contextId);
    const { method, originalUrl } = req as {
      method: string;
      originalUrl: string;
    };

    // Redact credential-bearing query params before logging the URL. OAuth
    // flows carry single-use secrets on the query string (`?cap=`, `?code=`,
    // `?state=`, `?token=`); logging them verbatim would leak a live, redeemable
    // credential into Pino/Sentry and browser history. Only the VALUE is masked.
    const safeUrl = originalUrl.replace(
      /([?&](?:cap|code|state|token|access_token|refresh_token)=)[^&]*/gi,
      '$1[REDACTED]',
    );

    logger.log(`Request ${method}: ${safeUrl}`);
  });
};

export const setupPrefix = (
  app: INestApplication,
  {
    apiDefaultVersion,
    globalPrefix,
    globalPrefixIgnore,
  }: Pick<
    IHttpServerParams,
    'apiDefaultVersion' | 'globalPrefix' | 'globalPrefixIgnore'
  >,
) => {
  const resultVersion = getVersion(apiDefaultVersion);

  if (resultVersion) {
    app.enableVersioning({
      defaultVersion: resultVersion,
      prefix: false,
      type: VersioningType.URI,
    });
  }

  if (globalPrefix) {
    app.setGlobalPrefix(globalPrefix, {
      exclude: [
        {
          path: '/health/check',
          method: RequestMethod.ALL,
        },
        {
          path: '/metrics/',
          method: RequestMethod.ALL,
        },
        ...(globalPrefixIgnore || []).map((c) => ({
          path: c,
          method: RequestMethod.ALL,
        })),
      ],
    });
  }
};

export const buildHttpNestApp = async (
  appBootstrapperModule: DynamicModule,
  params: IHttpServerParams,
) => {
  const adapter = new FastifyAdapter(params.fastifyOptions);
  const app = await NestFactory.create(
    appBootstrapperModule,
    adapter as unknown as FastifyAdapter,
    {
      rawBody: true,
    },
  );

  app.enableShutdownHooks();

  const cfg = app.get(AppBootstrapperConfigService);

  setupMiddlewares(app, {
    helmetOptions: params.helmetOptions,
    compression: params.compression,
    stripResponse: params.stripResponse,
    corsOrigin: params.corsOrigin,
  });

  setupPrefix(app, {
    apiDefaultVersion: params.apiDefaultVersion,
    globalPrefix: params.globalPrefix,
    globalPrefixIgnore: params.globalPrefixIgnore,
  });

  if (params.swagger) {
    setupSwagger(app, {
      ...params.swagger,
      appName: cfg.appName,
      version: cfg.appVersion,
    });
  }

  return app;
};

export const runHttpApp = async (
  app: INestApplication,
  params: IHttpServerParams,
) => {
  const port = params.port || 3000;
  await (<INestApplication>app).listen(port, '0.0.0.0');

  const logger = app.get(DefaultLogger);

  logger.log(`HTTP server init with port ${params.port}`);
};

export const buildHttpServerExtension = (
  params: IHttpServerParams,
  appChangeCb?: (app: INestApplication) => INestApplication,
): IAppBootstrapperExtension => {
  return {
    modules: [HttpServerModule.forRoot(params)],
    defaultLogger: RequestContextLogger,
    customBootstrapper: async (module) => {
      let app = await buildHttpNestApp(module, params);

      if (appChangeCb) {
        app = appChangeCb(app);
      }

      await runHttpApp(app, params);
    },
  };
};
