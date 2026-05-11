import { ConsoleLogger, type LoggerService } from '@nestjs/common';
import lodash from 'lodash';
import P from 'pino';
import pretty from 'pino-pretty';

const { isObject, isString, isUndefined, pickBy } = lodash;

import { type ILoggerParams, type LogLevel } from './logger.types';

export abstract class BaseLogger
  extends ConsoleLogger
  implements LoggerService
{
  protected readonly pino: P.Logger<'system'>;
  protected readonly level?: LogLevel;
  protected readonly prettyPrint?: boolean;
  protected readonly environment?: string;
  protected readonly appName?: string;
  protected readonly appVersion?: string;

  protected constructor(public readonly params: ILoggerParams) {
    super();

    const { level, prettyPrint, environment, appName, appVersion } = params;

    this.level = level;
    this.prettyPrint = prettyPrint;
    this.environment = environment;
    this.appName = appName;
    this.appVersion = appVersion;

    const pinoOptions: P.LoggerOptions<'system'> = {
      customLevels: { system: 99 },
      name: this.appName,
      level: this.level ?? 'info',
    };

    const stream = pretty({ colorize: true });

    this.pino = this.prettyPrint
      ? P<'system'>(pinoOptions, stream)
      : P<'system'>(pinoOptions);
  }

  /**
   * Return any custom payload fields that should be appended to all logs.
   */
  public abstract getCustomPayload?(): Record<string, unknown>;

  /**
   * Create the log payload.
   * @param options Build options
   */
  private buildPayload({
    msg,
    level,
    err,
    args,
  }: {
    msg: string;
    level: LogLevel;
    err?: Error;
    args?: unknown[];
  }): Record<string, unknown> {
    const data = (args ?? []).reduce<{
      [key: string]: unknown;
      _args?: unknown[];
    }>((acc, curr) => {
      if (isObject(curr)) {
        Object.assign(acc, curr);
      } else {
        (acc._args ??= []).push(curr);
      }
      return acc;
    }, {});

    return pickBy(
      {
        msg,
        error: err
          ? {
              ...err,
              stack: err.stack,
            }
          : undefined,
        level,
        environment: this.environment,
        appName: this.appName,
        appVersion: this.appVersion,
        data: Object.keys(data).length ? data : undefined,
        ...(this.getCustomPayload?.() ?? {}),
      },
      (v) => !isUndefined(v),
    );
  }

  /** Log a system-level event. */
  public system(msg: string, ...args: unknown[]): void {
    this.pino.system(this.buildPayload({ msg, level: 'system', args }));
  }

  /** Log a debug message. */
  public debug(msg: string, ...args: unknown[]): void {
    this.pino.debug(this.buildPayload({ msg, level: 'debug', args }));
  }

  /** Log an error message. */
  public error(
    err: Error | string,
    message?: string,
    ...args: unknown[]
  ): void {
    const isErr = !isString(err);
    this.pino.error(
      this.buildPayload({
        msg: message ?? (isErr ? (err as Error).message : err),
        level: 'error',
        args,
        err: isErr ? (err as Error) : undefined,
      }),
    );
  }

  /** Log an info message. */
  public log(msg: string, ...args: unknown[]): void {
    this.pino.info(this.buildPayload({ msg, level: 'info', args }));
  }

  /** Log a trace message. */
  public trace(msg: string, ...args: unknown[]): void {
    this.pino.trace(this.buildPayload({ msg, level: 'trace', args }));
  }

  /** Log a warn message. */
  public warn(msg: string, ...args: unknown[]): void {
    this.pino.warn(this.buildPayload({ msg, level: 'warn', args }));
  }
}
