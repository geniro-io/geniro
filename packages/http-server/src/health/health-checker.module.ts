import { type DynamicModule, Module, type Type } from '@nestjs/common';

import { HealthCheckerController } from './health-checker.controller';

@Module({})
export class HealthCheckerModule {
  static forRoot(): DynamicModule {
    const providers: Type<unknown>[] = [];

    return {
      controllers: [HealthCheckerController],
      module: HealthCheckerModule,
      exports: providers,
      providers,
    };
  }
}
