import { Duplex, PassThrough } from 'node:stream';

import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCommand,
  type BridgeEvent,
  type BridgeQuestion,
  type BridgeStartOptions,
  JsonLineParser,
  type SdkMessage,
  type SdkUsage,
  serializeFrame,
} from '@packages/claude-bridge';

/**
 * In-process stand-in for the sandbox-side Claude bridge process. Integration
 * tests register a scenario (via `MockRuntimeService.queueBridge`) that scripts
 * the bridge→host frame sequence a real `node bridge.mjs` would emit, and
 * `MockRuntime.execStream` plays it. The scenario drives the conversation: it
 * emits assistant/tool-call/question/result frames on stdout and can react to
 * host commands (`tool_call_response`, `user_message`, `interrupt`, `shutdown`)
 * via `onCommand`. This is the seam that lets a full `ClaudeAgent.run()` exercise
 * the real transport → stream-mapper → persistence path without a subprocess.
 */

const DEFAULT_SESSION_ID = 'mock-session';

export interface MockBridgeSession {
  /** The `start` options the host sent (prompt, model, tools, resume, …). */
  readonly startOptions: BridgeStartOptions;
  /** Host→bridge commands received after `start`, in order. */
  readonly commands: BridgeCommand[];
  /** Low-level: emit any bridge frame. */
  emit(frame: BridgeEvent): void;
  emitSdkMessage(message: SdkMessage): void;
  /** Emit an assistant turn message; `parentToolUseId` marks an SDK subagent. */
  emitAssistant(opts?: {
    text?: string;
    model?: string;
    usage?: SdkUsage;
    parentToolUseId?: string | null;
    sessionId?: string;
  }): void;
  emitToolCallRequest(id: string, toolName: string, args: unknown): void;
  emitQuestionRequest(id: string, questions: BridgeQuestion[]): void;
  emitResult(opts?: {
    subtype?: string;
    isError?: boolean;
    totalCostUsd?: number;
    usage?: SdkUsage;
    sessionId?: string;
  }): void;
  done(sessionId?: string): void;
  aborted(sessionId?: string): void;
  fatal(error: string): void;
  /** React to host→bridge commands (tool results, injections, interrupt). */
  onCommand(handler: (command: BridgeCommand) => void): void;
}

export type MockBridgeScenario = (
  session: MockBridgeSession,
) => void | Promise<void>;

class MockBridgeSessionImpl implements MockBridgeSession {
  readonly commands: BridgeCommand[] = [];
  private readonly handlers: ((command: BridgeCommand) => void)[] = [];
  private messageCounter = 0;

  constructor(
    readonly startOptions: BridgeStartOptions,
    private readonly write: (frame: BridgeEvent) => void,
  ) {}

  emit(frame: BridgeEvent): void {
    this.write(frame);
  }

  emitSdkMessage(message: SdkMessage): void {
    this.write({ type: 'sdk_message', message });
  }

  emitAssistant(
    opts: {
      text?: string;
      model?: string;
      usage?: SdkUsage;
      parentToolUseId?: string | null;
      sessionId?: string;
    } = {},
  ): void {
    this.messageCounter += 1;
    this.emitSdkMessage({
      type: 'assistant',
      session_id: opts.sessionId ?? DEFAULT_SESSION_ID,
      parent_tool_use_id: opts.parentToolUseId ?? null,
      message: {
        id: `mock-msg-${this.messageCounter}`,
        ...(opts.model !== undefined && { model: opts.model }),
        content: [{ type: 'text', text: opts.text ?? '' }],
        ...(opts.usage !== undefined && { usage: opts.usage }),
      },
    });
  }

  emitToolCallRequest(id: string, toolName: string, args: unknown): void {
    this.write({ type: 'tool_call_request', id, toolName, args });
  }

  emitQuestionRequest(id: string, questions: BridgeQuestion[]): void {
    this.write({ type: 'question_request', id, questions });
  }

  emitResult(
    opts: {
      subtype?: string;
      isError?: boolean;
      totalCostUsd?: number;
      usage?: SdkUsage;
      sessionId?: string;
    } = {},
  ): void {
    this.emitSdkMessage({
      type: 'result',
      subtype: opts.subtype ?? 'success',
      session_id: opts.sessionId ?? DEFAULT_SESSION_ID,
      ...(opts.isError !== undefined && { is_error: opts.isError }),
      ...(opts.totalCostUsd !== undefined && {
        total_cost_usd: opts.totalCostUsd,
      }),
      ...(opts.usage !== undefined && { usage: opts.usage }),
    });
  }

  done(sessionId: string = DEFAULT_SESSION_ID): void {
    this.write({ type: 'done', sessionId });
  }

  aborted(sessionId: string = DEFAULT_SESSION_ID): void {
    this.write({ type: 'aborted', sessionId });
  }

  fatal(error: string): void {
    this.write({ type: 'fatal', error });
  }

  onCommand(handler: (command: BridgeCommand) => void): void {
    this.handlers.push(handler);
  }

  deliver(command: BridgeCommand): void {
    this.commands.push(command);
    for (const handler of this.handlers) {
      handler(command);
    }
  }
}

/**
 * Build the duplex streams `MockRuntime.execStream` returns for a bridge launch.
 * Emits `ready` once the transport has attached its listeners, then runs the
 * next queued scenario when the host's `start` frame arrives. With no scenario
 * queued, the turn completes immediately (`done`) — a benign no-op default.
 */
export function createMockBridgeStreams(
  takeScenario: () => MockBridgeScenario | undefined,
): {
  stdin: Duplex;
  stdout: PassThrough;
  stderr: PassThrough;
  close: () => void;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const parser = new JsonLineParser<BridgeCommand>();
  let closed = false;
  let session: MockBridgeSessionImpl | undefined;

  const write = (frame: BridgeEvent): void => {
    if (!closed && stdout.writable) {
      stdout.write(serializeFrame(frame));
    }
  };

  // Ready must land after ClaudeBridgeTransport.start attaches stream listeners
  // (it does so synchronously in the constructor before awaiting waitReady).
  setImmediate(() =>
    write({ type: 'ready', protocolVersion: BRIDGE_PROTOCOL_VERSION }),
  );

  stdin.on('data', (chunk: Buffer) => {
    const commands = parser.push(chunk);
    for (const command of commands) {
      if (typeof command !== 'object' || command === null) {
        continue;
      }
      if (command.type === 'start') {
        session = new MockBridgeSessionImpl(command.options, write);
        const scenario = takeScenario();
        if (scenario) {
          void Promise.resolve(scenario(session)).catch((err: unknown) =>
            write({
              type: 'fatal',
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        } else {
          write({ type: 'done', sessionId: DEFAULT_SESSION_ID });
        }
      } else if (session) {
        session.deliver(command);
      }
    }
  });

  return {
    stdin,
    stdout,
    stderr,
    close: () => {
      closed = true;
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}
