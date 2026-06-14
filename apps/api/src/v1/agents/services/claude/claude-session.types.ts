import type { BridgeQuestion } from '@packages/claude-bridge';

export const CLAUDE_INSTALL_DIR = '/opt/geniro-claude';
export const CLAUDE_PLUGINS_DIR = `${CLAUDE_INSTALL_DIR}/plugins`;

/**
 * Tools that only make sense inside a Geniro agent loop (turn control,
 * dynamic tool loading, subagent/peer listing and dispatch) — never forwarded
 * into a Claude SDK session, per the spec's forbidden actions. The SDK session
 * has its own turn lifecycle and subagent mechanics; forwarding these would
 * hand the sandboxed model control over host-side agent orchestration.
 * `subagents_list` is excluded alongside `subagents_run_task`: surfacing
 * subagents the SDK session cannot invoke is a fail-open leak across the trust
 * boundary, not a useful capability.
 */
export const CLAUDE_AGENT_CONTEXT_BOUND_TOOLS: ReadonlySet<string> = new Set([
  'finish',
  'wait_for',
  'tool_search',
  'subagents_list',
  'subagents_run_task',
  'communication_exec',
]);

/** Claude Code natives (Read/Write/Edit/Bash) already cover these in-sandbox. */
export const CLAUDE_NATIVE_OVERLAP_TOOLS: ReadonlySet<string> = new Set([
  'shell',
]);
export const CLAUDE_NATIVE_OVERLAP_TOOL_PREFIXES: readonly string[] = [
  'files_',
];

/**
 * Proxied Geniro tool invocation from the in-bridge MCP server, sanitized at
 * the transport trust boundary. `args` stays `unknown` — the dispatcher
 * validates it against the tool's own schema on invoke.
 */
export type ClaudeToolCallRequest = {
  id: string;
  toolName: string;
  args: unknown;
};

/** Intercepted AskUserQuestion frame, sanitized at the transport trust boundary. */
export type ClaudeQuestionRequest = {
  id: string;
  questions: BridgeQuestion[];
};

/**
 * One Claude Code plugin to load into a session. `path` points at the plugin
 * root inside the repository (the directory holding `.claude-plugin/plugin.json`);
 * empty means the repository root itself is the plugin. Several entries may
 * share a repository — it is cloned once per (repoUrl, ref) pair.
 */
export type ClaudePluginSource = {
  repoUrl: string;
  ref?: string;
  path?: string;
};

/**
 * Per-thread Claude session metadata persisted in `Thread.metadata` for
 * cross-turn continuity (resume when the container is alive, replay when not).
 * Sessions are keyed BY NODE ID: a root thread can host several Claude agents
 * (kind-agnostic communication tool), and a single thread-scoped session id
 * would let agent X resume agent Y's transcript.
 * Virtual keys are deliberately NOT persisted here — they live only in process
 * memory for the duration of a run and are revoked in its `finally`.
 */
export type ClaudeThreadMetadata = {
  claudeSessions?: Record<string, string>;
};
