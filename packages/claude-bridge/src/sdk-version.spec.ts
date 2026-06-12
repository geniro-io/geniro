import { describe, expect, it } from 'vitest';

import { CLAUDE_AGENT_SDK_VERSION, exactSdkVersionFromRange } from './index';

/**
 * CLAUDE_AGENT_SDK_VERSION is derived at module-load from this package's own
 * claude-agent-sdk dependency range and fed verbatim into
 * "npm install <pkg>@<version>" inside every sandbox. The range-to-exact
 * reduction must yield a single installable version for the pin forms we use,
 * and fail loudly for anything it cannot pin — a silently empty or space-split
 * spec would install the wrong (or floating) SDK into the sandbox.
 */
describe('exactSdkVersionFromRange', () => {
  it.each([
    ['^0.3.173', '0.3.173'],
    ['~1.2.3', '1.2.3'],
    ['0.3.173', '0.3.173'],
    ['1.2.3-beta.1', '1.2.3-beta.1'],
    ['2.0.0+build.5', '2.0.0+build.5'],
  ])('reduces the pin %s to the exact version %s', (range, expected) => {
    expect(exactSdkVersionFromRange(range)).toBe(expected);
  });

  it.each([
    'latest', // dist-tag: a leading-non-digit strip would collapse it to ''
    'next',
    '*',
    '>=1.2.3 <2', // compound range: would leave a space-split "1.2.3 <2"
    '1.x',
    '',
    'workspace:^1.2.3',
  ])(
    'throws on the un-pinnable range %s instead of emitting a broken spec',
    (range) => {
      expect(() => exactSdkVersionFromRange(range)).toThrow(
        /pin the dependency to an exact semver/,
      );
    },
  );

  // A single exact pin may legally carry BOTH a prerelease and build-metadata
  // suffix (`1.2.3-rc.1+build.5` is valid SemVer and a valid `npm install
  // pkg@<version>` argument). Prerelease-only (`1.2.3-beta.1`) and build-only
  // (`2.0.0+build.5`) are already accepted above; the combined form is the same
  // single installable pin and must reduce to itself, not throw.
  it.each([
    ['1.2.3-rc.1+build.5', '1.2.3-rc.1+build.5'],
    ['^0.3.173-canary.1+sha.abc', '0.3.173-canary.1+sha.abc'],
  ])(
    'reduces the exact pin %s (prerelease + build metadata) to %s',
    (range, expected) => {
      expect(exactSdkVersionFromRange(range)).toBe(expected);
    },
  );
});

describe('CLAUDE_AGENT_SDK_VERSION', () => {
  it('resolves the real package dependency range to an exact semver', () => {
    expect(CLAUDE_AGENT_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
