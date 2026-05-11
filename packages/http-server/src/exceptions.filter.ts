import {
  type ArgumentsHost,
  Catch,
  type HttpServer,
  type INestApplication,
} from '@nestjs/common';
import {
  BaseExceptionFilter,
  ContextIdFactory,
  HttpAdapterHost,
} from '@nestjs/core';
import { BaseLogger, Logger, SentryService } from '@packages/common';
import type { FastifyRequest } from 'fastify';

import { RequestContextService } from './context';
import { ExceptionHandler } from './exception-handler';

@Catch()
export class ExceptionsFilter extends BaseExceptionFilter {
  constructor(private readonly moduleRef: INestApplication) {
    const applicationRef = moduleRef.get(HttpAdapterHost) as HttpServer;

    super(applicationRef);
  }

  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const contextId = ContextIdFactory.create();
    const response = ctx.getResponse() as {
      status: (code: number) => { send: (data: unknown) => void };
    };
    const request = ctx.getRequest<FastifyRequest & FastifyRequest['raw']>();

    this.moduleRef.registerRequestByContextId(request, contextId);

    const sentryService = await this.moduleRef.resolve<SentryService>(
      SentryService,
      contextId,
    );
    const logger = await this.moduleRef.resolve<BaseLogger>(Logger, contextId);

    const exceptionHandler = new ExceptionHandler(
      new RequestContextService(request),
      logger,
      sentryService,
    );

    const data = exceptionHandler.handle(exception);

    const isServerError = data.statusCode >= 500;
    response.status(data.statusCode).send({
      statusCode: data.statusCode,
      code: data.code,
      message: isServerError ? 'Internal server error' : data.message,
      fullMessage: isServerError ? undefined : data.fullMessage,
      fields: isServerError ? undefined : data.fields,
    });
  }
}
