import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  BaseException,
  BaseLogger,
  Logger,
  SentryService,
} from '@packages/common';

import { RequestContextService } from './context';
import type { ISentryExceptionData } from './http-server.types';

@Injectable()
export class ExceptionHandler {
  constructor(
    private readonly requestContextService: RequestContextService,
    @Inject(Logger)
    private readonly logger: BaseLogger,
    private readonly sentryService: SentryService,
  ) {}

  public getSentryExceptionData(exception: unknown): ISentryExceptionData {
    const requestData = this.requestContextService.getRequestData();
    const exceptionData = BaseException.getExceptionData(
      exception as Error | BaseException,
    );

    return {
      ...requestData,
      ...exceptionData,
      level:
        exceptionData.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR
          ? 'error'
          : 'warning',
    };
  }

  public handle(exception: unknown, message?: string): ISentryExceptionData {
    const data = this.getSentryExceptionData(exception);

    const realMessage = message || data.message;

    this.logger.error(exception as Error | string, realMessage, {
      ...data,
    });

    if (data.statusCode >= HttpStatus.BAD_REQUEST) {
      this.sentryService.send(exception as Error, data);
    }

    return data;
  }
}
