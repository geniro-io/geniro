import { Injectable } from '@nestjs/common';
import { BadRequestException, DefaultLogger } from '@packages/common';

import { environment } from '../../../environments';
import {
  OAUTH_PROVIDER_CONFIGS,
  OAuthProvider,
  OAuthTokenResult,
} from '../oauth-credentials.types';

interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Provider-facing HTTP for the OAuth authorization-code flow. Kept as a
 * separate injectable so integration tests can override it with a fake token
 * result instead of reaching the real provider over the network — the
 * orchestration service ({@link OAuthCredentialsService}) owns everything else.
 */
@Injectable()
export class OAuthExchangeService {
  constructor(private readonly logger: DefaultLogger) {}

  resolveClientCredentials(provider: OAuthProvider): OAuthClientCredentials {
    switch (provider) {
      case OAuthProvider.Linear:
        return {
          clientId: environment.linearOAuthClientId,
          clientSecret: environment.linearOAuthClientSecret,
        };
      default:
        return { clientId: '', clientSecret: '' };
    }
  }

  /** True only when both client id and secret are configured for the provider. */
  isProviderConfigured(provider: OAuthProvider): boolean {
    const { clientId, clientSecret } = this.resolveClientCredentials(provider);
    return Boolean(clientId) && Boolean(clientSecret);
  }

  /**
   * Exchange an authorization `code` (+ PKCE verifier) for an access token.
   * Throws `OAUTH_PROVIDER_NOT_CONFIGURED` when the client id/secret are unset
   * and `OAUTH_TOKEN_EXCHANGE_FAILED` on a non-OK / token-less response.
   */
  async exchangeAuthorizationCode(
    provider: OAuthProvider,
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<OAuthTokenResult> {
    const { clientId, clientSecret } = this.resolveClientCredentials(provider);
    if (!clientId || !clientSecret) {
      throw new BadRequestException('OAUTH_PROVIDER_NOT_CONFIGURED');
    }

    const config = OAUTH_PROVIDER_CONFIGS[provider];
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: codeVerifier,
    });

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    const data = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      token_type?: string;
      scope?: string;
      expires_in?: number;
      error?: string;
    };

    if (!response.ok || !data.access_token) {
      this.logger.error(
        `OAuth token exchange failed for ${provider}: status ${response.status} ${data.error ?? ''}`,
      );
      throw new BadRequestException('OAUTH_TOKEN_EXCHANGE_FAILED');
    }

    const scopes =
      typeof data.scope === 'string'
        ? data.scope.split(/[\s,]+/).filter(Boolean)
        : null;
    // Any numeric lifetime yields a concrete expiry — a non-positive value maps
    // to an already-past Date (token dead on arrival) rather than `null`, so
    // status() never mistakes it for a permanent, non-expiring token. Only an
    // absent / non-numeric `expires_in` means "expiry unknown" → null.
    const expiresAt =
      typeof data.expires_in === 'number'
        ? new Date(Date.now() + data.expires_in * 1000)
        : null;
    const accountLabel = await this.fetchAccountLabel(
      provider,
      data.access_token,
    );

    return { accessToken: data.access_token, scopes, expiresAt, accountLabel };
  }

  /**
   * Best-effort human-readable account label for the node UI. Never throws —
   * a failure just yields `null` and the caller falls back to the provider id.
   */
  private async fetchAccountLabel(
    provider: OAuthProvider,
    accessToken: string,
  ): Promise<string | null> {
    if (provider !== OAuthProvider.Linear) {
      return null;
    }
    try {
      const response = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: accessToken,
        },
        body: JSON.stringify({ query: '{ viewer { name } }' }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await response.json().catch(() => ({}))) as {
        data?: { viewer?: { name?: string } };
      };
      const name = data.data?.viewer?.name;
      return typeof name === 'string' && name.length > 0 ? name : null;
    } catch (error) {
      this.logger.debug(
        `Failed to fetch ${provider} account label: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
