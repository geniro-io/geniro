/**
 * JSON-line stdio protocol between the Geniro API (host) and the bridge
 * process running inside a sandbox runtime. One JSON object per line; stdout
 * carries bridge events, stdin carries host commands. This file must stay
 * free of `@anthropic-ai/claude-agent-sdk` imports — the host consumes it
 * without ever loading the SDK; SDK message shapes below are structural
 * subsets of what the bridge forwards verbatim.
 */

export const BRIDGE_PROTOCOL_VERSION = 2;

// The sandbox SDK version is derived from this package's own dependency range
// (see `CLAUDE_AGENT_SDK_VERSION` in `index.ts`) — it deliberately does NOT
// live here, because reading package.json is a runtime concern, not a
// compile-time protocol shape.

// ---------------------------------------------------------------------------
// SDK message shapes (structural subset consumed by the host-side mapper)
// ---------------------------------------------------------------------------

export type SdkUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type SdkContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

export type SdkAssistantMessage = {
  type: 'assistant';
  uuid?: string;
  session_id: string;
  parent_tool_use_id?: string | null;
  message: {
    id?: string;
    model?: string;
    content: SdkContentBlock[];
    usage?: SdkUsage;
    stop_reason?: string | null;
  };
};

export type SdkUserMessage = {
  type: 'user';
  uuid?: string;
  session_id: string;
  parent_tool_use_id?: string | null;
  message: {
    content: SdkContentBlock[] | string;
  };
};

export type SdkSystemMessage = {
  type: 'system';
  subtype: string;
  session_id: string;
  [key: string]: unknown;
};

export type SdkModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
};

export type SdkResultMessage = {
  type: 'result';
  subtype: string;
  session_id: string;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: SdkUsage;
  modelUsage?: Record<string, SdkModelUsage>;
};

export type SdkStreamEvent = {
  type: 'stream_event';
  session_id: string;
  parent_tool_use_id?: string | null;
  event: {
    type: string;
    index?: number;
    delta?: { type?: string; text?: string; thinking?: string };
    content_block?: SdkContentBlock;
    [key: string]: unknown;
  };
};

export type SdkMessage =
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkSystemMessage
  | SdkResultMessage
  | SdkStreamEvent;

// ---------------------------------------------------------------------------
// Host -> bridge commands (stdin)
// ---------------------------------------------------------------------------

/**
 * A Geniro tool forwarded into the SDK session. The bridge registers each one
 * on its in-process MCP server (exposed as `mcp__geniro__<name>`); invocations
 * are proxied back to the host as `tool_call_request` events and resolved by
 * `tool_call_response` commands carrying the same id.
 */
export type BridgeToolDefinition = {
  /** Geniro tool name (without the `mcp__geniro__` prefix). */
  name: string;
  description: string;
  /** JSON Schema (draft-07) for the tool arguments. */
  inputSchema: Record<string, unknown>;
};

export type BridgeStartOptions = {
  /** Initial user prompt for this turn. */
  prompt: string;
  /** Appended to the Claude Code preset system prompt. */
  systemPrompt?: string;
  model: string;
  maxTurns?: number;
  /** SDK session id to resume (cross-turn continuity). */
  resume?: string;
  /** Working directory of the session inside the sandbox. */
  cwd?: string;
  /** Local plugin directories (cloned repos) loaded into the session. */
  pluginPaths?: string[];
  /** Claude Code setting sources to load (e.g. ['project']). */
  settingSources?: ('user' | 'project' | 'local')[];
  /** Geniro tools exposed inside the session via the in-bridge MCP server. */
  tools?: BridgeToolDefinition[];
};

export type BridgeCommand =
  | { type: 'start'; options: BridgeStartOptions }
  | { type: 'user_message'; text: string }
  | { type: 'interrupt' }
  | { type: 'shutdown' }
  /** Resolves the pending `tool_call_request` with the same id. Exactly one of `result`/`error` is set. */
  | { type: 'tool_call_response'; id: string; result?: string; error?: string }
  /**
   * Resolves the pending `question_request` with the same id. `answers` align
   * by index with the request's `questions`; `deny: true` (or missing answers)
   * makes the bridge deny the AskUserQuestion call gracefully. The current
   * host always ends the turn via `interrupt` instead of answering live
   * (NeedMoreInfo / parent-relay both resume the session with the answer as
   * the next prompt); the answer path is exercised end-to-end by the SDK and
   * reserved for a live-answer mode.
   */
  | {
      type: 'question_response';
      id: string;
      answers?: string[];
      deny?: boolean;
    };

// ---------------------------------------------------------------------------
// Bridge -> host events (stdout)
// ---------------------------------------------------------------------------

/** One question from an intercepted AskUserQuestion tool call. */
export type BridgeQuestion = {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label?: string; description?: string }[];
};

export type BridgeEvent =
  | { type: 'ready'; protocolVersion: number }
  | { type: 'sdk_message'; message: SdkMessage }
  /** Proxied invocation of a forwarded Geniro tool; the host replies with `tool_call_response` carrying the same id. */
  | { type: 'tool_call_request'; id: string; toolName: string; args: unknown }
  /** Intercepted AskUserQuestion; the host replies with `question_response` carrying the same id. */
  | { type: 'question_request'; id: string; questions: BridgeQuestion[] }
  | { type: 'done'; sessionId?: string }
  | { type: 'aborted'; sessionId?: string }
  | { type: 'fatal'; error: string };
