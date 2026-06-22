import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';

import { OAuthProvider } from '../oauth-credentials.types';
import { BaseOAuthProvider } from './base-oauth-provider';

const ACCOUNT_LABEL_PROBE_TIMEOUT_MS = 10_000;

/**
 * Linear strategy. Authenticates against Linear's remote MCP server, which is
 * its OWN RFC 8414 authorization server exposing `/register` (DCR), `/authorize`
 * and `/token` (S256) — so there is NO pre-registered Linear OAuth app and no
 * deployment credential. All endpoints are resolved at run time by the base
 * discovery; only the stable MCP resource URL + scopes are provider-specific.
 */
@Injectable()
export class LinearOAuthProvider extends BaseOAuthProvider {
  constructor(logger: DefaultLogger) {
    super(logger);
  }

  readonly provider = OAuthProvider.Linear;
  // The stable Linear MCP endpoint — RFC 9728 discovery root + RFC 8707 resource
  // the issued token is audience-bound to. MUST stay identical to
  // OAUTH_PROVIDER_CONFIGS[Linear].mcpUrl (the endpoint that same token is later
  // injected against in agent-mcp/linear-mcp.ts); a drift would make the
  // audience-bound bearer get rejected at the MCP resource.
  readonly resourceUrl = 'https://mcp.linear.app/mcp';
  readonly scopes = ['read', 'write'];
  // Standard OAuth scope delimiter. The MCP authorization server is RFC 6749
  // compliant (space-delimited), unlike Linear's legacy app-OAuth which used a
  // comma — that endpoint is no longer the target.
  readonly scopeSeparator = ' ';

  /**
   * Linear's MCP server is its OWN identity source. With the just-issued,
   * MCP-audience-bound bearer we call the server's documented `get_user("me")`
   * tool and read back the authenticated user, returning `"<name> (<email>)"`
   * (or a graceful subset).
   *
   * The legacy `api.linear.app/graphql { viewer }` probe was removed because the
   * MCP-scoped token is NOT valid at that GENERAL API endpoint — but it IS valid
   * at the MCP resource it is RFC 8707 audience-bound to, so the server's own
   * `get_user` tool authenticates fine. A single stateless POST suffices:
   * Linear's MCP needs no `initialize`/session handshake for a `tools/call`.
   *
   * Best-effort and fail-soft: any failure (network, non-OK, malformed/crafted
   * frame) returns `null` so a failed probe never blocks acquisition (the
   * orchestration service then falls back to the provider name). The response is
   * untrusted external JSON — every level is structurally validated before
   * dereference and the body is never logged (it could echo the bearer/PII).
   */
  protected async probeAccountLabel(
    accessToken: string,
  ): Promise<string | null> {
    try {
      const response = await fetch(this.resourceUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          // Streamable HTTP: the server MAY answer as JSON or SSE.
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_user', arguments: { query: 'me' } },
        }),
        signal: AbortSignal.timeout(ACCOUNT_LABEL_PROBE_TIMEOUT_MS),
      });
      if (!response.ok) {
        // Safe envelope only — never the body (it could echo the bearer/PII).
        this.logger.debug(
          `Linear account-label probe non-OK: status ${response.status}`,
        );
        return null;
      }
      const user = this.parseGetUser(await response.text());
      if (!user) {
        return null;
      }
      const name = this.asString(user.name);
      const email = this.asString(user.email);
      const displayName = this.asString(user.displayName);
      if (name && email) {
        return `${name} (${email})`;
      }
      return name ?? displayName ?? email ?? null;
    } catch (error) {
      this.logger.debug(
        `Linear account-label probe failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return null;
    }
  }

  /**
   * Extract the `get_user` result object from a Streamable-HTTP `tools/call`
   * reply. The JSON-RPC envelope arrives either as SSE `data:` line(s) or — for
   * a server that negotiated plain JSON — as the whole body; the user object is
   * itself a JSON STRING nested in `result.content[].text`. Every level is
   * guarded (trust boundary); returns `null` on any structural surprise.
   */
  private parseGetUser(raw: string): Record<string, unknown> | null {
    const candidates: string[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        candidates.push(trimmed.slice('data:'.length).trim());
      }
    }
    // Fallback: a plain application/json reply has no SSE framing.
    candidates.push(raw.trim());

    for (const candidate of candidates) {
      const user = this.extractUserFromEnvelope(candidate);
      if (user) {
        return user;
      }
    }
    return null;
  }

  private extractUserFromEnvelope(
    candidate: string,
  ): Record<string, unknown> | null {
    let envelope: unknown;
    try {
      envelope = JSON.parse(candidate);
    } catch {
      return null;
    }
    if (!this.isObject(envelope) || !this.isObject(envelope.result)) {
      return null;
    }
    const content = envelope.result.content;
    if (!Array.isArray(content)) {
      return null;
    }
    for (const block of content) {
      if (!this.isObject(block) || block.type !== 'text') {
        continue;
      }
      const text = this.asString(block.text);
      if (!text) {
        continue;
      }
      try {
        const user: unknown = JSON.parse(text);
        if (this.isObject(user)) {
          return user;
        }
      } catch {
        // Not the user block — keep scanning the remaining content blocks.
      }
    }
    return null;
  }
}
