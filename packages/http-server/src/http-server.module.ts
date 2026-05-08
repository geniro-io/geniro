import { type DynamicModule, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodSerializerInterceptor } from 'nestjs-zod';

import { AppContextModule } from './context';
import { ExceptionHandler } from './exception-handler';
import { HealthCheckerModule } from './health/health-checker.module';
import { HttpServerParams, type IHttpServerParams } from './http-server.types';
import { ZodValidationPipe } from './pipes/zod-validation.pipe';

@Module({})
export class HttpServerModule {
  static forRoot(params: IHttpServerParams): DynamicModule {
    const providers = [
      {
        provide: HttpServerParams,
        useValue: params,
      },
      ExceptionHandler,
    ];

    return {
      imports: [AppContextModule.forRoot(), HealthCheckerModule.forRoot()],
      module: HttpServerModule,
      exports: providers,
      providers: [
        ...providers,
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
      ],
    };
  }
}
