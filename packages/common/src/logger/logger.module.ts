import {
  type DynamicModule,
  Global,
  type Provider,
  type Type,
} from '@nestjs/common';
import lodash from 'lodash';

const { compact } = lodash;

import { BaseLogger } from './base-logger.js';
import { DefaultLogger } from './default-logger.js';
import { type ILoggerParams, Logger, LoggerParams } from './logger.types.js';
import { SentryService } from './sentry.service.js';

@Global()
export class LoggerModule {
  static forRoot(
    param: ILoggerParams,
    instance?: Type<BaseLogger>,
  ): DynamicModule {
    const providers: Provider[] = compact([
      {
        provide: LoggerParams,
        useValue: param,
      },
      DefaultLogger,
      instance,
      {
        provide: Logger,
        useClass: instance ?? DefaultLogger,
      },
      SentryService,
    ]);

    return {
      module: LoggerModule,
      exports: providers,
      providers,
    };
  }
}
