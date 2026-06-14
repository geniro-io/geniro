import type {
  BridgeQuestion,
  BridgeToolDefinition,
} from '@packages/claude-bridge';
import { InternalException } from '@packages/common';

import { environment } from '../../../../environments';
import type { BuiltAgentTool } from '../../../agent-tools/tools/base-tool';
import {
  CLAUDE_AGENT_CONTEXT_BOUND_TOOLS,
  CLAUDE_NATIVE_OVERLAP_TOOL_PREFIXES,
  CLAUDE_NATIVE_OVERLAP_TOOLS,
} from './claude-session.types';

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
 *
 * The authority match is greedy up to the LAST `@`, so a password that itself
 * contains an unencoded `@` (e.g. `user:p@ss@host`) is redacted whole — a
 * first-`@` stop would leak the password tail. The scheme match is
 * case-insensitive: this also redacts git stderr (an untrusted sandbox byte
 * stream), which can echo an RFC-3986-legal upper/mixed-case `HTTPS://` that
 * must be stripped the same way.
 */
export function redactGitUrl(text: string): string {
  return text.replace(/(https:\/\/)[^/\s]*@/gi, '$1***@');
}

/**
 * Exclusion policy for forwarding wired Geniro tools into a Claude SDK
 * session: agent-context-bound tools never cross (forbidden by the spec), and
 * tools wholly covered by Claude Code natives are skipped to avoid duplicate
 * capability surfaces confusing the model.
 */
export function isToolForwardableToClaude(name: string): boolean {
  if (CLAUDE_AGENT_CONTEXT_BOUND_TOOLS.has(name)) {
    return false;
  }
  if (CLAUDE_NATIVE_OVERLAP_TOOLS.has(name)) {
    return false;
  }
  return !CLAUDE_NATIVE_OVERLAP_TOOL_PREFIXES.some((prefix) =>
    name.startsWith(prefix),
  );
}

/**
 * Render an intercepted AskUserQuestion as plain text — the form the question
 * takes when it must leave the SDK session (a NeedMoreInfo thread message for
 * the user, or a relayed question for a parent agent).
 */
export function formatQuestionsAsText(questions: BridgeQuestion[]): string {
  const blocks = questions
    .filter(
      (question): question is BridgeQuestion & { question: string } =>
        typeof question.question === 'string' && question.question !== '',
    )
    .map((question) => {
      const lines = [question.question];
      for (const option of question.options ?? []) {
        if (!option.label) {
          continue;
        }
        lines.push(
          option.description
            ? `- ${option.label}: ${option.description}`
            : `- ${option.label}`,
        );
      }
      return lines.join('\n');
    });
  return blocks.length > 0
    ? blocks.join('\n\n')
    : 'The agent asked a question but its content could not be read.';
}

/**
 * Map wired tools to the wire-format definitions the in-bridge MCP server
 * registers. A tool without a pre-computed JSON schema is forwarded with an
 * empty object schema — argument fidelity degrades but the tool stays callable
 * (host-side validation remains authoritative on dispatch).
 */
export function buildBridgeToolDefinitions(
  tools: BuiltAgentTool[],
): BridgeToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.__ajvSchema ?? { type: 'object', properties: {} },
  }));
}

/**
 * Environment injected into the bridge exec session (NOT baked into the
 * container) so the per-thread virtual key never outlives the session and the
 * LiteLLM master key never reaches the sandbox.
 *
 * `githubToken` (when the thread owner has a linked GitHub App installation)
 * authenticates Claude's native `gh` CLI and git over HTTPS — the latter via
 * the credential helper `ClaudeBootstrapService.configureGitAuth` installs.
 * Omitted entirely when absent so native git/gh stay cleanly unauthenticated
 * rather than half-wired with an empty credential.
 */
export function buildClaudeSessionEnv(
  virtualKey: string,
  githubToken?: string | null,
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
    // Proxied Geniro tools execute host-side over the stdio protocol; the
    // SDK's default in-process MCP stream-close timeout is 60s, which slow
    // tools (large clones, long searches) can exceed.
    CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '300000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    // gh CLI reads GH_TOKEN directly; native git consumes it through the
    // credential helper. Spread last so an empty/absent token contributes
    // nothing (no GH_TOKEN key) rather than an empty-string credential.
    ...(githubToken ? { GH_TOKEN: githubToken } : {}),
  };
}
