import { PassThrough } from 'node:stream';

import { DefaultLogger } from '@packages/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { K8sRuntime } from '../../runtime/services/k8s-runtime';
import { K8sExecTransport } from './k8s-exec-transport';

const createLogger = (): DefaultLogger =>
  new DefaultLogger({
    environment: 'test',
    appName: 'test',
    appVersion: '1.0.0',
  });

const createStreams = () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const close = vi.fn(() => {
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  });
  return { stdin, stdout, stderr, close };
};

const createRuntime = (streams: ReturnType<typeof createStreams>) =>
  ({
    execStream: vi.fn().mockResolvedValue(streams),
  }) as unknown as K8sRuntime;

describe('K8sExecTransport', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('start() invokes runtime.execStream with [command, ...args] and { env }', async () => {
    const streams = createStreams();
    const runtime = createRuntime(streams);
    const env = { FOO: 'bar' };
    const transport = new K8sExecTransport(
      runtime,
      'node',
      ['server.js', '--port', '3000'],
      env,
      createLogger(),
    );

    await transport.start();

    expect(runtime.execStream).toHaveBeenCalledTimes(1);
    expect(runtime.execStream).toHaveBeenCalledWith(
      ['node', 'server.js', '--port', '3000'],
      { env },
    );
  });

  it('send() writes JSON.stringify(message) + newline to stdin', async () => {
    const streams = createStreams();
    const runtime = createRuntime(streams);
    const transport = new K8sExecTransport(
      runtime,
      'mcp-server',
      [],
      {},
      createLogger(),
    );

    await transport.start();

    const chunks: Buffer[] = [];
    streams.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

    const message = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'ping',
      params: {},
    };
    await transport.send(message);

    const written = chunks.map((c) => c.toString()).join('');
    expect(written).toBe(JSON.stringify(message) + '\n');
  });

  it('onmessage fires when stdout emits a complete newline-delimited JSON-RPC message', async () => {
    const streams = createStreams();
    const runtime = createRuntime(streams);
    const transport = new K8sExecTransport(
      runtime,
      'mcp-server',
      [],
      {},
      createLogger(),
    );

    const onmessage = vi.fn();
    transport.onmessage = onmessage;

    await transport.start();

    const msg = { jsonrpc: '2.0', id: 1, result: { tools: [] } };
    streams.stdout.write(JSON.stringify(msg) + '\n');

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onmessage).toHaveBeenCalledTimes(1);
    expect(onmessage).toHaveBeenCalledWith(msg);
  });

  it('onmessage handles multiple messages split across chunks (buffering)', async () => {
    const streams = createStreams();
    const runtime = createRuntime(streams);
    const transport = new K8sExecTransport(
      runtime,
      'mcp-server',
      [],
      {},
      createLogger(),
    );

    const received: unknown[] = [];
    transport.onmessage = (msg) => received.push(msg);

    await transport.start();

    const msg1 = { jsonrpc: '2.0', id: 1, result: {} };
    const msg2 = { jsonrpc: '2.0', id: 2, result: { ok: true } };
    const full = JSON.stringify(msg1) + '\n' + JSON.stringify(msg2) + '\n';

    // Split across two chunks to verify buffering
    const mid = Math.floor(full.length / 2);
    streams.stdout.write(full.slice(0, mid));
    streams.stdout.write(full.slice(mid));

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(msg1);
    expect(received[1]).toEqual(msg2);
  });

  it('close() calls the close function returned from execStream', async () => {
    const streams = createStreams();
    const runtime = createRuntime(streams);
    const transport = new K8sExecTransport(
      runtime,
      'mcp-server',
      [],
      {},
      createLogger(),
    );

    await transport.start();
    await transport.close();

    expect(streams.close).toHaveBeenCalledTimes(1);
  });

  it('surfaces stderr tail as an error via onerror on early close before any MCP message', async () => {
    const streams = createStreams();
    const runtime = createRuntime(streams);
    const transport = new K8sExecTransport(
      runtime,
      'mcp-server',
      ['--config', 'mcp.json'],
      {},
      createLogger(),
    );

    const onerror = vi.fn();
    transport.onerror = onerror;

    await transport.start();

    streams.stderr.write('command not found: mcp-server\n');
    streams.stdin.destroy();

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onerror).toHaveBeenCalledTimes(1);
    const error = onerror.mock.calls[0]?.[0] as unknown;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'MCP transport closed before handshake',
    );
    expect((error as Error).message).toContain('command not found: mcp-server');
    expect((error as Error).message).toContain(
      'Command: mcp-server --config mcp.json',
    );
  });

  it('logs the early close at debug, not error (caller decides severity)', async () => {
    const streams = createStreams();
    const runtime = createRuntime(streams);
    const logger = createLogger();
    const errorSpy = vi.spyOn(logger, 'error');
    const debugSpy = vi.spyOn(logger, 'debug');
    const transport = new K8sExecTransport(
      runtime,
      'mcp-server',
      ['--config', 'mcp.json'],
      {},
      logger,
    );
    transport.onerror = () => undefined;

    await transport.start();

    streams.stderr.write('command not found: mcp-server\n');
    streams.stdin.destroy();

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('MCP transport closed early'),
    );
  });

  it('does not emit early-close error after receiving at least one JSON message', async () => {
    const streams = createStreams();
    const runtime = createRuntime(streams);
    const transport = new K8sExecTransport(
      runtime,
      'mcp-server',
      [],
      {},
      createLogger(),
    );

    const onerror = vi.fn();
    transport.onerror = onerror;

    await transport.start();

    streams.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`,
    );
    streams.stderr.write('some warning\n');
    streams.stdin.destroy();

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onerror).not.toHaveBeenCalled();
  });

  it('handles invalid JSON gracefully — logs error but does not throw', async () => {
    const streams = createStreams();
    const runtime = createRuntime(streams);
    const logger = createLogger();
    const loggerErrorSpy = vi.spyOn(logger, 'error');
    const transport = new K8sExecTransport(
      runtime,
      'mcp-server',
      [],
      {},
      logger,
    );

    const onmessage = vi.fn();
    const onerror = vi.fn();
    transport.onmessage = onmessage;
    transport.onerror = onerror;

    await transport.start();

    streams.stdout.write('not valid json\n');

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onmessage).not.toHaveBeenCalled();
    expect(onerror).not.toHaveBeenCalled();
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining('Failed to parse MCP message'),
    );
  });
});
