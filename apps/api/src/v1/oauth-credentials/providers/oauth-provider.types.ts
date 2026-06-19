/**
 * Types for the OAuth provider strategies — the authorization-server
 * coordinates resolved by discovery (RFC 9728 protected-resource metadata ->
 * RFC 8414 authorization-server metadata) and the client registered per-flow
 * via Dynamic Client Registration (RFC 7591).
 *
 * Every value here originates from an UNTRUSTED external response and is only
 * produced AFTER the structural validation in `BaseOAuthProvider` — these
 * interfaces describe the already-validated shape, never the raw wire payload.
 */

/**
 * Authorization-server coordinates resolved by discovery for a single flow.
 * `resource` is the RFC 8707 resource indicator — the MCP endpoint the minted
 * token must be audience-bound to — and is sent on both the authorize and the
 * token requests.
 */
export interface DiscoveredOAuthServer {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  resource: string;
}

/**
 * A client registered for a single flow via Dynamic Client Registration.
 * `clientSecret` is `null` for a public (PKCE-only) client — the common case
 * for an MCP authorization server that advertises
 * `token_endpoint_auth_method: "none"`. When the server returns a secret it is
 * carried in the Redis pending-state alongside the PKCE verifier and used at
 * the token exchange. The per-flow client is ephemeral for ACQUISITION; as of
 * M3.1, a credential that carries a refresh token additionally persists its
 * issuing client durably (`client_id` on the row, `client_secret` in OpenBao)
 * so a later `refresh_token` grant can re-present it — see
 * `.claude/rules/oauth-mcp.md`.
 */
export interface RegisteredClient {
  clientId: string;
  clientSecret: string | null;
}
