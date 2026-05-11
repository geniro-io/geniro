// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks ───────────────────────────────────────────────────────────────
//
// Mock the API module so that no real HTTP calls are made during the test.
// useChatsUsageStats calls getThreadUsageStatistics on mount and on thread
// status transitions; useChatsWebSocket calls getThreadById /
// getThreadByExternalId in response to certain events. None of those calls
// should succeed in jsdom — mocking them prevents fetch errors and also
// prevents unhandled-promise-rejection noise from swallowing test failures.
//
// We do NOT mock useChatsWebSocket, useChatsUsageStats, or webSocketService —
// the whole point of this suite is to exercise the real reducer path.

vi.mock('../../../api', () => ({
  threadsApi: {
    getThreadUsageStatistics: vi.fn().mockResolvedValue({
      data: {
        total: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          totalPrice: 0,
          currentContext: 0,
        },
        byNode: {},
      },
    }),
    getThreadById: vi.fn().mockResolvedValue({ data: null }),
    getThreadByExternalId: vi.fn().mockResolvedValue({ data: null }),
  },
}));

// ── Imports after mocks ────────────────────────────────────────────────────────

import { threadsApi } from '../../../api';
import { parseFixture } from './fixture-schema';
import threeSubagentBatchRaw from './fixtures/three-subagent-batch.json';
import { WSReplayHarnessSection } from './WSReplayHarnessSection';

// ── Seed fixture ──────────────────────────────────────────────────────────────

const SEED = parseFixture(threeSubagentBatchRaw, 'three-subagent-batch.json');

// EXPECTED_SUM: sum of all requestTokenUsage.totalPrice fields in the fixture.
// Fixture description states $0.102. We derive it programmatically so the test
// stays in sync with the fixture without hardcoding a magic number.
const EXPECTED_SUM = SEED.events.reduce((acc, e) => {
  const maybePrice = (
    e.event as { data?: { requestTokenUsage?: { totalPrice?: number } } }
  ).data?.requestTokenUsage?.totalPrice;
  return acc + (typeof maybePrice === 'number' ? maybePrice : 0);
}, 0);

// ── Helpers ───────────────────────────────────────────────────────────────────

// Total replay duration without any speed scaling.
const TOTAL_DELAY_MS = SEED.events.reduce((acc, e) => acc + e.delayMs, 0);

// Extra time budget beyond delayMs to allow:
// 1. emitToHandlers wraps handlers in setTimeout(fn, 0) — needs at least 1 ms
// 2. flushAgentMessages is also scheduled via setTimeout(fn, 0) — another 1 ms
// 3. React state updates and re-renders (synchronous in act() but still need a
//    flush tick after setThreadTokenUsageByNode resolves).
// 5 ms covers all three layers with a comfortable margin.
const DISPATCH_FLUSH_MS = 5;

// Build the mock response shape for getThreadUsageStatistics.
// Satisfies AxiosResponse<ThreadUsageStatisticsDto> — required status/headers/config
// fields are stubs; the production code only reads `.data`.
const makeUsageStatsResponse = (totalPrice: number) => ({
  data: {
    total: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      totalPrice,
      currentContext: 0,
    },
    byNode: {},
    requests: 0,
    byTool: [],
    toolsAggregate: {
      totalPrice: 0,
      totalCalls: 0,
      totalDurationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    },
    userMessageCount: 0,
    modelsUsed: [],
  },
  status: 200,
  statusText: 'OK',
  headers: {},
  config: { headers: {} as never },
});

// ── Shared teardown ───────────────────────────────────────────────────────────

afterEach(() => {
  // Explicit cleanup needed: auto-cleanup is not wired in this vitest setup
  // (no setupFiles with @testing-library/react auto-cleanup). Pattern from
  // thread-blocks.spec.tsx in this repo.
  cleanup();
  vi.useRealTimers();
  // Reset the mock completely (clears both the once-queue AND the default
  // implementation) then re-set the safe default so no test bleeds its
  // mockResolvedValueOnce queue into the next test.
  vi.mocked(threadsApi.getThreadUsageStatistics).mockReset();
  vi.mocked(threadsApi.getThreadUsageStatistics).mockResolvedValue(
    makeUsageStatsResponse(0),
  );
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WSReplayHarnessSection — integration', () => {
  it('renders "Event 0 / 28" on initial mount', () => {
    const { container } = render(<WSReplayHarnessSection />);
    // The playback state row shows "Event {index} / {total}".
    expect(container.textContent).toContain(`Event 0 / ${SEED.events.length}`);
  });

  // Timeout raised to 30 s: 27 act() iterations with fake timers each complete
  // quickly in real time, but jsdom + React re-renders add ~50–200 ms per step
  // in CI — 27 * 200 ms = 5.4 s, already over the 5 s default.
  it('renders aggregate price = $0.10 after playing all priced events (running state)', async () => {
    vi.useFakeTimers();
    const { container, getByRole } = render(<WSReplayHarnessSection />);

    // Step through events 1..27 (everything except the terminal done).
    // Stopping before the last event keeps the thread in running state so the
    // WS aggregate path (not the REST-authoritative path) is exercised.
    for (let i = 0; i < SEED.events.length - 1; i++) {
      await act(async () => {
        fireEvent.click(getByRole('button', { name: 'Step' }));
        vi.advanceTimersByTime(DISPATCH_FLUSH_MS); // flush emitToHandlers + agentMessageBuffer
      });
    }

    // After playing events 1-27 we should have accumulated $0.102 from the 15
    // priced agent.message events. formatUsd uses Intl.NumberFormat at 2 dp,
    // so 0.102 renders as "$0.10". The regex allows an optional third digit
    // in case the formatter ever uses 3 dp.
    expect(container.textContent).toMatch(/\$0\.10[012]?/);
    vi.useRealTimers();
  }, 30_000);

  it('aggregate price is monotonic-non-decreasing during step-by-step playback (running state only)', async () => {
    vi.useFakeTimers();
    const { container, getByRole } = render(<WSReplayHarnessSection />);

    const parsePrice = (text: string): number => {
      const match = text.match(/\$(\d+\.\d+)/);
      return match ? parseFloat(match[1]) : 0;
    };

    let lastPrice = 0;
    // Walk events 1..27 — stop before terminal done to avoid REST-switch.
    for (let i = 0; i < SEED.events.length - 1; i++) {
      await act(async () => {
        fireEvent.click(getByRole('button', { name: 'Step' }));
        vi.advanceTimersByTime(DISPATCH_FLUSH_MS);
      });
      const current = parsePrice(container.textContent ?? '');
      expect(current).toBeGreaterThanOrEqual(lastPrice);
      lastPrice = current;
    }

    // After the walk, price should be $0.102.
    expect(lastPrice).toBeCloseTo(0.102, 2);
    vi.useRealTimers();
  }, 30_000);

  it('resets aggregate to undefined on Reset click', async () => {
    // getThreadUsageStatistics is called three times during this test:
    //   1. On initial mount (running) — 0 is fine, WS aggregate used.
    //   2. On running→done — EXPECTED_SUM so the $0.10 assertion passes.
    //   3. On remounted harness (after reset, key change) — 0 so the
    //      reset assertion ($—|$0.00) passes.
    vi.mocked(threadsApi.getThreadUsageStatistics)
      .mockResolvedValueOnce(makeUsageStatsResponse(0))
      .mockResolvedValueOnce(makeUsageStatsResponse(EXPECTED_SUM))
      .mockResolvedValueOnce(makeUsageStatsResponse(0));

    vi.useFakeTimers();

    const { container, getByRole } = render(<WSReplayHarnessSection />);

    // Play to completion.
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Play' }));
      vi.advanceTimersByTime(TOTAL_DELAY_MS + 1000);
    });

    // Price should be non-zero after playback.
    expect(container.textContent).toMatch(/\$0\.10/);

    // Click Reset — aggregate goes back to undefined.
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Reset' }));
      vi.advanceTimersByTime(DISPATCH_FLUSH_MS);
    });

    // formatUsd(undefined) → "$—"; formatUsd(0) → "$0.00"
    // Both are acceptable depending on whether React re-renders synchronously.
    expect(container.textContent).toMatch(/\$—|\$0\.00/);
  });

  it('pauses playback — aggregate does not advance after Pause', async () => {
    vi.useFakeTimers();

    const { container, getByRole } = render(<WSReplayHarnessSection />);

    // Play and advance roughly halfway through (first 10 event delays).
    const halfwayMs = SEED.events
      .slice(0, 10)
      .reduce((acc, e) => acc + e.delayMs, 0);

    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Play' }));
      vi.advanceTimersByTime(halfwayMs + DISPATCH_FLUSH_MS);
    });

    // Capture the price at the midpoint.
    const midPrice =
      (container.textContent ?? '').match(/\$(\d+\.\d+)/)?.[1] ?? '0';

    // Pause and then advance well past the remaining fixture duration.
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Pause' }));
      vi.advanceTimersByTime(TOTAL_DELAY_MS + 1000);
    });

    const afterPausePrice =
      (container.textContent ?? '').match(/\$(\d+\.\d+)/)?.[1] ?? '0';

    // Guard: midPrice must be non-zero so the equality check below is meaningful.
    // If price is $0 at the midpoint, pause is not actually being tested.
    expect(parseFloat(midPrice)).toBeGreaterThan(0);

    // The price must not have advanced after Pause.
    expect(afterPausePrice).toBe(midPrice);
  });
});
