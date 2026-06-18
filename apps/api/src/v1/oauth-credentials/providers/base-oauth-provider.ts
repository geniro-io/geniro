import { Injectable } from '@nestjs/common';
import { BadRequestException, DefaultLogger } from '@packages/common';

import { OAuthProvider, OAuthTokenResult } from '../oauth-credentials.types';
import {
  DiscoveredOAuthServer,
  RegisteredClient,
} from './oauth-provider.types';

const DISCOVERY_TIMEOUT_MS = 10_000;
const REGISTER_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 15_000;

interface JsonResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * Base for per-provider OAuth strategies. Owns the deployment-config-free
 * acquisition flow against an MCP server's OWN authorization server:
 *
 *   discover()           : RFC 9728 protected-resource metadata -> RFC 8414
 *                          authorization-server metadata (authorize / token /
 *                          register endpoints + the RFC 8707 resource).
 *   register()           : RFC 7591 Dynamic Client Registration — a per-flow
 *                          client, no pre-provisioned OAuth app, no deploy config.
 *   buildAuthorizeUrl()  : the authorization-code + PKCE consent leg.
 *   exchangeCode()       : the token leg.
 *
 * Both request legs carry the RFC 8707 `resource` indicator so the issued token
 * is audience-bound to the MCP endpoint (without it the bearer may be rejected
 * at the MCP resource).
 *
 * TRUST BOUNDARY: every response (`.well-known`, `/register`, `/token`) is
 * untrusted external JSON. Each is structurally validated (object-ness +
 * required-field typing) BEFORE any property is dereferenced, and response
 * BODIES are never logged — they may carry a `client_secret` or access token;
 * only safe envelope fields (status, stage) reach the log. See
 * `.claude/rules/sandbox-boundary.md`.
 */
@Injectable()
export abstract class BaseOAuthProvider {
  protected constructor(protected readonly logger: DefaultLogger) {}

  /** The provider this strategy handles. */
  abstract readonly provider: OAuthProvider;

  /**
   * The remote MCP resource URL. Doubles as the RFC 9728 discovery root and the
   * RFC 8707 resource indicator the issued token is audience-bound to.
   */
  abstract readonly resourceUrl: string;

  /** Scopes requested when the project configures none. */
  abstract readonly scopes: string[];

  /** Separator joining scopes in the `scope` parameter (standard OAuth: space). */
  abstract readonly scopeSeparator: string;

  /**
   * Resolve the authorization-server coordinates for this provider's MCP
   * resource. Two external GETs (protected-resource -> authorization-server
   * metadata); throws `OAUTH_DISCOVERY_FAILED` (fail-closed) on any malformed /
   * missing metadata so the caller writes no partial pending-state.
   */
  async discover(): Promise<DiscoveredOAuthServer> {
    const { resource, authorizationServer } =
      await this.fetchProtectedResourceMetadata();
    const endpoints =
      await this.fetchAuthorizationServerMetadata(authorizationServer);
    return { ...endpoints, resource };
  }

  /**
   * Register a per-flow client via RFC 7591 Dynamic Client Registration. Public
   * (`token_endpoint_auth_method: none`) — PKCE is the proof-of-possession, so a
   * public client needs no stored secret; if the server nonetheless returns a
   * `client_secret` it is captured and used at the token exchange.
   */
  async register(
    server: DiscoveredOAuthServer,
    redirectUri: string,
  ): Promise<RegisteredClient> {
    const requestBody = JSON.stringify({
      client_name: 'Geniro',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: this.scopes.join(this.scopeSeparator),
    });
    const response = await this.postJson(
      server.registrationEndpoint,
      requestBody,
      'application/json',
      REGISTER_TIMEOUT_MS,
    );
    if (!response.ok || !this.isObject(response.body)) {
      this.logger.error(
        `OAuth DCR registration failed for ${this.provider}: status ${response.status}`,
      );
      throw new BadRequestException('OAUTH_REGISTRATION_FAILED');
    }
    const clientId = this.asString(response.body.client_id);
    if (!clientId) {
      this.logger.error(
        `OAuth DCR registration returned no client_id for ${this.provider}`,
      );
      throw new BadRequestException('OAUTH_REGISTRATION_FAILED');
    }
    return {
      clientId,
      clientSecret: this.asString(response.body.client_secret),
    };
  }

  /**
   * Build the authorization-code consent URL. The `redirect_uri` passed here
   * MUST byte-for-byte equal the `redirect_uris[0]` registered in {@link
   * register} and the value used at {@link exchangeCode}, or the AS rejects the
   * flow.
   */
  buildAuthorizeUrl(
    server: DiscoveredOAuthServer,
    clientId: string,
    redirectUri: string,
    state: string,
    codeChallenge: string,
  ): string {
    const url = new URL(server.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', this.scopes.join(this.scopeSeparator));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // RFC 8707 — audience-bind the issued token to the MCP resource.
    url.searchParams.set('resource', server.resource);
    return url.toString();
  }

  /**
   * Exchange an authorization `code` (+ PKCE verifier) for an access token at
   * the discovered token endpoint. `accountLabel` is always `null` here — an
   * MCP-scoped token does not authenticate a provider identity probe, so the
   * orchestration service supplies the provider-name fallback.
   */
  async exchangeCode(
    server: DiscoveredOAuthServer,
    client: RegisteredClient,
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<OAuthTokenResult> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      code_verifier: codeVerifier,
      // RFC 8707 — same audience binding as the authorize request.
      resource: server.resource,
    });
    if (client.clientSecret) {
      body.set('client_secret', client.clientSecret);
    }

    const response = await this.postJson(
      server.tokenEndpoint,
      body.toString(),
      'application/x-www-form-urlencoded',
      TOKEN_TIMEOUT_MS,
    );
    if (!response.ok || !this.isObject(response.body)) {
      this.logger.error(
        `OAuth token exchange failed for ${this.provider}: status ${response.status}`,
      );
      throw new BadRequestException('OAUTH_TOKEN_EXCHANGE_FAILED');
    }

    const data = response.body;
    const accessToken = this.asString(data.access_token);
    if (!accessToken) {
      this.logger.error(
        `OAuth token exchange returned no access_token for ${this.provider}`,
      );
      throw new BadRequestException('OAUTH_TOKEN_EXCHANGE_FAILED');
    }

    const scopes =
      typeof data.scope === 'string'
        ? data.scope.split(/[\s,]+/).filter(Boolean)
        : null;
    // Any numeric lifetime yields a concrete expiry — a non-positive value maps
    // to an already-past Date (token dead on arrival) rather than `null`, so
    // status() never mistakes it for a permanent token. Only an absent /
    // non-numeric `expires_in` means "expiry unknown" -> null.
    const expiresAt =
      typeof data.expires_in === 'number'
        ? new Date(Date.now() + data.expires_in * 1000)
        : null;

    return { accessToken, scopes, expiresAt, accountLabel: null };
  }

  /**
   * RFC 9728 — protected-resource metadata. The well-known segment is inserted
   * between host and resource path (`.../.well-known/oauth-protected-resource/<path>`),
   * falling back to the origin-level path. Returns the canonical resource id and
   * the first advertised authorization server.
   */
  private async fetchProtectedResourceMetadata(): Promise<{
    resource: string;
    authorizationServer: string;
  }> {
    const resourceUrl = new URL(this.resourceUrl);
    const candidates = [
      `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`,
      `${resourceUrl.origin}/.well-known/oauth-protected-resource`,
    ];

    // Accept the FIRST candidate that returns an OK, object-shaped body. A 200
    // with a non-object body (a JSON error page, a misrouted scalar/array/null)
    // is NOT a usable answer — keep trying the next candidate rather than
    // treating the first OK response as final, or the origin-level fallback is
    // silently skipped.
    let body: Record<string, unknown> | undefined;
    let lastStatus = 0;
    for (const url of candidates) {
      const response = await this.getJson(url, DISCOVERY_TIMEOUT_MS);
      if (response.ok && this.isObject(response.body)) {
        body = response.body;
        break;
      }
      lastStatus = response.status;
    }
    if (body === undefined) {
      this.failDiscovery('protected-resource metadata', `status ${lastStatus}`);
    }

    const servers = this.asStringArray(body.authorization_servers);
    const authorizationServer =
      servers && servers.length > 0 ? servers[0] : null;
    if (!authorizationServer) {
      this.failDiscovery(
        'protected-resource metadata',
        'missing authorization_servers',
      );
    }
    // Fall back to the configured resource URL when the metadata omits it.
    const resource = this.asString(body.resource) ?? this.resourceUrl;
    return { resource, authorizationServer };
  }

  /**
   * RFC 8414 — authorization-server metadata at
   * `<issuer>/.well-known/oauth-authorization-server`. Returns the three
   * endpoints the flow needs; throws `OAUTH_DISCOVERY_FAILED` if the issuer is
   * non-HTTPS, the metadata `issuer` does not match the discovered issuer
   * (RFC 8414 §3.3 — mix-up defense), any endpoint is missing, or any endpoint
   * is not HTTPS (these requests carry the code, PKCE verifier, and any
   * client_secret).
   */
  private async fetchAuthorizationServerMetadata(asIssuer: string): Promise<{
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint: string;
  }> {
    let issuerUrl: URL;
    try {
      issuerUrl = new URL(asIssuer);
    } catch {
      this.failDiscovery('authorization-server issuer', 'invalid issuer URL');
    }
    if (issuerUrl.protocol !== 'https:') {
      this.failDiscovery('authorization-server issuer', 'non-HTTPS issuer');
    }
    const issuerPath = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname;
    const metadataUrl = `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`;

    const response = await this.getJson(metadataUrl, DISCOVERY_TIMEOUT_MS);
    if (!response.ok || !this.isObject(response.body)) {
      this.failDiscovery(
        'authorization-server metadata',
        `status ${response.status}`,
      );
    }
    const body = response.body;
    // RFC 8414 §3.3 — the metadata `issuer` MUST equal the issuer identifier we
    // discovered it from, or this is a mixed-up / different server.
    if (this.asString(body.issuer) !== asIssuer) {
      this.failDiscovery('authorization-server metadata', 'issuer mismatch');
    }
    const authorizationEndpoint = this.asString(body.authorization_endpoint);
    const tokenEndpoint = this.asString(body.token_endpoint);
    const registrationEndpoint = this.asString(body.registration_endpoint);
    if (!authorizationEndpoint || !tokenEndpoint || !registrationEndpoint) {
      this.failDiscovery(
        'authorization-server metadata',
        'missing required endpoint',
      );
    }
    if (
      !this.isHttpsUrl(authorizationEndpoint) ||
      !this.isHttpsUrl(tokenEndpoint) ||
      !this.isHttpsUrl(registrationEndpoint)
    ) {
      this.failDiscovery('authorization-server metadata', 'non-HTTPS endpoint');
    }
    return { authorizationEndpoint, tokenEndpoint, registrationEndpoint };
  }

  private async getJson(url: string, timeoutMs: number): Promise<JsonResponse> {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      // Network / timeout — a non-OK result so discovery fails closed upstream.
      this.logger.debug(
        `OAuth discovery GET failed for ${this.provider}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return { ok: false, status: 0, body: null };
    }
  }

  private async postJson(
    url: string,
    body: string,
    contentType: string,
    timeoutMs: number,
  ): Promise<JsonResponse> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': contentType, Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const parsed = (await response.json().catch(() => null)) as unknown;
      return { ok: response.ok, status: response.status, body: parsed };
    } catch (error) {
      this.logger.debug(
        `OAuth POST failed for ${this.provider}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return { ok: false, status: 0, body: null };
    }
  }

  private failDiscovery(stage: string, safeDetail: string): never {
    // Safe envelope only — never the response body (may carry a secret).
    this.logger.error(
      `OAuth discovery failed for ${this.provider} at ${stage}: ${safeDetail}`,
    );
    throw new BadRequestException('OAUTH_DISCOVERY_FAILED');
  }

  /** Narrow an unknown parsed JSON value to a non-null object. */
  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private isHttpsUrl(value: string): boolean {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private asStringArray(value: unknown): string[] | null {
    return Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? (value as string[])
      : null;
  }
}
