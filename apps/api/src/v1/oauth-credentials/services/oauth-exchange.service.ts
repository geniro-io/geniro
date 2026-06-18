import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import { OAuthProvider, OAuthTokenResult } from '../oauth-credentials.types';
import { BaseOAuthProvider } from '../providers/base-oauth-provider';
import { LinearOAuthProvider } from '../providers/linear-oauth-provider';
import { RegisteredClient } from '../providers/oauth-provider.types';

/**
 * Resolves the per-provider OAuth strategy and delegates the provider-facing
 * HTTP — discovery (RFC 9728 -> RFC 8414), Dynamic Client Registration
 * (RFC 7591), and the token exchange — to it. Kept as a separate injectable so
 * integration tests can override it with a fake instead of reaching the real
 * provider over the network; the orchestration service
 * ({@link OAuthCredentialsService}) owns Redis / OpenBao / DB.
 *
 * A new OAuth MCP provider is a single strategy class registered in the module,
 * plus one line in this service's constructor provider-registry (the map below).
 */
@Injectable()
export class OAuthExchangeService {
  private readonly providers: Partial<Record<OAuthProvider, BaseOAuthProvider>>;

  constructor(linearProvider: LinearOAuthProvider) {
    this.providers = {
      [OAuthProvider.Linear]: linearProvider,
    };
  }

  /**
   * Discover the provider's authorization server and register a per-flow client
   * (DCR), then build the consent URL. Returns the authorize URL plus the
   * registered client for the caller to stow in the pending-state. Throws
   * (fail-closed) on any discovery / registration failure so the caller
   * persists no partial state.
   *
   * `redirectUri` MUST be the SAME value later passed to
   * {@link exchangeAuthorizationCode} — it is registered as `redirect_uris[0]`
   * and echoed in the authorize URL, so a byte-for-byte mismatch makes the AS
   * reject the flow.
   */
  async prepareAuthorization(
    provider: OAuthProvider,
    redirectUri: string,
    state: string,
    codeChallenge: string,
  ): Promise<{ authorizeUrl: string; client: RegisteredClient }> {
    const strategy = this.resolveProvider(provider);
    const server = await strategy.discover();
    const client = await strategy.register(server, redirectUri);
    const authorizeUrl = strategy.buildAuthorizeUrl(
      server,
      client.clientId,
      redirectUri,
      state,
      codeChallenge,
    );
    return { authorizeUrl, client };
  }

  /**
   * Exchange an authorization `code` (+ PKCE verifier) for an access token,
   * using the per-flow `client` registered at {@link prepareAuthorization}.
   * Re-discovers the token endpoint so the exchange always targets the same
   * authorization server that issued the code.
   */
  async exchangeAuthorizationCode(
    provider: OAuthProvider,
    code: string,
    codeVerifier: string,
    redirectUri: string,
    client: RegisteredClient,
  ): Promise<OAuthTokenResult> {
    const strategy = this.resolveProvider(provider);
    const server = await strategy.discover();
    return await strategy.exchangeCode(
      server,
      client,
      code,
      codeVerifier,
      redirectUri,
    );
  }

  private resolveProvider(provider: OAuthProvider): BaseOAuthProvider {
    const strategy = this.providers[provider];
    if (!strategy) {
      throw new BadRequestException('OAUTH_PROVIDER_NOT_SUPPORTED');
    }
    return strategy;
  }
}
