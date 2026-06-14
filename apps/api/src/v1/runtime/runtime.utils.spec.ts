import { describe, expect, it } from 'vitest';

import { resolveDockerOptions } from './runtime.utils';

/**
 * resolveDockerOptions is the seam that decides whether the app pins an
 * explicit Docker socket or defers to dockerode's standard env resolution
 * (DOCKER_HOST / TLS / default socket). Pinning a path suppresses DOCKER_HOST,
 * which is exactly what broke Colima/Podman hosts — so "no explicit socket →
 * undefined" is the load-bearing case here, not a formality.
 */
describe('resolveDockerOptions', () => {
  it('uses an explicit DOCKER_SOCKET path when set', () => {
    expect(
      resolveDockerOptions({ dockerSocket: '/custom/docker.sock' }),
    ).toEqual({ socketPath: '/custom/docker.sock' });
  });

  it('trims surrounding whitespace from the socket path', () => {
    expect(
      resolveDockerOptions({ dockerSocket: '  /custom/docker.sock  ' }),
    ).toEqual({ socketPath: '/custom/docker.sock' });
  });

  it.each([undefined, null, '', '   '])(
    'returns undefined to defer to dockerode standard env resolution (%p)',
    (value) => {
      expect(resolveDockerOptions({ dockerSocket: value })).toBeUndefined();
    },
  );

  // getEnv('DOCKER_SOCKET') coerces magic strings (true/1/on, false/0/off) to a
  // boolean, so a non-string reaches resolveDockerOptions in production. The
  // typeof guard must treat it as "unset" rather than calling .trim() on it.
  it.each([true, false])(
    'returns undefined (not a TypeError) when getEnv coerced the value to a boolean (%p)',
    (value) => {
      expect(resolveDockerOptions({ dockerSocket: value })).toBeUndefined();
    },
  );
});
