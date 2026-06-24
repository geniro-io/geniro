import type { IContextData } from '@packages/http-server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GitHubAppService } from '../git-auth/services/github-app.service';
import { SecretsStoreService } from '../secrets-store/services/secrets-store.service';
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

/** Build the non-github fields of an expected settings response. */
const baseSettings = (
  overrides: Partial<{
    litellmManagementEnabled: boolean;
    isAdmin: boolean;
    githubWebhookEnabled: boolean;
  }> = {},
) => ({
  litellmManagementEnabled: true,
  isAdmin: false,
  githubWebhookEnabled: false,
  apiVersion: '1.2.3',
  webVersion: '0.4.5',
  ...overrides,
});

describe('SystemController', () => {
  let controller: SystemController;
  let mockGitHubAppService: { isConfigured: ReturnType<typeof vi.fn> };
  let mockSecretsStore: { isAvailable: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockGitHubAppService = {
      isConfigured: vi.fn().mockReturnValue(false),
    };
    mockSecretsStore = {
      isAvailable: vi.fn().mockReturnValue(false),
    };

    controller = new SystemController(
      mockGitHubAppService as unknown as GitHubAppService,
      mockSecretsStore as unknown as SecretsStoreService,
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

    it('App configured + secrets store available: both flags true', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      mockSecretsStore.isAvailable.mockReturnValue(true);
      const result = controller.getSettings(nonAdminCtx);
      expect(result).toEqual({
        githubAppEnabled: true,
        githubUserPatEnabled: true,
        ...baseSettings(),
      });
    });

    it('App not configured + secrets store available: PAT available, App not', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(false);
      mockSecretsStore.isAvailable.mockReturnValue(true);
      const result = controller.getSettings(nonAdminCtx);
      expect(result).toEqual({
        githubAppEnabled: false,
        githubUserPatEnabled: true,
        ...baseSettings(),
      });
    });

    it('App configured + secrets store unavailable: App available, PAT not', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      mockSecretsStore.isAvailable.mockReturnValue(false);
      const result = controller.getSettings(nonAdminCtx);
      expect(result).toEqual({
        githubAppEnabled: true,
        githubUserPatEnabled: false,
        ...baseSettings(),
      });
    });

    it('neither configured: both flags false', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(false);
      mockSecretsStore.isAvailable.mockReturnValue(false);
      const result = controller.getSettings(nonAdminCtx);
      expect(result).toEqual({
        githubAppEnabled: false,
        githubUserPatEnabled: false,
        ...baseSettings(),
      });
    });

    it('should return litellmManagementEnabled: false when disabled', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      mockSecretsStore.isAvailable.mockReturnValue(true);
      mockEnvironment.litellmManagementEnabled = false;
      const result = controller.getSettings(nonAdminCtx);
      expect(result).toEqual({
        githubAppEnabled: true,
        githubUserPatEnabled: true,
        ...baseSettings({ litellmManagementEnabled: false }),
      });
    });

    it('should return isAdmin: true when user has admin role', () => {
      const result = controller.getSettings(adminCtx);
      expect(result.isAdmin).toBe(true);
    });

    it('should return isAdmin: false when user has no roles', () => {
      const result = controller.getSettings(noRolesCtx);
      expect(result.isAdmin).toBe(false);
    });

    it('should return isAdmin: false when user has roles but not the admin role', () => {
      const multiRoleCtx = { roles: ['viewer', 'editor'] } as IContextData;
      const result = controller.getSettings(multiRoleCtx);
      expect(result.isAdmin).toBe(false);
    });

    it('should return isAdmin: true when custom admin role matches', () => {
      mockEnvironment.adminRole = 'superuser';

      const superuserCtx = { roles: ['superuser'] } as IContextData;
      expect(controller.getSettings(superuserCtx).isAdmin).toBe(true);

      const defaultAdminCtx = { roles: ['admin'] } as IContextData;
      expect(controller.getSettings(defaultAdminCtx).isAdmin).toBe(false);
    });

    it('should return apiVersion and webVersion from environment', () => {
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
