import { describe, expect, it } from 'vitest';

import { ThreadStatus } from '../threads.types';
import { ThreadStatusTransitionService } from './thread-status-transition.service';

const NOW = new Date('2026-04-24T12:00:00Z');
const EARLIER = new Date('2026-04-24T11:59:50Z'); // 10000ms before NOW

function makeService(): ThreadStatusTransitionService {
  return new ThreadStatusTransitionService();
}

function makeCurrent(
  status: ThreadStatus,
  runningStartedAt: Date | null = null,
  totalRunningMs: number | string = 0,
) {
  return { status, runningStartedAt, totalRunningMs: totalRunningMs as number };
}

describe('ThreadStatusTransitionService', () => {
  describe('* → Running (from each non-Running status)', () => {
    const nonRunningStatuses = [
      ThreadStatus.Waiting,
      ThreadStatus.Done,
      ThreadStatus.Stopped,
      ThreadStatus.NeedMoreInfo,
    ];

    for (const fromStatus of nonRunningStatuses) {
      it(`${fromStatus} → Running: sets runningStartedAt = now, preserves totalRunningMs`, () => {
        const svc = makeService();
        const result = svc.computeTransition(
          makeCurrent(fromStatus, null, 5000),
          ThreadStatus.Running,
          NOW,
        );
        expect(result.status).toBe(ThreadStatus.Running);
        expect(result.runningStartedAt).toBe(NOW);
        expect(result.totalRunningMs).toBe(5000);
      });
    }
  });

  describe('Running → Running (idempotent)', () => {
    it('keeps the original runningStartedAt (no clock reset), preserves totalRunningMs', () => {
      const svc = makeService();
      const original = new Date('2026-04-24T11:00:00Z');
      const result = svc.computeTransition(
        makeCurrent(ThreadStatus.Running, original, 3000),
        ThreadStatus.Running,
        NOW,
      );
      expect(result.status).toBe(ThreadStatus.Running);
      expect(result.runningStartedAt?.getTime()).toBe(original.getTime());
      expect(result.totalRunningMs).toBe(3000);
    });
  });

  describe('Running → non-Running (accumulates elapsed ms)', () => {
    const nonRunningTargets = [
      ThreadStatus.Waiting,
      ThreadStatus.Done,
      ThreadStatus.Stopped,
      ThreadStatus.NeedMoreInfo,
    ];

    for (const toStatus of nonRunningTargets) {
      it(`Running → ${toStatus}: runningStartedAt = null, totalRunningMs = seed + 10000`, () => {
        const svc = makeService();
        const result = svc.computeTransition(
          makeCurrent(ThreadStatus.Running, EARLIER, 2000),
          toStatus,
          NOW,
        );
        expect(result.status).toBe(toStatus);
        expect(result.runningStartedAt).toBeNull();
        expect(result.totalRunningMs).toBe(2000 + 10000);
      });
    }
  });

  describe('non-Running → non-Running (both fields unchanged)', () => {
    it('Waiting → Stopped: runningStartedAt and totalRunningMs unchanged', () => {
      const svc = makeService();
      const result = svc.computeTransition(
        makeCurrent(ThreadStatus.Waiting, null, 7500),
        ThreadStatus.Stopped,
        NOW,
      );
      expect(result.status).toBe(ThreadStatus.Stopped);
      expect(result.runningStartedAt).toBeNull();
      expect(result.totalRunningMs).toBe(7500);
    });

    it('Done → NeedMoreInfo: both fields unchanged', () => {
      const svc = makeService();
      const result = svc.computeTransition(
        makeCurrent(ThreadStatus.Done, null, 1234),
        ThreadStatus.NeedMoreInfo,
        NOW,
      );
      expect(result.status).toBe(ThreadStatus.NeedMoreInfo);
      expect(result.runningStartedAt).toBeNull();
      expect(result.totalRunningMs).toBe(1234);
    });
  });

  describe('Edge case: Running → non-Running with runningStartedAt = null (DB drift)', () => {
    it('does not throw, treats delta as 0, sets runningStartedAt = null', () => {
      const svc = makeService();
      const result = svc.computeTransition(
        makeCurrent(ThreadStatus.Running, null, 9999),
        ThreadStatus.Stopped,
        NOW,
      );
      expect(result.status).toBe(ThreadStatus.Stopped);
      expect(result.runningStartedAt).toBeNull();
      expect(result.totalRunningMs).toBe(9999);
    });
  });

  describe('bigint coercion: totalRunningMs as string', () => {
    it('Running → Stopped with string "12345" totalRunningMs: result is number 12345 + delta', () => {
      const svc = makeService();
      const result = svc.computeTransition(
        makeCurrent(ThreadStatus.Running, EARLIER, '12345'),
        ThreadStatus.Stopped,
        NOW,
      );
      expect(result.status).toBe(ThreadStatus.Stopped);
      expect(result.runningStartedAt).toBeNull();
      expect(typeof result.totalRunningMs).toBe('number');
      expect(result.totalRunningMs).toBe(12345 + 10000);
    });

    it('non-Running → Running with string "9876" totalRunningMs: result is number 9876', () => {
      const svc = makeService();
      const result = svc.computeTransition(
        makeCurrent(ThreadStatus.Waiting, null, '9876'),
        ThreadStatus.Running,
        NOW,
      );
      expect(typeof result.totalRunningMs).toBe('number');
      expect(result.totalRunningMs).toBe(9876);
    });
  });
});
