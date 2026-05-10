import {
  type DynamicModule,
  Module,
  type ModuleMetadata,
} from '@nestjs/common';

import { type IAppBootstrapperParams } from './app-bootstrapper.types';
import { AppBootstrapperConfigModule } from './app-bootstrapper-config.module';

@Module({})
export class AppBootstrapperModule {
  static forRoot(
    bootstrapModules: ModuleMetadata['imports'],
    parameters: IAppBootstrapperParams,
  ): DynamicModule {
    return {
      module: AppBootstrapperModule,
      imports: [
        AppBootstrapperConfigModule.forRoot(parameters),
        ...(bootstrapModules || []),
      ],
      providers: [],
      exports: [],
      controllers: [],
    };
  }
}
