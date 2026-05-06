import type {
  RuntimeExecParams,
  RuntimeExecResult,
} from '../../../../v1/runtime/runtime.types';

/**
 * Snapshot of an `exec()` call recorded by the mock.
 *
 * `cmdString` is the joined command (string commands are passed through; array
 * commands are joined with a single space) — this is what matchers match
 * against and what shows up in the request log.
 */
export interface MockRuntimeExecRequest {
  cmd: RuntimeExecParams['cmd'];
  cmdString: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Hostname of the runtime instance that received the call. */
  runtimeHostname: string;
  /** Monotonically increasing call index across the whole mock. */
  callIndex: number;
}

/**
 * Reply for a stubbed exec. Defaults are filled in at resolution time:
 * `exitCode = 0`, `stdout = ''`, `stderr = ''`, `fail = exitCode !== 0`.
 *
 * Set `hangUntilAbort: true` to leave the exec pending forever; the call
 * resolves only when the caller's `AbortSignal` fires, mirroring how a real
 * `sleep 60` behaves under stop. Without an abort signal the call still
 * hangs — useful for stop-execution tests but never for the happy path.
 *
 * `dynamic` lets a fixture compute the reply from the request — useful for
 * matchers that need to echo back part of the command (e.g. an `echo` stub).
 */
export type MockRuntimeExecReply =
  | (Partial<RuntimeExecResult> & { hangUntilAbort?: boolean })
  | ((
      req: MockRuntimeExecRequest,
    ) => Partial<RuntimeExecResult> & { hangUntilAbort?: boolean });

/**
 * Matcher fields combine with AND semantics: every defined field must match
 * for the fixture to be considered. The most-specific matching fixture wins
 * (count of defined fields). Ties are broken by registration order.
 *
 * - `cmd` — substring (string) or regex match against the joined command.
 * - `cwd` — exact match.
 * - `runtimeHostname` — substring or regex against the runtime instance hostname.
 */
export interface MockRuntimeExecMatcher {
  cmd?: string | RegExp;
  cwd?: string;
  runtimeHostname?: string | RegExp;
}

export interface MockRuntimeExecFixture {
  matcher: MockRuntimeExecMatcher;
  reply: MockRuntimeExecReply;
}
