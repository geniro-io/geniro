import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export { JsonLineParser, serializeFrame } from './json-line-parser';
export type {
  BridgeCommand,
  BridgeEvent,
  BridgeQuestion,
  BridgeStartOptions,
  BridgeToolDefinition,
  SdkAssistantMessage,
  SdkContentBlock,
  SdkMessage,
  SdkModelUsage,
  SdkResultMessage,
  SdkStreamEvent,
  SdkSystemMessage,
  SdkUsage,
  SdkUserMessage,
} from './protocol.types';
export { BRIDGE_PROTOCOL_VERSION } from './protocol.types';
export { sanitizeBridgeQuestions } from './question-sanitizer';

/**
 * Reduce a package.json dependency range to the exact version to install into
 * the sandbox. Only single-version pins are supported (`^x.y.z`, `~x.y.z`,
 * `x.y.z`); a compound range, dist-tag, or alias cannot be reduced to one
 * `npm install <pkg>@<version>` argument, so it throws loudly rather than
 * emitting an empty (`latest`) or space-split (`>=1.2.3 <2`) spec.
 */
export function exactSdkVersionFromRange(range: string): string {
  const version = range.replace(/^[~^]/, '');
  // Exact x.y.z, optionally with a `-prerelease` and/or `+build` suffix (both
  // legal SemVer and valid `npm install pkg@<version>` arguments). The two
  // groups are independent so a combined `-rc.1+build.5` matches.
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
    throw new Error(
      `claude-bridge: cannot resolve an exact @anthropic-ai/claude-agent-sdk version from "${range}" — pin the dependency to an exact semver (e.g. ^1.2.3)`,
    );
  }
  return version;
}

/**
 * SDK version installed into sandboxes at session bootstrap, read from this
 * package's own `@anthropic-ai/claude-agent-sdk` dependency range so a bump in
 * package.json can never silently pin an older SDK into the sandbox. Unlike
 * `getBridgeScriptPath` (whose `bridge.mjs` lives only in `dist/`, forcing a
 * src→dist fallback), `package.json` sits at the package root and resolves via
 * a single `../` from either `src/` (ts dev) or `dist/` (built).
 */
function resolveSdkVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  const range = pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'];
  if (!range) {
    throw new Error(
      'claude-bridge: @anthropic-ai/claude-agent-sdk is missing from dependencies — cannot resolve the sandbox SDK version',
    );
  }
  return exactSdkVersionFromRange(range);
}

export const CLAUDE_AGENT_SDK_VERSION = resolveSdkVersion();

/**
 * Absolute path of the built sandbox-side bridge script (ESM). The host reads
 * this file and ships it into the runtime at session bootstrap; the script
 * expects `@anthropic-ai/claude-agent-sdk` to be installed next to it inside
 * the sandbox — the SDK is never loaded in the API process.
 *
 * When the package is consumed from `dist/` (built API), the script sits next
 * to this module; when consumed from `src/` (ts dev server via tsconfig
 * paths), it lives in the sibling `dist/` — the package build must have run.
 */
export function getBridgeScriptPath(): string {
  const candidates = [
    join(__dirname, 'bridge.mjs'),
    join(__dirname, '..', 'dist', 'bridge.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `claude-bridge script not found (looked at: ${candidates.join(', ')}) — run the @packages/claude-bridge build`,
  );
}
