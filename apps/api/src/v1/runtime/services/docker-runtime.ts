import { randomUUID } from 'node:crypto';
import { Duplex, PassThrough } from 'node:stream';

import { BadRequestException, extractErrorMessage } from '@packages/common';
import Docker from 'dockerode';

import { environment } from '../../../environments';
import {
  type RuntimeExecParams,
  type RuntimeExecResult,
  RuntimeStartingPhase,
  type RuntimeStartParams,
} from '../runtime.types';
import { buildEnvPrefix } from '../runtime.utils';
import { BaseRuntime } from './base-runtime';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Minimal logger interface accepted by DockerRuntime. */
export interface DockerRuntimeLogger {
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string | Error, message?: string, ...args: unknown[]): void;
}

type ShellSession = {
  id: string;
  exec: Docker.Exec;
  inputStream: Duplex;
  stdoutStream: PassThrough;
  stderrStream: PassThrough;
  stdoutBuffer: string;
  stderrBuffer: string;
  queue: SessionCommand[];
  busy: boolean;
  workdir: string;
  env?: string[];
};

type SessionCommand = {
  script: string;
  workdir: string;
  timeoutMs?: number;
  tailTimeoutMs?: number;
  signal?: AbortSignal;
  resolve: (res: RuntimeExecResult) => void;
  reject: (err: Error) => void;
};

/**
 * DockerRuntime using dockerode
 *
 * Each instance manages exactly one container lifecycle: start -> exec (any number) -> stop.
 * It respects standard Docker environment configuration (DOCKER_HOST, DOCKER_CERT_PATH, etc.).
 * For Podman, ensure the Docker-compatible socket is exposed and set via DOCKER_HOST.
 */
export class DockerRuntime extends BaseRuntime {
  private docker: Docker;
  private image?: string;
  private container: Docker.Container | null = null;
  private containerWorkdir: string | null = null;
  // Stored during start() so stop() can remove the per-runtime bridge network.
  private networkName: string | null = null;
  private sessions = new Map<string, ShellSession>();
  private logger?: DockerRuntimeLogger;

  constructor(
    dockerOptions?: Docker.DockerOptions,
    params?: { image?: string; logger?: DockerRuntimeLogger },
  ) {
    super();
    this.docker = new Docker(dockerOptions);
    this.image = params?.image;
    this.logger = params?.logger;
  }

  static async getByName(
    name: string,
    dockerOptions?: Docker.DockerOptions,
  ): Promise<Docker.Container | null> {
    return DockerRuntime.findContainerByName(new Docker(dockerOptions), name);
  }

  private static async findContainerByName(
    docker: Docker,
    name: string,
  ): Promise<Docker.Container | null> {
    try {
      const list = await docker.listContainers({
        all: true,
        filters: { name: [name] },
      });

      const exact = list.filter((c) =>
        c.Names?.some((n) => n.replace(/^\//, '') === name),
      );

      if (!exact[0]) {
        return null;
      }

      return docker.getContainer(exact[0].Id);
    } catch {
      return null;
    }
  }

  static async stopByName(
    name: string,
    dockerOptions?: Docker.DockerOptions,
  ): Promise<void> {
    const container = await DockerRuntime.getByName(name, dockerOptions);
    if (!container) {
      return;
    }

    await DockerRuntime.stopByInstance(container);
  }

  private dropSession(sessionId: string, _reason?: Error) {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return;
    }

    this.sessions.delete(sessionId);

    s.inputStream.removeAllListeners();
    s.stdoutStream.removeAllListeners();
    s.stderrStream.removeAllListeners();

    try {
      s.inputStream.destroy();
      s.stdoutStream.destroy();
      s.stderrStream.destroy();
    } catch {
      // Ignore errors during cleanup
    }
  }

  private async restartSession(
    sessionId: string,
    workdir: string,
    env: string[] | undefined,
    pending: SessionCommand[],
    reason: Error,
  ) {
    this.logger?.warn(
      `[DockerRuntime] Restarting session "${sessionId}" due to: ${reason.message}` +
        (pending.length ? ` (${pending.length} pending commands)` : ''),
    );
    this.dropSession(sessionId, reason);
    try {
      const s = await this.ensureSession(sessionId, workdir, env);
      for (const c of pending) {
        this.enqueueSessionCommand(s, c);
      }
      void this.processSessionQueue(s);
    } catch (restartError) {
      // Session restart failed — reject all pending commands so callers
      // are not left hanging indefinitely.
      const err =
        restartError instanceof Error
          ? restartError
          : new Error(String(restartError));
      this.logger?.error(
        `[DockerRuntime] Failed to restart session "${sessionId}": ${err.message}` +
          ` — rejecting ${pending.length} pending command(s)`,
      );
      for (const c of pending) {
        c.reject(err);
      }
    }
  }

  private async ensureImage(name: string) {
    const ref = name.includes(':') ? name : `${name}:latest`;
    try {
      await this.docker.getImage(ref).inspect();
    } catch {
      const stream = await this.docker.pull(ref);
      await new Promise<void>((res, rej) =>
        this.docker.modem.followProgress(
          stream,
          (err: Error | null | undefined) => (err ? rej(err) : res()),
        ),
      );
    }
    return this.docker.getImage(ref);
  }

  private prepareEnv(env?: Record<string, string>) {
    return env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined;
  }

  private async ensureSession(
    sessionId: string,
    workdir: string,
    env?: string[],
  ): Promise<ShellSession> {
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.inputStream.destroyed) {
      return existing;
    }

    if (existing?.inputStream.destroyed) {
      this.dropSession(sessionId, new Error('SESSION_STREAM_DESTROYED'));
    }

    if (!this.container) {
      throw new Error('Runtime not started');
    }

    const exec = await this.container.exec({
      Cmd: ['/bin/sh'],
      Env: env,
      WorkingDir: workdir,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: true,
      Tty: false,
    });

    const stream = (await exec.start({
      hijack: true,
      stdin: true,
    })) as unknown as Duplex;

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    this.docker.modem.demuxStream(stream, stdoutStream, stderrStream);

    const session: ShellSession = {
      id: sessionId,
      exec,
      inputStream: stream,
      stdoutStream,
      stderrStream,
      stdoutBuffer: '',
      stderrBuffer: '',
      queue: [],
      busy: false,
      workdir,
      env,
    };

    // Put streams into flowing mode so Docker's demuxed data is consumed
    // even when no command is in-flight (prevents backpressure stalling).
    stdoutStream.resume();
    stderrStream.resume();

    const cleanup = () => {
      // When a command is in-flight (busy === true), the command-level
      // closeListener already handles cleanup and session restart.
      // Running session-level cleanup here would race: it deletes the session
      // from the Map and destroys streams before finishWithRestart can
      // complete, causing orphaned pending commands.
      if (session.busy) {
        return;
      }

      this.sessions.delete(sessionId);
      try {
        stream.removeAllListeners();
        stdoutStream.removeAllListeners();
        stderrStream.removeAllListeners();
      } catch {
        //
      }
    };

    stream.on('error', cleanup);
    stream.on('end', cleanup);
    stream.on('close', cleanup);

    this.sessions.set(sessionId, session);
    return session;
  }

  private enqueueSessionCommand(session: ShellSession, cmd: SessionCommand) {
    session.queue.push(cmd);
    void this.processSessionQueue(session);
  }

  private async processSessionQueue(session: ShellSession) {
    if (session.busy) {
      return;
    }

    const next = session.queue.shift();
    if (!next) {
      return;
    }

    session.busy = true;

    try {
      const marker = randomUUID();
      const endToken = `__AI_END_${marker}__`;
      const stderrEndToken = `__AI_END_ERR_${marker}__`;
      // Use newlines instead of semicolons to support heredocs (<<EOF syntax)
      // Semicolons would break heredoc closing delimiters that must be on their own line
      const wrappedScript = [
        next.script,
        `printf "\\n${endToken}:%s\\n" $?`,
        `printf "\\n${stderrEndToken}\\n" 1>&2`,
      ].join('\n');

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let finished = false;
      let tailTimer: NodeJS.Timeout | null = null;
      let abortListener: (() => void) | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let closeListener: (() => void) | null = null;

      let stdoutDone = false;
      let stderrDone = false;
      let exitCode: number | null = null;
      let stdoutContent: string | null = null;
      let hasReceivedOutput = false;

      const sid = session.id;
      const sEnv = session.env;

      const cleanupListeners = () => {
        session.stdoutStream.off('data', onStdoutData);
        session.stderrStream.off('data', onStderrData);
        session.inputStream.off('error', onError);
        if (closeListener) {
          session.inputStream.off('close', closeListener);
          session.inputStream.off('end', closeListener);
          closeListener = null;
        }
        if (abortListener) {
          abortListener();
          abortListener = null;
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (tailTimer) {
          clearTimeout(tailTimer);
          tailTimer = null;
        }
      };

      const finishWithRestart = (res: RuntimeExecResult, reason: Error) => {
        if (finished) {
          return;
        }
        finished = true;
        cleanupListeners();
        const pending = session.queue.splice(0);
        session.busy = false;
        // Resolve the caller immediately — don't block on session restart.
        // The restart runs in the background so the caller gets its
        // timeout/abort/error result without waiting for a new shell.
        next.resolve(res);
        void this.restartSession(sid, next.workdir, sEnv, pending, reason);
      };

      const maybeResolve = () => {
        if (!stdoutDone || !stderrDone) {
          return;
        }
        if (finished) {
          return;
        }
        finished = true;
        cleanupListeners();
        next.resolve({
          exitCode: exitCode ?? 1,
          stdout: stdoutContent ?? '',
          stderr: stderrBuffer,
          fail: (exitCode ?? 1) !== 0,
          execPath: next.workdir,
        });
        session.busy = false;
        void this.processSessionQueue(session);
      };

      const resetTailTimer = () => {
        if (tailTimer) {
          clearTimeout(tailTimer);
        }
        // Only start tail timeout after first output is received
        // This prevents timeouts during legitimate silent periods (e.g., Python heredoc stdin reading)
        if (hasReceivedOutput && next.tailTimeoutMs && next.tailTimeoutMs > 0) {
          tailTimer = setTimeout(() => {
            finishWithRestart(
              {
                exitCode: 124,
                stdout: stdoutBuffer,
                stderr: stderrBuffer || 'Process timed out - no logs received',
                fail: true,
                execPath: next.workdir,
                timeout: next.tailTimeoutMs,
              },
              new Error('SESSION_TAIL_TIMEOUT'),
            );
          }, next.tailTimeoutMs).unref();
        }
      };

      const onStdoutData = (chunk: Buffer) => {
        hasReceivedOutput = true;
        resetTailTimer();
        stdoutBuffer = this.appendTail(stdoutBuffer, chunk, MAX_OUTPUT_BYTES);
        const endTokenWithColon = `${endToken}:`;
        const endIdx = stdoutBuffer.indexOf(endTokenWithColon);
        if (endIdx === -1) {
          return;
        }

        const exitStart = endIdx + endTokenWithColon.length;
        const exitLineEnd = stdoutBuffer.indexOf('\n', exitStart);
        const exitData =
          exitLineEnd === -1
            ? stdoutBuffer.slice(exitStart)
            : stdoutBuffer.slice(exitStart, exitLineEnd);
        const parsed = Number.parseInt(exitData.trim() || '0', 10);
        exitCode = Number.isNaN(parsed) ? 1 : parsed;

        stdoutContent = stdoutBuffer.slice(0, endIdx);
        if (stdoutContent.endsWith('\n')) {
          stdoutContent = stdoutContent.slice(0, -1);
        }

        stdoutDone = true;
        maybeResolve();
      };

      const onStderrData = (chunk: Buffer) => {
        hasReceivedOutput = true;
        resetTailTimer();
        stderrBuffer = this.appendTail(stderrBuffer, chunk, MAX_OUTPUT_BYTES);
        const idx = stderrBuffer.indexOf(stderrEndToken);
        if (idx === -1) {
          return;
        }
        let cleaned = stderrBuffer.slice(0, idx);
        if (cleaned.endsWith('\n')) {
          cleaned = cleaned.slice(0, -1);
        }
        stderrBuffer = cleaned;
        stderrDone = true;
        maybeResolve();
      };

      const onError = (err: Error) => {
        if (finished) {
          return;
        }
        finishWithRestart(
          {
            exitCode: 124,
            stdout: stdoutBuffer,
            stderr: stderrBuffer || err.message,
            fail: true,
            execPath: next.workdir,
          },
          err,
        );
      };

      session.stdoutStream.on('data', onStdoutData);
      session.stderrStream.on('data', onStderrData);
      session.inputStream.on('error', onError);

      closeListener = () => onError(new Error('SESSION_CLOSED'));
      session.inputStream.on('close', closeListener);
      session.inputStream.on('end', closeListener);

      if (next.timeoutMs && next.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          finishWithRestart(
            {
              exitCode: 124,
              stdout: stdoutBuffer,
              stderr: stderrBuffer || 'Process timed out',
              fail: true,
              execPath: next.workdir,
              timeout: next.timeoutMs,
            },
            new Error('SESSION_TIMEOUT'),
          );
        }, next.timeoutMs).unref();
      }

      resetTailTimer();

      const abortNow = () => {
        finishWithRestart(
          {
            exitCode: 124,
            stdout: stdoutBuffer,
            stderr: stderrBuffer || 'Aborted',
            fail: true,
            execPath: next.workdir,
          },
          new Error('ABORTED'),
        );
      };

      if (next.signal) {
        if (next.signal.aborted) {
          abortNow();
          return;
        }

        const onAbort = () => abortNow();
        next.signal.addEventListener('abort', onAbort, { once: true });
        abortListener = () => {
          try {
            next.signal?.removeEventListener('abort', onAbort);
          } catch {
            //
          }
        };
      }

      session.inputStream.write(`${wrappedScript}\n`);
    } catch (error) {
      session.busy = false;
      const pending = session.queue.splice(0);
      next.reject(error as Error);
      void this.restartSession(
        session.id,
        next.workdir,
        session.env,
        pending,
        error as Error,
      );
    }
  }

  private async getByName(name: string): Promise<Docker.Container | null> {
    return DockerRuntime.findContainerByName(this.docker, name);
  }

  private async ensureNetwork(networkName: string): Promise<void> {
    try {
      const networks = await this.docker.listNetworks({
        filters: { name: [networkName] },
      });

      if (networks.length > 0) {
        return;
      }

      await this.docker.createNetwork({
        Name: networkName,
        Driver: 'bridge',
        Labels: {
          'geniro/managed': 'true',
          'geniro/created-by': 'docker-runtime',
        },
      });
    } catch (error) {
      // Race: parallel runtimes/test workers can list-empty then both call
      // createNetwork. The loser gets HTTP 409 "already exists" — the network
      // now exists, which is the post-condition we wanted, so accept it.
      const errorMessage = extractErrorMessage(error);
      if (
        errorMessage.includes('already exists') ||
        errorMessage.includes('409')
      ) {
        return;
      }
      throw new Error(`Failed to create network ${networkName}: ${error}`, {
        cause: error,
      });
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
    for (const cmd of cmds) {
      const res = await this.exec({
        cmd,
        env,
        timeoutMs: timeoutMs ?? 10 * 60_000,
      });
      if (res.fail) {
        throw new Error(`Init failed: ${res.stderr || res.stdout}`);
      }
    }
  }

  private async createContainerWithRetry(
    containerName: string,
    createFn: () => Promise<Docker.Container>,
  ): Promise<Docker.Container> {
    try {
      return await createFn();
    } catch (error) {
      const errorMessage = extractErrorMessage(error);
      if (
        errorMessage.includes('already in use') ||
        errorMessage.includes('name is already')
      ) {
        const conflictContainer = await this.getByName(containerName);
        if (conflictContainer) {
          await DockerRuntime.stopByInstance(conflictContainer);
        }

        return await createFn();
      }

      throw error;
    }
  }

  async start(params?: RuntimeStartParams): Promise<void> {
    if (this.container) {
      return;
    }

    const imageName =
      params?.image || this.image || environment.dockerRuntimeImage;
    if (!imageName) {
      throw new BadRequestException(
        'IMAGE_NOT_SPECIFIED',
        'Image not specified',
      );
    }
    this.image = imageName;

    const containerName = params?.containerName || `rt-${randomUUID()}`;
    const existingContainer = await this.getByName(containerName);

    if (existingContainer && !params?.recreate) {
      const inspect = await existingContainer.inspect();
      if (!inspect.State.Running) {
        await existingContainer.start();
      }

      this.container = existingContainer;
      this.containerWorkdir = this.getWorkdir(params?.workdir);

      this.emit({
        type: 'start',
        data: { params: params || {} },
      });

      return;
    }

    if (existingContainer && params?.recreate) {
      await DockerRuntime.stopByInstance(existingContainer);
    }

    this.emit({
      type: 'phase',
      data: { phase: RuntimeStartingPhase.PullingImage },
    });
    await this.ensureImage(imageName);
    const cmd = ['sh', '-lc', 'while :; do sleep 2147483; done'];

    const networkName = params?.network || 'geniro-runtime';
    await this.ensureNetwork(networkName);
    this.networkName = networkName;

    let containerEnv = params?.env || {};

    if (params?.registryMirrors?.length) {
      containerEnv = {
        ...containerEnv,
        DOCKER_REGISTRY_MIRRORS: params.registryMirrors.join(','),
      };
    }

    if (params?.insecureRegistries?.length) {
      containerEnv = {
        ...containerEnv,
        DOCKER_INSECURE_REGISTRIES: params.insecureRegistries.join(','),
      };
    }

    if (!('DOCKER_HOST' in containerEnv)) {
      containerEnv = {
        ...containerEnv,
        DOCKER_HOST: 'unix:///var/run/docker.sock',
      };
    }

    const env = this.prepareEnv(containerEnv);

    const hostConfig: Docker.HostConfig = {
      NetworkMode: networkName,
      AutoRemove: true,
      // Privileged mode is required because runtime containers may need to run
      // Docker-in-Docker (e.g., building images, spawning nested containers)
      // and access host devices.
      Privileged: true,
      // Sandbox workloads (e.g. the Claude Agent bridge) reach host-published
      // services (LiteLLM) via host.docker.internal on every Docker backend.
      ExtraHosts: ['host.docker.internal:host-gateway'],
    };

    try {
      const container = await this.createContainerWithRetry(
        containerName,
        async () => {
          return await this.docker.createContainer({
            Image: imageName,
            name: containerName,
            Env: env,
            WorkingDir: this.getWorkdir(params?.workdir),
            Cmd: cmd,
            Labels: { 'geniro.io/type': 'runtime', ...(params?.labels ?? {}) },
            Tty: false,
            AttachStdin: false,
            AttachStdout: false,
            AttachStderr: false,
            OpenStdin: false,
            HostConfig: hostConfig,
          });
        },
      );

      await container.start();
      this.container = container;
      this.containerWorkdir = this.getWorkdir(params?.workdir);

      this.emit({
        type: 'phase',
        data: { phase: RuntimeStartingPhase.ContainerCreated },
      });

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

  async stop(): Promise<void> {
    try {
      if (!this.container) {
        return;
      }

      // Reject all pending/in-flight session commands before tearing down the
      // container.  Without this, callers whose promises are still waiting in
      // a session queue would hang indefinitely.
      const stopError = new Error('Runtime stopped');
      for (const session of this.sessions.values()) {
        for (const cmd of session.queue) {
          cmd.reject(stopError);
        }
        session.queue.length = 0;
      }

      const stoppedNetworkName = this.networkName;
      await DockerRuntime.stopByInstance(this.container);
      this.container = null;
      this.containerWorkdir = null;
      this.networkName = null;
      this.sessions.clear();

      if (stoppedNetworkName) {
        await DockerRuntime.removeNetworkIfManaged(
          this.docker,
          stoppedNetworkName,
        );
      }

      this.emit({ type: 'stop', data: {} });
    } catch (error) {
      this.emit({ type: 'stop', data: { error } });
      throw error;
    }
  }

  static async stopByInstance(container: Docker.Container): Promise<void> {
    await container.stop({ t: 10 }).catch(() => undefined);
    await container.remove({ force: true }).catch(() => undefined);
  }

  /**
   * Remove a bridge network if it was created by DockerRuntime and has no
   * remaining containers attached. Skips the shared default network
   * ('geniro-runtime') to avoid breaking concurrently running runtimes.
   */
  private static async removeNetworkIfManaged(
    docker: Docker,
    networkName: string,
  ): Promise<void> {
    if (networkName === 'geniro-runtime') {
      return;
    }

    let networks: Docker.NetworkInspectInfo[];
    try {
      networks = await docker.listNetworks({
        filters: { name: [networkName] },
      });
    } catch {
      return;
    }

    const network = networks.find((n) => n.Name === networkName);
    if (!network) {
      return;
    }

    const isManaged =
      network.Labels?.['geniro/managed'] === 'true' &&
      network.Labels?.['geniro/created-by'] === 'docker-runtime';
    if (!isManaged) {
      return;
    }

    const hasContainers =
      network.Containers !== undefined &&
      Object.keys(network.Containers).length > 0;
    if (hasContainers) {
      return;
    }

    try {
      await docker.getNetwork(network.Id).remove();
    } catch {
      // best-effort: another runtime may have already removed it
    }
  }

  async exec(params: RuntimeExecParams): Promise<RuntimeExecResult> {
    if (!this.container) {
      throw new Error('Runtime not started');
    }

    const fullWorkdir = this.containerWorkdir || this.workdir;

    const env = this.prepareEnv(params.env);

    if (params.sessionId) {
      try {
        return await this.execInSession(params, fullWorkdir, env);
      } catch (error) {
        return {
          exitCode: 124,
          stdout: '',
          stderr: extractErrorMessage(error),
          fail: true,
          execPath: fullWorkdir,
        };
      }
    }

    const execId = randomUUID();

    // Prepare command with optional cwd prefix
    let cmdString: string;
    if (Array.isArray(params.cmd)) {
      cmdString = params.cmd.join(' && ');
    } else {
      cmdString = params.cmd;
    }

    // If cwd is provided, prepend cd command
    if (params.cwd) {
      cmdString = `cd ${JSON.stringify(params.cwd)} && ${cmdString}`;
    }

    const cmd = ['sh', '-lc', cmdString];
    const abortController = new AbortController();

    if (params.signal) {
      if (params.signal.aborted) {
        abortController.abort();
      } else {
        params.signal.addEventListener(
          'abort',
          () => {
            try {
              abortController.abort();
            } catch {
              //
            }
          },
          { once: true },
        );
      }
    }

    const ex = await this.container.exec({
      Cmd: cmd,
      Env: env,
      WorkingDir: fullWorkdir,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      abortSignal: abortController.signal,
    });

    this.emit({
      type: 'execStart',
      data: { execId, params },
    });

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    let stdoutBuf = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
    let stderrBuf = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
    let hasReceivedOutput = false;

    stdoutStream.on('data', (c: Buffer) => {
      stdoutBuf = this.appendTail(
        stdoutBuf,
        c as Buffer<ArrayBufferLike>,
        MAX_OUTPUT_BYTES,
      );
    });
    stderrStream.on('data', (c: Buffer) => {
      stderrBuf = this.appendTail(
        stderrBuf,
        c as Buffer<ArrayBufferLike>,
        MAX_OUTPUT_BYTES,
      );
    });

    const execStream = await ex.start({ hijack: true, stdin: false });
    this.docker.modem.demuxStream(execStream, stdoutStream, stderrStream);

    let timedOut = false;
    let tailTimedOut = false;
    let overallTimer: NodeJS.Timeout | null = null;
    let tailTimer: NodeJS.Timeout | null = null;

    const resetTailTimer = () => {
      if (tailTimer) {
        clearTimeout(tailTimer);
      }

      // Only start tail timeout after first output is received
      // This prevents timeouts during legitimate silent periods (e.g., Python heredoc stdin reading)
      if (
        hasReceivedOutput &&
        params.tailTimeoutMs &&
        params.tailTimeoutMs > 0
      ) {
        tailTimer = setTimeout(() => {
          tailTimedOut = true;
          try {
            execStream.destroy(
              new Error('Process timed out - no logs received'),
            );
          } catch {
            //
          }
        }, params.tailTimeoutMs).unref();
      }
    };

    const onData = () => {
      hasReceivedOutput = true;
      resetTailTimer();
    };

    stdoutStream.on('data', onData);
    stderrStream.on('data', onData);

    const cleanup = () => {
      if (overallTimer) {
        clearTimeout(overallTimer);
      }
      if (tailTimer) {
        clearTimeout(tailTimer);
      }
      stdoutStream.removeListener('data', onData);
      stderrStream.removeListener('data', onData);
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          cleanup();
          abortController.abort();
          resolve();
        };

        const fail = (e: Error) => {
          cleanup();
          abortController.abort();
          if (e.message.includes('Process timed out')) {
            resolve();
          } else {
            reject(e);
          }
        };

        execStream.on('end', done);
        execStream.on('close', done);
        execStream.on('error', fail);

        if (params.timeoutMs && params.timeoutMs > 0) {
          overallTimer = setTimeout(() => {
            timedOut = true;
            try {
              execStream.destroy(new Error('Process timed out'));
            } catch {
              //
            }
          }, params.timeoutMs).unref();
        }

        resetTailTimer();
      });

      const info = await ex.inspect();
      const exitCode = timedOut || tailTimedOut ? 124 : info.ExitCode || 0;
      const stdout = stdoutBuf.toString('utf8');
      const stderr = stderrBuf.toString('utf8');

      const result: RuntimeExecResult = {
        exitCode,
        stdout,
        stderr,
        fail: exitCode !== 0,
        execPath: fullWorkdir,
      };

      this.emit({
        type: 'execEnd',
        data: { execId, params, result },
      });

      return result;
    } catch (error) {
      cleanup();

      this.emit({
        type: 'execEnd',
        data: { execId, params, error },
      });

      throw error;
    }
  }

  private async execInSession(
    params: RuntimeExecParams,
    workdir: string,
    env?: string[],
  ): Promise<RuntimeExecResult> {
    const sessionId = params.sessionId as string;
    const session = await this.ensureSession(sessionId, workdir, env);
    const envPrefix = buildEnvPrefix(params.env);
    let userCmd = Array.isArray(params.cmd)
      ? params.cmd.join(' && ')
      : params.cmd;

    // If cwd is provided, prepend cd command
    if (params.cwd) {
      userCmd = `cd ${JSON.stringify(params.cwd)} && ${userCmd}`;
    }

    const script = `${envPrefix}${userCmd || ':'}`;

    return await new Promise<RuntimeExecResult>((resolve, reject) => {
      this.enqueueSessionCommand(session, {
        script,
        workdir,
        timeoutMs: params.timeoutMs,
        tailTimeoutMs: params.tailTimeoutMs,
        signal: params.signal,
        resolve,
        reject,
      });
    });
  }

  /**
   * Execute command with persistent streams for real-time communication
   * Returns properly demultiplexed stdin/stdout/stderr streams
   * Uses docker.modem.demuxStream to handle Docker's 8-byte header format
   *
   * @param command - Command and arguments as array
   * @param options - Optional execution options (workdir, env)
   * @returns Promise with stdin/stdout/stderr streams and close function
   */
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
    if (!this.container) {
      throw new Error('Runtime not started');
    }

    const workdir = options?.workdir || this.containerWorkdir || this.workdir;
    const env = this.prepareEnv(options?.env);

    const exec = await this.container.exec({
      Cmd: command,
      Env: env,
      WorkingDir: workdir,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: true,
      Tty: false,
    });

    const stream = (await exec.start({
      hijack: true,
      stdin: true,
    })) as unknown as Duplex;

    const stdout = new PassThrough();
    const stderr = new PassThrough();

    // Use dockerode's native demuxStream - handles 8-byte header format correctly
    this.docker.modem.demuxStream(stream, stdout, stderr);

    // demuxStream only write()s into the targets and never end()s them, so
    // without explicit propagation a consumer of `stdout` cannot observe the
    // exec process dying (OOM-kill, container removal) and waits forever.
    // Mirrors K8sRuntime, which ends its PassThroughs in the status callback.
    const propagateEnd = () => {
      // end() on a destroyed stream emits ERR_STREAM_DESTROYED — close()
      // destroys all three streams before the raw stream's 'close' fires.
      if (!stdout.destroyed) {
        stdout.end();
      }
      if (!stderr.destroyed) {
        stderr.end();
      }
    };
    stream.on('end', propagateEnd);
    stream.on('close', propagateEnd);

    return {
      stdin: stream,
      stdout,
      stderr,
      close: () => {
        try {
          stream.destroy();
          stdout.destroy();
          stderr.destroy();
        } catch {
          // Ignore cleanup errors
        }
      },
    };
  }
}
