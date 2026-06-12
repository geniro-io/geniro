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
