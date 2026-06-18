import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';

import { OAuthProvider } from '../oauth-credentials.types';
import { BaseOAuthProvider } from './base-oauth-provider';

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
}
