import { PassThrough } from 'node:stream';

import { serializeFrame } from '@packages/claude-bridge';
import type { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';

import type { BaseRuntime } from '../../../runtime/services/base-runtime';
import {
  ClaudeBridgeHandlers,
  ClaudeBridgeTransport,
} from './claude-bridge-transport';

describe('ClaudeBridgeTransport', () => {
  let stdout: PassThrough;
  let stderr: PassThrough;
  let stdin: PassThrough;
  let closeStreams: ReturnType<typeof vi.fn>;
  let runtime: BaseRuntime;
  let handlers: {
    onSdkMessage: ReturnType<typeof vi.fn>;
    onDone: ReturnType<typeof vi.fn>;
    onAborted: ReturnType<typeof vi.fn>;
    onFatal: ReturnType<typeof vi.fn>;
    onToolCallRequest: ReturnType<typeof vi.fn>;
    onQuestionRequest: ReturnType<typeof vi.fn>;
    onActivity: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    stdout = new PassThrough();
    stderr = new PassThrough();
    stdin = new PassThrough();
    closeStreams = vi.fn();
    runtime = {
      execStream: vi
        .fn()
        .mockResolvedValue({ stdin, stdout, stderr, close: closeStreams }),
    } as unknown as BaseRuntime;
    handlers = {
      onSdkMessage: vi.fn(),
      onDone: vi.fn(),
      onAborted: vi.fn(),
      onFatal: vi.fn(),
      onToolCallRequest: vi.fn(),
      onQuestionRequest: vi.fn(),
      onActivity: vi.fn(),
    };
  });

  const startTransport = async (): Promise<ClaudeBridgeTransport> => {
    const startPromise = ClaudeBridgeTransport.start({
      runtime,
      bridgePath: '/opt/geniro-claude/bridge.mjs',
      env: {},
      handlers: handlers as unknown as ClaudeBridgeHandlers,
      logger: mockDeep<DefaultLogger>(),
    });
    // Let execStream resolve and the constructor attach stream listeners
    // before the ready frame arrives.
    await new Promise((resolve) => setImmediate(resolve));
    stdout.emit(
      'data',
      Buffer.from(serializeFrame({ type: 'ready', protocolVersion: 1 })),
    );
    return await startPromise;
  };

  it('keeps pumping protocol frames after a JSON-primitive line (null) on stdout', async () => {
    // The transport promises that a stray non-protocol stdout line cannot
    // kill the pump. `null` is valid JSON, so it bypasses the invalid-line
    // callback and reaches the event dispatcher — which must not crash on it.
    // An exception here propagates as an uncaught error out of the runtime
    // stream's 'data' handler (API-process blast radius).
    const transport = await startTransport();

    expect(() => stdout.emit('data', Buffer.from('null\n'))).not.toThrow();

    stdout.emit(
      'data',
      Buffer.from(
        serializeFrame({
          type: 'sdk_message',
          message: { type: 'system', subtype: 'init', session_id: 's-1' },
        }),
      ),
    );

    expect(handlers.onSdkMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'system', session_id: 's-1' }),
    );
    expect(handlers.onFatal).not.toHaveBeenCalled();

    transport.close();
  });

  it('fails the transport instead of letting a throwing message handler escape the stdout data handler', async () => {
    // The catch in onStdout is the last guard keeping a throwing handler from
    // escaping a runtime stream's 'data' handler uncaught in the API process.
    // A handler crash must become a graceful transport-fail, not a blast.
    const transport = await startTransport();

    handlers.onSdkMessage.mockImplementation(() => {
      throw new Error('handler boom');
    });

    expect(() =>
      stdout.emit(
        'data',
        Buffer.from(
          serializeFrame({
            type: 'sdk_message',
            message: { type: 'assistant', session_id: 's-1' },
          }),
        ),
      ),
    ).not.toThrow();

    expect(handlers.onFatal).toHaveBeenCalledTimes(1);
    expect(handlers.onFatal).toHaveBeenCalledWith(
      expect.stringContaining('bridge stdout processing error'),
    );
    expect(handlers.onFatal.mock.calls[0]![0]).toContain('handler boom');

    // After the fatal, the `finished` latch must suppress further frames: a
    // second sandbox-controlled stdout frame neither re-fires onFatal nor
    // reaches the (still-throwing) handler again.
    const sdkCallsAtFatal = handlers.onSdkMessage.mock.calls.length;
    expect(() =>
      stdout.emit(
        'data',
        Buffer.from(
          serializeFrame({
            type: 'sdk_message',
            message: { type: 'assistant', session_id: 's-2' },
          }),
        ),
      ),
    ).not.toThrow();

    expect(handlers.onFatal).toHaveBeenCalledTimes(1);
    expect(handlers.onSdkMessage.mock.calls.length).toBe(sdkCallsAtFatal);

    transport.close();
  });

  it('rejects waitReady and closes the streams when the ready frame never arrives', async () => {
    vi.useFakeTimers();
    try {
      const startPromise = ClaudeBridgeTransport.start({
        runtime,
        bridgePath: '/opt/geniro-claude/bridge.mjs',
        env: {},
        handlers: handlers as unknown as ClaudeBridgeHandlers,
        logger: mockDeep<DefaultLogger>(),
        readyTimeoutMs: 5_000,
      });
      const assertion = expect(startPromise).rejects.toMatchObject({
        errorCode: 'CLAUDE_BRIDGE_NOT_READY',
      });
      await vi.advanceTimersByTimeAsync(5_001);
      await assertion;
      expect(closeStreams).toHaveBeenCalled();
      // A hung bridge gets a NOT_READY rejection, not an onFatal callback —
      // the caller never received a transport to attach a session to.
      expect(handlers.onFatal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects waitReady (not onFatal) when a fatal frame arrives before ready', async () => {
    const startPromise = ClaudeBridgeTransport.start({
      runtime,
      bridgePath: '/opt/geniro-claude/bridge.mjs',
      env: {},
      handlers: handlers as unknown as ClaudeBridgeHandlers,
      logger: mockDeep<DefaultLogger>(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    stdout.emit(
      'data',
      Buffer.from(serializeFrame({ type: 'fatal', error: 'boot exploded' })),
    );

    await expect(startPromise).rejects.toMatchObject({
      errorCode: 'CLAUDE_BRIDGE_FAILED',
    });
    expect(handlers.onFatal).not.toHaveBeenCalled();
  });

  it('reports an unexpected stream end with the pending partial line', async () => {
    const transport = await startTransport();

    stdout.emit('data', Buffer.from('{"type":"sdk_mess'));
    stdout.emit('end');

    expect(handlers.onFatal).toHaveBeenCalledWith(
      expect.stringContaining('pending: {"type":"sdk_mess'),
    );
    transport.close();
  });

  it('ignores frames after done and treats a later stream end as expected', async () => {
    const transport = await startTransport();

    stdout.emit(
      'data',
      Buffer.from(serializeFrame({ type: 'done', sessionId: 's-9' })),
    );
    expect(handlers.onDone).toHaveBeenCalledWith('s-9');

    stdout.emit(
      'data',
      Buffer.from(serializeFrame({ type: 'fatal', error: 'late' })),
    );
    stdout.emit('end');
    expect(handlers.onFatal).not.toHaveBeenCalled();

    transport.close();
  });

  it('ignores sdk_message frames without a message object (trust boundary)', async () => {
    const transport = await startTransport();

    expect(() => {
      stdout.emit('data', Buffer.from(serializeFrame({ type: 'sdk_message' })));
      stdout.emit(
        'data',
        Buffer.from(serializeFrame({ type: 'sdk_message', message: null })),
      );
      stdout.emit(
        'data',
        Buffer.from(serializeFrame({ type: 'sdk_message', message: 42 })),
      );
    }).not.toThrow();

    expect(handlers.onSdkMessage).not.toHaveBeenCalled();
    expect(handlers.onFatal).not.toHaveBeenCalled();
    transport.close();
  });

  it('forwards a valid tool_call_request with args passed through verbatim', async () => {
    const transport = await startTransport();

    stdout.emit(
      'data',
      Buffer.from(
        serializeFrame({
          type: 'tool_call_request',
          id: 'tool-1',
          toolName: 'knowledge_search_docs',
          args: { query: 'threads', nested: { deep: true } },
        }),
      ),
    );

    expect(handlers.onToolCallRequest).toHaveBeenCalledWith({
      id: 'tool-1',
      toolName: 'knowledge_search_docs',
      args: { query: 'threads', nested: { deep: true } },
    });
    transport.close();
  });

  it('drops tool_call_request frames with missing/empty id or toolName (trust boundary)', async () => {
    const transport = await startTransport();

    expect(() => {
      stdout.emit(
        'data',
        Buffer.from(serializeFrame({ type: 'tool_call_request' })),
      );
      stdout.emit(
        'data',
        Buffer.from(
          serializeFrame({ type: 'tool_call_request', id: '', toolName: 't' }),
        ),
      );
      stdout.emit(
        'data',
        Buffer.from(
          serializeFrame({ type: 'tool_call_request', id: 42, toolName: 't' }),
        ),
      );
      stdout.emit(
        'data',
        Buffer.from(
          serializeFrame({
            type: 'tool_call_request',
            id: 'tool-1',
            toolName: { evil: true },
          }),
        ),
      );
    }).not.toThrow();

    expect(handlers.onToolCallRequest).not.toHaveBeenCalled();
    expect(handlers.onFatal).not.toHaveBeenCalled();
    transport.close();
  });

  it('forwards a question_request keeping only structurally valid question entries', async () => {
    const transport = await startTransport();

    stdout.emit(
      'data',
      Buffer.from(
        serializeFrame({
          type: 'question_request',
          id: 'question-1',
          questions: [
            null,
            'garbage',
            {
              question: 'Which DB?',
              header: 'DB',
              multiSelect: false,
              options: [42, { label: 'Postgres', description: 'pg' }],
            },
            { question: 7, options: 'nope' },
          ],
        }),
      ),
    );

    expect(handlers.onQuestionRequest).toHaveBeenCalledWith({
      id: 'question-1',
      questions: [
        {
          question: 'Which DB?',
          header: 'DB',
          multiSelect: false,
          options: [{ label: 'Postgres', description: 'pg' }],
        },
        {},
      ],
    });
    transport.close();
  });

  it('drops question_request frames without a string id and survives non-array questions', async () => {
    const transport = await startTransport();

    expect(() => {
      stdout.emit(
        'data',
        Buffer.from(
          serializeFrame({ type: 'question_request', questions: [] }),
        ),
      );
      stdout.emit(
        'data',
        Buffer.from(
          serializeFrame({
            type: 'question_request',
            id: 'question-2',
            questions: { not: 'an array' },
          }),
        ),
      );
    }).not.toThrow();

    expect(handlers.onQuestionRequest).toHaveBeenCalledTimes(1);
    expect(handlers.onQuestionRequest).toHaveBeenCalledWith({
      id: 'question-2',
      questions: [],
    });
    transport.close();
  });

  it('treats a heartbeat frame as a keepalive no-op that fires onActivity only (trust boundary)', async () => {
    const transport = await startTransport();

    // onActivity fires for every stdout chunk (the ready frame already counted),
    // so measure the delta the heartbeat itself contributes.
    const activityBefore = handlers.onActivity.mock.calls.length;

    expect(() => {
      stdout.emit('data', Buffer.from(serializeFrame({ type: 'heartbeat' })));
      // Extra junk fields on a heartbeat are harmless — it carries no payload,
      // so there is nothing to structurally dereference.
      stdout.emit(
        'data',
        Buffer.from(
          serializeFrame({ type: 'heartbeat', evil: { nested: true } }),
        ),
      );
    }).not.toThrow();

    expect(handlers.onActivity.mock.calls.length).toBeGreaterThan(
      activityBefore,
    );
    expect(handlers.onSdkMessage).not.toHaveBeenCalled();
    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(handlers.onAborted).not.toHaveBeenCalled();
    expect(handlers.onFatal).not.toHaveBeenCalled();
    expect(handlers.onToolCallRequest).not.toHaveBeenCalled();
    expect(handlers.onQuestionRequest).not.toHaveBeenCalled();

    // The pump survives the heartbeat: a real frame after it still routes.
    stdout.emit(
      'data',
      Buffer.from(serializeFrame({ type: 'done', sessionId: 's-hb' })),
    );
    expect(handlers.onDone).toHaveBeenCalledWith('s-hb');

    transport.close();
  });

  it('writes tool_call_response and question_response commands to stdin', async () => {
    const transport = await startTransport();
    const written: string[] = [];
    stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()));

    transport.send({ type: 'tool_call_response', id: 'tool-1', result: 'ok' });
    transport.send({
      type: 'question_response',
      id: 'question-1',
      answers: ['Postgres'],
    });
    await new Promise((resolve) => setImmediate(resolve));

    const joined = written.join('');
    expect(joined).toContain('"type":"tool_call_response"');
    expect(joined).toContain('"id":"tool-1"');
    expect(joined).toContain('"type":"question_response"');
    expect(joined).toContain('"answers":["Postgres"]');
    transport.close();
  });

  it('sends a shutdown frame before destroying streams on close', async () => {
    const transport = await startTransport();
    const written: string[] = [];
    stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()));

    transport.close();
    await new Promise((resolve) => setImmediate(resolve));

    expect(written.join('')).toContain('"type":"shutdown"');
    expect(closeStreams).toHaveBeenCalled();
  });
});
