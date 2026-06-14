/**
 * Behavioral tests for the bridge process entrypoint (`bridge.ts`).
 *
 * The module runs `main()` at import time, so each test boots a fresh module
 * registry with `process.stdin` replaced by a PassThrough and the SDK `query`
 * mocked. Assertions target the bridge's observable protocol surfaces only:
 * what reaches the SDK streaming-input iterable, what frames appear on
 * stdout, and what diagnostics appear on stderr.
 */
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { serializeFrame } from './json-line-parser';
import type { BridgeCommand } from './protocol.types';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: mocks.query as unknown as typeof actual.query,
  };
});

/** Structural shape of the messages the bridge feeds the SDK input stream. */
type StreamedUserMessage = {
  message: { content: string | { type: string; text?: string }[] };
};

type QueryArgs = {
  prompt: string | AsyncIterable<StreamedUserMessage>;
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitMs(ms: number): Promise<void> {
  return await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractText(message: StreamedUserMessage): string {
  const content = message.message.content;
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
}

/** Background-drains the SDK streaming-input iterable into `into`. */
function drainPrompt(
  prompt: string | AsyncIterable<StreamedUserMessage>,
  into: string[],
): void {
  if (typeof prompt === 'string') {
    into.push(prompt);
    return;
  }
  void (async () => {
    for await (const message of prompt) {
      into.push(extractText(message));
    }
  })();
}

interface BridgeHarness {
  /** Writes commands as a SINGLE stdin chunk (frames coalesced on purpose). */
  sendChunk: (commands: BridgeCommand[]) => void;
  /** Writes raw bytes verbatim — for chunks that split a frame mid-line. */
  sendRaw: (raw: string) => void;
  /** Parsed JSON protocol frames the bridge wrote to stdout so far. */
  protocolFrames: () => Record<string, unknown>[];
  /** stderr lines written by the bridge's own logger so far. */
  bridgeStderrLines: () => string[];
  /** Resolves when the bridge calls process.exit (mocked, non-fatal). */
  exited: Promise<unknown>;
}

let restoreStdin: (() => void) | null = null;

async function bootBridge(): Promise<BridgeHarness> {
  const stdin = new PassThrough();
  const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', {
    value: stdin,
    configurable: true,
  });
  restoreStdin = () => {
    if (originalStdin) {
      Object.defineProperty(process, 'stdin', originalStdin);
    }
  };

  const stdoutChunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(
    (chunk: unknown): boolean => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    },
  );

  const stderrChunks: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(
    (chunk: unknown): boolean => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    },
  );

  const exitDeferred = deferred<unknown>();
  vi.spyOn(process, 'exit').mockImplementation(
    (code?: number | string | null): never => {
      exitDeferred.resolve(code ?? 0);
      return undefined as never;
    },
  );

  vi.resetModules();
  await import('./bridge');

  return {
    sendChunk: (commands: BridgeCommand[]) => {
      stdin.write(commands.map((command) => serializeFrame(command)).join(''));
    },
    sendRaw: (raw: string) => {
      stdin.write(raw);
    },
    protocolFrames: () => {
      const frames: Record<string, unknown>[] = [];
      for (const line of stdoutChunks.join('').split('\n')) {
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRecord(parsed)) {
            frames.push(parsed);
          }
        } catch {
          // non-JSON stdout noise is not a protocol frame
        }
      }
      return frames;
    },
    bridgeStderrLines: () =>
      stderrChunks
        .join('')
        .split('\n')
        .filter((line) => line.startsWith('[claude-bridge]')),
    exited: exitDeferred.promise,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.query.mockReset();
  restoreStdin?.();
  restoreStdin = null;
});

describe('bridge stdin command delivery', () => {
  it('delivers a user_message coalesced into the same stdin chunk as start to the SDK input stream', async () => {
    const injectedText = 'follow-up injected in the same pipe read as start';
    const promptTexts: string[] = [];

    mocks.query.mockImplementation((args: QueryArgs) => {
      drainPrompt(args.prompt, promptTexts);
      return (async function* () {
        // Give the bridge time to route any input frames that arrived
        // together with `start` into the streaming-input queue before the
        // turn's result closes it. On a correct bridge the coalesced
        // user_message is queued synchronously during session startup, so
        // this window is generous; on a broken bridge it NEVER arrives.
        await waitMs(75);
        yield { type: 'result', subtype: 'success', session_id: 'session-1' };
      })();
    });

    const harness = await bootBridge();

    // One write == one pipe chunk: `start` and `user_message` coalesced,
    // exactly as the host's back-to-back flush produces them.
    harness.sendChunk([
      {
        type: 'start',
        options: { prompt: 'initial turn prompt', model: 'claude-test' },
      },
      { type: 'user_message', text: injectedText },
    ]);

    await harness.exited;

    expect(promptTexts).toContain('initial turn prompt');
    expect(promptTexts).toContain(injectedText);
  });

  it('surfaces instead of silently swallowing a user_message that arrives after the turn result closed the input queue', async () => {
    const lateText = 'second injection while the session is still open';
    const promptTexts: string[] = [];
    const sessionMayEnd = deferred<void>();

    mocks.query.mockImplementation((args: QueryArgs) => {
      drainPrompt(args.prompt, promptTexts);
      return (async function* () {
        await waitMs(10);
        // First turn ends — the bridge reacts by closing the input queue —
        // but the SDK session stays open (streaming-input sessions accept
        // further injections that extend the conversation into a new turn).
        yield { type: 'result', subtype: 'success', session_id: 'session-1' };
        await sessionMayEnd.promise;
      })();
    });

    const harness = await bootBridge();

    harness.sendChunk([
      {
        type: 'start',
        options: { prompt: 'initial turn prompt', model: 'claude-test' },
      },
    ]);

    // Wait until the bridge has processed the result frame (and thus closed
    // its input queue) before injecting the late message.
    await vi.waitFor(() => {
      const sawResult = harness
        .protocolFrames()
        .some(
          (frame) =>
            frame.type === 'sdk_message' &&
            isRecord(frame.message) &&
            frame.message.type === 'result',
        );
      expect(sawResult).toBe(true);
    });

    const stderrBaseline = harness.bridgeStderrLines().length;
    harness.sendChunk([{ type: 'user_message', text: lateText }]);
    await waitMs(75);

    const reachedSession = promptTexts.includes(lateText);
    const diagnosticsAfterInjection = harness
      .bridgeStderrLines()
      .slice(stderrBaseline);
    const surfacedAsDiagnostic = diagnosticsAfterInjection.some(
      (line) =>
        line.includes(lateText) || /drop|discard|closed|reject/i.test(line),
    );

    sessionMayEnd.resolve();
    await harness.exited;

    expect(
      reachedSession || surfacedAsDiagnostic,
      `user_message after the turn result was silently swallowed: it neither reached the SDK input stream (received prompts: ${JSON.stringify(
        promptTexts,
      )}) nor produced a stderr diagnostic (bridge stderr after injection: ${JSON.stringify(
        diagnosticsAfterInjection,
      )})`,
    ).toBe(true);
  });

  it('completes a user_message whose frame is split across the start chunk and a later chunk', async () => {
    const injectedText = 'frame split across the handshake boundary';
    const promptTexts: string[] = [];

    mocks.query.mockImplementation((args: QueryArgs) => {
      drainPrompt(args.prompt, promptTexts);
      return (async function* () {
        await waitMs(75);
        yield { type: 'result', subtype: 'success', session_id: 'session-1' };
      })();
    });

    const harness = await bootBridge();

    // The host's first pipe read ends mid-frame: `start\n` plus only the prefix
    // of the user_message frame (no terminating newline). The remainder is held
    // as the start parser's partial line, seeded into the running session, and
    // completed by the second chunk.
    const userFrame = serializeFrame({
      type: 'user_message',
      text: injectedText,
    });
    const splitAt = Math.floor(userFrame.length / 2);
    const startFrame = serializeFrame({
      type: 'start',
      options: { prompt: 'initial turn prompt', model: 'claude-test' },
    });

    harness.sendRaw(startFrame + userFrame.slice(0, splitAt));
    // Let main() resolve `start`, hand off to runSession, register its stdin
    // listener, and seed the carried-over partial before the remainder lands.
    await waitMs(10);
    harness.sendRaw(userFrame.slice(splitAt));

    await harness.exited;

    expect(promptTexts).toContain('initial turn prompt');
    expect(promptTexts).toContain(injectedText);
  });

  it('aborts (not completes) the session when an interrupt is coalesced into the start chunk', async () => {
    const promptTexts: string[] = [];

    mocks.query.mockImplementation((args: QueryArgs) => {
      drainPrompt(args.prompt, promptTexts);
      // A coalesced interrupt aborts before any turn output — empty stream.
      return (async function* () {})();
    });

    const harness = await bootBridge();

    harness.sendChunk([
      {
        type: 'start',
        options: { prompt: 'initial turn prompt', model: 'claude-test' },
      },
      { type: 'interrupt' },
    ]);

    await harness.exited;

    // The replayed interrupt must end the session as `aborted`, never `done` —
    // a stopped thread must not complete a billable turn.
    const frames = harness.protocolFrames();
    expect(frames.some((frame) => frame.type === 'aborted')).toBe(true);
    expect(frames.some((frame) => frame.type === 'done')).toBe(false);
  });
});
