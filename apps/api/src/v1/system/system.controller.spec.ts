import type { IContextData } from '@packages/http-server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GitPatModeService } from '../git-auth/services/git-pat-mode.service';
import { GitHubAppService } from '../git-auth/services/github-app.service';
import { GitHubAuthMethod } from '../graph-resources/graph-resources.types';
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
  let mockGitPatModeService: {
    mode: ReturnType<typeof vi.fn>;
    isPatMode: ReturnType<typeof vi.fn>;
    isPatConfigured: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockGitHubAppService = {
      isConfigured: vi.fn(),
    };
    // Default: app mode (the existing behaviour). PAT-mode tests override.
    mockGitPatModeService = {
      mode: vi.fn().mockReturnValue(GitHubAuthMethod.GithubApp),
      isPatMode: vi.fn().mockReturnValue(false),
      isPatConfigured: vi.fn().mockReturnValue(false),
    };

    controller = new SystemController(
      mockGitHubAppService as unknown as GitHubAppService,
      mockGitPatModeService as unknown as GitPatModeService,
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

    it('app mode + App configured: available + installable', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      const result = controller.getSettings(nonAdminCtx);
      expect(result).toEqual({
        githubAppEnabled: true,
        githubAuthMode: GitHubAuthMethod.GithubApp,
        githubAvailable: true,
        githubAppInstallable: true,
        ...baseSettings(),
      });
    });

    it('app mode + App not configured: unavailable + not installable', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(false);
      const result = controller.getSettings(nonAdminCtx);
      expect(result).toEqual({
        githubAppEnabled: false,
        githubAuthMode: GitHubAuthMethod.GithubApp,
        githubAvailable: false,
        githubAppInstallable: false,
        ...baseSettings(),
      });
    });

    it('pat mode + PAT configured (App not configured): available but NOT installable', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(false);
      mockGitPatModeService.mode.mockReturnValue(GitHubAuthMethod.Pat);
      mockGitPatModeService.isPatMode.mockReturnValue(true);
      mockGitPatModeService.isPatConfigured.mockReturnValue(true);
      const result = controller.getSettings(nonAdminCtx);
      expect(result).toEqual({
        githubAppEnabled: false,
        githubAuthMode: GitHubAuthMethod.Pat,
        githubAvailable: true,
        githubAppInstallable: false,
        ...baseSettings(),
      });
    });

    it('pat mode + PAT NOT configured: unavailable + not installable', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(false);
      mockGitPatModeService.mode.mockReturnValue(GitHubAuthMethod.Pat);
      mockGitPatModeService.isPatMode.mockReturnValue(true);
      mockGitPatModeService.isPatConfigured.mockReturnValue(false);
      const result = controller.getSettings(nonAdminCtx);
      expect(result).toEqual({
        githubAppEnabled: false,
        githubAuthMode: GitHubAuthMethod.Pat,
        githubAvailable: false,
        githubAppInstallable: false,
        ...baseSettings(),
      });
    });

    it('pat mode while App ALSO configured: githubAppEnabled true but NOT installable', () => {
      // App env vars are set but GITHUB_AUTH_MODE=pat — the install UI must stay
      // hidden because the App is not the active mode.
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      mockGitPatModeService.mode.mockReturnValue(GitHubAuthMethod.Pat);
      mockGitPatModeService.isPatMode.mockReturnValue(true);
      mockGitPatModeService.isPatConfigured.mockReturnValue(true);
      const result = controller.getSettings(nonAdminCtx);
      expect(result).toEqual({
        githubAppEnabled: true,
        githubAuthMode: GitHubAuthMethod.Pat,
        githubAvailable: true,
        githubAppInstallable: false,
        ...baseSettings(),
      });
    });

    it('should return litellmManagementEnabled: false when disabled', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      mockEnvironment.litellmManagementEnabled = false;
      const result = controller.getSettings(nonAdminCtx);
      expect(result).toEqual({
        githubAppEnabled: true,
        githubAuthMode: GitHubAuthMethod.GithubApp,
        githubAvailable: true,
        githubAppInstallable: true,
        ...baseSettings({ litellmManagementEnabled: false }),
      });
    });

    it('should return isAdmin: true when user has admin role', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      const result = controller.getSettings(adminCtx);
      expect(result.isAdmin).toBe(true);
    });

    it('should return isAdmin: false when user has no roles', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      const result = controller.getSettings(noRolesCtx);
      expect(result.isAdmin).toBe(false);
    });

    it('should return isAdmin: false when user has roles but not the admin role', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      const multiRoleCtx = { roles: ['viewer', 'editor'] } as IContextData;
      const result = controller.getSettings(multiRoleCtx);
      expect(result.isAdmin).toBe(false);
    });

    it('should return isAdmin: true when custom admin role matches', () => {
      mockGitHubAppService.isConfigured.mockReturnValue(true);
      mockEnvironment.adminRole = 'superuser';

      const superuserCtx = { roles: ['superuser'] } as IContextData;
      expect(controller.getSettings(superuserCtx).isAdmin).toBe(true);

      const defaultAdminCtx = { roles: ['admin'] } as IContextData;
      expect(controller.getSettings(defaultAdminCtx).isAdmin).toBe(false);
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
