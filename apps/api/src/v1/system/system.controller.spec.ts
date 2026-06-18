import type { IContextData } from '@packages/http-server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GitHubAppService } from '../git-auth/services/github-app.service';
import { AuthProviderType } from './dto/system.dto';
import { SystemController } from './system.controller';

const KEYCLOAK_URL = 'http://localhost:8082';
const KEYCLOAK_REALM = 'geniro';
const KEYCLOAK_CLIENT_ID = 'geniro';
const ZITADEL_ISSUER = 'http://localhost:8085';
const ZITADEL_CLIENT_ID = 'zitadel-geniro';

const ADMIN_ROLE = 'admin';

const mockEnvironment: Record<string, unknown> = {
  authProvider: 'keycloak',
  keycloakUrl: KEYCLOAK_URL,
  keycloakRealm: KEYCLOAK_REALM,
  keycloakClientId: KEYCLOAK_CLIENT_ID,
  zitadelIssuer: ZITADEL_ISSUER,
  zitadelClientId: ZITADEL_CLIENT_ID,
  adminRole: ADMIN_ROLE,
  githubWebhookSecret: '',
  apiVersion: '1.2.3',
  webVersion: '0.4.5',
};

vi.mock('../../environments', () => ({
  get environment() {
    return mockEnvironment;
  },
}));

describe('SystemController', () => {
  let controller: SystemController;
  let mockGitHubAppService: { isConfigured: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockGitHubAppService = {
      isConfigured: vi.fn(),
    };

    controller = new SystemController(
      mockGitHubAppService as unknown as GitHubAppService,
    );

    // Reset to default for each test
    mockEnvironment.authProvider = 'keycloak';
    mockEnvironment.litellmManagementEnabled = true;
    mockEnvironment.adminRole = ADMIN_ROLE;
    mockEnvironment.githubWebhookSecret = '';
  });

  describe('getSettings', () => {
    const adminCtx = { roles: [ADMIN_ROLE] } as IContextData;
    const nonAdminCtx = { roles: ['viewer'] } as IContextData;
    const noRolesCtx = {} as IContextData;

    it('should return githubAppEnabled: true when configured', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      const result = controller.getSettings(nonAdminCtx);
      expect(result).toEqual({
        githubAppEnabled: true,
        litellmManagementEnabled: true,
        isAdmin: false,
        githubWebhookEnabled: false,
        apiVersion: '1.2.3',
        webVersion: '0.4.5',
      });
    });

    it('should return githubAppEnabled: false when not configured', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(false);
      const result = controller.getSettings(nonAdminCtx);
      expect(result).toEqual({
        githubAppEnabled: false,
        litellmManagementEnabled: true,
        isAdmin: false,
        githubWebhookEnabled: false,
        apiVersion: '1.2.3',
        webVersion: '0.4.5',
      });
    });

    it('should return litellmManagementEnabled: false when disabled', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      mockEnvironment.litellmManagementEnabled = false;
      const result = controller.getSettings(nonAdminCtx);
      expect(result).toEqual({
        githubAppEnabled: true,
        litellmManagementEnabled: false,
        isAdmin: false,
        githubWebhookEnabled: false,
        apiVersion: '1.2.3',
        webVersion: '0.4.5',
      });
    });

    it('should return isAdmin: true when user has admin role', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      const result = controller.getSettings(adminCtx);
      expect(result).toEqual({
        githubAppEnabled: true,
        litellmManagementEnabled: true,
        isAdmin: true,
        githubWebhookEnabled: false,
        apiVersion: '1.2.3',
        webVersion: '0.4.5',
      });
    });

    it('should return isAdmin: false when user has no roles', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      const result = controller.getSettings(noRolesCtx);
      expect(result).toEqual({
        githubAppEnabled: true,
        litellmManagementEnabled: true,
        isAdmin: false,
        githubWebhookEnabled: false,
        apiVersion: '1.2.3',
        webVersion: '0.4.5',
      });
    });

    it('should return isAdmin: false when user has roles but not the admin role', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      const multiRoleCtx = { roles: ['viewer', 'editor'] } as IContextData;
      const result = controller.getSettings(multiRoleCtx);
      expect(result).toEqual({
        githubAppEnabled: true,
        litellmManagementEnabled: true,
        isAdmin: false,
        githubWebhookEnabled: false,
        apiVersion: '1.2.3',
        webVersion: '0.4.5',
      });
    });

    it('should return isAdmin: true when custom admin role matches', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      mockEnvironment.adminRole = 'superuser';

      const superuserCtx = { roles: ['superuser'] } as IContextData;
      const superuserResult = controller.getSettings(superuserCtx);
      expect(superuserResult).toEqual({
        githubAppEnabled: true,
        litellmManagementEnabled: true,
        isAdmin: true,
        githubWebhookEnabled: false,
        apiVersion: '1.2.3',
        webVersion: '0.4.5',
      });

      const defaultAdminCtx = { roles: ['admin'] } as IContextData;
      const defaultAdminResult = controller.getSettings(defaultAdminCtx);
      expect(defaultAdminResult).toEqual({
        githubAppEnabled: true,
        litellmManagementEnabled: true,
        isAdmin: false,
        githubWebhookEnabled: false,
        apiVersion: '1.2.3',
        webVersion: '0.4.5',
      });
    });

    it('should return apiVersion and webVersion from environment', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      const result = controller.getSettings(nonAdminCtx);
      expect(result.apiVersion).toBe('1.2.3');
      expect(result.webVersion).toBe('0.4.5');
    });
  });

  describe('getAuthConfig', () => {
    it('should return keycloak config when authProvider is keycloak', () => {
      mockEnvironment.authProvider = 'keycloak';

      const result = controller.getAuthConfig();

      expect(result).toEqual({
        provider: AuthProviderType.Keycloak,
        issuer: `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`,
        clientId: KEYCLOAK_CLIENT_ID,
      });
    });

    it('should return zitadel config when authProvider is zitadel', () => {
      mockEnvironment.authProvider = 'zitadel';

      const result = controller.getAuthConfig();

      expect(result).toEqual({
        provider: AuthProviderType.Zitadel,
        issuer: ZITADEL_ISSUER,
        clientId: ZITADEL_CLIENT_ID,
      });
    });
  });
});
