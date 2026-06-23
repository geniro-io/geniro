import { Sandbox } from '@daytonaio/sdk';
import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DaytonaExecTransport } from './daytona-exec-transport';

const createLogger = (): DefaultLogger =>
  new DefaultLogger({
    environment: 'test',
    appName: 'test',
    appVersion: '1.0.0',
  });

/** Builds a mock Sandbox with controllable process methods. */
function createMockSandbox() {
  let onStdout: ((chunk: string) => void) | undefined;
  let onStderr: ((chunk: string) => void) | undefined;
  let logsResolve: (() => void) | undefined;
  let logsReject: ((err: Error) => void) | undefined;

  const logsPromise = new Promise<void>((resolve, reject) => {
    logsResolve = resolve;
    logsReject = reject;
  });

  const process = {
    createSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    executeSessionCommand: vi.fn().mockResolvedValue({ cmdId: 'cmd-001' }),
    getSessionCommandLogs: vi.fn(
      (
        _sessionId: string,
        _cmdId: string,
        stdoutCb?: (chunk: string) => void,
        stderrCb?: (chunk: string) => void,
      ) => {
        onStdout = stdoutCb;
        onStderr = stderrCb;
        return logsPromise;
      },
    ),
    sendSessionCommandInput: vi.fn().mockResolvedValue(undefined),
  };

  return {
    sandbox: { process } as unknown as Sandbox,
    process,
    /** Simulate the MCP server writing to stdout */
    writeStdout: (data: string) => onStdout?.(data),
    /** Simulate the MCP server writing to stderr */
    writeStderr: (data: string) => onStderr?.(data),
    /** Simulate the log stream completing (process exit) */
    resolveLogs: () => logsResolve?.(),
    /** Simulate the log stream erroring */
    rejectLogs: (err: Error) => logsReject?.(err),
  };
}

describe('DaytonaExecTransport', () => {
  let mock: ReturnType<typeof createMockSandbox>;
  let transport: DaytonaExecTransport;

  beforeEach(() => {
    mock = createMockSandbox();
    transport = new DaytonaExecTransport(
      mock.sandbox,
      'npx',
      ['-y', '@mcp/server'],
      { API_KEY: 'secret' },
      createLogger(),
    );
  });

  it('start() creates session and launches command', async () => {
    await transport.start();

    expect(mock.process.createSession).toHaveBeenCalledTimes(1);
    // Session ID should start with "mcp-"
    const sessionId = mock.process.createSession.mock.calls[0]?.[0] as string;
    expect(sessionId).toMatch(/^mcp-/);

    expect(mock.process.executeSessionCommand).toHaveBeenCalledTimes(1);
    const [sid, req] = mock.process.executeSessionCommand.mock.calls[0] as [
      string,
      { command: string; runAsync: boolean; suppressInputEcho: boolean },
    ];
    expect(sid).toBe(sessionId);
    expect(req.runAsync).toBe(true);
    expect(req.suppressInputEcho).toBe(true);
    // Command should include env prefix and the full command
    expect(req.command).toContain("export API_KEY='secret'");
    expect(req.command).toContain('npx -y @mcp/server');

    expect(mock.process.getSessionCommandLogs).toHaveBeenCalledTimes(1);
  });

  it('send() calls sendSessionCommandInput with serialized JSON + newline', async () => {
    await transport.start();

    const message = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'test',
      params: {},
    };
    await transport.send(message);

    expect(mock.process.sendSessionCommandInput).toHaveBeenCalledTimes(1);
    const [sessionId, cmdId, data] = mock.process.sendSessionCommandInput.mock
      .calls[0] as [string, string, string];
    expect(sessionId).toMatch(/^mcp-/);
    expect(cmdId).toBe('cmd-001');
    expect(data).toBe(JSON.stringify(message) + '\n');
  });

  it('stdout parsing triggers onmessage for valid JSON-RPC lines', async () => {
    const received: unknown[] = [];
    transport.onmessage = (msg) => received.push(msg);

    await transport.start();

    const msg1 = { jsonrpc: '2.0', id: 1, result: {} };
    const msg2 = { jsonrpc: '2.0', id: 2, result: { tools: [] } };
    mock.writeStdout(JSON.stringify(msg1) + '\n' + JSON.stringify(msg2) + '\n');

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(msg1);
    expect(received[1]).toEqual(msg2);
  });

  it('close() deletes session and fires onclose', async () => {
    const onclose = vi.fn();
    transport.onclose = onclose;

    await transport.start();
    await transport.close();

    expect(mock.process.deleteSession).toHaveBeenCalledTimes(1);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('close() followed by log stream resolve fires onclose exactly once', async () => {
    const onclose = vi.fn();
    transport.onclose = onclose;

    await transport.start();
    await transport.close();

    // Simulate the log stream resolving after close() was called
    mock.resolveLogs();

    // Allow microtask queue to flush
    await new Promise<void>((resolve) => setImmediate(resolve));

    // onclose must have been called exactly once (from close()), not again from the stream
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('send() rejects when not connected', async () => {
    const message = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'test',
      params: {},
    };
    await expect(transport.send(message)).rejects.toThrow(
      'Transport not connected',
    );
  });

  it('early process exit surfaces stderr via onerror', async () => {
    const onerror = vi.fn();
    transport.onerror = onerror;

    await transport.start();

    // Simulate stderr output followed by immediate stream completion (process exit)
    mock.writeStderr('Error: command not found\n');
    mock.resolveLogs();

    // Allow microtask to process
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onerror).toHaveBeenCalledTimes(1);
    const error = onerror.mock.calls[0]?.[0] as Error;
    expect(error.message).toContain('MCP transport closed before handshake');
    expect(error.message).toContain('Error: command not found');
  });

  it('logs the early close at debug, not error (caller decides severity)', async () => {
    const freshMock = createMockSandbox();
    const logger = createLogger();
    const errorSpy = vi.spyOn(logger, 'error');
    const debugSpy = vi.spyOn(logger, 'debug');
    const freshTransport = new DaytonaExecTransport(
      freshMock.sandbox,
      'npx',
      ['-y', '@mcp/server'],
      { API_KEY: 'secret' },
      logger,
    );
    freshTransport.onerror = () => undefined;

    await freshTransport.start();

    freshMock.writeStderr('Error: command not found\n');
    freshMock.resolveLogs();

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('MCP transport closed early'),
    );
  });

  it('malformed JSON on stdout is logged and skipped', async () => {
    const received: unknown[] = [];
    transport.onmessage = (msg) => received.push(msg);

    await transport.start();

    mock.writeStdout('not-json\n');
    mock.writeStdout(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n',
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('sendSessionCommandInput failure triggers onerror', async () => {
    const onerror = vi.fn();
    transport.onerror = onerror;

    mock.process.sendSessionCommandInput.mockRejectedValueOnce(
      new Error('Connection lost'),
    );

    await transport.start();

    const message = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'test',
      params: {},
    };
    await expect(transport.send(message)).rejects.toThrow('Connection lost');

    expect(onerror).toHaveBeenCalledTimes(1);
    expect((onerror.mock.calls[0]?.[0] as Error).message).toBe(
      'Connection lost',
    );
  });

  it('stdin echo is filtered out from stdout', async () => {
    const received: unknown[] = [];
    transport.onmessage = (msg) => received.push(msg);

    await transport.start();

    // Send a message — this registers it for echo filtering
    const outgoing = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'initialize',
      params: {},
    };
    await transport.send(outgoing);

    // Daytona echoes the sent message back on stdout, followed by the real response
    const serverResponse = {
      jsonrpc: '2.0',
      id: 1,
      result: { capabilities: {} },
    };
    mock.writeStdout(
      JSON.stringify(outgoing) + '\n' + JSON.stringify(serverResponse) + '\n',
    );

    // Only the server response should be delivered, not the echo
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(serverResponse);
  });

  it('send() retries when input pipe is not ready yet', async () => {
    vi.useFakeTimers();

    await transport.start();

    // First two calls fail with "input.pipe not found", third succeeds
    mock.process.sendSessionCommandInput
      .mockRejectedValueOnce(
        new Error(
          'failed to open input pipe: open /root/.daytona/sessions/mcp-xxx/cmd-001/input.pipe: no such file or directory',
        ),
      )
      .mockRejectedValueOnce(new Error('input.pipe: no such file or directory'))
      .mockResolvedValueOnce(undefined);

    const message = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'test',
      params: {},
    };
    const sendPromise = transport.send(message);

    // Advance through the retry delays
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    await sendPromise;

    expect(mock.process.sendSessionCommandInput).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });
});
