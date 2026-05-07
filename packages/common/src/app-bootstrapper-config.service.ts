import { Inject, Injectable } from '@nestjs/common';

import * as appBootstrapperTypes from './app-bootstrapper.types';

@Injectable()
export class AppBootstrapperConfigService {
  constructor(
    @Inject(appBootstrapperTypes.BootstrapParameters)
    private readonly params: appBootstrapperTypes.IAppBootstrapperParams,
  ) {}

  public get appVersion() {
    return this.params.appVersion;
  }

  public get appName() {
    return this.params.appName;
  }

  public get environment() {
    return this.params.environment;
  }
}
