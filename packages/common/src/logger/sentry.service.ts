import { Inject, Injectable, Scope } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import lodash from 'lodash';

const { isObject } = lodash;

import { BaseLogger } from './base-logger.js';
import * as loggerTypes from './logger.types.js';

@Injectable({
  scope: Scope.DEFAULT,
})
export class SentryService {
  private isSentryInit = false;
  private isWarningSent = false;

  constructor(
    @Inject(loggerTypes.LoggerParams)
    public readonly loggerParams: loggerTypes.ILoggerParams,
    @Inject(loggerTypes.Logger)
    private readonly logger: BaseLogger,
  ) {}

  public send(err: Error, data?: loggerTypes.ISentryLogData) {
    if (!this.isSentryInit) {
      this.init();
    }

    const scope = Sentry.getCurrentScope();

    if (isObject(data)) {
      scope.setExtra('data', data);
    }

    if (data?.message) {
      scope.setExtra('message', data.message);
    }

    if (data?.url) {
      scope.setExtra('url', data.url);
    }

    if (data?.userId) {
      scope.setUser({
        userID: data.userId,
        username: String(data.userId),
      });
    }

    if (data?.requestId) {
      scope.setTag('requestId', String(data.requestId));
    }

    if (data?.operationId) {
      scope.setTag('operationId', String(data.operationId));
    }

    if (data?.errorCode) {
      scope.setTag('errorCode', String(data.errorCode));
    }

    if (data?.statusCode) {
      scope.setTag('statusCode', String(data.statusCode));
    }

    if (this.loggerParams?.appVersion) {
      scope.setTag('appVersion', this.loggerParams?.appVersion);
    }

    if (this.loggerParams?.appName) {
      scope.setTag('appName', this.loggerParams?.appName);
    }

    if (this.loggerParams?.environment) {
      scope.setTag('environment', this.loggerParams?.environment);
    }

    scope.setLevel(data?.level || 'error');

    Sentry.captureException(err);
  }

  public init() {
    const dsn = this.loggerParams?.sentryDsn;
    if (!dsn) {
      if (!this.isWarningSent) {
        this.logger.warn('Sentry cannot be used without dsn');
      }

      this.isWarningSent = true;

      return;
    }

    this.logger.system('Init sentry');

    Sentry.init({
      environment: this.loggerParams?.environment,
      dsn,
      normalizeDepth: 11,
      integrations: [
        // unfortunately, sentry does not provide a way to add additional tags to record,
        // that can be useful to track records within whole application
        Sentry.extraErrorDataIntegration({ depth: 10 }),
      ],
    });

    this.isSentryInit = true;
  }
}
