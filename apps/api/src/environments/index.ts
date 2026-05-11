import { resolve } from 'node:path';

import * as dotenv from 'dotenv';

const appRoot = resolve(__dirname, '..', '..');

dotenv.config({
  path: resolve(appRoot, '.env'),
  quiet: true,
  override: true,
});

import { environment as dev } from './environment.dev';
import { environment as prod } from './environment.prod';
import { environment as test } from './environment.test';

const ENV_MAP = {
  test: test(),
  development: dev(),
  production: prod(),
};
const NODE_ENV: keyof typeof ENV_MAP = <keyof typeof ENV_MAP>(
  String(process.env.NODE_ENV || 'production')
);

export const environment = ENV_MAP[NODE_ENV];

let fingerprintOverride: string | undefined;

/**
 * Override the instance fingerprint. Tests call this from `createTestModule()`
 * with a unique value per app instance so Redis-shared namespaces (BullMQ
 * queue names, pub/sub channels, distributed locks) don't bleed across test
 * files or sequential test apps in the same worker. Pass `undefined` to clear.
 */
export const setInstanceFingerprint = (value: string | undefined): void => {
  fingerprintOverride = value;
};

/**
 * Identity of the running app instance. In dev/prod this is just the
 * deployment env name (one process per env). In tests it's overridden per
 * `createTestModule()` call so each ephemeral app owns its own slice of any
 * Redis-shared namespace.
 */
export const getInstanceFingerprint = (): string =>
  fingerprintOverride ?? environment.env;
