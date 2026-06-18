import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';

import {
  OAUTH_PROVIDER_CONFIGS,
  OAuthProvider,
} from '../oauth-credentials.types';
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
  readonly resourceUrl = OAUTH_PROVIDER_CONFIGS[OAuthProvider.Linear].mcpUrl;
  readonly scopes = ['read', 'write'];
  // Standard OAuth scope delimiter. The MCP authorization server is RFC 6749
  // compliant (space-delimited), unlike Linear's legacy app-OAuth which used a
  // comma — that endpoint is no longer the target.
  readonly scopeSeparator = ' ';
}
