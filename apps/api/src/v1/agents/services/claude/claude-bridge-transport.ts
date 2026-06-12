import { Duplex, PassThrough } from 'node:stream';

import {
  BridgeCommand,
  BridgeEvent,
  JsonLineParser,
  sanitizeBridgeQuestions,
  SdkMessage,
  serializeFrame,
} from '@packages/claude-bridge';
import { DefaultLogger, InternalException } from '@packages/common';

import { BaseRuntime } from '../../../runtime/services/base-runtime';
import {
  ClaudeQuestionRequest,
  ClaudeToolCallRequest,
} from './claude-session.types';

export type ClaudeBridgeHandlers = {
  onSdkMessage: (message: SdkMessage) => void;
  onDone: (sessionId?: string) => void;
  onAborted: (sessionId?: string) => void;
  onFatal: (error: string) => void;
  /** Fired on every stdout chunk — the keepalive hook. */
  onActivity?: () => void;
  /** Proxied Geniro tool invocation; reply via send({type: 'tool_call_response', ...}). */
  onToolCallRequest?: (request: ClaudeToolCallRequest) => void;
  /** Intercepted AskUserQuestion; reply via send({type: 'question_response', ...}). */
  onQuestionRequest?: (request: ClaudeQuestionRequest) => void;
};

type BridgeStreams = {
  stdin: Duplex;
  stdout: PassThrough;
  stderr: PassThrough;
  close: () => void;
};

const DEFAULT_READY_TIMEOUT_MS = 60_000;

/**
 * Host side of the JSON-line stdio protocol: owns the runtime exec session
 * running `node bridge.mjs` inside the sandbox and pumps frames both ways.
 * Modeled on agent-mcp's DockerExecTransport (the proven exec-stream seam),
 * with split-chunk-safe parsing via the shared JsonLineParser.
 */
export class ClaudeBridgeTransport {
  private readonly parser = new JsonLineParser<BridgeEvent>();
  private finished = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  private constructor(
    private readonly streams: BridgeStreams,
    private readonly handlers: ClaudeBridgeHandlers,
    private readonly logger: DefaultLogger,
  ) {
    this.streams.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.streams.stderr.on('data', (chunk: Buffer) => {
      this.logger.debug(`[claude-bridge stderr] ${chunk.toString().trim()}`);
    });
    this.streams.stdout.on('end', () => this.onStreamEnd());
    this.streams.stdout.on('error', (error: Error) =>
      this.fail(`bridge stdout error: ${error.message}`),
    );
    this.streams.stdin.on('error', (error: Error) =>
      this.fail(`bridge stdin error: ${error.message}`),
    );
  }

  static async start(params: {
    runtime: BaseRuntime;
    bridgePath: string;
    env: Record<string, string>;
    workdir?: string;
    handlers: ClaudeBridgeHandlers;
    logger: DefaultLogger;
    readyTimeoutMs?: number;
  }): Promise<ClaudeBridgeTransport> {
    const streams = await params.runtime.execStream(
      ['node', params.bridgePath],
      {
        env: params.env,
        ...(params.workdir !== undefined && { workdir: params.workdir }),
      },
    );

    const transport = new ClaudeBridgeTransport(
      streams,
      params.handlers,
      params.logger,
    );
    await transport.waitReady(
      params.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    );
    return transport;
  }

  send(command: BridgeCommand): void {
    if (this.finished) {
      return;
    }
    this.streams.stdin.write(serializeFrame(command));
  }

  /** True once the session settled (done/aborted/fatal/closed) — sends are no-ops. */
  isFinished(): boolean {
    return this.finished;
  }

  interrupt(): void {
    this.send({ type: 'interrupt' });
  }

  close(): void {
    if (!this.finished) {
      // Ask the bridge process to exit before tearing the streams down —
      // destroying the hijacked streams alone leaves `node bridge.mjs`
      // blocked on stdin forever inside a long-lived container.
      try {
        this.streams.stdin.write(serializeFrame({ type: 'shutdown' }));
      } catch {
        // stream may already be unwritable; the bridge's stdin-end handler
        // is the fallback exit path.
      }
    }
    this.finished = true;
    try {
      this.streams.close();
    } catch (error) {
      this.logger.debug(
        `Error closing bridge streams: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async waitReady(timeoutMs: number): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyResolve = null;
        this.readyReject = null;
        this.close();
        reject(
          new InternalException(
            'CLAUDE_BRIDGE_NOT_READY',
            `Claude bridge did not become ready within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.readyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.readyReject = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  private onStdout(chunk: Buffer): void {
    this.handlers.onActivity?.();

    // A synchronous throw here escapes as an uncaught error from the runtime
    // stream's 'data' handler (API-process blast radius) — fail the transport
    // instead. The stdout bytes are sandbox-controlled; assume the worst.
    try {
      const events = this.parser.push(chunk, (line, error) => {
        this.logger.debug(
          `Ignoring non-protocol bridge stdout line (${error.message}): ${line.slice(0, 200)}`,
        );
      });

      for (const event of events) {
        this.handleEvent(event);
      }
    } catch (error) {
      this.fail(
        `bridge stdout processing error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private handleEvent(event: BridgeEvent): void {
    if (this.finished) {
      return;
    }

    // `null` and other non-object lines are valid JSON and pass the parser's
    // invalid-line guard; touching `.type` on them would throw synchronously
    // inside the runtime stream's 'data' handler (uncaught in the API process).
    if (typeof event !== 'object' || event === null) {
      this.logger.debug(
        `Ignoring non-object bridge frame: ${JSON.stringify(event)?.slice(0, 200)}`,
      );
      return;
    }

    switch (event.type) {
      case 'ready': {
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
        return;
      }
      case 'sdk_message': {
        // The payload crosses a trust boundary (sandbox processes can write
        // to the bridge's stdout fd) — a missing/non-object `message` would
        // throw inside this stream 'data' handler, uncaught in the API process.
        const message = event.message as SdkMessage | undefined;
        if (typeof message !== 'object' || message === null) {
          this.logger.debug(
            'Ignoring sdk_message frame without a message object',
          );
          return;
        }
        this.handlers.onSdkMessage(message);
        return;
      }
      // For both request kinds: a malformed frame is dropped without a
      // response (there is no trustworthy id to answer on). The bridge's
      // pending promise self-heals via the SDK's MCP stream timeout; only a
      // hostile in-sandbox writer produces such frames in the first place.
      case 'tool_call_request': {
        const id =
          typeof event.id === 'string' && event.id !== '' ? event.id : null;
        const toolName =
          typeof event.toolName === 'string' && event.toolName !== ''
            ? event.toolName
            : null;
        if (!id || !toolName) {
          this.logger.debug('Ignoring malformed tool_call_request frame');
          return;
        }
        this.handlers.onToolCallRequest?.({ id, toolName, args: event.args });
        return;
      }
      case 'question_request': {
        const id =
          typeof event.id === 'string' && event.id !== '' ? event.id : null;
        if (!id) {
          this.logger.debug('Ignoring malformed question_request frame');
          return;
        }
        this.handlers.onQuestionRequest?.({
          id,
          questions: sanitizeBridgeQuestions(event.questions),
        });
        return;
      }
      case 'done': {
        this.finished = true;
        this.handlers.onDone(event.sessionId);
        return;
      }
      case 'aborted': {
        this.finished = true;
        this.handlers.onAborted(event.sessionId);
        return;
      }
      case 'fatal': {
        this.fail(event.error);
        return;
      }
    }
  }

  private onStreamEnd(): void {
    if (this.finished) {
      return;
    }
    const pending = this.parser.pending();
    this.fail(
      `bridge stream ended unexpectedly${pending ? ` (pending: ${pending.slice(0, 200)})` : ''}`,
    );
  }

  private fail(error: string): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const exception = new InternalException('CLAUDE_BRIDGE_FAILED', error);
    if (this.readyReject) {
      const reject = this.readyReject;
      this.readyResolve = null;
      this.readyReject = null;
      reject(exception);
      return;
    }
    this.handlers.onFatal(error);
  }
}
