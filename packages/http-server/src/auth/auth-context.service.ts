import { Inject, Injectable, Optional, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { UnauthorizedException } from '@packages/common';
import type { FastifyRequest } from 'fastify';
import type { UnknownRecord } from 'type-fest';

import { HttpServerAuthParams } from '../http-server.types';
import type { IAuthModuleParams, IContextData } from './auth.types';
import { AuthContextDataBuilder } from './auth-context-data-builder';
import { AuthContextStorage } from './auth-context-storage';
import { AuthProvider } from './providers/auth.provider';

@Injectable({ scope: Scope.REQUEST })
export class AuthContextService {
  private contextData: IContextData | undefined;

  constructor(
    private readonly authContextDataBuilder: AuthContextDataBuilder,
    @Inject(REQUEST)
    protected readonly request: FastifyRequest,
    @Inject(HttpServerAuthParams)
    protected readonly params?: IAuthModuleParams,
    @Inject(AuthProvider)
    @Optional()
    private readonly authProvider?: AuthProvider,
  ) {}

  public async init() {
    const token = this.getToken();

    const contextData = await this.authContextDataBuilder.buildContextData(
      token,
      (this.request?.headers || {}) as UnknownRecord,
    );

    this.contextData = contextData;

    return contextData;
  }

  public getToken(): string | undefined {
    if (this.authProvider?.getToken) {
      return this.authProvider?.getToken(this.request);
    }

    const jwtHeader = this.request?.headers?.authorization;
    const token = jwtHeader?.split(' ').pop();

    return token;
  }

  public get sub(): string | undefined {
    return this.contextData?.sub;
  }

  public checkSub(): string {
    const sub = this.sub;

    if (!sub) {
      throw new UnauthorizedException('UNAUTHORIZED', 'No sub');
    }

    return sub;
  }

  public context<T extends IContextData>(): T {
    return this.contextData as T;
  }

  public contextStorage<T extends IContextData>(): AuthContextStorage<T> {
    const instance = this.params?.storage || AuthContextStorage;

    return new instance<T>(this.contextData as T, this.request);
  }

  public get isAuthorized() {
    return !!this.contextData;
  }
}
