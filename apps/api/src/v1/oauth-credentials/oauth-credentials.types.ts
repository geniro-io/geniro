/**
 * Per-project OAuth credential providers and the stable remote-MCP endpoint
 * each authenticates against.
 *
 * There are NO deployment credentials: the authorize / token / registration
 * endpoints and the OAuth client itself are discovered (RFC 9728 -> RFC 8414)
 * and registered (RFC 7591 Dynamic Client Registration) per flow by the
 * provider strategy, against the MCP server's OWN authorization server. Only
 * `mcpUrl` — the stable endpoint the stored token is injected against — is a
 * compile-time constant, so a new provider is one strategy class, one module
 * `providers[]` line, and one registry line in `OAuthExchangeService`'s
 * constructor.
 */

export enum OAuthProvider {
  Linear = 'linear',
}

export interface OAuthProviderConfig {
  /**
   * Remote MCP endpoint for this provider. Doubles as the RFC 9728 discovery
   * root and the RFC 8707 resource indicator. The stored token is injected as a
   * bearer header, wrapped via `mcp-remote` — the same stdio config serves BOTH
   * the SimpleAgent and the co-located Claude bridge (there is no separate
   * `{type:'http'}` transport on the Claude path).
   */
  mcpUrl: string;
}

/** Result of a successful authorization-code exchange or refresh-token grant. */
export interface OAuthTokenResult {
  accessToken: string;
  scopes: string[] | null;
  expiresAt: Date | null;
  /**
   * The refresh token, when the authorization server issues one (often gated on
   * an `offline_access` scope / `prompt=consent`). `null` when absent. A
   * provider that ROTATES the refresh token returns a fresh value on every
   * `refresh_token` grant, so this is re-persisted on each refresh, not only at
   * first exchange.
   */
  refreshToken: string | null;
  accountLabel: string | null;
}

/**
 * Static per-provider config — the stable remote MCP endpoint only. Authorize /
 * token / registration URLs are discovered at run time from the MCP server's
 * own authorization-server metadata, so nothing here needs confirming against a
 * pre-registered OAuth app.
 */
export const OAUTH_PROVIDER_CONFIGS: Record<
  OAuthProvider,
  OAuthProviderConfig
> = {
  [OAuthProvider.Linear]: {
    mcpUrl: 'https://mcp.linear.app/mcp',
  },
};

/** Redis key namespace for a pending authorization (PKCE verifier + CSRF state). */
export const OAUTH_STATE_CACHE_PREFIX = 'oauth:state:';

/** TTL (seconds) for a pending authorization — the window between start and callback. */
export const OAUTH_STATE_TTL_SECONDS = 600;

/**
 * Server-side payload stored under the random `state` while the user is at the
 * provider consent screen. Holds the PKCE verifier (never exposed to the
 * browser) plus the resume target. `graphId`/`nodeId` drive the editor flow;
 * `threadId` is the M3 background/trigger resume target (forward-compat seam).
 */
export interface OAuthPendingState {
  projectId: string;
  provider: OAuthProvider;
  codeVerifier: string;
  createdBy: string;
  /**
   * The per-flow client registered via Dynamic Client Registration at
   * `start()`. Carried here (never persisted durably) so `exchange()` presents
   * the same `client_id` the authorization code was issued to. `clientSecret`
   * is null for a public (PKCE-only) client — same sensitivity as the
   * `codeVerifier` above; server-side, 600s TTL.
   */
  clientId: string;
  clientSecret: string | null;
  graphId?: string;
  nodeId?: string;
  threadId?: string;
}
