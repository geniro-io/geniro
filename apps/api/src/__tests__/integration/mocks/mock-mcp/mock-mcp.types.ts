/**
 * Minimal shape of an MCP tool advertised to the agent. Mirrors the parts of
 * `ListToolsResult['tools'][number]` we actually populate from tests.
 *
 * `inputSchema` is JSON-Schema; when omitted we default to a permissive
 * passthrough object schema so tests don't have to repeat it.
 */
export interface MockMcpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Snapshot of an MCP `callTool()` invocation. Recorded before resolution so
 * even fixture-throwing calls show up in `getRequests()`.
 */
export interface MockMcpCallToolRequest {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  callIndex: number;
}

/**
 * Reply for a stubbed `callTool`. The MCP SDK callTool returns `CallToolResult`
 * with shape `{ content: [{type: 'text', text: '…'}], isError?: boolean }`.
 *
 * Plain strings are auto-wrapped into the canonical text-content shape.
 */
export type MockMcpCallToolReply =
  | string
  | Record<string, unknown>
  | ((req: MockMcpCallToolRequest) => string | Record<string, unknown>);

export interface MockMcpCallToolMatcher {
  /** Matches `getMcpConfig().name` (e.g. `'filesystem'`). Substring or regex. */
  serverName?: string | RegExp;
  /** Exact tool name (e.g. `'list_directory'`). */
  toolName?: string;
  /**
   * AND-set of arg keys that must be present on the call (any value).
   * Use this to disambiguate two fixtures for the same tool that branch on
   * which optional parameter the caller supplied.
   */
  hasArgs?: string[];
}

export interface MockMcpCallToolFixture {
  matcher: MockMcpCallToolMatcher;
  reply: MockMcpCallToolReply;
}
