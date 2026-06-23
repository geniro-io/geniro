import { Duplex, PassThrough } from 'node:stream';

import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { DefaultLogger } from '@packages/common';

import { BaseRuntime } from '../../runtime/services/base-runtime';

/**
 * Custom MCP transport using DockerRuntime.execStream
 * Communicates with MCP servers running inside Docker containers
 * Streams are already properly demultiplexed by DockerRuntime
 */
export class DockerExecTransport implements Transport {
  private stdin?: Duplex;
  private stdout?: PassThrough;
  private stderr?: PassThrough;
  private closeStream?: () => void;
  private buffer = '';
  private stderrTail = '';
  private sawAnyMessage = false;
  private isConnected = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private appendStderrTail(chunk: Buffer, maxBytes = 64 * 1024): void {
    const next = chunk.toString('utf8');
    if (!next) {
      return;
    }
    if (!this.stderrTail) {
      this.stderrTail =
        next.length <= maxBytes ? next : next.slice(next.length - maxBytes);
      return;
    }
    const combined = this.stderrTail + next;
    this.stderrTail =
      combined.length <= maxBytes
        ? combined
        : combined.slice(combined.length - maxBytes);
  }

  private buildEarlyCloseError(): Error {
    const cmd = [this.command, ...this.args].join(' ');
    const stderr = this.stderrTail.trim();
    const suffix = stderr ? `\n\nstderr (tail):\n${stderr}` : '';
    return new Error(
      `MCP transport closed before handshake. Command: ${cmd}${suffix}`,
    );
  }

  constructor(
    private readonly getRuntimeInstance: () => BaseRuntime,
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly logger: DefaultLogger,
  ) {}

  public async start(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    // Get runtime instance dynamically
    const runtime = this.getRuntimeInstance();

    // Get properly demuxed streams from runtime
    if (!('execStream' in runtime)) {
      throw new Error('Runtime does not support execStream');
    }

    const streams = await runtime.execStream([this.command, ...this.args], {
      env: this.env,
    });

    this.stdin = streams.stdin;
    this.stdout = streams.stdout;
    this.stderr = streams.stderr;
    this.closeStream = streams.close;

    this.stderr!.on('data', (data: Buffer) => {
      this.appendStderrTail(data);
    });

    // stdout is already demuxed - just parse JSON-RPC line by line
    this.stdout!.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line) as JSONRPCMessage;
            this.sawAnyMessage = true;
            if (this.onmessage) {
              this.onmessage(message);
            }
          } catch (error) {
            this.logger.error(
              error instanceof Error ? error : new Error(String(error)),
              `Failed to parse MCP message: ${line}`,
            );
          }
        }
      }
    });

    this.stdin!.on('error', (error: Error) => {
      this.logger.error(error, 'DockerExecTransport error');
      if (this.onerror) {
        this.onerror(error);
      }
      this.close();
    });

    this.stdin!.on('close', () => {
      // If the underlying process exits before producing any MCP messages,
      // surface stderr to avoid generic "connection closed" errors.
      if (!this.sawAnyMessage && this.stderrTail.trim()) {
        const err = this.buildEarlyCloseError();
        // debug, not error: an early close is propagated to the caller via
        // `onerror`, and the caller decides severity (the Linear MCP deploy-time
        // validation tolerates it and re-logs at warn). Logging at error here is
        // premature double-handling that surfaces a scary ERROR for an expected,
        // tolerated condition. The full error (with the stderr tail) still rides
        // `onerror` for any caller that treats it as fatal.
        this.logger.debug(`MCP transport closed early: ${err.message}`);
        this.onerror?.(err);
      }
      if (this.onclose) {
        this.onclose();
      }
      this.close();
    });

    this.isConnected = true;
  }

  public send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected || !this.stdin) {
        reject(new Error('Transport not connected'));
        return;
      }

      const success = this.stdin.write(JSON.stringify(message) + '\n');
      if (success) {
        resolve();
      } else {
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const onClose = () => {
          cleanup();
          reject(new Error('Transport stream closed while waiting for drain'));
        };
        const cleanup = () => {
          this.stdin?.removeListener('drain', onDrain);
          this.stdin?.removeListener('error', onError);
          this.stdin?.removeListener('close', onClose);
        };
        this.stdin.once('drain', onDrain);
        this.stdin.once('error', onError);
        this.stdin.once('close', onClose);
      }
    });
  }

  public async close(): Promise<void> {
    if (this.isConnected) {
      this.closeStream?.();
      this.isConnected = false;
    }
  }
}
