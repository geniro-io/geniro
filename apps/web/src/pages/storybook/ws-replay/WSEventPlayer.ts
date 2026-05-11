import { webSocketService } from '../../../services/WebSocketService';
import type { LoadedFixture } from './fixture-schema';
import type { ProgressCallback, SpeedMultiplier } from './ws-replay.types';

/**
 * Plays back a WS event fixture through the local WebSocketService event bus.
 * Uses _unsafeInjectEventForHarness so no real socket connection is required.
 *
 * Consumers must call dispose() before unmounting to prevent timer leaks.
 */
export class WSEventPlayer {
  private readonly fixture: LoadedFixture;
  private readonly onProgress: ProgressCallback;

  private index: number = 0;
  private isRunning: boolean = false;
  private speedMultiplier: SpeedMultiplier = 1;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private lastEmittedAt: number | null = null;
  // Incremented on dispose() and reset() so that any already-queued
  // setTimeout callbacks (both the outer scheduling timer and the inner
  // setTimeout(fn, 0) inside emitCurrentEvent) can detect stale captures
  // and bail out without emitting.
  private generation: number = 0;
  private disposed: boolean = false;

  constructor(fixture: LoadedFixture, onProgress: ProgressCallback) {
    this.fixture = fixture;
    this.onProgress = onProgress;
    // Emit initial progress so consumers know total immediately without
    // waiting for the first play/step/reset call.
    this.emitProgress();
  }

  /**
   * Start playback from the current index.
   * Idempotent: noop if already running or disposed.
   */
  play(): void {
    if (this.disposed) {
      return;
    }
    if (this.isRunning) {
      return;
    }
    if (this.index >= this.fixture.events.length) {
      return;
    }
    this.isRunning = true;
    this.scheduleNext();
  }

  /**
   * Pause playback at the current index.
   * Clears the pending timer; index is preserved for resume.
   */
  pause(): void {
    if (this.disposed) {
      return;
    }
    this.clearTimer();
    this.isRunning = false;
    this.emitProgress();
  }

  /**
   * Emit exactly one event at the current index, ignoring its delay.
   * Advances the index regardless of running/paused state.
   * If already running, the active timer is cancelled and re-scheduled from
   * the new index to prevent a double-advance on the next tick.
   */
  step(): void {
    if (this.disposed) {
      return;
    }
    if (this.index >= this.fixture.events.length) {
      return;
    }
    this.emitCurrentEvent();
    this.index += 1;
    this.emitProgress();
    if (this.isRunning) {
      this.clearTimer();
      this.scheduleNext();
    }
  }

  /**
   * Reset to the beginning. Clears timer, resets index, lastEmittedAt, and
   * isRunning. Does NOT emit a clear event to the bus.
   */
  reset(): void {
    if (this.disposed) {
      return;
    }
    this.generation += 1;
    this.clearTimer();
    this.index = 0;
    this.isRunning = false;
    this.lastEmittedAt = null;
    this.emitProgress();
  }

  /**
   * Update playback speed.
   * If currently running, cancels the active timer and re-schedules the next
   * event using the new multiplier.
   *
   * Note: mid-event speed changes may extend playback by up to one event's
   * delay because the elapsed portion of the current wait is not reclaimed.
   *
   * @param multiplier New speed multiplier.
   */
  setSpeed(multiplier: SpeedMultiplier): void {
    if (this.disposed) {
      return;
    }
    this.speedMultiplier = multiplier;
    if (this.isRunning) {
      this.clearTimer();
      this.scheduleNext();
    }
    this.emitProgress();
  }

  /**
   * Tear down this player. Clears any pending timer.
   * After dispose(), no further events will be emitted and all public methods
   * become no-ops. Consumers must dispose before unmount.
   */
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.clearTimer();
    this.isRunning = false;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private scheduleNext(): void {
    if (this.index >= this.fixture.events.length) {
      this.isRunning = false;
      this.emitProgress();
      return;
    }

    const fixtureEvent = this.fixture.events[this.index];
    const effectiveDelay = Math.max(
      0,
      fixtureEvent.delayMs / this.speedMultiplier,
    );

    this.timerHandle = setTimeout(() => {
      this.timerHandle = null;
      if (this.disposed) {
        return;
      }
      this.emitCurrentEvent();
      this.index += 1;
      this.emitProgress();

      if (this.isRunning) {
        this.scheduleNext();
      }
    }, effectiveDelay);
  }

  private emitCurrentEvent(): void {
    if (this.index >= this.fixture.events.length) {
      return;
    }
    const fixtureEvent = this.fixture.events[this.index];
    this.lastEmittedAt = Date.now();
    // Capture generation at call time. The isCancelled lambda is evaluated
    // inside the setTimeout(fn, 0) in WebSocketService.emitToHandlers — if
    // dispose() or reset() increments this.generation between emitCurrentEvent
    // and handler execution, the check fires and the handler is skipped.
    const capturedGen = this.generation;
    webSocketService._unsafeInjectEventForHarnessGuarded(
      fixtureEvent.event.type,
      fixtureEvent.event,
      () => capturedGen !== this.generation,
    );
  }

  private clearTimer(): void {
    if (this.timerHandle !== null) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  private emitProgress(): void {
    this.onProgress({
      index: this.index,
      total: this.fixture.events.length,
      isRunning: this.isRunning,
      lastEmittedAt: this.lastEmittedAt,
    });
  }
}
