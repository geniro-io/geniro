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

/** `canUseTool` as the bridge passes it into the SDK query options. */
type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: unknown,
) => Promise<unknown>;

/** Query args augmented with the options surface the M4 spike inspects. */
type QueryArgsWithOptions = QueryArgs & {
  options?: { canUseTool?: CanUseToolFn };
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

  it('emits keepalive heartbeat frames on a timer while a session runs', async () => {
    // A small interval (the host can tune it via env) lets the assertion use the
    // same real-timer harness as the rest of this file — several ticks land
    // inside an 80ms turn that produces no other stdout.
    process.env.GENIRO_CLAUDE_BRIDGE_HEARTBEAT_MS = '15';
    try {
      mocks.query.mockImplementation((args: QueryArgs) => {
        drainPrompt(args.prompt, []);
        return (async function* () {
          await waitMs(80);
          yield { type: 'result', subtype: 'success', session_id: 'session-1' };
        })();
      });

      const harness = await bootBridge();
      harness.sendChunk([
        {
          type: 'start',
          options: { prompt: 'initial turn prompt', model: 'claude-test' },
        },
      ]);

      await harness.exited;

      const frames = harness.protocolFrames();
      const heartbeats = frames.filter((frame) => frame.type === 'heartbeat');
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);
      // The timer is cleared on session end: the terminal `done`/`result` frames
      // are the last protocol frames, with no heartbeat after them.
      const lastHeartbeatIdx = frames.lastIndexOf(
        heartbeats[heartbeats.length - 1]!,
      );
      const doneIdx = frames.findIndex((frame) => frame.type === 'done');
      expect(doneIdx).toBeGreaterThan(-1);
      expect(lastHeartbeatIdx).toBeLessThan(doneIdx);
    } finally {
      delete process.env.GENIRO_CLAUDE_BRIDGE_HEARTBEAT_MS;
    }
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

  it('exits without launching a session when shutdown/interrupt arrives before start', async () => {
    // A stop landing while the bridge is still booting (before `start`) must
    // never reach `query()` — the handshake rejects, main() emits fatal and
    // exits, and no billable session begins. Covers the pre-start abort branch.
    mocks.query.mockImplementation(() => (async function* () {})());

    const harness = await bootBridge();
    harness.sendChunk([{ type: 'shutdown' }]);

    await harness.exited;

    expect(mocks.query).not.toHaveBeenCalled();
    const frames = harness.protocolFrames();
    expect(frames.some((frame) => frame.type === 'fatal')).toBe(true);
    expect(
      frames.some((frame) => frame.type === 'done' || frame.type === 'aborted'),
    ).toBe(false);
  });
});

describe('bridge in-session question answering (M4 step-1 spike)', () => {
  // Spike for the in-session inter-agent ask-back path: prove the bridge can
  // answer an intercepted AskUserQuestion IN PLACE via a `question_response`
  // command (NOT `interrupt`) and let the SAME SDK session continue to its
  // result with the answer incorporated. The SDK `query` is mocked here, so
  // this exercises the bridge's `canUseTool` -> `question_request` ->
  // `question_response` plumbing end-to-end through the stdio protocol; it does
  // NOT exercise the live Anthropic SDK's own resume semantics (that is an SDK
  // contract the host-side resume path layers on top — see the step-1 approval
  // checkpoint).
  it('resolves a pending AskUserQuestion via question_response (not interrupt) and the SAME session continues to a result with the answer incorporated', async () => {
    const promptTexts: string[] = [];
    let questionDecision: unknown;
    const decisionMade = deferred<void>();

    mocks.query.mockImplementation((args: QueryArgsWithOptions) => {
      drainPrompt(args.prompt, promptTexts);
      return (async function* () {
        // The SDK reaches an AskUserQuestion mid-turn: it invokes the bridge's
        // canUseTool and AWAITS the host's answer. On a correct bridge this
        // emits a question_request frame and blocks until a question_response
        // command resolves it — without ending the turn.
        const canUseTool = args.options?.canUseTool;
        if (!canUseTool) {
          throw new Error('bridge did not pass canUseTool to the SDK query');
        }
        const decision = await canUseTool(
          'AskUserQuestion',
          {
            questions: [
              {
                question: 'Which database?',
                header: 'DB',
                multiSelect: false,
                options: [
                  { label: 'Postgres', description: 'pg' },
                  { label: 'MySQL', description: 'my' },
                ],
              },
            ],
          },
          {},
        );
        questionDecision = decision;
        decisionMade.resolve();
        // The answer was incorporated; the SAME session continues to its result
        // — no interrupt, no aborted frame.
        yield { type: 'result', subtype: 'success', session_id: 'session-1' };
      })();
    });

    const harness = await bootBridge();
    harness.sendChunk([
      {
        type: 'start',
        options: { prompt: 'initial turn prompt', model: 'claude-test' },
      },
    ]);

    // The bridge must forward the intercepted question to the host as a
    // question_request before any answer can be supplied.
    let questionId: string | undefined;
    await vi.waitFor(() => {
      const frame = harness
        .protocolFrames()
        .find((f) => f.type === 'question_request');
      expect(frame).toBeDefined();
      questionId = (frame as { id?: string }).id;
      expect(typeof questionId).toBe('string');
    });

    // Answer in place — question_response, NOT interrupt.
    harness.sendChunk([
      { type: 'question_response', id: questionId!, answers: ['Postgres'] },
    ]);

    await decisionMade.promise;
    await harness.exited;

    const frames = harness.protocolFrames();
    // The host's answer reached the SDK as the AskUserQuestion result.
    expect(questionDecision).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which database?': 'Postgres' } },
    });
    // The same session continued to a result and ended cleanly (done), never
    // aborted — the live-answer path does not tear the turn down.
    expect(
      frames.some(
        (f) =>
          f.type === 'sdk_message' &&
          isRecord(f.message) &&
          f.message.type === 'result',
      ),
    ).toBe(true);
    expect(frames.some((f) => f.type === 'done')).toBe(true);
    expect(frames.some((f) => f.type === 'aborted')).toBe(false);
  });
});
