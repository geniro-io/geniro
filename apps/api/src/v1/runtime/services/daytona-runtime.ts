import { randomUUID } from 'node:crypto';
import { Duplex, PassThrough } from 'node:stream';

import { Daytona, Sandbox } from '@daytonaio/sdk';
import { extractErrorMessage } from '@packages/common';

import { environment } from '../../../environments';
import {
  RuntimeExecParams,
  RuntimeExecResult,
  RuntimeStartingPhase,
  RuntimeStartParams,
} from '../runtime.types';
import { buildEnvPrefix, shellEscape } from '../runtime.utils';
import { BaseRuntime } from './base-runtime';

/** Configuration needed to connect to the Daytona API. */
export interface DaytonaRuntimeConfig {
  apiKey: string;
  apiUrl: string;
  target?: string;
}

/** Minimal logger interface accepted by DaytonaRuntime. */
export interface DaytonaRuntimeLogger {
  log(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string | Error, message?: string, ...args: unknown[]): void;
}

const SANDBOX_CREATE_TIMEOUT_SECONDS = 300;

/** No new stdout/stderr output for this duration → command is considered stuck. */
const IDLE_TIMEOUT_MS = 300_000;

/** Absolute wall-clock limit; overridden by params.timeoutMs when provided. */
const HARD_TIMEOUT_MS = 3_600_000;

/**
 * Fixed poll interval for the safety-net poller (ms).
 * Only used in the streaming (runAsync: true) path for idle-timeout-aware execution.
 */
const POLL_INTERVAL_MS = 200;

/**
 * Grace period before the snapshot fallback kicks in (ms).
 * Only used in the streaming (runAsync: true) path.
 */
const SNAPSHOT_GRACE_MS = 1_000;

/**
 * Number of poll ticks between snapshot fallback checks.
 * Only used in the streaming (runAsync: true) path.
 */
const SNAPSHOT_EVERY_N_TICKS = 10;

/**
 * DaytonaRuntime using the @daytonaio/sdk
 *
 * Each instance manages exactly one Daytona sandbox lifecycle: start -> exec (any number) -> stop.
 * Sessions are created lazily via the Daytona process session API.
 */
export class DaytonaRuntime extends BaseRuntime {
  private daytona: Daytona | null = null;
  private sandbox: Sandbox | null = null;
  private readonly config: DaytonaRuntimeConfig;
  private readonly snapshot: string;
  private readonly logger?: DaytonaRuntimeLogger;
  private readonly activeSessions = new Set<string>();

  /**
   * Per-session command queue. Daytona sessions are single-shell processes —
   * sending two `runAsync: false` commands concurrently to the same session
   * causes one to hang indefinitely (exit code file / response routing
   * collision on the server side). This map serializes commands per session.
   */
  private readonly sessionQueue = new Map<string, Promise<unknown>>();

  constructor(
    config?: DaytonaRuntimeConfig,
    params?: { snapshot?: string; logger?: DaytonaRuntimeLogger },
  ) {
    super();
    this.config = config ?? {
      apiKey: '',
      apiUrl: '',
    };
    this.snapshot = params?.snapshot || environment.dockerRuntimeImage || '';
    this.logger = params?.logger;
  }

  /**
   * Checks whether the Daytona API is reachable and responsive.
   * Performs a lightweight sandbox list call to verify connectivity.
   */
  static async checkHealth(
    config: DaytonaRuntimeConfig,
  ): Promise<{ healthy: boolean; error?: string }> {
    try {
      const daytona = new Daytona({
        apiKey: config.apiKey || undefined,
        apiUrl: config.apiUrl || undefined,
        target: config.target || undefined,
      });
      // Lightweight call — fetch at most 1 sandbox to verify API
      // connectivity. Since SDK 0.18 `list` returns an async iterator;
      // pulling the first page is what triggers the HTTP round-trip.
      await daytona.list({ limit: 1 }).next();
      return { healthy: true };
    } catch (error) {
      return {
        healthy: false,
        error: extractErrorMessage(error),
      };
    }
  }

  static async stopByName(
    name: string,
    config?: DaytonaRuntimeConfig,
  ): Promise<void> {
    const daytona = new Daytona({
      apiKey: config?.apiKey || undefined,
      apiUrl: config?.apiUrl || undefined,
      target: config?.target || undefined,
    });

    try {
      const sandbox = await daytona.get(name);
      await daytona.delete(sandbox).catch(() => undefined);
    } catch {
      // Sandbox not found or already deleted — nothing to do
    }
  }

  /**
   * Returns the underlying Daytona Sandbox instance, if started.
   * Used by DaytonaExecTransport for MCP session-based communication.
   */
  public getSandbox(): Sandbox | null {
    return this.sandbox;
  }

  async start(params?: RuntimeStartParams): Promise<void> {
    if (this.sandbox) {
      return;
    }

    this.daytona = new Daytona({
      apiKey: this.config.apiKey || undefined,
      apiUrl: this.config.apiUrl || undefined,
      target: this.config.target || undefined,
    });

    const sandboxName = params?.containerName || `rt-${randomUUID()}`;
    const snapshotOrImage = params?.image || this.snapshot;

    // Check if an existing sandbox can be reused
    if (!params?.recreate) {
      try {
        const existing = await this.daytona.get(sandboxName);
        if (existing) {
          if (existing.state !== 'started') {
            await this.daytona.start(existing, SANDBOX_CREATE_TIMEOUT_SECONDS);
          }
          this.sandbox = existing;
          this.emit({
            type: 'phase',
            data: { phase: RuntimeStartingPhase.ContainerCreated },
          });
          this.emit({
            type: 'phase',
            data: { phase: RuntimeStartingPhase.Ready },
          });
          this.emit({ type: 'start', data: { params: params || {} } });
          return;
        }
      } catch {
        // Not found — will create
      }
    }

    if (params?.recreate) {
      try {
        const existing = await this.daytona.get(sandboxName);
        if (existing) {
          await this.daytona.delete(existing).catch(() => undefined);
        }
      } catch {
        // Not found — nothing to clean up
      }
    }

    const commonParams = {
      name: sandboxName,
      envVars: params?.env,
      labels: params?.labels,
      // Disable auto-stop so long-running sandbox stays alive
      autoStopInterval: 0,
    };

    this.emit({
      type: 'phase',
      data: { phase: RuntimeStartingPhase.PullingImage },
    });

    try {
      this.sandbox = await this.createSandbox(commonParams, snapshotOrImage);
    } catch (error) {
      // If the cached snapshot image was lost (e.g. runner DinD wiped after
      // recreate), Daytona returns "pull access denied" because the built
      // snapshot no longer exists in the runner's local registry.
      // Invalidate the stale snapshot and retry once so it rebuilds fresh.
      if (snapshotOrImage && this.isStaleSnapshotError(error)) {
        this.logger?.warn(
          `[DaytonaRuntime] Sandbox creation failed with stale snapshot error. ` +
            `Invalidating cached snapshot for "${snapshotOrImage}" and retrying…`,
        );

        await this.invalidateStaleSnapshot(snapshotOrImage, error);
        await this.cleanupSandbox(sandboxName);

        try {
          this.sandbox = await this.createSandbox(
            commonParams,
            snapshotOrImage,
          );
        } catch (retryError) {
          this.emit({
            type: 'start',
            data: { params: params || {}, error: retryError },
          });
          throw retryError;
        }
      } else {
        this.emit({ type: 'start', data: { params: params || {}, error } });
        throw error;
      }
    }

    this.emit({
      type: 'phase',
      data: { phase: RuntimeStartingPhase.ContainerCreated },
    });

    try {
      // Daytona overrides the image's ENTRYPOINT with its own agent process,
      // so the image entrypoint (e.g. runtime-entrypoint.sh that starts dockerd)
      // never runs. Detect and execute it automatically before user initScript.
      await this.runImageEntrypoint(params?.env);

      if (params?.initScript) {
        this.emit({
          type: 'phase',
          data: { phase: RuntimeStartingPhase.InitScript },
        });
        await this.runInitScript(
          params.initScript,
          params.env,
          params.initScriptTimeoutMs,
        );
      }

      this.emit({
        type: 'phase',
        data: { phase: RuntimeStartingPhase.Ready },
      });
      this.emit({ type: 'start', data: { params: params || {} } });
    } catch (error) {
      this.emit({ type: 'start', data: { params: params || {}, error } });
      throw error;
    }
  }

  private async runInitScript(
    script?: string | string[],
    env?: Record<string, string>,
    timeoutMs?: number,
  ) {
    if (!script) {
      return;
    }

    const cmds = Array.isArray(script) ? script : [script];
    const timeoutSeconds = Math.ceil((timeoutMs ?? 10 * 60_000) / 1000);

    for (const cmd of cmds) {
      const res = await this.exec({
        cmd,
        env,
        timeoutMs: timeoutSeconds * 1000,
      });
      if (res.fail) {
        throw new Error(`Init failed: ${res.stderr || res.stdout}`);
      }
    }
  }

  /**
   * If the sandbox image ships a runtime entrypoint script, execute it.
   * Daytona replaces the image ENTRYPOINT with its own agent, so scripts
   * like `runtime-entrypoint.sh` (which starts dockerd, etc.) never run
   * automatically. This method detects and runs the entrypoint with a
   * no-op argument so it initialises the environment and returns.
   */
  private async runImageEntrypoint(
    env?: Record<string, string>,
  ): Promise<void> {
    const entrypoint = '/usr/local/bin/runtime-entrypoint.sh';

    const check = await this.exec({
      cmd: `test -x ${entrypoint} && echo exists`,
      timeoutMs: 10_000,
    });

    if (check.fail || !check.stdout.includes('exists')) {
      return;
    }

    const res = await this.exec({
      cmd: `${entrypoint} true`,
      env,
      timeoutMs: 180_000,
    });

    if (res.fail) {
      this.logger?.warn(
        `[DaytonaRuntime] Image entrypoint failed (non-fatal): ${res.stderr || res.stdout}`,
      );
    }
  }

  async stop(): Promise<void> {
    try {
      if (!this.sandbox || !this.daytona) {
        return;
      }

      // Clean up sessions
      for (const sessionId of this.activeSessions) {
        try {
          await this.sandbox.process.deleteSession(sessionId);
        } catch {
          // Session may already be gone
        }
      }
      this.activeSessions.clear();

      await this.daytona.delete(this.sandbox).catch(() => undefined);
      this.sandbox = null;
      this.daytona = null;

      this.emit({ type: 'stop', data: {} });
    } catch (error) {
      this.emit({ type: 'stop', data: { error } });
      throw error;
    }
  }

  async exec(params: RuntimeExecParams): Promise<RuntimeExecResult> {
    if (!this.sandbox) {
      throw new Error('Runtime not started');
    }
    const fullWorkdir = this.getWorkdir(params.cwd) || this.workdir;
    const execId = randomUUID();

    let cmdString: string;
    if (Array.isArray(params.cmd)) {
      cmdString = params.cmd.join(' && ');
    } else {
      cmdString = params.cmd;
    }

    // Prepend cd when cwd is specified
    if (params.cwd) {
      cmdString = `cd ${shellEscape(params.cwd)} && ${cmdString}`;
    }

    this.emit({
      type: 'execStart',
      data: { execId, params },
    });

    if (params.sessionId) {
      try {
        const result = await this.execInSession(params, cmdString);
        this.emit({
          type: 'execEnd',
          data: { execId, params, result },
        });
        return result;
      } catch (error) {
        // Session may be stuck after a timeout or network error.
        // Recreate it so subsequent commands on this session don't hang.
        // Store the promise so concurrent callers (execInSession) can await it.
        this.sessionRecreatePromise = this.recreateSession(params.sessionId);
        await this.sessionRecreatePromise;

        const err = extractErrorMessage(error);
        const result: RuntimeExecResult = {
          exitCode: 124,
          stdout: '',
          stderr: err,
          fail: true,
          execPath: fullWorkdir,
        };
        this.emit({
          type: 'execEnd',
          data: { execId, params, error },
        });
        return result;
      }
    }

    // One-shot execution via a temporary session.
    // Using executeSessionCommand instead of executeCommand gives proper
    // stdout/stderr separation (executeCommand interleaves them into a
    // single `result` string).
    try {
      const result = await this.execOneShot(params, cmdString, fullWorkdir);
      this.emit({
        type: 'execEnd',
        data: { execId, params, result },
      });
      return result;
    } catch (error) {
      this.emit({
        type: 'execEnd',
        data: { execId, params, error },
      });

      throw error;
    }
  }

  /**
   * Pending session recreation promise. Callers must await this before using
   * the session to avoid racing against a background delete+create.
   */
  private sessionRecreatePromise: Promise<void> | null = null;

  private async execInSession(
    params: RuntimeExecParams,
    cmdString: string,
  ): Promise<RuntimeExecResult> {
    const sessionId = params.sessionId as string;

    // Serialize commands on the same session. Daytona sessions are single-shell
    // processes — concurrent `runAsync: false` calls cause one to hang forever.
    const prev = this.sessionQueue.get(sessionId) ?? Promise.resolve();
    const resultPromise = prev
      .catch(() => {
        /* ignore previous command errors — we still need to run ours */
      })
      .then(() => this.execInSessionInner(params, cmdString));

    // Store the new tail of the queue (including this command)
    this.sessionQueue.set(sessionId, resultPromise);

    try {
      return await resultPromise;
    } finally {
      // Clean up the queue entry if we're still the tail
      if (this.sessionQueue.get(sessionId) === resultPromise) {
        this.sessionQueue.delete(sessionId);
      }
    }
  }

  private async execInSessionInner(
    params: RuntimeExecParams,
    cmdString: string,
  ): Promise<RuntimeExecResult> {
    const sessionId = params.sessionId as string;
    const fullWorkdir = this.getWorkdir(params.cwd) || this.workdir;

    // Wait for any pending session recreation to finish before proceeding
    if (this.sessionRecreatePromise) {
      await this.sessionRecreatePromise;
      this.sessionRecreatePromise = null;
    }

    // Ensure session exists
    if (!this.activeSessions.has(sessionId)) {
      await this.sandbox!.process.createSession(sessionId);
      this.activeSessions.add(sessionId);
      // Initialize session CWD to this.workdir, mirroring Docker's WorkingDir behaviour.
      // Daytona sessions start in the sandbox default (e.g. /home/daytona) which does not
      // match this.workdir (/runtime-workspace).  Without this, cloned repos land in the
      // wrong directory while execPath still reports /runtime-workspace, causing tools
      // (explorer, shell) to look for files that don't exist at the reported path.
      try {
        await this.sandbox!.process.executeSessionCommand(sessionId, {
          command: `mkdir -p ${this.workdir} && cd ${this.workdir}`,
          runAsync: false,
        });
      } catch {
        this.logger?.warn(
          `[DaytonaRuntime] Failed to initialise session "${sessionId}" workdir "${this.workdir}" — commands may run from the sandbox default directory`,
        );
      }
    }

    // Build env prefix same as Docker runtime.
    // Prefix with `set +eu` to reset shell options that a PREVIOUS session
    // command may have left active. Daytona sessions are persistent shells —
    // if a prior command ran `set -eu`, the `-e` flag causes the shell to
    // EXIT when any subsequent command returns non-zero (e.g. `bun install`
    // exits 127 when bun isn't installed). This kills the shell process and
    // the Daytona toolbox's exit code polling hangs forever.
    const envPrefix = buildEnvPrefix(params.env);
    const script = `set +eu 2>/dev/null; ${envPrefix}${cmdString || ':'}`;

    // When idleTimeoutMs is explicitly provided, use the streaming path
    // (runAsync: true + awaitCommand) so we can detect "no output for N seconds".
    // Otherwise, use the synchronous path (runAsync: false) which avoids the
    // WebSocket deadlock for fast-exiting commands (e.g. `bun install` when
    // bun is not installed exits 127 instantly but the WS stream never closes).
    if (params.idleTimeoutMs !== undefined) {
      return this.execInSessionStreaming(
        sessionId,
        script,
        params,
        fullWorkdir,
      );
    }

    return this.execInSessionSync(sessionId, script, params, fullWorkdir);
  }

  /**
   * Synchronous session execution using `runAsync: false`.
   *
   * The Daytona server blocks on the HTTP request, polls the exit code file
   * internally every 50ms, and returns the response with exitCode + stdout +
   * stderr when the command completes. No WebSocket involved.
   */
  private async execInSessionSync(
    sessionId: string,
    script: string,
    params: RuntimeExecParams,
    fullWorkdir: string,
  ): Promise<RuntimeExecResult> {
    const timeoutSecs = Math.ceil((params.timeoutMs ?? HARD_TIMEOUT_MS) / 1000);

    // Check abort before starting
    if (params.signal?.aborted) {
      return {
        exitCode: 124,
        stdout: '',
        stderr: 'Aborted',
        fail: true,
        execPath: fullWorkdir,
      };
    }

    // Race the synchronous SDK call against an abort signal (if provided)
    const execPromise = this.sandbox!.process.executeSessionCommand(
      sessionId,
      { command: script, runAsync: false },
      timeoutSecs,
    );

    const result = await (params.signal
      ? this.raceWithAbort(execPromise, params.signal)
      : execPromise.then((r) => ({ aborted: false as const, response: r })));

    if (result.aborted) {
      this.sessionRecreatePromise = this.recreateSession(sessionId);
      return {
        exitCode: 124,
        stdout: '',
        stderr: 'Aborted',
        fail: true,
        execPath: fullWorkdir,
      };
    }

    const { exitCode, stdout, stderr } = result.response as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    };
    const code = exitCode ?? (stderr ? 1 : 0);

    return {
      exitCode: code,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
      fail: code !== 0,
      execPath: fullWorkdir,
    };
  }

  /**
   * Streaming session execution using `runAsync: true` + `awaitCommand`.
   * Only used when `idleTimeoutMs` is explicitly provided, so idle timeout
   * detection (based on streaming output activity) is possible.
   */
  private async execInSessionStreaming(
    sessionId: string,
    script: string,
    params: RuntimeExecParams,
    fullWorkdir: string,
  ): Promise<RuntimeExecResult> {
    const { cmdId } = await this.sandbox!.process.executeSessionCommand(
      sessionId,
      { command: script, runAsync: true },
    );

    return this.awaitCommand({
      sessionId,
      cmdId,
      params,
      fullWorkdir,
      onSessionStuck: (result) => {
        // Start session recreation and store the promise so the next
        // execInSession call can await it before using the session.
        this.sessionRecreatePromise = this.recreateSession(sessionId);
        return result;
      },
    });
  }

  /**
   * Race an SDK promise against an AbortSignal. If the signal fires first,
   * returns `{ aborted: true }`. Otherwise returns the SDK response.
   * If the SDK promise rejects, the rejection propagates to the caller.
   */
  private raceWithAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal,
  ): Promise<{ aborted: true } | { aborted: false; response: T }> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        resolve({ aborted: true });
      };

      if (signal.aborted) {
        resolve({ aborted: true });
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });

      promise
        .then((response) => {
          signal.removeEventListener('abort', onAbort);
          resolve({ aborted: false, response });
        })
        .catch((error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        });
    });
  }

  /**
   * Execute a command in a temporary Daytona session (one-shot).
   * Creates an ephemeral session, runs the command synchronously
   * (`runAsync: false`), and deletes the session afterwards.
   *
   * With `runAsync: false` the Daytona server blocks on the HTTP request,
   * polls the exit code internally, and returns exitCode + stdout + stderr
   * when the command completes. No WebSocket involved.
   */
  private async execOneShot(
    params: RuntimeExecParams,
    cmdString: string,
    fullWorkdir: string,
  ): Promise<RuntimeExecResult> {
    const tempSessionId = `oneshot-${randomUUID()}`;
    const timeoutSecs = Math.ceil((params.timeoutMs ?? HARD_TIMEOUT_MS) / 1000);

    try {
      await this.sandbox!.process.createSession(tempSessionId);

      const envPrefix = buildEnvPrefix(params.env);
      const script = `${envPrefix}${cmdString || ':'}`;

      // Check abort before starting
      if (params.signal?.aborted) {
        return {
          exitCode: 124,
          stdout: '',
          stderr: 'Aborted',
          fail: true,
          execPath: fullWorkdir,
        };
      }

      let raceResult: { aborted: true } | { aborted: false; response: unknown };
      try {
        const execPromise = this.sandbox!.process.executeSessionCommand(
          tempSessionId,
          { command: script, runAsync: false },
          timeoutSecs,
        );

        raceResult = params.signal
          ? await this.raceWithAbort(execPromise, params.signal)
          : {
              aborted: false as const,
              response: await execPromise,
            };
      } catch (error) {
        // SDK error (timeout, network, etc.) — return as failed result
        const msg = extractErrorMessage(error);
        return {
          exitCode: 124,
          stdout: '',
          stderr: msg,
          fail: true,
          execPath: fullWorkdir,
        };
      }

      if (raceResult.aborted) {
        return {
          exitCode: 124,
          stdout: '',
          stderr: 'Aborted',
          fail: true,
          execPath: fullWorkdir,
        };
      }

      const { exitCode, stdout, stderr } = raceResult.response as {
        exitCode?: number;
        stdout?: string;
        stderr?: string;
      };
      const code = exitCode ?? (stderr ? 1 : 0);

      return {
        exitCode: code,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        fail: code !== 0,
        execPath: fullWorkdir,
      };
    } finally {
      try {
        await this.sandbox!.process.deleteSession(tempSessionId);
      } catch {
        // Session may already be gone
      }
    }
  }

  /**
   * Streaming polling logic for awaiting a command that has already been
   * submitted via `executeSessionCommand` with `runAsync: true`.
   *
   * Only used when idle timeout detection is needed (requires streaming output
   * to track last-activity timestamps). Most exec calls now use the synchronous
   * `runAsync: false` path which avoids the WebSocket deadlock for fast-exiting
   * commands.
   *
   * Uses two completion signals racing against each other:
   * 1. **Stream** (`getSessionCommandLogs` WebSocket) — primary signal. When it
   *    resolves, fetch exit code via `getSessionCommand`.
   * 2. **Fixed-interval polling** (200ms) — safety net for fast-exiting commands
   *    whose WebSocket close may be delayed.
   *
   * The command itself is NEVER retried. Only `getSessionCommand` (read-only
   * status check) is polled.
   */
  private awaitCommand(opts: {
    sessionId: string;
    cmdId: string;
    params: RuntimeExecParams;
    fullWorkdir: string;
    onSessionStuck?: (result: RuntimeExecResult) => RuntimeExecResult;
  }): Promise<RuntimeExecResult> {
    const { sessionId, cmdId, params, fullWorkdir, onSessionStuck } = opts;

    const hardMs = Math.min(
      params.timeoutMs ?? HARD_TIMEOUT_MS,
      HARD_TIMEOUT_MS,
    );
    const startAt = Date.now();
    let lastOutputAt = Date.now();
    let stdout = '';
    let stderr = '';
    let streamActive = true;

    return new Promise<RuntimeExecResult>((resolve) => {
      let settled = false;
      let pollInterval: ReturnType<typeof setInterval> | null = null;
      let pollTick = 0;

      const fetchExitCode = async (): Promise<number> => {
        try {
          const cmd = await this.sandbox!.process.getSessionCommand(
            sessionId,
            cmdId,
          );
          if (typeof cmd.exitCode === 'number') {
            return cmd.exitCode;
          }
        } catch {
          // cmdId not found — cleaned up after fast exit
        }
        return stderr.length > 0 ? 1 : 0;
      };

      const settle = (result: RuntimeExecResult) => {
        if (settled) {
          return;
        }
        settled = true;
        streamActive = false;
        if (pollInterval !== null) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
        resolve(result);
      };

      const settleWithStuckHandler = (result: RuntimeExecResult) => {
        if (settled) {
          return;
        }
        settle(onSessionStuck ? onSessionStuck(result) : result);
      };

      // Stream: primary completion signal
      void this.sandbox!.process.getSessionCommandLogs(
        sessionId,
        cmdId,
        (chunk: string) => {
          if (!streamActive) {
            return;
          }
          stdout += chunk;
          lastOutputAt = Date.now();
        },
        (chunk: string) => {
          if (!streamActive) {
            return;
          }
          stderr += chunk;
          lastOutputAt = Date.now();
        },
      )
        .then(async () => {
          if (settled) {
            return;
          }
          const exitCode = await fetchExitCode();
          settle({
            exitCode,
            stdout,
            stderr,
            fail: exitCode !== 0,
            execPath: fullWorkdir,
          });
        })
        .catch(() => {
          /* stream error on session kill — expected */
        });

      // Poll: safety net for fast-exiting commands whose WebSocket close is delayed.
      //
      // The Daytona toolbox only sets exitCode on the Command object after the log
      // stream WebSocket closes, but the follow=true WebSocket may never close for
      // fast-exiting commands (e.g. exit 127 — command not found). This creates a
      // deadlock: the WS waits for exitCode to be set, and exitCode is only set when
      // the WS closes.
      //
      // The snapshot fallback breaks this deadlock: after SNAPSHOT_FALLBACK_AFTER_MS
      // we periodically call the non-streaming log endpoint (plain HTTP GET). If it
      // returns any output the command has already run and buffered its output, so we
      // can merge the snapshot data into our accumulated output and settle immediately
      // using the exit code from getSessionCommand (or infer from stderr).
      pollInterval = setInterval(() => {
        if (settled) {
          return;
        }

        pollTick++;

        void (async () => {
          // Abort signal check
          if (params.signal?.aborted) {
            settleWithStuckHandler({
              exitCode: 124,
              stdout,
              stderr: 'Aborted',
              fail: true,
              execPath: fullWorkdir,
            });
            return;
          }

          const now = Date.now();

          // Idle timeout
          const idleMs = params.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
          if (now - lastOutputAt >= idleMs) {
            settleWithStuckHandler({
              exitCode: 124,
              stdout,
              stderr: `Idle timeout: no output for ${idleMs / 1000}s`,
              fail: true,
              execPath: fullWorkdir,
            });
            return;
          }

          // Hard timeout
          if (now - startAt >= hardMs) {
            settleWithStuckHandler({
              exitCode: 124,
              stdout,
              stderr: `Hard timeout: command exceeded ${hardMs / 1000}s`,
              fail: true,
              execPath: fullWorkdir,
            });
            return;
          }

          // Check command status via the live command endpoint
          let cmd: { exitCode?: number } | undefined;
          try {
            cmd = await this.sandbox!.process.getSessionCommand(
              sessionId,
              cmdId,
            );
          } catch {
            // 404: cmdId cleaned up — fast exit; infer from output
            settle({
              exitCode: stderr.length > 0 ? 1 : 0,
              stdout,
              stderr,
              fail: stderr.length > 0,
              execPath: fullWorkdir,
            });
            return;
          }

          if (cmd && typeof cmd.exitCode === 'number') {
            streamActive = false;
            settle({
              exitCode: cmd.exitCode,
              stdout,
              stderr,
              fail: cmd.exitCode !== 0,
              execPath: fullWorkdir,
            });
            return;
          }

          // Snapshot fallback: if exitCode is still undefined after the grace period
          // AND the WS stream has delivered zero output (indicating the WS is stuck
          // open rather than still streaming), fetch the buffered log snapshot via
          // plain HTTP GET (no streaming).
          //
          // When the Daytona toolbox keeps the follow=true WebSocket open indefinitely
          // for fast-exiting commands (e.g. exit 127 — command not found), the WS
          // delivers no data and never closes. The snapshot endpoint is a regular HTTP
          // GET that returns buffered output immediately. Non-empty snapshot output
          // means the command has already exited; settle using the snapshot data.
          //
          // The guard `stdout === '' && stderr === ''` ensures we only apply the
          // fallback when the WS stream has not delivered any data — avoiding false
          // positives for long-running commands that are actively streaming output.
          if (
            !params.signal?.aborted &&
            now - startAt >= SNAPSHOT_GRACE_MS &&
            pollTick % SNAPSHOT_EVERY_N_TICKS === 0 &&
            stdout === '' &&
            stderr === ''
          ) {
            try {
              const snapshot =
                await this.sandbox!.process.getSessionCommandLogs(
                  sessionId,
                  cmdId,
                );
              const snapStdout = snapshot?.stdout ?? '';
              const snapStderr = snapshot?.stderr ?? '';

              // Non-empty snapshot means the command ran and buffered output → it exited
              if (snapStdout || snapStderr) {
                // Re-fetch exit code. When getSessionCommand still returns undefined
                // (the server hasn't updated it yet), infer from the SNAPSHOT stderr
                // rather than the WS-accumulated stderr (which may be empty because
                // the WS was stuck open and never delivered any data).
                let exitCode: number;
                try {
                  const cmd = await this.sandbox!.process.getSessionCommand(
                    sessionId,
                    cmdId,
                  );
                  exitCode =
                    typeof cmd.exitCode === 'number'
                      ? cmd.exitCode
                      : snapStderr.length > 0
                        ? 1
                        : 0;
                } catch {
                  exitCode = snapStderr.length > 0 ? 1 : 0;
                }
                streamActive = false;
                settle({
                  exitCode,
                  stdout: snapStdout,
                  stderr: snapStderr,
                  fail: exitCode !== 0,
                  execPath: fullWorkdir,
                });
              }
            } catch {
              // Snapshot fetch failed — continue polling normally
            }
          }
        })();
      }, POLL_INTERVAL_MS);
    });
  }

  /**
   * Creates a sandbox with retry logic. If the first attempt times out
   * (likely stuck in pending_build — Daytona issue #3602), cleans up the
   * stuck sandbox and retries with a fresh name. Up to MAX_CREATE_RETRIES
   * total attempts.
   */
  private async createSandbox(
    commonParams: {
      name: string;
      envVars?: Record<string, string>;
      labels?: Record<string, string>;
      autoStopInterval: number;
    },
    snapshotOrImage: string,
  ): Promise<Sandbox> {
    const MAX_CREATE_RETRIES = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_CREATE_RETRIES; attempt++) {
      // Use original name on first attempt, fresh name on retries
      const name =
        attempt === 1 ? commonParams.name : `${commonParams.name}-r${attempt}`;
      const params = { ...commonParams, name };

      // For retry attempts, clean up any stale sandbox from a previous run
      if (attempt > 1) {
        await this.cleanupSandbox(name);
      }

      try {
        if (snapshotOrImage) {
          return await this.daytona!.create(
            { ...params, image: snapshotOrImage },
            { timeout: SANDBOX_CREATE_TIMEOUT_SECONDS },
          );
        }
        return await this.daytona!.create(params, {
          timeout: SANDBOX_CREATE_TIMEOUT_SECONDS,
        });
      } catch (err) {
        lastError = err;

        if (attempt < MAX_CREATE_RETRIES) {
          this.logger?.warn(
            `[DaytonaRuntime] Sandbox creation attempt ${attempt}/${MAX_CREATE_RETRIES} failed` +
              ` (name="${name}"). Cleaning up and retrying…`,
          );

          // Best-effort cleanup of the stuck sandbox
          await this.cleanupSandbox(name);
        }
      }
    }

    throw lastError;
  }

  /**
   * Best-effort deletion of a sandbox by name.
   * Used to clean up stuck sandboxes before retrying creation.
   */
  private async cleanupSandbox(name: string): Promise<void> {
    try {
      const sandbox = await this.daytona!.get(name);
      if (sandbox) {
        await this.daytona!.delete(sandbox).catch((e) => {
          this.logger?.warn(
            `[DaytonaRuntime] Failed to clean up sandbox "${name}": ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        });
      }
    } catch {
      // Not found — already cleaned up
    }
  }

  /**
   * Detects "pull access denied" errors that indicate a stale/missing
   * snapshot image in the runner's local Docker registry.
   */
  private isStaleSnapshotError(error: unknown): boolean {
    const msg = extractErrorMessage(error);
    return msg.includes('pull access denied');
  }

  /**
   * Extracts a Daytona snapshot name from a "pull access denied" error message.
   * Error format: "pull access denied for <snapshot-name>, repository..."
   */
  private extractSnapshotNameFromError(error: unknown): string | null {
    if (!error) {
      return null;
    }
    const msg = extractErrorMessage(error);
    const match = msg.match(/pull access denied for (\S+),/);
    return match?.[1] ?? null;
  }

  /**
   * Finds and deletes the cached Daytona snapshot built from the given image
   * so that the next sandbox creation triggers a fresh snapshot build.
   */
  private async invalidateStaleSnapshot(
    imageName: string,
    error?: unknown,
  ): Promise<void> {
    try {
      // Strategy 1: Extract snapshot name from error and delete directly
      const snapshotName = this.extractSnapshotNameFromError(error);
      if (snapshotName) {
        try {
          const directSnapshot = await this.daytona!.snapshot.get(snapshotName);
          if (directSnapshot) {
            this.logger?.log(
              `[DaytonaRuntime] Deleting stale snapshot "${snapshotName}" (direct match from error)`,
            );
            await this.daytona!.snapshot.delete(directSnapshot);
            return;
          }
        } catch {
          // Snapshot not found by name — fall through to list-based search
        }
      }

      // Strategy 2: Search by imageName or buildInfo in snapshot list
      const { items } = await this.daytona!.snapshot.list(1, 100);
      const stale = items.find(
        (s) =>
          s.imageName === imageName ||
          s.buildInfo?.dockerfileContent?.includes(`FROM ${imageName}`),
      );
      if (stale) {
        this.logger?.log(
          `[DaytonaRuntime] Deleting stale snapshot "${stale.name}" (id=${stale.id})`,
        );
        await this.daytona!.snapshot.delete(stale);
      } else {
        this.logger?.warn(
          `[DaytonaRuntime] No cached snapshot found for image "${imageName}" — ` +
            `retry will attempt to create from image directly`,
        );
      }
    } catch (err) {
      this.logger?.warn(
        `[DaytonaRuntime] Failed to invalidate stale snapshot: ${extractErrorMessage(err)}`,
      );
    }
  }

  private async recreateSession(sessionId: string): Promise<void> {
    this.activeSessions.delete(sessionId);
    try {
      await this.sandbox!.process.deleteSession(sessionId);
    } catch {
      // Session might already be gone
    }
    try {
      await this.sandbox!.process.createSession(sessionId);
      this.activeSessions.add(sessionId);
    } catch (error) {
      this.logger?.warn(
        `[DaytonaRuntime] Failed to recreate session "${sessionId}": ${extractErrorMessage(error)}`,
      );
    }
  }

  private static stripAnsi(str: string): string {
    /* eslint-disable no-control-regex */
    return str
      .replace(
        /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g,
        '',
      )
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
    /* eslint-enable no-control-regex */
  }

  public override async execStream(
    command: string[],
    options?: {
      workdir?: string;
      env?: Record<string, string>;
    },
  ): Promise<{
    stdin: Duplex;
    stdout: PassThrough;
    stderr: PassThrough;
    close: () => void;
  }> {
    if (!this.sandbox) {
      throw new Error('Runtime not started');
    }

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    const cwd = options?.workdir || this.workdir;
    const envPrefix = buildEnvPrefix(options?.env);
    const escapedArgs = command.map(shellEscape);
    const cmd = `${envPrefix}${escapedArgs.join(' ')}`;
    let accumulated = '';

    const ptyId = `pty-${randomUUID()}`;
    this.activeSessions.add(ptyId);
    const ptyHandle = await this.sandbox.process.createPty({
      id: ptyId,
      cwd,
      envs: { SHELL: '/bin/sh', TERM: 'xterm-256color', ...options?.env },
      cols: 220,
      rows: 50,
      onData: (data: Uint8Array) => {
        const text = new TextDecoder().decode(data);
        const stripped = DaytonaRuntime.stripAnsi(text);
        if (stripped) {
          accumulated += stripped;
          stdoutStream.write(stripped);
        }
      },
    });

    await ptyHandle.waitForConnection();

    // Send the command to the PTY shell
    await ptyHandle.sendInput(cmd + '\n');

    // Wait for completion in the background and handle exit
    void ptyHandle
      .wait()
      .then((result) => {
        const exitCode = result.exitCode ?? 0;
        if (exitCode !== 0 && accumulated) {
          stderrStream.write(accumulated);
        }
        stderrStream.end();
        stdoutStream.end();
      })
      .catch(() => {
        stderrStream.end();
        stdoutStream.end();
      });

    const stdinDuplex = new Duplex({
      write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ) {
        void ptyHandle
          .sendInput(chunk.toString())
          .then(() => callback())
          .catch((err: Error) => callback(err));
      },
      read() {
        // No-op — stdin is write-only from the caller's perspective
      },
    });

    const close = () => {
      this.activeSessions.delete(ptyId);
      void ptyHandle
        .kill()
        .catch(() => {})
        .then(() => ptyHandle.disconnect());
    };

    return {
      stdin: stdinDuplex,
      stdout: stdoutStream,
      stderr: stderrStream,
      close,
    };
  }
}
