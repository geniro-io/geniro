import { Inject, Injectable, Optional } from '@nestjs/common';
import type { UnknownRecord } from 'type-fest';

import * as httpServerTypes from '../http-server.types';
import type { IAuthModuleParams, IContextData } from './auth.types';
import { AuthProvider } from './providers/auth.provider';

@Injectable()
export class AuthContextDataBuilder {
  constructor(
    @Inject(httpServerTypes.HttpServerAuthParams)
    private readonly params?: IAuthModuleParams,
    @Inject(AuthProvider)
    @Optional()
    private readonly authProvider?: AuthProvider,
  ) {}

  public getDevUser(headers?: UnknownRecord): IContextData | undefined {
    const context = Object.entries(headers || {}).reduce(
      (acc: IContextData, [key, value]) => {
        if (key.startsWith('x-dev-jwt-')) {
          const propKey = key.replace('x-dev-jwt-', '');
          let preparedValue = value;

          if (typeof preparedValue === 'string') {
            try {
              preparedValue = JSON.parse(preparedValue);
            } catch {
              // ignore
            }
          }

          acc[propKey] = preparedValue;
        }

        return acc;
      },
      {},
    );

    if (Object.keys(context).length === 0) {
      return undefined;
    }

    return context;
  }

  public async buildContextData(
    token?: string,
    headers?: UnknownRecord,
  ): Promise<IContextData | undefined> {
    const isDevMode = this.params?.devMode;

    if (isDevMode) {
      const ctx = this.getDevUser(headers);

      if (ctx) {
        return ctx;
      }
    }

    if (!token || !this.authProvider) {
      return undefined;
    }

    return this.authProvider.verifyToken(token);
  }
}
