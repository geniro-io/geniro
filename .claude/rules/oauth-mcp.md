---
paths:
  - "apps/api/src/v1/oauth-credentials/**"
---

# OAuth for MCP Providers

Rules for the per-project OAuth credential providers that authenticate the agent's remote MCP nodes (e.g. Linear).

## Authenticate against the MCP server's OWN authorization server (DCR), not a per-deployment app

An OAuth MCP provider authenticates against the **MCP server's own** authorization server, discovered and registered **per flow** — there is NO pre-registered OAuth application and NO deployment credential (no `*_OAUTH_CLIENT_ID` / `*_OAUTH_CLIENT_SECRET` env, no `linearOAuthEnabled`-style gate).

The acquisition flow (owned by `BaseOAuthProvider`):

1. **Discover** — RFC 9728 protected-resource metadata (`<resource-origin>/.well-known/oauth-protected-resource[/<path>]`, with an origin-level fallback) → `authorization_servers[0]` → RFC 8414 authorization-server metadata (`<issuer>/.well-known/oauth-authorization-server`) for the authorize / token / registration endpoints.
2. **Register** — RFC 7591 Dynamic Client Registration (`POST /register`) yields a per-flow `{ client_id, client_secret? }`. Register a PUBLIC client (`token_endpoint_auth_method: "none"`) — PKCE is the proof-of-possession; capture a `client_secret` only when the server returns one.
3. **Authorize + exchange** — authorization-code + PKCE (S256), with the RFC 8707 `resource` indicator on BOTH the authorize and token requests so the issued token is audience-bound to the MCP endpoint (without it the bearer may be rejected at the resource).

## A new provider is one class + two registry lines

Add a `BaseOAuthProvider` subclass that declares only `provider`, `resourceUrl` (the MCP endpoint — also the RFC 9728 discovery root and the RFC 8707 resource), `scopes`, and `scopeSeparator` (standard OAuth uses a SPACE, not a comma — the legacy app-OAuth comma does not apply to the MCP AS), then register it in `OAuthCredentialsModule`'s `providers` AND add one line to the `OAuthExchangeService` constructor's provider-registry map (mirrors the `agent-mcp` `BaseMcp` + per-provider pattern). The explicit, type-safe constructor registry is kept deliberately over a dynamic multi-provider DI token, so a 2nd provider is one strategy class + one module line + one exchange-service constructor line — not a zero-edit drop-in. Providers are stateless → plain `@Injectable()` singletons (not `Scope.TRANSIENT`, which is for the per-runtime mutable state MCP blocks hold). Keep the explicit `constructor(logger) { super(logger); }` for reliable NestJS DI metadata emission on the subclass.

## No durable client storage, no migration

The per-flow client (`clientId` + nullable `clientSecret`) rides the EXISTING Redis pending-state alongside the PKCE verifier (server-side, short TTL) — never a durable column or a new table. A per-`(project, provider)` credential row has no home for a per-deployment client, so durable / cached DCR registration is the wrong shape; re-discover + re-register per flow instead.

## Fail closed, and validate the untrusted discovery responses

- `start()` discovers + registers BEFORE writing any pending-state — a discovery / registration failure throws and leaves NO partial state.
- Every external response (`.well-known`, `/register`, `/token`) is untrusted JSON: structurally validate object-ness + field typing before any dereference, and NEVER log a response body (it may carry a `client_secret` or token) — only safe envelope fields. See `.claude/rules/sandbox-boundary.md`.
- Discovered endpoints MUST be HTTPS, and the AS-metadata `issuer` MUST equal the discovered `authorization_servers[0]` (RFC 8414 §3.3 mix-up defense).
- The `redirect_uri` MUST be byte-for-byte identical across the DCR `redirect_uris[0]`, the authorize request, and the token exchange — derive all three from one `redirectUri(provider)` method.

## Acquisition only

This module is the credential ACQUISITION side. The token CONSUMPTION chain (the stored secret → graph-compiler `collectSecretNames` → runtime env → the `mcp-remote` bearer header) is independent and unchanged — the token reaches the sandbox via each block's own `x-ui:secret-select` channel, NEVER `x-ui:secret-select-host` (which is host-only, the opposite side of the trust boundary).
