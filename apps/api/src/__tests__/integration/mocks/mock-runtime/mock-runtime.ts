import { Duplex, PassThrough } from 'node:stream';

import {
  RuntimeExecParams,
  RuntimeExecResult,
  RuntimeStartingPhase,
  RuntimeStartParams,
} from '../../../../v1/runtime/runtime.types';
import {
  BaseRuntime,
  RuntimeEvent,
} from '../../../../v1/runtime/services/base-runtime';
import { MockRuntimeService } from './mock-runtime.service';

/**
 * In-process `BaseRuntime` for integration tests.
 *
 * - `start()` / `stop()` flip an internal flag and emit phase events so the
 *   `RuntimeProvider` lifecycle plumbing (status transitions, notifications)
 *   exercises its real code paths without spinning a container.
 * - `exec()` delegates to `MockRuntimeService.resolveExec` — fixtures + a
 *   handful of built-in fallbacks (cat /etc/hostname, echo) handle the
 *   commands tests actually issue.
 * - `execStream()` returns idle pipes that close immediately; tests that
 *   actually want streaming output should use a real runtime instead.
 *
 * Each instance gets a fresh hostname (allocated by the manager) — this is
 * how revision tests observe "container was recreated".
 */
export class MockRuntime extends BaseRuntime {
  private readonly hostname: string;
  private started = false;
  private startParams?: RuntimeStartParams;

  constructor(private readonly mockService: MockRuntimeService) {
    super();
    this.hostname = mockService.allocateHostname();
  }

  public getHostname(): string {
    return this.hostname;
  }

  public override async start(params: RuntimeStartParams): Promise<void> {
    this.startParams = params;
    this.emitPhase(RuntimeStartingPhase.PullingImage);
    this.emitPhase(RuntimeStartingPhase.ContainerCreated);
    this.emitPhase(RuntimeStartingPhase.InitScript);
    this.emitPhase(RuntimeStartingPhase.Ready);
    this.started = true;
    this.emitEvent({ type: 'start', data: { params } });
  }

  public override async stop(): Promise<void> {
    this.started = false;
    this.emitEvent({ type: 'stop', data: {} });
  }

  public override async exec(
    params: RuntimeExecParams,
  ): Promise<RuntimeExecResult> {
    if (!this.started) {
      return {
        fail: true,
        exitCode: 125,
        stdout: '',
        stderr: 'MockRuntime: exec called before start',
        execPath: 'mock',
      };
    }

    if (params.signal?.aborted) {
      return {
        fail: true,
        exitCode: 124,
        stdout: '',
        stderr: 'Aborted',
        execPath: 'mock',
      };
    }

    const cmdString = Array.isArray(params.cmd)
      ? params.cmd.join(' ')
      : params.cmd;
    const fullCmd = params.cwd ? `cd ${params.cwd} && ${cmdString}` : cmdString;

    const result = this.mockService.resolveExec({
      cmd: params.cmd,
      cmdString: fullCmd,
      cwd: params.cwd,
      env: { ...this.startParams?.env, ...params.env },
      runtimeHostname: this.hostname,
    });

    if ('__hangUntilAbort' in result && result.__hangUntilAbort) {
      // Fixture asked to hang until aborted. Mirror DockerRuntime semantics:
      // resolve with exitCode=124 + stderr="Aborted" when the signal fires.
      // If no signal is provided we still hang — caller bug, surfaces fast.
      return await new Promise<RuntimeExecResult>((resolve) => {
        const onAbort = () => {
          resolve({
            fail: true,
            exitCode: 124,
            stdout: '',
            stderr: 'Aborted',
            execPath: 'mock',
          });
        };
        if (params.signal) {
          params.signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    return result as RuntimeExecResult;
  }

  public override async execStream(
    _command: string[],
    _options?: { workdir?: string; env?: Record<string, string> },
  ): Promise<{
    stdin: Duplex;
    stdout: PassThrough;
    stderr: PassThrough;
    close: () => void;
  }> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    setImmediate(() => {
      stdout.end();
      stderr.end();
    });
    return {
      stdin,
      stdout,
      stderr,
      close: () => {
        stdin.destroy();
        stdout.destroy();
        stderr.destroy();
      },
    };
  }

  private emitPhase(phase: RuntimeStartingPhase): void {
    this.emitEvent({ type: 'phase', data: { phase } });
  }

  private emitEvent(event: RuntimeEvent): void {
    // BaseRuntime.emit is protected; access via cast.
    (this as unknown as { emit: (e: RuntimeEvent) => void }).emit(event);
  }
}
