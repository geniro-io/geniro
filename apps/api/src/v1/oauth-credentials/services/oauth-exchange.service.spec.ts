import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthProvider, OAuthTokenResult } from '../oauth-credentials.types';
import { LinearOAuthProvider } from '../providers/linear-oauth-provider';
import {
  DiscoveredOAuthServer,
  RegisteredClient,
} from '../providers/oauth-provider.types';
import { OAuthExchangeService } from './oauth-exchange.service';

const REDIRECT_URI = 'https://app.example.com/oauth/callback/linear';

const server: DiscoveredOAuthServer = {
  authorizationEndpoint: 'https://mcp.linear.app/authorize',
  tokenEndpoint: 'https://mcp.linear.app/token',
  registrationEndpoint: 'https://mcp.linear.app/register',
  resource: 'https://mcp.linear.app/mcp',
};

interface ProviderMock {
  discover: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  buildAuthorizeUrl: ReturnType<typeof vi.fn>;
  exchangeCode: ReturnType<typeof vi.fn>;
  refreshAccessToken: ReturnType<typeof vi.fn>;
}

describe('OAuthExchangeService', () => {
  let service: OAuthExchangeService;
  let linear: ProviderMock;

  beforeEach(() => {
    linear = {
      discover: vi.fn(),
      register: vi.fn(),
      buildAuthorizeUrl: vi.fn(),
      exchangeCode: vi.fn(),
      refreshAccessToken: vi.fn(),
    };
    service = new OAuthExchangeService(
      linear as unknown as LinearOAuthProvider,
    );
  });

  describe('prepareAuthorization', () => {
    it('discovers, registers a per-flow client, and builds the consent URL', async () => {
      const client: RegisteredClient = {
        clientId: 'dcr-1',
        clientSecret: null,
      };
      linear.discover.mockResolvedValue(server);
      linear.register.mockResolvedValue(client);
      linear.buildAuthorizeUrl.mockReturnValue(
        'https://mcp.linear.app/authorize?client_id=dcr-1',
      );

      const result = await service.prepareAuthorization(
        OAuthProvider.Linear,
        REDIRECT_URI,
        'state-1',
        'challenge-1',
      );

      expect(linear.discover).toHaveBeenCalledTimes(1);
      expect(linear.register).toHaveBeenCalledWith(server, REDIRECT_URI);
      expect(linear.buildAuthorizeUrl).toHaveBeenCalledWith(
        server,
        'dcr-1',
        REDIRECT_URI,
        'state-1',
        'challenge-1',
      );
      expect(result).toEqual({
        authorizeUrl: 'https://mcp.linear.app/authorize?client_id=dcr-1',
        client,
      });
    });

    it('fails closed on a discovery failure — registration is never attempted', async () => {
      linear.discover.mockRejectedValue(new Error('OAUTH_DISCOVERY_FAILED'));
      await expect(
        service.prepareAuthorization(
          OAuthProvider.Linear,
          REDIRECT_URI,
          's',
          'c',
        ),
      ).rejects.toThrow(/OAUTH_DISCOVERY_FAILED/);
      expect(linear.register).not.toHaveBeenCalled();
      expect(linear.buildAuthorizeUrl).not.toHaveBeenCalled();
    });
  });

  describe('exchangeAuthorizationCode', () => {
    it('re-discovers and delegates to the provider exchange with the stored client', async () => {
      const tokenResult: OAuthTokenResult = {
        accessToken: 'tok',
        scopes: ['read', 'write'],
        expiresAt: null,
        refreshToken: null,
        accountLabel: null,
      };
      const client: RegisteredClient = {
        clientId: 'dcr-1',
        clientSecret: null,
      };
      linear.discover.mockResolvedValue(server);
      linear.exchangeCode.mockResolvedValue(tokenResult);

      const result = await service.exchangeAuthorizationCode(
        OAuthProvider.Linear,
        'auth-code',
        'verifier',
        REDIRECT_URI,
        client,
      );

      expect(linear.discover).toHaveBeenCalledTimes(1);
      expect(linear.exchangeCode).toHaveBeenCalledWith(
        server,
        client,
        'auth-code',
        'verifier',
        REDIRECT_URI,
      );
      expect(result).toBe(tokenResult);
    });
  });

  describe('refreshAccessToken', () => {
    it('re-discovers and delegates to the provider refresh with the stored client', async () => {
      const tokenResult: OAuthTokenResult = {
        accessToken: 'tok-refreshed',
        scopes: null,
        expiresAt: null,
        refreshToken: 'rotated',
        accountLabel: null,
      };
      const client: RegisteredClient = {
        clientId: 'dcr-1',
        clientSecret: 'shh',
      };
      linear.discover.mockResolvedValue(server);
      linear.refreshAccessToken.mockResolvedValue(tokenResult);

      const result = await service.refreshAccessToken(
        OAuthProvider.Linear,
        'refresh-tok',
        client,
      );

      expect(linear.discover).toHaveBeenCalledTimes(1);
      expect(linear.refreshAccessToken).toHaveBeenCalledWith(
        server,
        client,
        'refresh-tok',
      );
      expect(result).toBe(tokenResult);
    });

    it('throws OAUTH_PROVIDER_NOT_SUPPORTED for an unregistered provider', async () => {
      const unknown = 'telegram' as OAuthProvider;
      await expect(
        service.refreshAccessToken(unknown, 'refresh-tok', {
          clientId: 'x',
          clientSecret: null,
        }),
      ).rejects.toThrow(/OAUTH_PROVIDER_NOT_SUPPORTED/);
      expect(linear.discover).not.toHaveBeenCalled();
    });
  });

  describe('provider resolution', () => {
    it('throws OAUTH_PROVIDER_NOT_SUPPORTED for an unregistered provider', async () => {
      const unknown = 'telegram' as OAuthProvider;
      await expect(
        service.prepareAuthorization(unknown, REDIRECT_URI, 's', 'c'),
      ).rejects.toThrow(/OAUTH_PROVIDER_NOT_SUPPORTED/);
      await expect(
        service.exchangeAuthorizationCode(unknown, 'code', 'v', REDIRECT_URI, {
          clientId: 'x',
          clientSecret: null,
        }),
      ).rejects.toThrow(/OAUTH_PROVIDER_NOT_SUPPORTED/);
      expect(linear.discover).not.toHaveBeenCalled();
    });
  });
});
