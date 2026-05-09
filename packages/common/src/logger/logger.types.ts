import type { SeverityLevel } from '@sentry/core';
import type { LevelWithSilent } from 'pino';

export type LogLevel = LevelWithSilent | 'system';

export interface ILoggerParams {
  prettyPrint?: boolean;
  sentryDsn?: string;
  level?: LogLevel;
  environment: string;
  appName: string;
  appVersion: string;
}

export interface ISentryLogData {
  userId?: string;
  requestId?: string;
  operationId?: string;
  level?: SeverityLevel;
  errorCode?: string;
  statusCode?: number;
  message?: string;
  url?: string;
  [key: string]: unknown;
}

export const LoggerParams = Symbol('LoggerParams');
export const Logger = Symbol('Logger');
