import { randomUUID } from 'node:crypto';

import { Sandbox } from '@daytonaio/sdk';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { DefaultLogger } from '@packages/common';

import { buildEnvPrefix } from '../../runtime/runtime.utils';

const STDERR_MAX_BYTES = 64 * 1024;
const SEND_RETRY_ATTEMPTS = 10;
const SEND_RETRY_DELAY_MS = 500;

/**
 * MCP transport that communicates with an MCP server running inside a Daytona sandbox.
 *
 * Uses Daytona's session-based process API:
 * - Creates a dedicated session per transport instance
 * - Launches the MCP server command asynchronously via executeSessionCommand
 * - Streams stdout/stderr via getSessionCommandLogs with callbacks
 * - Sends JSON-RPC messages to the process stdin via sendSessionCommandInput
 *
 * NOTE: Daytona's log stream echoes stdin data back as stdout.  To prevent the
 * MCP client from misinterpreting its own outgoing messages as server responses,
 * every serialized line we send is added to `pendingEchoLines` and stripped from
 * the stdout stream on first match.
 */
export class DaytonaExecTransport implements Transport {
  private readonly daytonaSessionId = `mcp-${randomUUID()}`;
  private cmdId: string | null = null;
  private buffer = '';
  private stderrTail = '';
  private sawAnyMessage = false;
  private isConnected = false;

  /** Lines we sent via stdin that we expect to see echoed back on stdout. */
  private readonly pendingEchoLines = new Set<string>();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly logger: DefaultLogger,
  ) {}

  private appendStderrTail(chunk: string): void {
    if (!chunk) {
      return;
    }
    if (!this.stderrTail) {
      this.stderrTail =
        chunk.length <= STDERR_MAX_BYTES
          ? chunk
          : chunk.slice(chunk.length - STDERR_MAX_BYTES);
      return;
    }
    const combined = this.stderrTail + chunk;
    this.stderrTail =
      combined.length <= STDERR_MAX_BYTES
        ? combined
        : combined.slice(combined.length - STDERR_MAX_BYTES);
  }

  private buildEarlyCloseError(): Error {
    const cmd = [this.command, ...this.args].join(' ');
    const stderr = this.stderrTail.trim();
    const suffix = stderr ? `\n\nstderr (tail):\n${stderr}` : '';
    return new Error(
      `MCP transport closed before handshake. Command: ${cmd}${suffix}`,
    );
  }

  private processStdoutChunk(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      // Daytona echoes stdin back on stdout — skip lines we sent ourselves.
      if (this.pendingEchoLines.has(trimmed)) {
        this.pendingEchoLines.delete(trimmed);
        continue;
      }

      try {
        const message = JSON.parse(trimmed) as JSONRPCMessage;
        this.sawAnyMessage = true;
        this.onmessage?.(message);
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error : new Error(String(error)),
          `Failed to parse MCP message: ${trimmed}`,
        );
      }
    }
  }

  public async start(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    await this.sandbox.process.createSession(this.daytonaSessionId);

    const envPrefix = buildEnvPrefix(this.env);
    const fullCmd = `${envPrefix}${this.command} ${this.args.join(' ')}`;

    // suppressInputEcho: true asks the toolbox to suppress stdin echo server-side.
    // pendingEchoLines provides a client-side fallback for toolbox versions that
    // ignore the flag or MCP servers with their own echo behavior.
    const { cmdId } = await this.sandbox.process.executeSessionCommand(
      this.daytonaSessionId,
      { command: fullCmd, runAsync: true, suppressInputEcho: true },
    );
    this.cmdId = cmdId;

    // Stream logs with callbacks. The promise resolves when the process exits
    // or the stream closes.
    void this.sandbox.process
      .getSessionCommandLogs(
        this.daytonaSessionId,
        cmdId,
        (chunk: string) => this.processStdoutChunk(chunk),
        (chunk: string) => this.appendStderrTail(chunk),
      )
      .then(() => {
        // If close() was already called, isConnected is already false — don't fire callbacks again.
        if (!this.isConnected) {
          return;
        }
        // Stream resolved — process exited.
        if (!this.sawAnyMessage && this.stderrTail.trim()) {
          const err = this.buildEarlyCloseError();
          // debug, not error: the early close is propagated via `onerror` and
          // the caller decides severity (the Linear MCP deploy-time validation
          // tolerates it). Logging at error here is premature double-handling
          // that surfaces a scary ERROR for an expected, tolerated condition.
          this.logger.debug(`MCP transport closed early: ${err.message}`);
          this.onerror?.(err);
        }
        this.isConnected = false;
        this.onclose?.();
      })
      .catch(() => {
        // Log stream errors are non-actionable here; the transport
        // will surface problems via onerror/onclose as needed.
      });

    this.isConnected = true;
  }

  public async send(message: JSONRPCMessage): Promise<void> {
    if (!this.isConnected || !this.cmdId) {
      throw new Error('Transport not connected');
    }

    const data = JSON.stringify(message) + '\n';

    // Register the line so the echo filter in processStdoutChunk can skip it.
    this.pendingEchoLines.add(data.trim());

    // The input pipe may not exist yet when the async command is still starting.
    // Retry with backoff to handle this race condition.
    for (let attempt = 1; attempt <= SEND_RETRY_ATTEMPTS; attempt++) {
      try {
        await this.sandbox.process.sendSessionCommandInput(
          this.daytonaSessionId,
          this.cmdId,
          data,
        );
        return;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isInputPipeNotReady =
          msg.includes('input.pipe') || msg.includes('no such file');

        if (isInputPipeNotReady && attempt < SEND_RETRY_ATTEMPTS) {
          this.logger.debug(
            `MCP send: input pipe not ready, retrying (${attempt}/${SEND_RETRY_ATTEMPTS})...`,
          );
          await new Promise((r) => setTimeout(r, SEND_RETRY_DELAY_MS));
          continue;
        }

        // Clean up the echo entry since we failed to send.
        this.pendingEchoLines.delete(data.trim());

        const err = error instanceof Error ? error : new Error(msg);
        this.onerror?.(err);
        throw err;
      }
    }
  }

  public async close(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    this.isConnected = false;

    try {
      await this.sandbox.process.deleteSession(this.daytonaSessionId);
    } catch {
      // Session may already be gone
    }

    this.onclose?.();
  }
}
