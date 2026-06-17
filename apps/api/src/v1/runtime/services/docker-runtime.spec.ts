import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DockerRuntime, type DockerRuntimeLogger } from './docker-runtime';

const mockResult = {
  exitCode: 0,
  stdout: 'ok',
  stderr: '',
  fail: false,
  execPath: '/runtime-workspace',
};

describe('DockerRuntime (sessions)', () => {
  let runtime: DockerRuntime;
  let runtimeSessionApi: {
    execInSession: DockerRuntime['execInSession'];
    enqueueSessionCommand: DockerRuntime['enqueueSessionCommand'];
    ensureSession: DockerRuntime['ensureSession'];
  };

  beforeEach(() => {
    runtime = new DockerRuntime({} as never);
    // Bypass the runtime-not-started guard; we stub execInSession, so no real container is needed.
    (runtime as unknown as { container: Record<string, unknown> }).container =
      {};
    runtimeSessionApi = runtime as unknown as typeof runtimeSessionApi;
  });

  it('routes sessionId exec calls through execInSession', async () => {
    const execInSession = vi
      .spyOn(runtimeSessionApi, 'execInSession')
      .mockResolvedValue(mockResult);

    const result = await runtime.exec({ cmd: 'echo 1', sessionId: 'sess-1' });

    expect(execInSession).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 'echo 1', sessionId: 'sess-1' }),
      '/runtime-workspace',
      undefined,
    );
    expect(result).toEqual(mockResult);
  });

  it('builds env-prefixed script for session execution', async () => {
    const enqueueSpy = vi
      .spyOn(runtimeSessionApi, 'enqueueSessionCommand')
      .mockImplementation((_session: unknown, command: any) => {
        command.resolve(mockResult);
      });

    vi.spyOn(runtimeSessionApi, 'ensureSession').mockResolvedValue({
      id: 'sess-env',
      workdir: '/runtime-workspace',
      exec: {} as never,
      inputStream: { write: vi.fn() } as never,
      stdoutStream: new PassThrough(),
      stderrStream: new PassThrough(),
      stdoutBuffer: '',
      stderrBuffer: '',
      queue: [],
      busy: false,
    });

    const result = await runtimeSessionApi.execInSession(
      { cmd: 'echo $FOO', sessionId: 'sess-env', env: { FOO: 'bar' } },
      '/runtime-workspace',
      ['FOO=bar'],
    );

    const [, commandArg] = enqueueSpy.mock.calls[0]!;
    expect(commandArg.script).toContain("FOO='bar'");
    expect(commandArg.script).toContain('echo $FOO');
    expect(result).toEqual(mockResult);
  });

  it('prepends cd command when cwd is provided in session execution', async () => {
    const enqueueSpy = vi
      .spyOn(runtimeSessionApi, 'enqueueSessionCommand')
      .mockImplementation((_session: unknown, command: any) => {
        command.resolve(mockResult);
      });

    vi.spyOn(runtimeSessionApi, 'ensureSession').mockResolvedValue({
      id: 'sess-cwd',
      workdir: '/runtime-workspace',
      exec: {} as never,
      inputStream: { write: vi.fn() } as never,
      stdoutStream: new PassThrough(),
      stderrStream: new PassThrough(),
      stdoutBuffer: '',
      stderrBuffer: '',
      queue: [],
      busy: false,
    });

    const result = await runtimeSessionApi.execInSession(
      { cmd: 'ls', sessionId: 'sess-cwd', cwd: '/app/src' },
      '/runtime-workspace',
    );

    const [, commandArg] = enqueueSpy.mock.calls[0]!;
    expect(commandArg.script).toContain('cd "/app/src"');
    expect(commandArg.script).toContain('ls');
    expect(result).toEqual(mockResult);
  });

  it('handles cwd with spaces and special characters in session execution', async () => {
    const enqueueSpy = vi
      .spyOn(runtimeSessionApi, 'enqueueSessionCommand')
      .mockImplementation((_session: unknown, command: any) => {
        command.resolve(mockResult);
      });

    vi.spyOn(runtimeSessionApi, 'ensureSession').mockResolvedValue({
      id: 'sess-cwd-special',
      workdir: '/runtime-workspace',
      exec: {} as never,
      inputStream: { write: vi.fn() } as never,
      stdoutStream: new PassThrough(),
      stderrStream: new PassThrough(),
      stdoutBuffer: '',
      stderrBuffer: '',
      queue: [],
      busy: false,
    });

    const result = await runtimeSessionApi.execInSession(
      { cmd: 'pwd', sessionId: 'sess-cwd-special', cwd: '/path with spaces' },
      '/runtime-workspace',
    );

    const [, commandArg] = enqueueSpy.mock.calls[0]!;
    expect(commandArg.script).toContain('cd "/path with spaces"');
    expect(result).toEqual(mockResult);
  });
});

describe('DockerRuntime (ensureNetwork)', () => {
  type EnsureNetwork = (networkName: string) => Promise<void>;

  const buildRuntime = (
    listNetworks: ReturnType<typeof vi.fn>,
    createNetwork: ReturnType<typeof vi.fn>,
  ) => {
    const runtime = new DockerRuntime({} as never);
    (
      runtime as unknown as {
        docker: { listNetworks: unknown; createNetwork: unknown };
      }
    ).docker = {
      listNetworks,
      createNetwork,
    };
    return runtime as unknown as { ensureNetwork: EnsureNetwork };
  };

  it('returns early when the network already exists in the list result', async () => {
    const listNetworks = vi.fn().mockResolvedValue([{ Id: 'n1' }]);
    const createNetwork = vi.fn();
    const runtime = buildRuntime(listNetworks, createNetwork);

    await expect(
      runtime.ensureNetwork('geniro-runtime'),
    ).resolves.toBeUndefined();
    expect(createNetwork).not.toHaveBeenCalled();
  });

  it('creates the network when listNetworks returns empty', async () => {
    const listNetworks = vi.fn().mockResolvedValue([]);
    const createNetwork = vi.fn().mockResolvedValue(undefined);
    const runtime = buildRuntime(listNetworks, createNetwork);

    await runtime.ensureNetwork('geniro-runtime');

    expect(createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ Name: 'geniro-runtime', Driver: 'bridge' }),
    );
  });

  it('treats the 409 "already exists" race as success', async () => {
    const listNetworks = vi.fn().mockResolvedValue([]);
    const createNetwork = vi
      .fn()
      .mockRejectedValue(
        new Error(
          '(HTTP code 409) unexpected - network with name geniro-runtime already exists',
        ),
      );
    const runtime = buildRuntime(listNetworks, createNetwork);

    await expect(
      runtime.ensureNetwork('geniro-runtime'),
    ).resolves.toBeUndefined();
  });

  it('rethrows non-conflict createNetwork errors with the wrapped message', async () => {
    const listNetworks = vi.fn().mockResolvedValue([]);
    const createNetwork = vi
      .fn()
      .mockRejectedValue(
        new Error('connect ECONNREFUSED /var/run/docker.sock'),
      );
    const runtime = buildRuntime(listNetworks, createNetwork);

    await expect(runtime.ensureNetwork('geniro-runtime')).rejects.toThrow(
      /Failed to create network geniro-runtime/,
    );
  });
});

describe('DockerRuntime (exec-readiness probe)', () => {
  type ProbeApi = {
    container: unknown;
    waitForExecReady: () => Promise<void>;
    probeExecReady: (container: unknown) => Promise<boolean>;
  };

  const buildRuntime = (logger?: {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  }) => {
    const runtime = new DockerRuntime(
      {} as never,
      logger ? { logger: logger as unknown as DockerRuntimeLogger } : undefined,
    );
    return runtime as unknown as ProbeApi;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns once a probe reports the container is exec-ready (no warning)', async () => {
    const warn = vi.fn();
    const runtime = buildRuntime({ warn, error: vi.fn() });
    runtime.container = {};
    const probe = vi.spyOn(runtime, 'probeExecReady').mockResolvedValue(true);
    // Date.now: deadline calc -> 0, then under-deadline so the loop runs once.
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(100);

    await expect(runtime.waitForExecReady()).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('retries until a probe succeeds', async () => {
    const warn = vi.fn();
    const runtime = buildRuntime({ warn, error: vi.fn() });
    runtime.container = {};
    const probe = vi
      .spyOn(runtime, 'probeExecReady')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(100);

    await expect(runtime.waitForExecReady()).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('proceeds without throwing and warns when the container never warms (best-effort floor)', async () => {
    const warn = vi.fn();
    const runtime = buildRuntime({ warn, error: vi.fn() });
    runtime.container = {};
    vi.spyOn(runtime, 'probeExecReady').mockRejectedValue(
      new Error('exec rejected'),
    );
    // deadline -> 0; first check enters (one attempt); second check is past it.
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(100)
      .mockReturnValue(20_000);

    await expect(runtime.waitForExecReady()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('exec-readiness probe did not succeed'),
      'exec rejected',
    );
  });

  it('is a no-op when no container is set', async () => {
    const warn = vi.fn();
    const runtime = buildRuntime({ warn, error: vi.fn() });
    runtime.container = null;
    const probe = vi.spyOn(runtime, 'probeExecReady');

    await expect(runtime.waitForExecReady()).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('probeExecReady maps exit code 0 to ready and non-zero to not-ready', async () => {
    const runtime = buildRuntime();
    const makeContainer = (exitCode: number) => ({
      exec: vi.fn().mockResolvedValue({
        start: vi.fn().mockImplementation(async () => {
          const stream = new PassThrough();
          stream.end();
          return stream;
        }),
        inspect: vi.fn().mockResolvedValue({ ExitCode: exitCode }),
      }),
    });

    await expect(runtime.probeExecReady(makeContainer(0))).resolves.toBe(true);
    await expect(runtime.probeExecReady(makeContainer(1))).resolves.toBe(false);
  });
});
