// @vitest-environment jsdom
//
// Adversarial edge-case tests for WSEventPlayer — authored by the F->P
// adversarial loop. These tests target real bugs in WSEventPlayer.ts and
// WebSocketService._unsafeInjectEventForHarness; they MUST fail on current code.
//
// F->P invariant: each test was verified to fail 3x on today's code before
// inclusion here. Tests that passed on current code were deleted.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SocketEventHandler } from '../../../services/WebSocketService';
import { webSocketService } from '../../../services/WebSocketService';
import type { AgentMessageNotification } from '../../../services/WebSocketTypes';
import { NotificationScope } from '../../../services/WebSocketTypes';
import type { LoadedFixture, ProgressCallback } from './ws-replay.types';
import { WSEventPlayer } from './WSEventPlayer';

// ---------------------------------------------------------------------------
// Shared fixture factory
// ---------------------------------------------------------------------------

function makeAgentMsg(
  id: string,
  threadId: string,
  graphId: string,
): AgentMessageNotification {
  return {
    type: 'agent.message',
    graphId,
    ownerId: 'owner-1',
    nodeId: 'supervisor',
    threadId,
    internalThreadId: threadId,
    scope: [NotificationScope.Graph],
    data: {
      id,
      threadId,
      nodeId: 'supervisor',
      externalThreadId: threadId,
      createdAt: '2026-04-24T00:00:00Z',
      updatedAt: '2026-04-24T00:00:00Z',
      message: { role: 'ai', content: id },
    },
  };
}

const twoEventFixture: LoadedFixture = {
  name: 'edge-test',
  description: 'two-event fixture for adversarial tests',
  threadId: 'thread-edge',
  graphId: 'graph-edge',
  events: [
    { delayMs: 100, event: makeAgentMsg('ev0', 'thread-edge', 'graph-edge') },
    { delayMs: 200, event: makeAgentMsg('ev1', 'thread-edge', 'graph-edge') },
  ],
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('WSEventPlayer — adversarial edge cases', () => {
  let spy: ReturnType<typeof vi.fn<SocketEventHandler>>;
  let progressSpy: ReturnType<typeof vi.fn<ProgressCallback>>;

  beforeEach(() => {
    vi.useFakeTimers();
    spy = vi.fn<SocketEventHandler>();
    progressSpy = vi.fn<ProgressCallback>();
    webSocketService.on('agent.message', spy);
  });

  afterEach(() => {
    webSocketService.off('agent.message', spy);
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // H2: dispose() after outer timer fires but before inner setTimeout(fn,0)
  //     handler-wrapper completes must suppress handler delivery.
  //
  // Root cause: emitToHandlers() wraps each handler in setTimeout(fn, 0).
  // clearTimer() in dispose() only cancels the outer scheduling timer via
  // clearTimeout; it has no mechanism to cancel already-queued
  // setTimeout(fn, 0) callbacks that were scheduled before dispose() ran.
  //
  // Reproduction:
  //   1. play() — schedules outer 100ms timer
  //   2. advanceTimersByTime(100) — fires outer timer: timerHandle set to null,
  //      emitCurrentEvent queues setTimeout(fn, 0) for spy, index→1,
  //      scheduleNext() schedules outer 200ms timer
  //   3. dispose() — clearTimer() cancels the 200ms timer; isRunning=false;
  //      does NOT (and cannot) cancel the already-queued setTimeout(fn, 0)
  //   4. advanceTimersByTime(1) — the queued setTimeout(fn, 0) fires,
  //      delivering ev0 to spy — POST-DISPOSE emission
  //
  // Fix direction: track a "disposed" boolean and skip handler calls when
  // disposed is true, or use AbortController / generation counter to
  // invalidate queued callbacks.
  // -----------------------------------------------------------------------
  it('dispose() called after outer timer body runs but before inner handler-wrapper fires must not deliver the event', () => {
    const player = new WSEventPlayer(twoEventFixture, progressSpy);
    player.play();

    // Advance EXACTLY to the outer timer deadline — the 100ms timer fires,
    // emitting via emitToHandlers() which schedules setTimeout(fn, 0) for
    // the handler spy. Do NOT advance the extra 1ms that would flush the
    // inner timeout.
    vi.advanceTimersByTime(100);

    // At this point the outer timer has fired (timerHandle is null, index→1,
    // a 200ms outer timer for ev1 is pending), but the inner
    // setTimeout(fn, 0) wrapping spy has NOT yet executed.
    // dispose() should suppress all further delivery — including this one.
    player.dispose();

    // Flush the inner setTimeout(fn, 0) — this is where the bug manifests.
    // If dispose() did not suppress it, spy will be called once here.
    vi.advanceTimersByTime(1);

    // After dispose, spy must remain at 0 calls.
    // CURRENT BEHAVIOR (bug): spy is called 1 time because clearTimer() cannot
    // cancel the already-queued setTimeout(fn, 0) from emitToHandlers().
    expect(spy).toHaveBeenCalledTimes(0);
  });

  // -----------------------------------------------------------------------
  // H9: reset() called after outer timer fires but before inner
  //     setTimeout(fn,0) completes delivers a stale event AFTER reset.
  //
  // Same root cause as H2: emitToHandlers() wraps handlers in setTimeout(fn,0).
  // reset() calls clearTimer() (cancels the next scheduling timer) but cannot
  // cancel already-queued setTimeout(fn, 0) callbacks from the current event.
  //
  // Consequence: the consumer receives an event from the pre-reset state
  // AFTER reset() returns, causing the display to show data from the
  // previous playback position. This corrupts the "clean slate" guarantee
  // that reset() is supposed to provide.
  //
  // Reproduction:
  //   1. play() — schedules outer 100ms timer
  //   2. advanceTimersByTime(100) — fires outer timer: timerHandle=null,
  //      emitCurrentEvent queues setTimeout(fn, 0) for spy with ev0, index→1
  //   3. reset() — clearTimer() cancels outer 200ms timer; index→0; isRunning=false
  //   4. advanceTimersByTime(1) — stale setTimeout(fn, 0) fires → spy called with ev0
  //   5. spy.mock.calls[0][0].data.id === 'ev0' even though we're back at index 0
  //
  // Fix direction: same as H2 — disposed/generation flag checked inside
  // the setTimeout callback before calling the handler.
  // -----------------------------------------------------------------------
  it('reset() called after outer timer fires but before handler callback executes delivers no stale events post-reset', () => {
    const player = new WSEventPlayer(twoEventFixture, progressSpy);
    player.play();

    // Fire the outer 100ms timer (schedules inner setTimeout(fn,0) for ev0).
    vi.advanceTimersByTime(100);

    // reset() — should establish a clean state. index→0, isRunning=false.
    player.reset();

    // Flush the inner setTimeout(fn, 0) that was already queued before reset.
    vi.advanceTimersByTime(1);

    // spy must NOT have been called — the event was queued before reset but
    // should be suppressed because the player was reset.
    // CURRENT BEHAVIOR (bug): spy is called once with ev0 because
    // clearTimer() inside reset() cannot reach already-queued setTimeout callbacks.
    expect(spy).toHaveBeenCalledTimes(0);
  });
});
