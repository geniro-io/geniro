/**
 * JSON-line stdio protocol between the Geniro API (host) and the bridge
 * process running inside a sandbox runtime. One JSON object per line; stdout
 * carries bridge events, stdin carries host commands. This file must stay
 * free of `@anthropic-ai/claude-agent-sdk` imports — the host consumes it
 * without ever loading the SDK; SDK message shapes below are structural
 * subsets of what the bridge forwards verbatim.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;

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
};

export type BridgeCommand =
  | { type: 'start'; options: BridgeStartOptions }
  | { type: 'user_message'; text: string }
  | { type: 'interrupt' }
  | { type: 'shutdown' };

// ---------------------------------------------------------------------------
// Bridge -> host events (stdout)
// ---------------------------------------------------------------------------

export type BridgeEvent =
  | { type: 'ready'; protocolVersion: number }
  | { type: 'sdk_message'; message: SdkMessage }
  | { type: 'done'; sessionId?: string }
  | { type: 'aborted'; sessionId?: string }
  | { type: 'fatal'; error: string };
