import { existsSync } from 'node:fs';
import { join } from 'node:path';

export { JsonLineParser, serializeFrame } from './json-line-parser';
export type {
  BridgeCommand,
  BridgeEvent,
  BridgeStartOptions,
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
export {
  BRIDGE_PROTOCOL_VERSION,
  CLAUDE_AGENT_SDK_VERSION,
} from './protocol.types';

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
