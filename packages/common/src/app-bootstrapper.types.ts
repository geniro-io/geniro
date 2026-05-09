import {
  type DynamicModule,
  type ModuleMetadata,
  type Type,
} from '@nestjs/common';

import { type BaseLogger } from './logger/index';

export interface IAppBootstrapperParams {
  environment: string;
  appName: string;
  appVersion: string;
}

export const BootstrapParameters = Symbol('BootstrapParameters');

export interface IAppBootstrapperExtension {
  modules: NonNullable<ModuleMetadata['imports']>;
  defaultLogger?: Type<BaseLogger>;
  customBootstrapper?: (module: DynamicModule) => Promise<void>;
}
