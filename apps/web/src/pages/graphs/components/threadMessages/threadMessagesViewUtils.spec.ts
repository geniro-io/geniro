import { describe, expect, it } from 'vitest';

import { formatDurationMs } from './threadMessagesViewUtils';

describe('formatDurationMs', () => {
  it('returns em-dash for non-finite or non-positive', () => {
    expect(formatDurationMs(Number.NaN)).toBe('—');
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatDurationMs(0)).toBe('—');
    expect(formatDurationMs(-100)).toBe('—');
  });

  it('renders sub-second durations in ms', () => {
    expect(formatDurationMs(120)).toBe('120ms');
    expect(formatDurationMs(999)).toBe('999ms');
  });

  it('renders sub-minute durations as seconds with one decimal', () => {
    expect(formatDurationMs(2_600)).toBe('2.6s');
    expect(formatDurationMs(45_000)).toBe('45s');
  });

  it('renders minute durations with minute + second split', () => {
    expect(formatDurationMs(83_000)).toBe('1m 23s');
    expect(formatDurationMs(302_000)).toBe('5m 2s');
  });

  it('renders whole-minute durations without the seconds suffix', () => {
    expect(formatDurationMs(120_000)).toBe('2m');
  });

  it('rolls seconds over to the next minute instead of rendering "5m 60s"', () => {
    // 359.5s previously rendered as "5m 60s" because Math.floor(/60) and
    // Math.round(%60) disagreed at the rollover boundary.
    expect(formatDurationMs(359_500)).toBe('6m');
    // 59.5s should bubble up to "1m", not "0m 60s".
    expect(formatDurationMs(59_500)).toBe('1m');
  });
});
