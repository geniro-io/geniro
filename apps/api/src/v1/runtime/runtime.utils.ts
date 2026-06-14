const SAFE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolve dockerode connection options from the Docker environment. The shape
 * (`{ socketPath }` or `undefined`) is dockerode's `DockerOptions`; it is typed
 * as `Record<string, unknown>` to match `resolveRuntimeConfigByType`'s contract
 * and assigns cleanly to `new Docker(...)`.
 *
 * When `DOCKER_SOCKET` names an explicit socket path it wins (operator opt-in,
 * backward-compatible with existing deployments). Otherwise this returns
 * `undefined` so dockerode applies its OWN standard resolution — `DOCKER_HOST`,
 * `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`, then the platform-default socket —
 * the exact chain the `docker` CLI and testcontainers honor. Passing an
 * explicit `socketPath` would instead suppress that chain, which is why
 * Colima/Podman/Docker-Desktop hosts (which export `DOCKER_HOST`, not
 * `DOCKER_SOCKET`) previously failed with `ENOENT /var/run/docker.sock`. The
 * integration global-setup already relies on this same `new Docker()` env
 * resolution.
 *
 * `dockerSocket` is typed to admit `boolean` because `getEnv('DOCKER_SOCKET')`
 * coerces magic values (`true`/`1`/`on`/`false`/`0`/`off`) to a boolean at
 * runtime — so a non-string can reach here. A `typeof` check is required:
 * optional chaining (`?.trim()`) guards only null/undefined and would throw
 * `TypeError: trim is not a function` on a coerced boolean, crashing every
 * Docker runtime creation. A non-string is treated as "unset" → defer to
 * dockerode's standard resolution.
 */
export function resolveDockerOptions(env: {
  dockerSocket?: string | boolean | null;
}): Record<string, unknown> | undefined {
  const raw = env.dockerSocket;
  const socketPath = typeof raw === 'string' ? raw.trim() : undefined;
  return socketPath ? { socketPath } : undefined;
}

/**
 * Wraps a shell value in single quotes, escaping any embedded single quotes
 * using the standard POSIX pattern: replace ' with '\''
 */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds a shell `export KEY=value; ...` prefix string for injecting
 * environment variables into a shell command. Keys that don't match the
 * safe identifier pattern are silently skipped to prevent injection.
 *
 * Returns an empty string when env is undefined or has no entries.
 */
export function buildEnvPrefix(
  env: Record<string, string> | undefined,
): string {
  if (!env || !Object.keys(env).length) {
    return '';
  }

  return `${Object.entries(env)
    .filter(([k]) => SAFE_KEY_PATTERN.test(k))
    .map(([k, v]) => `export ${k}=${shellEscape(v)}`)
    .join('; ')}; `;
}
