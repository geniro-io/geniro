import { describe, expect, it } from 'vitest';

import { formatUsd } from './token-display';

describe('formatUsd', () => {
  it('returns the dash glyph for null', () => {
    expect(formatUsd(null)).toMatch(/^\$—$/);
  });

  it('returns the dash glyph for undefined', () => {
    expect(formatUsd(undefined)).toMatch(/^\$—$/);
  });

  it('returns the dash glyph for NaN', () => {
    expect(formatUsd(NaN)).toMatch(/^\$—$/);
  });

  it('formats zero as $0.000, distinct from the dash glyph', () => {
    expect(formatUsd(0)).toMatch(/^\$0\.000$/);
  });

  it('truncates (not rounds) to 3 decimal places — 0.4021 → $0.402', () => {
    // Math.floor(0.4021 * 1000) / 1000 === 0.402, not 0.402 rounded up
    expect(formatUsd(0.4021)).toMatch(/^\$0\.402$/);
  });
});
