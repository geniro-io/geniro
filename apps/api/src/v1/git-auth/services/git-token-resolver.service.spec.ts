import { Test, TestingModule } from '@nestjs/testing';
import { DefaultLogger, InternalException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GitHubAuthMethod } from '../../graph-resources/graph-resources.types';
import { GitProviderConnectionDao } from '../dao/git-provider-connection.dao';
import { GitProviderConnectionEntity } from '../entity/git-provider-connection.entity';
import { GitProvider } from '../git-auth.types';
import { GitPatModeService } from './git-pat-mode.service';
import { GitTokenResolverService } from './git-token-resolver.service';
import { GitHubAppService } from './github-app.service';

describe('GitTokenResolverService', () => {
  let service: GitTokenResolverService;
  let mockGitHubAppService: {
    isConfigured: ReturnType<typeof vi.fn>;
    getInstallationToken: ReturnType<typeof vi.fn>;
  };
  let mockConnectionDao: {
    getOne: ReturnType<typeof vi.fn>;
  };
  let mockGitPatModeService: {
    isPatMode: ReturnType<typeof vi.fn>;
    getValidatedPat: ReturnType<typeof vi.fn>;
    mode: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    mockGitHubAppService = {
      isConfigured: vi.fn().mockReturnValue(true),
      getInstallationToken: vi.fn().mockResolvedValue('ghs_app_token'),
    };

    mockConnectionDao = {
      getOne: vi.fn().mockResolvedValue(null),
    };

    // Default: app mode (the existing behaviour). PAT-mode tests override.
    mockGitPatModeService = {
      isPatMode: vi.fn().mockReturnValue(false),
      getValidatedPat: vi.fn(),
      mode: vi.fn().mockReturnValue(GitHubAuthMethod.GithubApp),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitTokenResolverService,
        {
          provide: GitHubAppService,
          useValue: mockGitHubAppService,
        },
        {
          provide: GitPatModeService,
          useValue: mockGitPatModeService,
        },
        {
          provide: GitProviderConnectionDao,
          useValue: mockConnectionDao,
        },
        {
          provide: DefaultLogger,
          useValue: {
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<GitTokenResolverService>(GitTokenResolverService);
  });

  describe('resolveToken', () => {
    it('should return GitHub App token when connection exists', async () => {
      mockConnectionDao.getOne.mockResolvedValue({
        metadata: { installationId: 12345 },
        isActive: true,
      } as unknown as GitProviderConnectionEntity);

      const result = await service.resolveToken(
        GitProvider.GitHub,
        'my-org',
        'user-1',
      );

      expect(result).toEqual({
        token: 'ghs_app_token',
        source: GitHubAuthMethod.GithubApp,
      });
      expect(mockConnectionDao.getOne).toHaveBeenCalledWith({
        userId: 'user-1',
        provider: GitProvider.GitHub,
        accountLogin: 'my-org',
        isActive: true,
      });
    });

    it('should return null when no connection found', async () => {
      mockConnectionDao.getOne.mockResolvedValue(null);

      const result = await service.resolveToken(
        GitProvider.GitHub,
        'my-org',
        'user-1',
      );

      expect(result).toBeNull();
      expect(mockConnectionDao.getOne).toHaveBeenCalledTimes(1);
    });

    it('should return null when App token generation fails and no fallback', async () => {
      mockConnectionDao.getOne.mockResolvedValue({
        metadata: { installationId: 12345 },
        isActive: true,
      } as unknown as GitProviderConnectionEntity);
      mockGitHubAppService.getInstallationToken.mockRejectedValue(
        new Error('Token generation failed'),
      );

      const result = await service.resolveToken(
        GitProvider.GitHub,
        'my-org',
        'user-1',
      );

      expect(result).toBeNull();
    });

    it('should return null when GitHub App is not configured', async () => {
      mockGitHubAppService.isConfigured.mockReturnValue(false);

      const result = await service.resolveToken(
        GitProvider.GitHub,
        'my-org',
        'user-1',
      );

      expect(result).toBeNull();
      expect(mockConnectionDao.getOne).not.toHaveBeenCalled();
    });

    it('should return null for non-GitHub providers', async () => {
      const result = await service.resolveToken(
        GitProvider.GitLab,
        'my-org',
        'user-1',
      );

      expect(result).toBeNull();
      expect(mockConnectionDao.getOne).not.toHaveBeenCalled();
    });

    it('should return null when no exact owner match exists without falling back', async () => {
      mockConnectionDao.getOne.mockResolvedValue(null);

      const result = await service.resolveToken(
        GitProvider.GitHub,
        'unknown-owner',
        'user-1',
      );

      expect(result).toBeNull();
      expect(mockConnectionDao.getOne).toHaveBeenCalledTimes(1);
      expect(mockConnectionDao.getOne).toHaveBeenCalledWith({
        userId: 'user-1',
        provider: GitProvider.GitHub,
        accountLogin: 'unknown-owner',
        isActive: true,
      });
    });
  });

  describe('resolveDefaultToken', () => {
    it('should return token from first active connection', async () => {
      mockConnectionDao.getOne.mockResolvedValue({
        metadata: { installationId: 99999 },
        isActive: true,
      } as unknown as GitProviderConnectionEntity);

      const result = await service.resolveDefaultToken('user-1');

      expect(result).toEqual({
        token: 'ghs_app_token',
        source: GitHubAuthMethod.GithubApp,
      });
      expect(mockConnectionDao.getOne).toHaveBeenCalledWith({
        userId: 'user-1',
        provider: GitProvider.GitHub,
        isActive: true,
      });
    });

    it('should return null when no connection exists', async () => {
      mockConnectionDao.getOne.mockResolvedValue(null);

      const result = await service.resolveDefaultToken('user-1');

      expect(result).toBeNull();
    });

    it('should return null when GitHub App is not configured', async () => {
      mockGitHubAppService.isConfigured.mockReturnValue(false);

      const result = await service.resolveDefaultToken('user-1');

      expect(result).toBeNull();
      expect(mockConnectionDao.getOne).not.toHaveBeenCalled();
    });

    it('should return null when token generation fails', async () => {
      mockConnectionDao.getOne.mockResolvedValue({
        metadata: { installationId: 99999 },
        isActive: true,
      } as unknown as GitProviderConnectionEntity);
      mockGitHubAppService.getInstallationToken.mockRejectedValue(
        new Error('Failed'),
      );

      const result = await service.resolveDefaultToken('user-1');

      expect(result).toBeNull();
    });
  });

  describe('PAT mode', () => {
    beforeEach(() => {
      mockGitPatModeService.isPatMode.mockReturnValue(true);
      mockGitPatModeService.mode.mockReturnValue(GitHubAuthMethod.Pat);
      mockGitPatModeService.getValidatedPat.mockReturnValue('ghp_test_pat');
    });

    it('resolveToken returns the PAT (source=Pat) and never touches the App path', async () => {
      const result = await service.resolveToken(
        GitProvider.GitHub,
        'some-org',
        'user-1',
      );

      expect(result).toEqual({
        token: 'ghp_test_pat',
        source: GitHubAuthMethod.Pat,
      });
      // PAT short-circuit is above the isConfigured() gate and the connection DAO.
      expect(mockConnectionDao.getOne).not.toHaveBeenCalled();
      expect(mockGitHubAppService.getInstallationToken).not.toHaveBeenCalled();
    });

    it('resolveToken resolves the PAT even when the GitHub App is NOT configured', async () => {
      mockGitHubAppService.isConfigured.mockReturnValue(false);

      const result = await service.resolveToken(
        GitProvider.GitHub,
        'some-org',
        'user-1',
      );

      expect(result).toEqual({
        token: 'ghp_test_pat',
        source: GitHubAuthMethod.Pat,
      });
    });

    it('resolveDefaultToken returns the PAT (source=Pat) above the !isConfigured early-return', async () => {
      mockGitHubAppService.isConfigured.mockReturnValue(false);

      const result = await service.resolveDefaultToken('user-1');

      expect(result).toEqual({
        token: 'ghp_test_pat',
        source: GitHubAuthMethod.Pat,
      });
      expect(mockConnectionDao.getOne).not.toHaveBeenCalled();
    });

    it('resolveToken fails CLOSED, propagating the InternalException when the PAT is missing/invalid', async () => {
      // Must be an InternalException specifically — the gh-clone / gh-base
      // re-throw guards key on `error instanceof InternalException` to surface
      // a PAT misconfig instead of swallowing it into an anonymous clone.
      mockGitPatModeService.getValidatedPat.mockImplementation(() => {
        throw new InternalException(
          'GITHUB_PAT_MISSING',
          'GITHUB_AUTH_MODE is "pat" but GITHUB_PAT is empty or unset',
        );
      });

      await expect(
        service.resolveToken(GitProvider.GitHub, 'some-org', 'user-1'),
      ).rejects.toThrow(InternalException);
      // And NOT silently a null token (which gh-clone would swallow).
    });

    it('resolveDefaultToken fails CLOSED, propagating the InternalException when the PAT is missing/invalid', async () => {
      mockGitPatModeService.getValidatedPat.mockImplementation(() => {
        throw new InternalException(
          'GITHUB_PAT_MISSING',
          'GITHUB_AUTH_MODE is "pat" but GITHUB_PAT is empty or unset',
        );
      });

      await expect(service.resolveDefaultToken('user-1')).rejects.toThrow(
        InternalException,
      );
    });

    it('still returns null for non-GitHub providers in pat mode', async () => {
      const result = await service.resolveToken(
        GitProvider.GitLab,
        'some-org',
        'user-1',
      );

      expect(result).toBeNull();
      // The non-GitHub guard runs before the PAT short-circuit.
      expect(mockGitPatModeService.getValidatedPat).not.toHaveBeenCalled();
    });
  });
});
