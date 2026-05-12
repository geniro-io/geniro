// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ThreadStoreUpdateNotification } from './WebSocketTypes';

// Capture every `socket.on(event, handler)` registration the service makes
// against the mocked socket.io client. Hoisted so vi.mock factory can close
// over it before the module under test is imported.
const mocks = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  const registeredHandlers = new Map<string, Handler[]>();
  const mockSocket = {
    on: vi.fn((event: string, handler: Handler) => {
      const list = registeredHandlers.get(event) ?? [];
      list.push(handler);
      registeredHandlers.set(event, list);
      return mockSocket;
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connected: false,
    id: 'mock-socket-id',
  };
  return { registeredHandlers, mockSocket };
});

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mocks.mockSocket),
  Socket: class {},
}));

describe('WebSocketService — socket.on registrations', () => {
  beforeEach(async () => {
    mocks.registeredHandlers.clear();
    mocks.mockSocket.on.mockClear();
    mocks.mockSocket.emit.mockClear();
    mocks.mockSocket.disconnect.mockClear();
    // Reset module state so each test starts with a fresh service instance
    // (the singleton holds connection state across tests otherwise).
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers a socket-level listener for thread.store.update events', async () => {
    // Importing after vi.resetModules + vi.mock('socket.io-client') guarantees
    // the freshly-imported service binds the mocked io() function.
    const { webSocketService } = await import('./WebSocketService');

    webSocketService.connect('test-jwt-token');

    // Every event the panel can subscribe to MUST have a corresponding
    // socket.on(event, ...) call inside setupEventListeners — otherwise the
    // real socket.io transport delivers the event but the service never
    // forwards it to the local handler bus. That is the bug this test exists
    // to catch.
    const registeredEvents = Array.from(mocks.registeredHandlers.keys());

    expect(registeredEvents).toContain('thread.store.update');
  });

  it('forwards a thread.store.update payload from socket.io to registered handlers', async () => {
    const { webSocketService } = await import('./WebSocketService');
    vi.useFakeTimers();

    const handler = vi.fn();
    webSocketService.on('thread.store.update', handler);
    webSocketService.connect('test-jwt-token');

    // Find the socket-level listener the service installed. If none exists,
    // this test fails at the !storeListener guard below — which is the
    // failure signature for the missing-listener bug.
    const storeListeners = mocks.registeredHandlers.get('thread.store.update');
    expect(storeListeners?.length ?? 0).toBeGreaterThanOrEqual(1);
    const storeListener = storeListeners![0]!;

    const notification: ThreadStoreUpdateNotification = {
      type: 'thread.store.update',
      graphId: 'graph-1',
      ownerId: 'owner-1',
      threadId: 'graph-1:thread-1',
      data: {
        externalThreadId: 'graph-1:thread-1',
        namespace: 'plan',
        key: 'root',
        mode: 'kv',
        action: 'put',
        authorAgentId: 'root',
      },
    };

    // Simulate the socket.io transport delivering the event.
    storeListener(notification);
    // emitToHandlers schedules with setTimeout(fn, 0); flush it.
    vi.advanceTimersByTime(1);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(notification);

    webSocketService.off('thread.store.update', handler);
  });
});
