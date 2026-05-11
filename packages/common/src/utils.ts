import { AppBootstrapper } from './app.bootstrapper';
import { type IAppBootstrapperParams } from './app-bootstrapper.types';

export const buildBootstrapper = (params: IAppBootstrapperParams) => {
  const instance = new AppBootstrapper(params);

  return instance;
};

export function getEnv(env: string, value: boolean): boolean;
export function getEnv(env: string, value: string): string;
export function getEnv(env: string): string;
export function getEnv(
  env: string,
  value?: string | boolean,
): string | boolean {
  const v = process.env[env] === undefined ? value : process.env[env];

  if (typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'string') {
    const normalized = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return v as string;
}

/**
 * Extracts a human-readable message from an arbitrary thrown value.
 *
 * Avoids the `[object Object]` trap from `String(err)` when a library
 * rejects/throws a plain object (e.g. `@kubernetes/client-node`'s WebSocket
 * Exec). Probes common shapes (`message`, `body.message`, `response.body.message`,
 * `reason`, `code`) and falls back to `JSON.stringify`, then `String(err)`.
 */
export function extractErrorMessage(err: unknown): string {
  if (err === null || err === undefined) {
    return String(err);
  }
  if (typeof err === 'string') {
    return err;
  }
  if (err instanceof Error) {
    return err.message || err.name || 'Error';
  }
  if (typeof err === 'object') {
    const record = err as Record<string | symbol, unknown>;
    const candidates: unknown[] = [
      record['message'],
      (record['body'] as Record<string, unknown> | undefined)?.['message'],
      (
        (record['response'] as Record<string, unknown> | undefined)?.[
          'body'
        ] as Record<string, unknown> | undefined
      )?.['message'],
      record['reason'],
      record['code'],
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate;
      }
    }
    // WebSocket ErrorEvent (ws library) hides the underlying Error on
    // Symbol-keyed properties (Symbol(kError), Symbol(kMessage)).
    for (const sym of Object.getOwnPropertySymbols(err)) {
      const value = record[sym];
      if (value instanceof Error && value.message) {
        return value.message;
      }
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    try {
      const serialized = JSON.stringify(err);
      if (serialized && serialized !== '{}') {
        return serialized;
      }
    } catch {
      // Circular or non-serializable — fall through.
    }
  }
  return String(err);
}
