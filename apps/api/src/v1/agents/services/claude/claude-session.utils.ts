import { InternalException } from '@packages/common';

import { environment } from '../../../../environments';

/**
 * LiteLLM alias for Claude Code's background/utility calls (title generation
 * etc.). Also part of the virtual key's model scope — the key must cover every
 * model the CLI can call.
 */
export const SMALL_FAST_MODEL_ALIAS = 'claude-haiku-4-5';

/**
 * Strips userinfo (`token@` / `user:token@`) from https URLs before they
 * reach a log line or error message — private-repo clone URLs legitimately
 * embed PATs, and those must never land in Pino/Sentry.
 */
export function redactGitUrl(text: string): string {
  return text.replace(/(https:\/\/)[^@/\s]+@/g, '$1***@');
}

/**
 * Environment injected into the bridge exec session (NOT baked into the
 * container) so the per-thread virtual key never outlives the session and the
 * LiteLLM master key never reaches the sandbox.
 */
export function buildClaudeSessionEnv(
  virtualKey: string,
): Record<string, string> {
  const baseUrl = environment.litellmSandboxUrl;
  if (!baseUrl) {
    throw new InternalException(
      'CLAUDE_SANDBOX_LLM_URL_MISSING',
      'LITELLM_SANDBOX_URL is not configured — Claude Agent sessions need a LiteLLM URL reachable from inside sandbox runtimes',
    );
  }

  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: virtualKey,
    // Background/utility calls (e.g. title generation) route through a cheap
    // registered alias instead of the default haiku snapshot id.
    ANTHROPIC_SMALL_FAST_MODEL: SMALL_FAST_MODEL_ALIAS,
    // The sandbox container IS the permission boundary; Claude Code requires
    // this acknowledgment to run with bypassed permissions as root.
    IS_SANDBOX: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
}
