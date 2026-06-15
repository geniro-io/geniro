import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationEvent } from '../../notifications/notifications.types';
import { RuntimeInstanceEntity } from '../entity/runtime-instance.entity';
import { RuntimeInstanceStatus, RuntimeType } from '../runtime.types';
import { DaytonaRuntime } from './daytona-runtime';
import { DockerRuntime } from './docker-runtime';
import { RuntimeProvider } from './runtime-provider';

const mockSandbox = {
  id: 'sandbox-1',
  name: 'test-sandbox',
  state: 'started',
  process: {
    executeCommand: vi.fn(),
    createSession: vi.fn(),
    executeSessionCommand: vi.fn(),
    getSessionCommand: vi.fn(),
    getSessionCommandLogs: vi.fn(),
    sendSessionCommandInput: vi.fn(),
    deleteSession: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    createPty: vi.fn(),
  },
};

const mockDaytonaInstance = {
  create: vi.fn().mockResolvedValue(mockSandbox),
  get: vi.fn(),
  delete: vi.fn().mockResolvedValue(undefined),
  start: vi.fn().mockResolvedValue(undefined),
  snapshot: {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    get: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  },
};

vi.mock('@daytonaio/sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@daytonaio/sdk')>();

  const MockDaytona = vi.fn(function (this: typeof mockDaytonaInstance) {
    Object.assign(this, mockDaytonaInstance);
  }) as unknown as typeof original.Daytona;

  return {
    ...original,
    Daytona: MockDaytona,
  };
});

describe('DaytonaRuntime', () => {
  let runtime: DaytonaRuntime;

  beforeEach(() => {
    runtime = new DaytonaRuntime({
      apiKey: 'key',
      apiUrl: 'http://api',
      target: 'us',
    });
    // Inject sandbox directly to bypass start()
    (runtime as unknown as { sandbox: typeof mockSandbox }).sandbox =
      mockSandbox;

    // Reset mocks
    vi.clearAllMocks();
  });

  describe('exec()', () => {
    /** Set up mocks for one-shot synchronous execution (runAsync: false). */
    function setupOneShotMocks(overrides?: {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    }) {
      const exitCode = overrides?.exitCode ?? 0;
      const stdout = overrides?.stdout ?? '';
      const stderr = overrides?.stderr ?? '';

      mockSandbox.process.createSession.mockResolvedValue(undefined);
      mockSandbox.process.executeSessionCommand.mockResolvedValue({
        exitCode,
        stdout,
        stderr,
      });
      mockSandbox.process.deleteSession.mockResolvedValue(undefined);
    }

    it('routes through temporary session for one-shot execution', async () => {
      setupOneShotMocks({ stdout: 'hello' });

      const result = await runtime.exec({ cmd: 'echo hello' });

      expect(mockSandbox.process.createSession).toHaveBeenCalledWith(
        expect.stringMatching(/^oneshot-/),
      );
      expect(mockSandbox.process.executeSessionCommand).toHaveBeenCalledWith(
        expect.stringMatching(/^oneshot-/),
        expect.objectContaining({
          command: 'echo hello',
          runAsync: false,
        }),
        3600,
      );
      expect(mockSandbox.process.deleteSession).toHaveBeenCalledWith(
        expect.stringMatching(/^oneshot-/),
      );
      expect(result.fail).toBe(false);
      expect(result.exitCode).toBe(0);
    });

    it('prepends cd command when cwd is provided', async () => {
      setupOneShotMocks({ stdout: '/app/src' });

      const result = await runtime.exec({
        cmd: 'pwd',
        cwd: '/app/src',
      });

      expect(mockSandbox.process.executeSessionCommand).toHaveBeenCalledWith(
        expect.stringMatching(/^oneshot-/),
        expect.objectContaining({
          command: expect.stringContaining("cd '/app/src'"),
          runAsync: false,
        }),
        3600,
      );
      expect(result.fail).toBe(false);
    });

    it('passes env via buildEnvPrefix in one-shot execution', async () => {
      setupOneShotMocks({ stdout: 'ok' });

      const result = await runtime.exec({
        cmd: 'echo $FOO',
        env: { FOO: 'bar' },
      });

      expect(mockSandbox.process.executeSessionCommand).toHaveBeenCalledWith(
        expect.stringMatching(/^oneshot-/),
        expect.objectContaining({
          command: expect.stringContaining("export FOO='bar'"),
          runAsync: false,
        }),
        3600,
      );
      expect(result.fail).toBe(false);
      expect(result.exitCode).toBe(0);
    });

    it('returns non-zero exit code for failing one-shot commands', async () => {
      setupOneShotMocks({ exitCode: 1, stderr: 'command not found' });

      const result = await runtime.exec({ cmd: 'notacommand' });

      expect(result.fail).toBe(true);
      expect(result.exitCode).toBe(1);
    });

    it('fast command — returns exit code immediately with runAsync: false', async () => {
      setupOneShotMocks({ exitCode: 127, stderr: 'bun: not found' });

      const result = await runtime.exec({ cmd: 'bun install' });

      expect(result.fail).toBe(true);
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toBe('bun: not found');
      // No WS streaming involved
      expect(mockSandbox.process.getSessionCommandLogs).not.toHaveBeenCalled();
      expect(mockSandbox.process.getSessionCommand).not.toHaveBeenCalled();
    });

    it('command not found — returns exit code 127', async () => {
      setupOneShotMocks({
        exitCode: 127,
        stderr: 'bash: nonexistent_cmd: command not found',
      });

      const result = await runtime.exec({ cmd: 'nonexistent_cmd' });

      expect(result.exitCode).toBe(127);
      expect(result.fail).toBe(true);
      expect(result.stderr).toContain('command not found');
    });

    it('returns aborted result when abort signal fires during one-shot execution', async () => {
      const controller = new AbortController();

      mockSandbox.process.createSession.mockResolvedValue(undefined);
      mockSandbox.process.deleteSession.mockResolvedValue(undefined);
      // SDK call that never resolves (simulating a long-running command)
      mockSandbox.process.executeSessionCommand.mockReturnValue(
        new Promise(() => undefined),
      );

      controller.abort();

      const result = await runtime.exec({
        cmd: 'sleep 60',
        signal: controller.signal,
      });

      expect(result.fail).toBe(true);
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toBe('Aborted');
      expect(mockSandbox.process.deleteSession).toHaveBeenCalledWith(
        expect.stringMatching(/^oneshot-/),
      );
    });

    it('timeout — returns exit code 124 when SDK throws on timeout', async () => {
      mockSandbox.process.createSession.mockResolvedValue(undefined);
      mockSandbox.process.deleteSession.mockResolvedValue(undefined);
      mockSandbox.process.executeSessionCommand.mockRejectedValue(
        new Error('Request timeout'),
      );

      const result = await runtime.exec({
        cmd: 'sleep 999',
        timeoutMs: 5_000,
      });

      expect(result.fail).toBe(true);
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain('Request timeout');
    });
  });

  describe('session-based exec()', () => {
    /**
     * Set up mocks for synchronous session execution (runAsync: false).
     * The second executeSessionCommand call (the user command) returns the result directly.
     */
    function setupSyncSessionMocks(overrides?: {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    }) {
      const exitCode = overrides?.exitCode ?? 0;
      const stdout = overrides?.stdout ?? '';
      const stderr = overrides?.stderr ?? '';

      mockSandbox.process.createSession.mockResolvedValue(undefined);
      // First call: workdir init (runAsync: false) → void
      // Subsequent calls: user command (runAsync: false) → result
      let callCount = 0;
      mockSandbox.process.executeSessionCommand.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Workdir init
          return Promise.resolve({ exitCode: 0 });
        }
        return Promise.resolve({ exitCode, stdout, stderr });
      });
    }

    it('creates session on first call and routes through executeSessionCommand', async () => {
      setupSyncSessionMocks();

      const result = await runtime.exec({
        cmd: 'echo test',
        sessionId: 'sess-1',
      });

      expect(mockSandbox.process.createSession).toHaveBeenCalledWith('sess-1');
      expect(mockSandbox.process.executeSessionCommand).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({
          command: expect.any(String),
          runAsync: false,
        }),
        3600,
      );
      expect(result.fail).toBe(false);
      expect(result.exitCode).toBe(0);
    });

    it('does not recreate session on subsequent calls', async () => {
      setupSyncSessionMocks();

      await runtime.exec({ cmd: 'echo 1', sessionId: 'sess-reuse' });

      setupSyncSessionMocks();

      await runtime.exec({ cmd: 'echo 2', sessionId: 'sess-reuse' });

      expect(mockSandbox.process.createSession).toHaveBeenCalledTimes(1);
      // init (once on first creation) + echo 1 + echo 2 = 3
      expect(mockSandbox.process.executeSessionCommand).toHaveBeenCalledTimes(
        3,
      );
    });

    it('prepends cd command for cwd in session execution', async () => {
      setupSyncSessionMocks();

      await runtime.exec({
        cmd: 'ls',
        sessionId: 'sess-cwd',
        cwd: '/workspace',
      });

      expect(mockSandbox.process.executeSessionCommand).toHaveBeenCalledWith(
        'sess-cwd',
        expect.objectContaining({
          command: expect.stringContaining("cd '/workspace'"),
          runAsync: false,
        }),
        3600,
      );
    });

    describe('session workdir initialisation', () => {
      it('runs mkdir + cd to /runtime-workspace synchronously when session is created', async () => {
        setupSyncSessionMocks();

        await runtime.exec({
          cmd: 'echo test',
          sessionId: 'sess-init-cwd',
        });

        // First executeSessionCommand call must be the workdir init (runAsync: false)
        expect(
          mockSandbox.process.executeSessionCommand,
        ).toHaveBeenNthCalledWith(1, 'sess-init-cwd', {
          command: 'mkdir -p /runtime-workspace && cd /runtime-workspace',
          runAsync: false,
        });
        // Second call is the actual user command (runAsync: false), prefixed with set +eu
        expect(
          mockSandbox.process.executeSessionCommand,
        ).toHaveBeenNthCalledWith(
          2,
          'sess-init-cwd',
          expect.objectContaining({
            command: expect.stringContaining('echo test'),
            runAsync: false,
          }),
          3600,
        );
      });

      it('does not re-initialise CWD on session reuse', async () => {
        setupSyncSessionMocks();

        await runtime.exec({ cmd: 'cmd1', sessionId: 'sess-init-reuse' });

        setupSyncSessionMocks();

        await runtime.exec({ cmd: 'cmd2', sessionId: 'sess-init-reuse' });

        // createSession called only once — session reused
        expect(mockSandbox.process.createSession).toHaveBeenCalledTimes(1);
        // init (1) + cmd1 (1) + cmd2 (1) = 3 total
        expect(mockSandbox.process.executeSessionCommand).toHaveBeenCalledTimes(
          3,
        );
        // The init command was only sent once (the very first call)
        const initCalls =
          mockSandbox.process.executeSessionCommand.mock.calls.filter(
            (args: unknown[]) => {
              const opts = args[1] as { command: string };
              return opts.command.includes('mkdir -p /runtime-workspace');
            },
          );
        expect(initCalls).toHaveLength(1);
      });

      it('swallows workdir init failure and still executes the command', async () => {
        let callCount = 0;
        mockSandbox.process.createSession.mockResolvedValue(undefined);
        mockSandbox.process.executeSessionCommand.mockImplementation(
          (_sessionId: string, opts: { runAsync: boolean }) => {
            callCount++;
            if (callCount === 1 && !opts.runAsync) {
              // Init call fails
              return Promise.reject(new Error('init mkdir failed'));
            }
            return Promise.resolve({
              exitCode: 0,
              stdout: '',
              stderr: '',
            });
          },
        );

        const result = await runtime.exec({
          cmd: 'test',
          sessionId: 'sess-init-fail',
        });

        // Command succeeds despite init failure
        expect(result.fail).toBe(false);
        expect(result.exitCode).toBe(0);
        // Both init (failed) and real command were attempted
        expect(callCount).toBe(2);
      });
    });
  });

  describe('execStream() — session-API bridge transport', () => {
    function wireSessionLogs() {
      let onStdout: ((chunk: string) => void) | undefined;
      let onStderr: ((chunk: string) => void) | undefined;
      let resolveLogs: (() => void) | undefined;

      mockSandbox.process.createSession.mockResolvedValue(undefined);
      mockSandbox.process.executeSessionCommand.mockResolvedValue({
        cmdId: 'cmd-1',
      });
      mockSandbox.process.deleteSession.mockResolvedValue(undefined);
      mockSandbox.process.sendSessionCommandInput.mockResolvedValue(undefined);
      mockSandbox.process.getSessionCommandLogs.mockImplementation(
        (
          _sessionId: string,
          _cmdId: string,
          stdoutCb: (chunk: string) => void,
          stderrCb: (chunk: string) => void,
        ) => {
          onStdout = stdoutCb;
          onStderr = stderrCb;
          return new Promise<void>((resolve) => {
            resolveLogs = resolve;
          });
        },
      );

      return {
        emitStdout: (text: string) => onStdout?.(text),
        emitStderr: (text: string) => onStderr?.(text),
        endLogs: () => resolveLogs?.(),
        flush: () => new Promise<void>((r) => setImmediate(r)),
      };
    }

    it('throws when sandbox is not started', async () => {
      const unstartedRuntime = new DaytonaRuntime({
        apiKey: 'k',
        apiUrl: 'http://api',
        target: 'us',
      });
      await expect(unstartedRuntime.execStream(['ls'])).rejects.toThrow(
        'Runtime not started',
      );
    });

    it('runs an async session command (suppressInputEcho) with cwd prepended and streams stdout line-by-line — NOT a PTY', async () => {
      const logs = wireSessionLogs();

      const { stdin, stdout, stderr, close } = await runtime.execStream(
        ['node', 'bridge.mjs'],
        { workdir: '/ws' },
      );

      expect(mockSandbox.process.createPty).not.toHaveBeenCalled();
      expect(mockSandbox.process.executeSessionCommand).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ runAsync: true, suppressInputEcho: true }),
      );
      const command = (
        mockSandbox.process.executeSessionCommand.mock.calls[0]![1] as {
          command: string;
        }
      ).command;
      expect(command).toContain("cd '/ws' &&");
      expect(command).toContain("'node' 'bridge.mjs'");

      const chunks: string[] = [];
      stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
      logs.emitStdout('{"type":"ready"}\n{"type":"heartbeat"}\n');
      await logs.flush();

      expect(chunks.join('')).toBe('{"type":"ready"}\n{"type":"heartbeat"}\n');
      expect(stdin).toBeDefined();
      expect(stderr).toBeDefined();
      expect(close).toBeInstanceOf(Function);
    });

    it('strips an echoed stdin line from stdout while passing genuine events through (echo filter)', async () => {
      const logs = wireSessionLogs();

      const { stdin, stdout } = await runtime.execStream(['node', 'b.mjs']);
      const chunks: string[] = [];
      stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

      stdin.write('{"type":"interrupt"}\n');
      await logs.flush();

      // Daytona may echo the command we sent back on stdout; a genuine event
      // follows. Only the genuine event must reach the host.
      logs.emitStdout('{"type":"interrupt"}\n{"type":"aborted"}\n');
      await logs.flush();

      expect(chunks.join('')).toBe('{"type":"aborted"}\n');
      expect(mockSandbox.process.sendSessionCommandInput).toHaveBeenCalledWith(
        expect.any(String),
        'cmd-1',
        '{"type":"interrupt"}\n',
      );
    });

    it('routes stderr through and ends both streams when the command exits', async () => {
      const logs = wireSessionLogs();

      const { stdout, stderr } = await runtime.execStream(['node', 'b.mjs']);
      const errChunks: string[] = [];
      stderr.on('data', (chunk: Buffer) => errChunks.push(chunk.toString()));
      // A paused PassThrough never emits 'end'; consume stdout so it flows.
      stdout.on('data', () => {});
      logs.emitStderr('boom\n');

      const stdoutEnded = new Promise<void>((r) => stdout.on('end', r));
      const stderrEnded = new Promise<void>((r) => stderr.on('end', r));
      logs.endLogs();
      await Promise.all([stdoutEnded, stderrEnded]);

      expect(errChunks.join('')).toContain('boom');
    });

    it('retries a stdin write while the session input pipe is not ready yet', async () => {
      const logs = wireSessionLogs();
      mockSandbox.process.sendSessionCommandInput
        .mockRejectedValueOnce(new Error('input.pipe: no such file'))
        .mockResolvedValueOnce(undefined);

      const { stdin } = await runtime.execStream(['node', 'b.mjs']);
      stdin.write('{"type":"shutdown"}\n');

      await vi.waitFor(() => {
        expect(
          mockSandbox.process.sendSessionCommandInput,
        ).toHaveBeenCalledTimes(2);
      });
    });

    it('close() deletes the session', async () => {
      wireSessionLogs();

      const { close } = await runtime.execStream(['ls']);
      close();
      await new Promise<void>((r) => setImmediate(r));

      expect(mockSandbox.process.deleteSession).toHaveBeenCalled();
    });

    it('close() ends stdout/stderr even if the log-stream promise never settles', async () => {
      wireSessionLogs(); // getSessionCommandLogs stays pending (endLogs not called)

      const { stdout, stderr, close } = await runtime.execStream([
        'node',
        'b.mjs',
      ]);
      stdout.on('data', () => {});
      stderr.on('data', () => {});
      const stdoutEnded = new Promise<void>((r) => stdout.on('end', r));
      const stderrEnded = new Promise<void>((r) => stderr.on('end', r));

      // The log promise is deliberately left pending — close() must end the
      // local streams itself so the consumer's 'end' handler fires and the
      // PassThroughs do not leak for the sandbox lifetime.
      close();
      await Promise.all([stdoutEnded, stderrEnded]);

      expect(mockSandbox.process.deleteSession).toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    it('cleans up sandbox and sessions', async () => {
      // Add a session via sync exec (runAsync: false)
      let callCount = 0;
      mockSandbox.process.createSession.mockResolvedValue(undefined);
      mockSandbox.process.executeSessionCommand.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ exitCode: 0 });
        }
        return Promise.resolve({ exitCode: 0, stdout: '1', stderr: '' });
      });

      await runtime.exec({
        cmd: 'echo 1',
        sessionId: 'sess-cleanup',
      });

      // Set up daytona mock for delete
      const mockDaytona = { delete: vi.fn().mockResolvedValue(undefined) };
      (runtime as unknown as { daytona: typeof mockDaytona }).daytona =
        mockDaytona;

      await runtime.stop();

      expect(mockSandbox.process.deleteSession).toHaveBeenCalledWith(
        'sess-cleanup',
      );
      expect(mockDaytona.delete).toHaveBeenCalledWith(mockSandbox);
    });
  });

  describe('abort signal handling', () => {
    beforeEach(() => {
      mockSandbox.process.createSession.mockResolvedValue(undefined);
      mockSandbox.process.deleteSession.mockResolvedValue(undefined);
    });

    it('returns aborted result when signal is already aborted (one-shot)', async () => {
      const abortController = new AbortController();
      abortController.abort();

      // SDK should not even be called when already aborted
      mockSandbox.process.executeSessionCommand.mockReturnValue(
        new Promise(() => undefined),
      );

      const result = await runtime.exec({
        cmd: 'sleep 60',
        signal: abortController.signal,
      });

      expect(result.fail).toBe(true);
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toBe('Aborted');
    });

    it('returns aborted result when signal fires during execution (one-shot)', async () => {
      const abortController = new AbortController();

      // SDK call never resolves — simulates a long-running command
      mockSandbox.process.executeSessionCommand.mockReturnValue(
        new Promise(() => undefined),
      );

      const resultPromise = runtime.exec({
        cmd: 'sleep 60',
        signal: abortController.signal,
      });

      // Abort mid-execution
      abortController.abort();

      const result = await resultPromise;

      expect(result.fail).toBe(true);
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toBe('Aborted');
    });
  });

  describe('start()', () => {
    let freshRuntime: DaytonaRuntime;

    beforeEach(() => {
      freshRuntime = new DaytonaRuntime({
        apiKey: 'key',
        apiUrl: 'http://api',
        target: 'us',
      });
      mockDaytonaInstance.create.mockResolvedValue(mockSandbox);
      mockDaytonaInstance.get.mockRejectedValue(new Error('Not found'));
      mockDaytonaInstance.delete.mockResolvedValue(undefined);
      // runImageEntrypoint exec calls need session mocks.
      // Return exitCode 1 so the entrypoint check sees "not found" and skips.
      mockSandbox.process.createSession.mockResolvedValue(undefined);
      mockSandbox.process.executeSessionCommand.mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: '',
      });
      mockSandbox.process.deleteSession.mockResolvedValue(undefined);
    });

    it('calls daytona.create() with correct params', async () => {
      await freshRuntime.start({
        containerName: 'my-sandbox',
        image: 'node:20',
        env: { NODE_ENV: 'test' },
        labels: { team: 'backend' },
      });

      expect(mockDaytonaInstance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'my-sandbox',
          image: 'node:20',
          envVars: { NODE_ENV: 'test' },
          labels: { team: 'backend' },
          autoStopInterval: 0,
        }),
        { timeout: 300 },
      );
    });

    it('is idempotent — calling twice does not create a second sandbox', async () => {
      await freshRuntime.start({ containerName: 'idempotent-sandbox' });
      await freshRuntime.start({ containerName: 'idempotent-sandbox' });

      expect(mockDaytonaInstance.create).toHaveBeenCalledTimes(1);
    });

    it('with recreate: true deletes existing sandbox first', async () => {
      const existingSandbox = { ...mockSandbox, id: 'existing-1' };
      mockDaytonaInstance.get.mockResolvedValue(existingSandbox);

      await freshRuntime.start({
        containerName: 'recreate-sandbox',
        recreate: true,
      });

      expect(mockDaytonaInstance.get).toHaveBeenCalledWith('recreate-sandbox');
      expect(mockDaytonaInstance.delete).toHaveBeenCalledWith(existingSandbox);
      expect(mockDaytonaInstance.create).toHaveBeenCalledTimes(1);
    });

    it('retries sandbox creation after invalidating stale snapshot on pull access denied error', async () => {
      const staleError = new Error(
        'Sandbox abc failed to start with status: error, error reason: Error response from daemon: pull access denied for daytona-abc123hash, repository does not exist',
      );

      // First 3 calls fail (createSandbox retries), 4th succeeds after snapshot invalidation
      mockDaytonaInstance.create
        .mockRejectedValueOnce(staleError)
        .mockRejectedValueOnce(staleError)
        .mockRejectedValueOnce(staleError)
        .mockResolvedValueOnce(mockSandbox);

      // Mock snapshot.get to return a snapshot for direct deletion
      const mockSnapshot = { id: 'snap-1', name: 'daytona-abc123hash' };
      mockDaytonaInstance.snapshot.get.mockResolvedValue(mockSnapshot);
      mockDaytonaInstance.snapshot.delete.mockResolvedValue(undefined);

      mockSandbox.process.createSession.mockResolvedValue(undefined);
      mockSandbox.process.executeSessionCommand.mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: '',
      });
      mockSandbox.process.deleteSession.mockResolvedValue(undefined);

      await freshRuntime.start({
        containerName: 'stale-test',
        image: 'node:20',
      });

      // Verify snapshot was looked up and deleted directly from error
      expect(mockDaytonaInstance.snapshot.get).toHaveBeenCalledWith(
        'daytona-abc123hash',
      );
      expect(mockDaytonaInstance.snapshot.delete).toHaveBeenCalledWith(
        mockSnapshot,
      );
      // Verify create was called 4 times: 3 retries in first createSandbox + 1 success after invalidation
      expect(mockDaytonaInstance.create).toHaveBeenCalledTimes(4);
    });
  });

  describe('exec guard', () => {
    it('throws when exec is called before start', async () => {
      const unstartedRuntime = new DaytonaRuntime({
        apiKey: 'k',
        apiUrl: 'http://api',
        target: 'us',
      });
      await expect(unstartedRuntime.exec({ cmd: 'echo hi' })).rejects.toThrow(
        'Runtime not started',
      );
    });
  });

  describe('session exec — timeout and abort scenarios', () => {
    function mockStreamingLogsWithoutSnapshots() {
      mockSandbox.process.getSessionCommandLogs.mockImplementation(
        (
          _sessionId: string,
          _cmdId: string,
          onStdout?: (chunk: string) => void,
          _onStderr?: (chunk: string) => void,
        ) => {
          if (!onStdout) {
            return Promise.resolve({});
          }
          return new Promise<void>(() => undefined);
        },
      );
    }

    beforeEach(() => {
      mockSandbox.process.createSession.mockResolvedValue(undefined);
    });

    describe('sync path (runAsync: false — default, no idleTimeoutMs)', () => {
      it('scenario 1: normal completion — returns exitCode directly', async () => {
        let callCount = 0;
        mockSandbox.process.executeSessionCommand.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({ exitCode: 0 });
          }
          return Promise.resolve({
            exitCode: 0,
            stdout: 'hello',
            stderr: '',
          });
        });

        const result = await runtime.exec({
          cmd: 'echo hello',
          sessionId: 'sess-normal',
        });

        expect(result.exitCode).toBe(0);
        expect(result.fail).toBe(false);
        expect(result.stdout).toBe('hello');
        // No WS streaming used
        expect(
          mockSandbox.process.getSessionCommandLogs,
        ).not.toHaveBeenCalled();
      });

      it('scenario 3: SDK timeout — returns exit code 124 on timeout error', async () => {
        let callCount = 0;
        mockSandbox.process.executeSessionCommand.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({ exitCode: 0 });
          }
          return Promise.reject(new Error('Request timeout after 10s'));
        });
        mockSandbox.process.deleteSession.mockResolvedValue(undefined);

        const result = await runtime.exec({
          cmd: 'long-running',
          sessionId: 'sess-hard',
          timeoutMs: 10_000,
        });

        // exec() catches the error and returns 124
        expect(result.exitCode).toBe(124);
        expect(result.fail).toBe(true);
        expect(result.stderr).toContain('Request timeout');
      });

      it('scenario 5: abort signal returns immediately when pre-aborted', async () => {
        let callCount = 0;
        mockSandbox.process.executeSessionCommand.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({ exitCode: 0 });
          }
          return new Promise(() => undefined); // never resolves
        });
        mockSandbox.process.deleteSession.mockResolvedValue(undefined);

        const controller = new AbortController();
        controller.abort();

        const result = await runtime.exec({
          cmd: 'test',
          sessionId: 'sess-abort',
          signal: controller.signal,
        });

        expect(result.exitCode).toBe(124);
        expect(result.stderr).toBe('Aborted');
        expect(result.fail).toBe(true);
      });

      it('scenario 5b: mid-execution abort terminates and returns aborted', async () => {
        const controller = new AbortController();
        let callCount = 0;

        mockSandbox.process.executeSessionCommand.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({ exitCode: 0 });
          }
          // Long-running command — never resolves naturally
          return new Promise(() => undefined);
        });
        mockSandbox.process.deleteSession.mockResolvedValue(undefined);

        const resultPromise = runtime.exec({
          cmd: 'test',
          sessionId: 'sess-abort-mid',
          signal: controller.signal,
        });

        // Fire abort mid-execution
        controller.abort();

        const result = await resultPromise;

        expect(result.exitCode).toBe(124);
        expect(result.stderr).toBe('Aborted');
        expect(result.fail).toBe(true);
        // Session recreation is initiated asynchronously (fire-and-forget)
        // and will be awaited by the next execInSession call via sessionRecreatePromise.
      });

      it('fast command — bun install returns exit code 127 immediately', async () => {
        let callCount = 0;
        mockSandbox.process.executeSessionCommand.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({ exitCode: 0 });
          }
          return Promise.resolve({
            exitCode: 127,
            stdout: '',
            stderr: 'bun: not found',
          });
        });

        const start = Date.now();
        const result = await runtime.exec({
          cmd: 'bun install',
          sessionId: 'sess-bun',
        });
        const elapsed = Date.now() - start;

        expect(result.exitCode).toBe(127);
        expect(result.fail).toBe(true);
        expect(result.stderr).toBe('bun: not found');
        // Must resolve quickly — the whole point of runAsync: false is no 5-min hang
        expect(elapsed).toBeLessThan(2000);
        // No WS streaming involved
        expect(
          mockSandbox.process.getSessionCommandLogs,
        ).not.toHaveBeenCalled();
      });

      it('passes correct timeout seconds to executeSessionCommand', async () => {
        let callCount = 0;
        mockSandbox.process.executeSessionCommand.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({ exitCode: 0 });
          }
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        });

        await runtime.exec({
          cmd: 'test',
          sessionId: 'sess-timeout-val',
          timeoutMs: 30_000,
        });

        // Second call (user command) should have timeout in seconds
        expect(
          mockSandbox.process.executeSessionCommand,
        ).toHaveBeenNthCalledWith(
          2,
          'sess-timeout-val',
          expect.objectContaining({
            command: expect.stringContaining('test'),
            runAsync: false,
          }),
          30,
        );
      });
    });

    describe('streaming path (runAsync: true — when idleTimeoutMs is set)', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('scenario 2: idle timeout fires when no output is produced', async () => {
        mockSandbox.process.executeSessionCommand.mockResolvedValue({
          cmdId: 'cmd-2',
        });
        mockStreamingLogsWithoutSnapshots();
        mockSandbox.process.getSessionCommand.mockResolvedValue({
          id: 'cmd-2',
          command: 'hang',
        });
        mockSandbox.process.deleteSession.mockResolvedValue(undefined);

        const execPromise = runtime.exec({
          cmd: 'hang',
          sessionId: 'sess-idle',
          idleTimeoutMs: 300_000,
        });

        await vi.advanceTimersByTimeAsync(302_000);
        const result = await execPromise;

        expect(result.exitCode).toBe(124);
        expect(result.fail).toBe(true);
        expect(result.stderr).toContain('Idle timeout');
        expect(mockSandbox.process.deleteSession).toHaveBeenCalledWith(
          'sess-idle',
        );
      });

      it('scenario 4: explicit timeoutMs used as hard timeout — error message contains caller-provided value', async () => {
        mockSandbox.process.executeSessionCommand.mockResolvedValue({
          cmdId: 'cmd-4',
        });
        mockSandbox.process.getSessionCommandLogs.mockImplementation(
          (
            _sessionId: string,
            _cmdId: string,
            onStdout: (chunk: string) => void,
          ) => {
            if (!onStdout) {
              return Promise.resolve({});
            }
            const outputInterval = setInterval(() => {
              onStdout('keep alive\n');
            }, 3000);
            return new Promise<void>(() => {
              void outputInterval;
            }).catch(() => {});
          },
        );
        mockSandbox.process.getSessionCommand.mockResolvedValue({
          id: 'cmd-4',
          command: 'test',
        });
        mockSandbox.process.deleteSession.mockResolvedValue(undefined);

        const execPromise = runtime.exec({
          cmd: 'test',
          sessionId: 'sess-explicit',
          timeoutMs: 10_000,
          idleTimeoutMs: 60_000,
        });

        await vi.advanceTimersByTimeAsync(12_000);
        const result = await execPromise;

        expect(result.stderr).toContain('10s');
        expect(result.stderr).not.toContain('3600s');
      });

      it('scenario 7: periodic output prevents idle timeout', async () => {
        mockSandbox.process.executeSessionCommand.mockResolvedValue({
          cmdId: 'cmd-7',
        });

        mockSandbox.process.getSessionCommandLogs.mockImplementation(
          (
            _sessionId: string,
            _cmdId: string,
            onStdout?: (chunk: string) => void,
          ) => {
            if (!onStdout) {
              return Promise.resolve({ stdout: 'progress\n', stderr: '' });
            }
            const outputInterval = setInterval(() => {
              onStdout('progress\n');
            }, 30_000);
            return new Promise<void>(() => {
              void outputInterval;
            }).catch(() => {});
          },
        );

        let pollCount = 0;
        mockSandbox.process.getSessionCommand.mockImplementation(() => {
          pollCount++;
          if (pollCount < 46) {
            return Promise.resolve({ id: 'cmd-7', command: 'test' });
          }
          return Promise.resolve({
            exitCode: 0,
            id: 'cmd-7',
            command: 'test',
          });
        });

        const execPromise = runtime.exec({
          cmd: 'test',
          sessionId: 'sess-output',
          idleTimeoutMs: 300_000,
        });

        await vi.advanceTimersByTimeAsync(120_000);
        const result = await execPromise;

        expect(result.exitCode).toBe(0);
        expect(result.fail).toBe(false);
      });

      it('scenario 8: idle timeout fires before hard timeout', async () => {
        mockSandbox.process.executeSessionCommand.mockResolvedValue({
          cmdId: 'cmd-8',
        });
        mockStreamingLogsWithoutSnapshots();
        mockSandbox.process.getSessionCommand.mockResolvedValue({
          id: 'cmd-8',
          command: 'test',
        });
        mockSandbox.process.deleteSession.mockResolvedValue(undefined);

        const execPromise = runtime.exec({
          cmd: 'test',
          sessionId: 'sess-idle-vs-hard',
          timeoutMs: 600_000,
          idleTimeoutMs: 300_000,
        });

        await vi.advanceTimersByTimeAsync(302_000);
        const result = await execPromise;

        expect(result.exitCode).toBe(124);
        expect(result.stderr).toContain('Idle timeout');
        expect(result.stderr).not.toContain('Hard timeout');
      });

      it('scenario 9a: returns failure immediately when command exits instantly (streaming with idleTimeoutMs)', async () => {
        mockSandbox.process.executeSessionCommand.mockResolvedValue({
          cmdId: 'cmd-fast-fail',
        });

        mockSandbox.process.getSessionCommandLogs.mockImplementation(
          (
            _sessionId: string,
            _cmdId: string,
            onStdout?: (chunk: string) => void,
          ) => {
            if (!onStdout) {
              return Promise.resolve({ stdout: '', stderr: '' });
            }
            return new Promise<void>(() => undefined);
          },
        );

        mockSandbox.process.getSessionCommand.mockResolvedValue({
          exitCode: 127,
          id: 'cmd-fast-fail',
          command: 'bun install',
        });
        mockSandbox.process.deleteSession.mockResolvedValue(undefined);

        const execPromise = runtime.exec({
          cmd: 'bun install',
          sessionId: 'sess-fast-fail',
          idleTimeoutMs: 15_000,
        });

        await vi.advanceTimersByTimeAsync(500);
        const result = await execPromise;

        expect(result.exitCode).toBe(127);
        expect(result.fail).toBe(true);
        expect(result.stderr).not.toContain('Idle timeout');
      });

      it('scenario 9b: returns failure when stream hangs and getSessionCommand delays exitCode', async () => {
        mockSandbox.process.executeSessionCommand.mockResolvedValue({
          cmdId: 'cmd-delayed',
        });

        mockSandbox.process.getSessionCommandLogs.mockImplementation(
          (
            _sessionId: string,
            _cmdId: string,
            onStdout?: (chunk: string) => void,
          ) => {
            if (!onStdout) {
              return Promise.resolve({ stdout: '', stderr: '' });
            }
            return new Promise<void>(() => undefined);
          },
        );

        let pollCount = 0;
        mockSandbox.process.getSessionCommand.mockImplementation(() => {
          pollCount++;
          if (pollCount <= 2) {
            return Promise.resolve({
              id: 'cmd-delayed',
              command: 'bun install',
            });
          }
          return Promise.resolve({
            exitCode: 127,
            id: 'cmd-delayed',
            command: 'bun install',
          });
        });
        mockSandbox.process.deleteSession.mockResolvedValue(undefined);

        const execPromise = runtime.exec({
          cmd: 'bun install',
          sessionId: 'sess-delayed',
          idleTimeoutMs: 15_000,
        });

        await vi.advanceTimersByTimeAsync(5000);
        const result = await execPromise;

        expect(result.exitCode).toBe(127);
        expect(result.fail).toBe(true);
      });

      it('scenario 9d: snapshot fallback — WS deadlock rescued by snapshot HTTP GET', async () => {
        mockSandbox.process.executeSessionCommand.mockResolvedValue({
          cmdId: 'cmd-bun-hang',
        });

        mockSandbox.process.getSessionCommandLogs.mockImplementation(
          (
            _sessionId: string,
            _cmdId: string,
            onStdout?: (chunk: string) => void,
          ) => {
            if (!onStdout) {
              return Promise.resolve({
                stdout: '',
                stderr: 'bun: not found\n',
              });
            }
            return new Promise<void>(() => undefined);
          },
        );

        mockSandbox.process.getSessionCommand.mockResolvedValue({
          id: 'cmd-bun-hang',
          command: 'bun install',
        });
        mockSandbox.process.deleteSession.mockResolvedValue(undefined);

        const execPromise = runtime.exec({
          cmd: 'bun install',
          sessionId: 'sess-bun-hang',
          idleTimeoutMs: 15_000,
        });

        await vi.advanceTimersByTimeAsync(3000);
        const result = await execPromise;

        expect(result.fail).toBe(true);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe('bun: not found\n');
        expect(result.stderr).not.toContain('Idle timeout');
      });

      it('scenario 9: fast-exit race — stream delivers stderr then getSessionCommand throws', async () => {
        const stderrOutput =
          'bash: cd: /nonexistent: No such file or directory';

        mockSandbox.process.executeSessionCommand.mockResolvedValue({
          cmdId: 'cmd-9',
        });

        mockSandbox.process.getSessionCommandLogs.mockImplementation(
          (
            _sessionId: string,
            _cmdId: string,
            _onStdout?: (chunk: string) => void,
            onStderr?: (chunk: string) => void,
          ) => {
            if (!onStderr) {
              return Promise.reject(new Error('cmdId not found'));
            }
            onStderr(stderrOutput);
            return Promise.resolve();
          },
        );

        mockSandbox.process.getSessionCommand.mockRejectedValue(
          new Error('cmdId not found'),
        );

        const execPromise = runtime.exec({
          cmd: 'cd /nonexistent',
          sessionId: 'sess-fast-exit',
          idleTimeoutMs: 15_000,
        });

        await vi.advanceTimersByTimeAsync(0);
        const result = await execPromise;

        expect(result.fail).toBe(true);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe(stderrOutput);
      });

      it('stream resolves first — poll is irrelevant', async () => {
        mockSandbox.process.executeSessionCommand.mockResolvedValue({
          cmdId: 'cmd-stream-first',
        });

        mockSandbox.process.getSessionCommandLogs.mockImplementation(
          (
            _sessionId: string,
            _cmdId: string,
            onStdout?: (chunk: string) => void,
          ) => {
            if (onStdout) {
              onStdout('stream output\n');
            }
            return Promise.resolve();
          },
        );

        mockSandbox.process.getSessionCommand.mockResolvedValue({
          exitCode: 0,
          id: 'cmd-stream-first',
          command: 'echo hi',
        });
        mockSandbox.process.deleteSession.mockResolvedValue(undefined);

        const execPromise = runtime.exec({
          cmd: 'echo hi',
          sessionId: 'sess-stream-first',
          idleTimeoutMs: 15_000,
        });

        await vi.advanceTimersByTimeAsync(0);
        const result = await execPromise;

        expect(result.exitCode).toBe(0);
        expect(result.fail).toBe(false);
        expect(result.stdout).toBe('stream output\n');
        expect(mockSandbox.process.getSessionCommand).toHaveBeenCalledTimes(1);
      });

      it('onSessionStuck callback return value is used', async () => {
        mockSandbox.process.executeSessionCommand.mockResolvedValue({
          cmdId: 'cmd-stuck-cb',
        });
        mockStreamingLogsWithoutSnapshots();
        mockSandbox.process.getSessionCommand.mockResolvedValue({
          id: 'cmd-stuck-cb',
          command: 'sleep infinity',
        });
        mockSandbox.process.deleteSession.mockResolvedValue(undefined);

        const execPromise = runtime.exec({
          cmd: 'sleep infinity',
          sessionId: 'sess-stuck-cb',
          idleTimeoutMs: 5_000,
        });

        await vi.advanceTimersByTimeAsync(6_000);
        const result = await execPromise;

        expect(result.exitCode).toBe(124);
        expect(result.fail).toBe(true);
        expect(result.stderr).toContain('Idle timeout');
        expect(mockSandbox.process.deleteSession).toHaveBeenCalledWith(
          'sess-stuck-cb',
        );
        expect(mockSandbox.process.createSession).toHaveBeenCalledWith(
          'sess-stuck-cb',
        );
      });
    });

    describe('one-shot path scenarios', () => {
      it('scenario 9c: one-shot returns failure immediately when command exits instantly', async () => {
        mockSandbox.process.createSession.mockResolvedValue(undefined);
        mockSandbox.process.executeSessionCommand.mockResolvedValue({
          exitCode: 127,
          stdout: '',
          stderr: 'bun: not found',
        });
        mockSandbox.process.deleteSession.mockResolvedValue(undefined);

        const result = await runtime.exec({
          cmd: 'bun install',
        });

        expect(result.exitCode).toBe(127);
        expect(result.fail).toBe(true);
        expect(result.stderr).not.toContain('Idle timeout');
        expect(mockSandbox.process.deleteSession).toHaveBeenCalledWith(
          expect.stringMatching(/^oneshot-/),
        );
      });
    });
  });
});

describe('RuntimeProvider type resolution', () => {
  it('resolveRuntimeByType(Daytona) returns DaytonaRuntime', () => {
    // Create a test subclass to access the protected method
    class TestableRuntimeProvider extends RuntimeProvider {
      public testResolveRuntimeByType(type: RuntimeType) {
        return this.resolveRuntimeByType(type);
      }
    }

    const provider = new TestableRuntimeProvider(
      {} as never,
      { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { emit: vi.fn().mockResolvedValue(undefined) } as never,
    );

    const runtime = provider.testResolveRuntimeByType(RuntimeType.Daytona);
    expect(runtime).toBeInstanceOf(DaytonaRuntime);
  });

  it('resolveRuntimeByType(Docker) still returns DockerRuntime', () => {
    class TestableRuntimeProvider extends RuntimeProvider {
      public testResolveRuntimeByType(type: RuntimeType) {
        return this.resolveRuntimeByType(type);
      }
    }

    const provider = new TestableRuntimeProvider(
      {} as never,
      { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { emit: vi.fn().mockResolvedValue(undefined) } as never,
    );

    const runtime = provider.testResolveRuntimeByType(RuntimeType.Docker);
    expect(runtime).toBeInstanceOf(DockerRuntime);
  });
});

describe('RuntimeProvider failure handling', () => {
  const mockDao = {
    getOne: vi.fn(),
    getAll: vi.fn(),
    create: vi.fn(),
    updateById: vi.fn(),
    transitionStatus: vi.fn(),
    deleteById: vi.fn(),
    hardDeleteById: vi.fn(),
  };

  const mockLogger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const mockNotificationsService = {
    emit: vi.fn().mockResolvedValue(undefined),
  };

  const baseParams = {
    graphId: 'graph-1',
    runtimeNodeId: 'node-1',
    threadId: 'thread-1',
    type: RuntimeType.Daytona,
    runtimeStartParams: { image: 'node:20' },
  };

  function buildRecord(
    overrides: Partial<RuntimeInstanceEntity> = {},
  ): RuntimeInstanceEntity {
    return {
      id: 'instance-1',
      graphId: 'graph-1',
      nodeId: 'node-1',
      threadId: 'thread-1',
      type: RuntimeType.Daytona,
      containerName: 'test-container-123',
      status: RuntimeInstanceStatus.Running,
      config: { image: 'node:20' },
      temporary: false,
      lastUsedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as RuntimeInstanceEntity;
  }

  let provider: RuntimeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDao.transitionStatus.mockResolvedValue(undefined as never);
    mockNotificationsService.emit.mockResolvedValue(undefined);
    provider = new RuntimeProvider(
      mockDao as never,
      mockLogger as never,
      mockNotificationsService as never,
    );
  });

  describe('provide() — cleans up failed runtime on ensureRuntimeForRecord failure', () => {
    it('stops container and hard-deletes record when new record creation fails', async () => {
      mockDao.getOne.mockResolvedValue(null);
      const createdRecord = buildRecord({
        status: RuntimeInstanceStatus.Starting,
      });
      mockDao.create.mockResolvedValue(createdRecord);
      mockDao.updateById.mockResolvedValue(undefined);
      mockDao.hardDeleteById.mockResolvedValue(undefined);

      mockDaytonaInstance.get.mockRejectedValue(new Error('Not found'));
      mockDaytonaInstance.create.mockRejectedValue(
        new Error('Sandbox creation timed out after 300s'),
      );

      await expect(provider.provide(baseParams)).rejects.toThrow(
        'Sandbox creation timed out after 300s',
      );

      // Failed transition marks the record before cleanup
      expect(mockDao.transitionStatus).toHaveBeenCalledWith(
        createdRecord.id,
        RuntimeInstanceStatus.Failed,
        expect.objectContaining({ errorCode: expect.any(String) }),
      );
      // Should hard-delete the record
      expect(mockDao.hardDeleteById).toHaveBeenCalledWith(createdRecord.id);
    });

    it('stops container and hard-deletes record when existing record re-start fails', async () => {
      const existingRecord = buildRecord({
        status: RuntimeInstanceStatus.Starting,
      });
      mockDao.getOne.mockResolvedValue(existingRecord);
      mockDao.updateById.mockResolvedValue(undefined);
      mockDao.hardDeleteById.mockResolvedValue(undefined);

      mockDaytonaInstance.get.mockRejectedValue(new Error('Not found'));
      mockDaytonaInstance.create.mockRejectedValue(
        new Error('Sandbox creation timed out after 300s'),
      );

      await expect(provider.provide(baseParams)).rejects.toThrow(
        'Sandbox creation timed out after 300s',
      );

      // Failed transition marks the record before cleanup
      expect(mockDao.transitionStatus).toHaveBeenCalledWith(
        existingRecord.id,
        RuntimeInstanceStatus.Failed,
        expect.objectContaining({ errorCode: expect.any(String) }),
      );
      // Should hard-delete the record
      expect(mockDao.hardDeleteById).toHaveBeenCalledWith(existingRecord.id);
    });
  });

  describe('provide() — handles existing Failed record', () => {
    it('cleans up Failed record and creates a fresh instance', async () => {
      const failedRecord = buildRecord({
        status: RuntimeInstanceStatus.Failed,
      });
      mockDao.getOne.mockResolvedValue(failedRecord);
      mockDao.hardDeleteById.mockResolvedValue(undefined);
      mockDao.updateById.mockResolvedValue(undefined);

      const freshRecord = buildRecord({
        id: 'instance-2',
        status: RuntimeInstanceStatus.Starting,
      });
      mockDao.create.mockResolvedValue(freshRecord);

      // Make the new creation succeed
      mockDaytonaInstance.get.mockRejectedValue(new Error('Not found'));
      mockDaytonaInstance.create.mockResolvedValue(mockSandbox);

      const result = await provider.provide(baseParams);

      // Failed records skip the Stopping transition (already terminal) — just
      // hard-delete before recreating.
      expect(mockDao.hardDeleteById).toHaveBeenCalledWith(failedRecord.id);
      // Should have created a new record
      expect(mockDao.create).toHaveBeenCalled();
      // Result should be a fresh (non-cached) runtime
      expect(result.cached).toBe(false);
    });
  });

  describe('stopRuntime()', () => {
    it('emits Stopping then Stopped with correct runtimeId', async () => {
      const record = buildRecord({ status: RuntimeInstanceStatus.Running });
      mockDao.updateById.mockResolvedValue(undefined);
      // No runtime in the runtimeInstances map — stopByName path will be taken.
      // DaytonaRuntime.stopByName uses new Daytona() internally (mocked).
      // get rejects → stopByName swallows the error silently.
      mockDaytonaInstance.get.mockRejectedValue(new Error('Not found'));

      vi.clearAllMocks();
      mockDao.updateById.mockResolvedValue(undefined);
      mockNotificationsService.emit.mockResolvedValue(undefined);

      await provider.stopRuntime(record);

      const emitCalls = mockNotificationsService.emit.mock.calls;
      expect(emitCalls).toHaveLength(2);

      expect(emitCalls[0]![0]).toEqual(
        expect.objectContaining({
          type: NotificationEvent.RuntimeStatus,
          data: expect.objectContaining({
            status: 'Stopping',
            runtimeId: record.id,
            threadId: record.threadId,
            nodeId: record.nodeId,
          }),
        }),
      );

      expect(emitCalls[1]![0]).toEqual(
        expect.objectContaining({
          type: NotificationEvent.RuntimeStatus,
          data: expect.objectContaining({
            status: 'Stopped',
            runtimeId: record.id,
          }),
        }),
      );
    });
  });

  describe('cleanupIdleRuntimes() — includes Failed records', () => {
    it('queries for Failed status alongside Running and Starting', async () => {
      mockDao.getAll.mockResolvedValue([]);

      await provider.cleanupIdleRuntimes(60_000);

      expect(mockDao.getAll).toHaveBeenCalledWith(
        expect.objectContaining({
          status: {
            $in: expect.arrayContaining([
              RuntimeInstanceStatus.Running,
              RuntimeInstanceStatus.Starting,
              RuntimeInstanceStatus.Failed,
            ]),
          },
        }),
      );
    });
  });

  describe('provide() — emits runtime status notifications', () => {
    it('emits Starting before and Running after successful new runtime creation', async () => {
      mockDao.getOne.mockResolvedValue(null);
      const createdRecord = buildRecord({
        status: RuntimeInstanceStatus.Starting,
      });
      mockDao.create.mockResolvedValue(createdRecord);
      mockDao.updateById.mockResolvedValue(undefined);

      mockDaytonaInstance.get.mockRejectedValue(new Error('Not found'));
      mockDaytonaInstance.create.mockResolvedValue(mockSandbox);

      await provider.provide(baseParams);

      const emitCalls = mockNotificationsService.emit.mock.calls.map(
        (c) => c[0] as { data: { status: string; startingPhase?: string } },
      );
      // Starting (initial) + phase emits (Starting with startingPhase set) + Running
      expect(emitCalls.length).toBeGreaterThanOrEqual(2);

      const startingCall = emitCalls[0]!;
      expect(startingCall).toEqual(
        expect.objectContaining({
          type: NotificationEvent.RuntimeStatus,
          graphId: 'graph-1',
          data: expect.objectContaining({
            status: 'Starting',
            runtimeId: 'instance-1',
            nodeId: 'node-1',
            threadId: 'thread-1',
            runtimeType: RuntimeType.Daytona,
          }),
        }),
      );

      const runningCall = emitCalls[emitCalls.length - 1]!;
      expect(runningCall).toEqual(
        expect.objectContaining({
          type: NotificationEvent.RuntimeStatus,
          graphId: 'graph-1',
          data: expect.objectContaining({
            status: 'Running',
            runtimeId: 'instance-1',
            nodeId: 'node-1',
            threadId: 'thread-1',
            runtimeType: RuntimeType.Daytona,
          }),
        }),
      );
    });

    it('emits Starting then Failed with error message when creation fails', async () => {
      mockDao.getOne.mockResolvedValue(null);
      const createdRecord = buildRecord({
        status: RuntimeInstanceStatus.Starting,
      });
      mockDao.create.mockResolvedValue(createdRecord);
      mockDao.updateById.mockResolvedValue(undefined);

      mockDaytonaInstance.get.mockRejectedValue(new Error('Not found'));
      mockDaytonaInstance.create.mockRejectedValue(
        new Error('Sandbox creation timed out after 300s'),
      );

      await expect(provider.provide(baseParams)).rejects.toThrow(
        'Sandbox creation timed out after 300s',
      );

      const emitCalls = mockNotificationsService.emit.mock.calls;
      // Starting + Stopping (from cleanupFailedInstance -> stopRuntime) + Stopped + Failed
      expect(emitCalls.length).toBeGreaterThanOrEqual(2);

      const startingCall = emitCalls[0]!;
      expect(startingCall[0]).toEqual(
        expect.objectContaining({
          type: NotificationEvent.RuntimeStatus,
          data: expect.objectContaining({
            status: 'Starting',
            runtimeId: 'instance-1',
          }),
        }),
      );

      const failedCall = emitCalls[emitCalls.length - 1]!;
      expect(failedCall[0]).toEqual(
        expect.objectContaining({
          type: NotificationEvent.RuntimeStatus,
          data: expect.objectContaining({
            status: 'Failed',
            runtimeId: 'instance-1',
            message: 'Sandbox creation timed out after 300s',
          }),
        }),
      );
    });

    it('emits notifications for existing record re-start path', async () => {
      const existingRecord = buildRecord({
        status: RuntimeInstanceStatus.Starting,
      });
      mockDao.getOne.mockResolvedValue(existingRecord);
      mockDao.updateById.mockResolvedValue(undefined);

      mockDaytonaInstance.get.mockRejectedValue(new Error('Not found'));
      mockDaytonaInstance.create.mockResolvedValue(mockSandbox);

      await provider.provide(baseParams);

      const emitCalls = mockNotificationsService.emit.mock.calls;
      expect(emitCalls.length).toBeGreaterThanOrEqual(2);

      const startingCall = emitCalls[0]!;
      expect(startingCall[0]).toEqual(
        expect.objectContaining({
          type: NotificationEvent.RuntimeStatus,
          data: expect.objectContaining({
            status: 'Starting',
            runtimeId: 'instance-1',
          }),
        }),
      );

      const runningCall = emitCalls[emitCalls.length - 1]!;
      expect(runningCall[0]).toEqual(
        expect.objectContaining({
          type: NotificationEvent.RuntimeStatus,
          data: expect.objectContaining({
            status: 'Running',
            runtimeId: 'instance-1',
          }),
        }),
      );
    });

    it('does not propagate notification emit failures', async () => {
      mockDao.getOne.mockResolvedValue(null);
      const createdRecord = buildRecord({
        status: RuntimeInstanceStatus.Starting,
      });
      mockDao.create.mockResolvedValue(createdRecord);
      mockDao.updateById.mockResolvedValue(undefined);

      mockDaytonaInstance.get.mockRejectedValue(new Error('Not found'));
      mockDaytonaInstance.create.mockResolvedValue(mockSandbox);

      // Make emit reject — should not affect provide()
      mockNotificationsService.emit.mockRejectedValue(
        new Error('WebSocket failure'),
      );

      const result = await provider.provide(baseParams);

      expect(result.cached).toBe(false);
      expect(result.runtime).toBeDefined();
    });
  });
});
