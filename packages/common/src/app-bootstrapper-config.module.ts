import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import {
  BootstrapParameters,
  type IAppBootstrapperParams,
} from './app-bootstrapper.types';
import { AppBootstrapperConfigService } from './app-bootstrapper-config.service';

@Module({})
@Global()
export class AppBootstrapperConfigModule {
  static forRoot(parameters: IAppBootstrapperParams): DynamicModule {
    const providers = [
      {
        provide: BootstrapParameters,
        useValue: parameters,
      },
      AppBootstrapperConfigService,
    ];

    return {
      module: AppBootstrapperConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: [`${process.cwd()}/.env`],
        }),
      ],
      providers,
      exports: providers,
    };
  }
}
