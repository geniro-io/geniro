import { PassThrough } from 'node:stream';

import { DefaultLogger } from '@packages/common';
import { describe, expect, it, vi } from 'vitest';

import { BaseRuntime } from '../../runtime/services/base-runtime';
import { DockerExecTransport } from './docker-exec-transport';

const createLogger = (): DefaultLogger =>
  new DefaultLogger({
    environment: 'test',
    appName: 'test',
    appVersion: '1.0.0',
  });

describe('DockerExecTransport', () => {
  it('surfaces stderr when transport closes before any MCP message', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const runtime = {
      execStream: async () => ({
        stdin,
        stdout,
        stderr,
        close: () => {
          stdin.destroy();
          stdout.destroy();
          stderr.destroy();
        },
      }),
    } as unknown as BaseRuntime;

    const transport = new DockerExecTransport(
      () => runtime,
      'docker',
      ['run', '--rm', '-i', 'image:latest'],
      {},
      createLogger(),
    );

    const onerror = vi.fn();
    transport.onerror = (e) => onerror(e);

    await transport.start();

    stderr.write('docker: not found\n');
    stdin.destroy();

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onerror).toHaveBeenCalledTimes(1);
    const error = onerror.mock.calls[0]?.[0] as unknown;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'MCP transport closed before handshake',
    );
    expect((error as Error).message).toContain('docker: not found');
    expect((error as Error).message).toContain('Command: docker run');
  });

  it('does not emit early-close stderr error after receiving at least one JSON message', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const runtime = {
      execStream: async () => ({
        stdin,
        stdout,
        stderr,
        close: () => {
          stdin.destroy();
          stdout.destroy();
          stderr.destroy();
        },
      }),
    } as unknown as BaseRuntime;

    const transport = new DockerExecTransport(
      () => runtime,
      'docker',
      ['run', '--rm', '-i', 'image:latest'],
      {},
      createLogger(),
    );

    const onerror = vi.fn();
    transport.onerror = (e) => onerror(e);

    await transport.start();

    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
    stderr.write('some warning\n');
    stdin.destroy();

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onerror).not.toHaveBeenCalled();
  });

  it('logs the early close at debug, not error (caller decides severity)', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const runtime = {
      execStream: async () => ({
        stdin,
        stdout,
        stderr,
        close: () => {
          stdin.destroy();
          stdout.destroy();
          stderr.destroy();
        },
      }),
    } as unknown as BaseRuntime;

    const logger = createLogger();
    const errorSpy = vi.spyOn(logger, 'error');
    const debugSpy = vi.spyOn(logger, 'debug');

    const transport = new DockerExecTransport(
      () => runtime,
      'docker',
      ['run', '--rm', '-i', 'image:latest'],
      {},
      logger,
    );
    transport.onerror = () => undefined;

    await transport.start();

    stderr.write('docker: not found\n');
    stdin.destroy();

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('MCP transport closed early'),
    );
  });
});
