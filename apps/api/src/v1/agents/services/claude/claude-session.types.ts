import type { BridgeQuestion } from '@packages/claude-bridge';

import type { BaseMcp } from '../../../agent-mcp/services/base-mcp';
import type { ResourceResolveContext } from '../../../graph-resources/graph-resources.types';

export const CLAUDE_INSTALL_DIR = '/opt/geniro-claude';
export const CLAUDE_PLUGINS_DIR = `${CLAUDE_INSTALL_DIR}/plugins`;

/**
 * LLM credential mode for a Claude Agent node.
 * - `System`: the agent's LLM calls route through the shared platform upstream
 *   (a scoped per-thread LiteLLM virtual key enters the sandbox).
 * - `ByoAnthropic`: the agent runs against the graph author's own Anthropic API
 *   key, resolved host-side from the secrets store and injected directly into
 *   this node's sandbox as `ANTHROPIC_API_KEY`, bypassing LiteLLM.
 */
export enum ClaudeAuthMode {
  System = 'system',
  ByoAnthropic = 'byo-anthropic',
}

/**
 * Tools that only make sense inside a Geniro agent loop — never forwarded into
 * a Claude SDK session. `finish`/`wait_for`/`tool_search` are turn control and
 * dynamic tool loading the SDK session owns itself. `subagents_run_task` is
 * excluded because the SDK has its OWN native subagent/Task mechanism —
 * forwarding ours would duplicate it; `subagents_list` is excluded alongside it
 * (surfacing subagents the SDK session cannot invoke is a fail-open leak, not a
 * useful capability).
 *
 * `communication_exec` is deliberately NOT excluded. Unlike subagents, peer
 * communication (a message to a distinct graph Agent node) has NO SDK-native
 * equivalent, and the graph already wires Claude agents to communication-tool
 * nodes (`agent-communication-tool` is a declared input/output for ClaudeAgent)
 * — so a connected Claude agent MUST be able to call its peers, or the graph
 * makes a promise the runtime breaks. Its returned tool usage folds via the
 * standard forwarded-tool path (dispatcher recordToolUsage -> __toolTokenUsage
 * -> caller node), and the cross-turn cost seed counts it (`aggregatePriorSpendUsd`).
 */
export const CLAUDE_AGENT_CONTEXT_BOUND_TOOLS: ReadonlySet<string> = new Set([
  'finish',
  'wait_for',
  'tool_search',
  'subagents_list',
  'subagents_run_task',
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
 * Per-node overrides for the model strings the Claude SDK emits, mapped onto
 * registered LiteLLM model names. The SDK resolves the alias tiers (sonnet/opus/
 * haiku/fable) on its own and sends the resulting string to LiteLLM, which routes
 * only by exact model-name match — so an alias that resolves to a snapshot id
 * LiteLLM does not know fails the call. Each override is optional: when set it
 * injects the matching `ANTHROPIC_DEFAULT_*_MODEL` into the session env so the
 * alias resolves to a registered name instead. `haiku` also covers background/
 * utility calls and defaults to the small-fast alias when unset; the rest fall
 * through to the SDK's built-in resolution when unset.
 */
export interface ClaudeModelOverrides {
  sonnet?: string;
  opus?: string;
  haiku?: string;
  fable?: string;
}

/**
 * A Geniro MCP block (`custom`/`filesystem`/`playwright`/`jira`) connected to a
 * Claude Agent node's output. Collected from the graph at compile time; at
 * run() each block's launch config is resolved host-side against the Claude
 * node's runtime (via `BaseMcp.resolveServerConfigForRuntime`) and merged into
 * the SDK `mcpServers` map through the bridge. `config` stays `unknown` — each
 * block validates it against its own schema inside `getMcpConfig`.
 */
export type ConnectedMcpServer = {
  instance: BaseMcp;
  config: unknown;
  nodeId: string;
};

/**
 * A GitHub resource node connected to a Claude Agent node's output. Collected
 * at compile time. At run() the Claude agent calls `resolveEnv` to obtain the
 * GH_TOKEN — the resource self-resolves it via the GitHub App installation —
 * and applies `name`/`email` as the git commit identity. This connected
 * resource is the ONLY source of native GitHub auth for a Claude agent: there
 * is no implicit owner-token self-resolution. No connected resource → no token.
 */
export type ConnectedGithubResource = {
  resolveEnv: (ctx?: ResourceResolveContext) => Promise<Record<string, string>>;
  name?: string;
  email?: string;
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
