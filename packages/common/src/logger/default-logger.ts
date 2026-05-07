import { Inject, Injectable } from '@nestjs/common';
import { networkInterfaces } from 'os';

import { BaseLogger } from './base-logger';
import * as loggerTypes from './logger.types';

@Injectable()
export class DefaultLogger extends BaseLogger {
  private networkInterfaces = networkInterfaces();

  constructor(
    @Inject(loggerTypes.LoggerParams)
    public readonly loggerParams: loggerTypes.ILoggerParams,
  ) {
    super(loggerParams);
  }

  private getLocalIp(): string {
    for (const devName in this.networkInterfaces) {
      const iface = this.networkInterfaces[devName] || [];

      for (const alias of iface) {
        if (
          alias.family === 'IPv4' &&
          alias.address !== '127.0.0.1' &&
          !alias.internal
        ) {
          return alias.address;
        }
      }
    }

    return '';
  }

  public getCustomPayload() {
    return {
      instanceIp: this.getLocalIp(),
    };
  }
}
