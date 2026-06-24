import { Test, TestingModule } from '@nestjs/testing';
import { DefaultLogger, InternalException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GitTokenResolverService } from '../../git-auth/services/git-token-resolver.service';
import { GithubResource, GithubResourceConfig } from './github-resource';

describe('GithubResource', () => {
  let githubResource: GithubResource;
  let mockLogger: DefaultLogger;
  let mockGitTokenResolverService: GitTokenResolverService;

  beforeEach(async () => {
    mockLogger = {
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
    } as unknown as DefaultLogger;

    mockGitTokenResolverService = {
      resolveToken: vi.fn().mockResolvedValue(null),
      resolveDefaultToken: vi.fn().mockResolvedValue(null),
    } as unknown as GitTokenResolverService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GithubResource,
        {
          provide: DefaultLogger,
          useValue: mockLogger,
        },
        {
          provide: GitTokenResolverService,
          useValue: mockGitTokenResolverService,
        },
      ],
    }).compile();

    githubResource = await module.resolve<GithubResource>(GithubResource);
  });

  describe('getData', () => {
    it('should return GitHub resource data with credential helper when auth enabled', async () => {
      const config: GithubResourceConfig = {
        auth: true,
      };

      const result = await githubResource.getData(config);

      expect(result.information).toContain(
        'Purpose: Work with GitHub from shell via gh CLI',
      );
      expect(result.kind).toBe('Shell');
      expect(result.data.initScriptTimeout).toBe(300000);
      expect(result.data.initScript).toContain('set -eu');
      expect(result.data.initScript).toContain('credential.helper');
      expect(result.data.initScript).toContain('x-access-token');
      expect(result.data.initScript).toContain('GH_TOKEN');
      expect(result.data.initScript).toContain(
        'gh config set git_protocol https',
      );
      expect(result.data.resolveEnv).toBeTypeOf('function');
    });

    it('should configure git user name when name is provided', async () => {
      const config: GithubResourceConfig = {
        name: 'Test User',
        auth: false,
      };

      const result = await githubResource.getData(config);

      expect(result.data.initScript).toContain(
        'git config --global user.name "Test User"',
      );
    });

    it('should configure default git user name when name is not provided', async () => {
      const config: GithubResourceConfig = {
        auth: false,
      };

      const result = await githubResource.getData(config);

      expect(result.data.initScript).toContain(
        'git config --global user.name "Geniro Bot"',
      );
    });

    it('should configure default git email when email is not provided', async () => {
      const config: GithubResourceConfig = {
        auth: false,
      };

      const result = await githubResource.getData(config);

      expect(result.data.initScript).toContain(
        'git config --global user.email "bot@geniro.io"',
      );
    });

    it('should configure git user email when email is provided', async () => {
      const config: GithubResourceConfig = {
        email: 'user@example.com',
        auth: false,
      };

      const result = await githubResource.getData(config);

      expect(result.data.initScript).toContain(
        'git config --global user.email "user@example.com"',
      );
    });

    it('should use provided name and fall back to default email when only name is given', async () => {
      const config: GithubResourceConfig = {
        name: 'Custom User',
        auth: false,
      };

      const result = await githubResource.getData(config);

      expect(result.data.initScript).toContain(
        'git config --global user.name "Custom User"',
      );
      expect(result.data.initScript).toContain(
        'git config --global user.email "bot@geniro.io"',
      );
    });

    it('should include GitHub CLI help information', async () => {
      const config: GithubResourceConfig = {
        auth: false,
      };

      const result = await githubResource.getData(config);

      expect(result.information).toContain('gh help');
      expect(result.information).toContain('gh <group> --help');
      expect(result.information).toContain('gh help <command>');
      expect(result.information).toContain('gh alias list');
      expect(result.information).toContain('gh extension list');
      expect(result.information).toContain('gh api --help');
    });

    it('should set up credential helper when auth is true', async () => {
      const config: GithubResourceConfig = {
        auth: true,
      };

      const result = await githubResource.getData(config);

      expect(result.data.initScript).toContain('credential.helper');
      expect(result.data.initScript).toContain('x-access-token');
      expect(result.data.initScript).toContain('GH_TOKEN');
    });

    it('should not set up credential helper when auth is false', async () => {
      const config: GithubResourceConfig = {
        auth: false,
      };

      const result = await githubResource.getData(config);

      expect(result.data.initScript).not.toContain('credential.helper');
    });

    it('should set up credential helper by default when auth is not specified', async () => {
      const config: GithubResourceConfig = {};

      const result = await githubResource.getData(config);

      expect(result.data.initScript).toContain('credential.helper');
      expect(result.data.initScript).toContain('x-access-token');
      expect(result.data.initScript).toContain('GH_TOKEN');
    });

    it('should configure Git protocol to HTTPS', async () => {
      const config: GithubResourceConfig = {
        auth: false,
      };

      const result = await githubResource.getData(config);

      expect(result.data.initScript).toContain(
        'gh config set git_protocol https',
      );
    });

    it('should disable Git pull rebase', async () => {
      const config: GithubResourceConfig = {
        auth: false,
      };

      const result = await githubResource.getData(config);

      expect(result.data.initScript).toContain(
        'git config --global pull.rebase false',
      );
    });

    it('should include error handling in init script', async () => {
      const config: GithubResourceConfig = {
        auth: false,
      };

      const result = await githubResource.getData(config);

      expect(result.data.initScript).toContain('set -eu');
      expect(result.data.initScript).toContain(
        'gh config set git_protocol https',
      );
      expect(result.data.initScript).toContain(
        'git config --global pull.rebase false',
      );
    });

    it('should have default git identity for ephemeral containers', async () => {
      const config: GithubResourceConfig = {
        auth: true,
      };

      const result = await githubResource.getData(config);

      expect(result.data.initScript).toContain(
        'git config --global user.name "Geniro Bot"',
      );
      expect(result.data.initScript).toContain(
        'git config --global user.email "bot@geniro.io"',
      );
    });

    it('should return resolveEnv that resolves to empty object when no userId', async () => {
      const config: GithubResourceConfig = {
        auth: true,
      };

      const result = await githubResource.getData(config);
      const env = await result.data.resolveEnv();

      expect(env).toEqual({});
    });

    it('should return resolveEnv that resolves GH_TOKEN from context', async () => {
      vi.mocked(
        mockGitTokenResolverService.resolveDefaultToken,
      ).mockResolvedValue({
        token: 'ghs_test123',
        source: 'github_app' as never,
      });

      const config: GithubResourceConfig = {
        auth: true,
      };

      const result = await githubResource.getData(config);
      const env = await result.data.resolveEnv({
        configurable: { thread_created_by: 'user-1' },
      });

      expect(env).toEqual({ GH_TOKEN: 'ghs_test123' });
      expect(
        mockGitTokenResolverService.resolveDefaultToken,
      ).toHaveBeenCalledWith('user-1');
    });

    it('should return resolveEnv that does NOT fall back to graph_created_by', async () => {
      const config: GithubResourceConfig = { auth: true };

      const result = await githubResource.getData(config);
      const env = await result.data.resolveEnv({
        configurable: { graph_created_by: 'graph-owner' },
      });

      expect(env).toEqual({});
      expect(
        mockGitTokenResolverService.resolveDefaultToken,
      ).not.toHaveBeenCalled();
    });

    it('resolveEnv re-throws an InternalException from the resolver (fail-closed on a broken PAT)', async () => {
      vi.mocked(
        mockGitTokenResolverService.resolveDefaultToken,
      ).mockRejectedValue(
        new InternalException('GITHUB_USER_PAT_UNREADABLE', 'unreadable'),
      );

      const result = await githubResource.getData({ auth: true });

      await expect(
        result.data.resolveEnv({
          configurable: { thread_created_by: 'user-1' },
        }),
      ).rejects.toThrow(InternalException);
    });

    it('resolveEnv returns {} (does not throw) on a benign resolver error', async () => {
      vi.mocked(
        mockGitTokenResolverService.resolveDefaultToken,
      ).mockRejectedValue(new Error('benign network blip'));

      const result = await githubResource.getData({ auth: true });

      const env = await result.data.resolveEnv({
        configurable: { thread_created_by: 'user-1' },
      });

      expect(env).toEqual({});
    });

    it('resolveEnv does not return user-A token when called with user-B identity', async () => {
      vi.mocked(
        mockGitTokenResolverService.resolveDefaultToken,
      ).mockImplementation(async (userId: string) => {
        if (userId === 'user-a') {
          return { token: 'ghs_user_a_token', source: 'github_app' as never };
        }
        return null;
      });

      const result = await githubResource.getData({ auth: true });

      const env = await result.data.resolveEnv({
        configurable: { thread_created_by: 'user-b' },
      });

      expect(env).toEqual({});
      expect(
        mockGitTokenResolverService.resolveDefaultToken,
      ).toHaveBeenCalledWith('user-b');
      expect(
        mockGitTokenResolverService.resolveDefaultToken,
      ).not.toHaveBeenCalledWith('user-a');
    });

    it('resolveToken does not return user-A token when called with user-B identity', async () => {
      vi.mocked(mockGitTokenResolverService.resolveToken).mockImplementation(
        async (_provider, _owner, userId: string) => {
          if (userId === 'user-a') {
            return { token: 'ghs_user_a_token', source: 'github_app' as never };
          }
          return null;
        },
      );

      const result = await githubResource.getData({ auth: true });

      const token = await result.resolveToken('some-org', 'user-b');

      expect(token).toBeNull();
      expect(mockGitTokenResolverService.resolveToken).toHaveBeenCalledWith(
        'github',
        'some-org',
        'user-b',
      );
    });

    it('should return resolveToken that resolves token for owner', async () => {
      vi.mocked(mockGitTokenResolverService.resolveToken).mockResolvedValue({
        token: 'ghs_owner_token',
        source: 'github_app' as never,
      });

      const config: GithubResourceConfig = {
        auth: true,
      };

      const result = await githubResource.getData(config);
      const token = await result.resolveToken('my-org', 'user-1');

      expect(token).toBe('ghs_owner_token');
      expect(mockGitTokenResolverService.resolveToken).toHaveBeenCalledWith(
        'github',
        'my-org',
        'user-1',
      );
    });

    it('should return null from resolveToken when no userId', async () => {
      const config: GithubResourceConfig = {
        auth: true,
      };

      const result = await githubResource.getData(config);
      const token = await result.resolveToken('my-org');

      expect(token).toBeNull();
    });
  });

  describe('setup', () => {
    it('should not have setup method defined', () => {
      expect(githubResource.setup).toBeUndefined();
    });
  });
});
