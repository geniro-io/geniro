/**
 * Per-project OAuth credential providers and their static endpoint config.
 *
 * Client id/secret are read from `environment` at the service layer (they are
 * deployment secrets, not constants). Everything that is provider-stable —
 * authorize/token URLs, default scopes, and the remote MCP endpoint — lives
 * here so a new provider is a single registry entry.
 */

export enum OAuthProvider {
  Linear = 'linear',
}

export interface OAuthProviderConfig {
  /** Authorization-code endpoint the user is redirected to for consent. */
  authorizeUrl: string;
  /** Token endpoint the server exchanges the code (+ PKCE verifier) against. */
  tokenUrl: string;
  /** Default scopes requested when none are configured per project. */
  scopes: string[];
  /** Separator used to join scopes in the authorize URL (Linear uses comma). */
  scopeSeparator: string;
  /**
   * Remote MCP endpoint for this provider. The stored token is injected as a
   * bearer header — `{type:'http'}` for the Claude bridge (M1), wrapped via
   * `mcp-remote` for the SimpleAgent stdio path.
   */
  mcpUrl: string;
}

/** Result of a successful authorization-code exchange. */
export interface OAuthTokenResult {
  accessToken: string;
  scopes: string[] | null;
  expiresAt: Date | null;
  accountLabel: string | null;
}

/**
 * Linear endpoints per its OAuth2 + remote-MCP docs. The exact values must be
 * confirmed against the registered Linear OAuth application before the live
 * flow is exercised; they are centralised here so that confirmation is a
 * one-line change.
 */
export const OAUTH_PROVIDER_CONFIGS: Record<
  OAuthProvider,
  OAuthProviderConfig
> = {
  [OAuthProvider.Linear]: {
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    scopes: ['read', 'write'],
    scopeSeparator: ',',
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
  graphId?: string;
  nodeId?: string;
  threadId?: string;
}
