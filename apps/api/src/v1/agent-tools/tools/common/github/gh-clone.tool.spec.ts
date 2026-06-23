import { ToolRunnableConfig } from '@langchain/core/tools';
import { Test, TestingModule } from '@nestjs/testing';
import { DefaultLogger, InternalException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { GitRepositoriesDao } from '../../../../git-repositories/dao/git-repositories.dao';
import { GitRepositoryEntity } from '../../../../git-repositories/entity/git-repository.entity';
import { BaseRuntime } from '../../../../runtime/services/base-runtime';
import { GhBaseToolConfig } from './gh-base.tool';
import { GhCloneTool, GhCloneToolSchemaType } from './gh-clone.tool';

describe('GhCloneTool', () => {
  let tool: GhCloneTool;
  let mockRuntime: BaseRuntime;
  let mockConfig: GhBaseToolConfig;
  let mockGitRepositoriesDao: GitRepositoriesDao;

  beforeEach(async () => {
    mockRuntime = {
      exec: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
    } as unknown as BaseRuntime;

    mockConfig = {
      runtimeProvider: {
        provide: vi.fn().mockResolvedValue(mockRuntime),
      } as any,
      resolveTokenForOwner: vi.fn().mockResolvedValue('ghp_test_token'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GhCloneTool,
        {
          provide: GitRepositoriesDao,
          useValue: {
            getOne: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({}),
            updateById: vi.fn().mockResolvedValue({}),
          },
        },
        {
          provide: DefaultLogger,
          useValue: {
            warn: vi.fn(),
            info: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
          },
        },
      ],
    }).compile();

    tool = module.get<GhCloneTool>(GhCloneTool);
    mockGitRepositoriesDao = module.get<GitRepositoriesDao>(GitRepositoriesDao);
  });

  describe('properties', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe('gh_clone');
    });

    it('should have correct description', () => {
      expect(tool.description).toContain('Clone a GitHub repository');
    });
  });

  describe('invoke', () => {
    const mockCfg: ToolRunnableConfig<BaseAgentConfigurable> = {
      configurable: {
        thread_id: 'test-thread-123',
        thread_created_by: 'user-123',
        graph_project_id: 'project-456',
      },
    };

    it('should clone repository and track it via DAO', async () => {
      const args: GhCloneToolSchemaType = {
        owner: 'octocat',
        repo: 'Hello-World',
      };

      vi.spyOn(tool as any, 'execGhCommand').mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
        execPath: '/runtime-workspace/test-thread-123',
      });

      await tool.invoke(args, mockConfig, mockCfg);

      expect(mockGitRepositoriesDao.getOne).toHaveBeenCalled();
      expect(mockGitRepositoriesDao.create).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'octocat',
          repo: 'Hello-World',
          url: 'https://github.com/octocat/Hello-World.git',
        }),
      );
    });

    it('should update repository if it already exists', async () => {
      const args: GhCloneToolSchemaType = {
        owner: 'octocat',
        repo: 'Hello-World',
      };

      vi.spyOn(tool as any, 'execGhCommand').mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
        execPath: '/runtime-workspace/test-thread-123',
      });

      vi.spyOn(mockGitRepositoriesDao, 'getOne').mockResolvedValue({
        id: 'existing-id',
      } as Partial<GitRepositoryEntity> as GitRepositoryEntity);

      await tool.invoke(args, mockConfig, mockCfg);

      expect(mockGitRepositoriesDao.updateById).toHaveBeenCalledWith(
        'existing-id',
        expect.objectContaining({
          url: 'https://github.com/octocat/Hello-World.git',
        }),
      );
    });

    it('fails CLOSED: re-throws a PAT-misconfig InternalException without an anonymous clone', async () => {
      const args: GhCloneToolSchemaType = {
        owner: 'octocat',
        repo: 'Hello-World',
      };

      const failClosedConfig: GhBaseToolConfig = {
        runtimeProvider: mockConfig.runtimeProvider,
        resolveTokenForOwner: vi
          .fn()
          .mockRejectedValue(
            new InternalException(
              'GITHUB_PAT_MISSING',
              'GITHUB_AUTH_MODE is "pat" but GITHUB_PAT is empty or unset',
            ),
          ),
      };

      const execGhCommandSpy = vi
        .spyOn(tool as any, 'execGhCommand')
        .mockResolvedValue({
          exitCode: 0,
          stdout: '',
          stderr: '',
          execPath: '',
        });

      // The PAT misconfiguration must surface, not be swallowed into an
      // anonymous clone (the gh-clone re-throw guard).
      await expect(
        tool.invoke(args, failClosedConfig, mockCfg),
      ).rejects.toThrow(InternalException);
      expect(execGhCommandSpy).not.toHaveBeenCalled();
    });

    it('should use git clone when no token is available', async () => {
      const args: GhCloneToolSchemaType = {
        owner: 'octocat',
        repo: 'Hello-World',
      };

      const noTokenConfig: GhBaseToolConfig = {
        runtimeProvider: mockConfig.runtimeProvider,
        resolveTokenForOwner: vi.fn().mockResolvedValue(null),
      };

      const execGhCommandSpy = vi
        .spyOn(tool as any, 'execGhCommand')
        .mockResolvedValue({
          exitCode: 0,
          stdout: '',
          stderr: '',
          execPath: '/runtime-workspace/test-thread-123',
        });

      await tool.invoke(args, noTokenConfig, mockCfg);

      expect(execGhCommandSpy).toHaveBeenCalled();
      const firstCallParams = execGhCommandSpy.mock.calls[0]![0] as {
        cmd: string;
        resolvedToken: string | null;
      };
      expect(firstCallParams.cmd).toContain('git clone');
      expect(firstCallParams.cmd).not.toContain('gh repo clone');
      expect(firstCallParams.cmd).toContain('[clone-heartbeat]');
      expect(firstCallParams.resolvedToken).toBeNull();
    });

    it('should retry with git clone when authenticated clone fails', async () => {
      const args: GhCloneToolSchemaType = {
        owner: 'octocat',
        repo: 'Hello-World',
      };

      vi.spyOn(tool as any, 'detectDefaultBranch').mockResolvedValue('main');
      vi.spyOn(tool as any, 'findAgentInstructions').mockResolvedValue(
        undefined,
      );

      const execGhCommandSpy = vi
        .spyOn(tool as any, 'execGhCommand')
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'Repository not granted to installation',
          execPath: '/runtime-workspace/test-thread-123',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
          execPath: '/runtime-workspace/test-thread-123',
        });

      await tool.invoke(args, mockConfig, mockCfg);

      expect(execGhCommandSpy).toHaveBeenCalledTimes(2);

      const firstCallParams = execGhCommandSpy.mock.calls[0]![0] as {
        cmd: string;
        resolvedToken: string | null;
      };
      expect(firstCallParams.cmd).toContain(' clone --progress ');
      expect(firstCallParams.cmd).toContain('http.extraHeader');
      expect(firstCallParams.cmd).toContain('[clone-heartbeat]');
      expect(firstCallParams.resolvedToken).toBe('ghp_test_token');

      const secondCallParams = execGhCommandSpy.mock.calls[1]![0] as {
        cmd: string;
        resolvedToken: string | null;
      };
      expect(secondCallParams.cmd).toContain('git clone');
      expect(secondCallParams.cmd).not.toContain('gh repo clone');
      expect(secondCallParams.cmd).toContain('[clone-heartbeat]');
      expect(secondCallParams.resolvedToken).toBeNull();
    });

    it('should sanitize dots in repo name to hyphens in default clone path', async () => {
      const args: GhCloneToolSchemaType = {
        owner: 'fluxnow',
        repo: 'fluxnow.dev',
      };

      vi.spyOn(tool as any, 'detectDefaultBranch').mockResolvedValue('main');
      vi.spyOn(tool as any, 'findAgentInstructions').mockResolvedValue(
        undefined,
      );

      const execGhCommandSpy = vi
        .spyOn(tool as any, 'execGhCommand')
        .mockResolvedValue({
          exitCode: 0,
          stdout: '',
          stderr: '',
          execPath: '/runtime-workspace/test-thread-123',
        });

      const result = await tool.invoke(args, mockConfig, mockCfg);

      const cloneCmd = (execGhCommandSpy.mock.calls[0]![0] as { cmd: string })
        .cmd;
      expect(cloneCmd).toContain('/runtime-workspace/fluxnow-dev');
      expect(cloneCmd).not.toContain('/runtime-workspace/fluxnow.dev');
      expect(result.output.path).toBe('/runtime-workspace/fluxnow-dev');
    });

    it('should use explicit workdir as-is without sanitization', async () => {
      const args: GhCloneToolSchemaType = {
        owner: 'fluxnow',
        repo: 'fluxnow.dev',
        workdir: '/runtime-workspace/my-custom-path',
      };

      vi.spyOn(tool as any, 'detectDefaultBranch').mockResolvedValue('main');
      vi.spyOn(tool as any, 'findAgentInstructions').mockResolvedValue(
        undefined,
      );

      const execGhCommandSpy = vi
        .spyOn(tool as any, 'execGhCommand')
        .mockResolvedValue({
          exitCode: 0,
          stdout: '',
          stderr: '',
          execPath: '/runtime-workspace/test-thread-123',
        });

      const result = await tool.invoke(args, mockConfig, mockCfg);

      const cloneCmd = (execGhCommandSpy.mock.calls[0]![0] as { cmd: string })
        .cmd;
      expect(cloneCmd).toContain('/runtime-workspace/my-custom-path');
      expect(result.output.path).toBe('/runtime-workspace/my-custom-path');
    });

    it('should always include explicit destination in clone command for plain repo name', async () => {
      const args: GhCloneToolSchemaType = {
        owner: 'octocat',
        repo: 'Hello-World',
      };

      vi.spyOn(tool as any, 'detectDefaultBranch').mockResolvedValue('main');
      vi.spyOn(tool as any, 'findAgentInstructions').mockResolvedValue(
        undefined,
      );

      const execGhCommandSpy = vi
        .spyOn(tool as any, 'execGhCommand')
        .mockResolvedValue({
          exitCode: 0,
          stdout: '',
          stderr: '',
          execPath: '/runtime-workspace/test-thread-123',
        });

      const result = await tool.invoke(args, mockConfig, mockCfg);

      const cloneCmd = (execGhCommandSpy.mock.calls[0]![0] as { cmd: string })
        .cmd;
      expect(cloneCmd).toContain('/runtime-workspace/Hello-World');
      expect(result.output.path).toBe('/runtime-workspace/Hello-World');
    });

    it('should sanitize repo name with multiple special chars', async () => {
      const args: GhCloneToolSchemaType = {
        owner: 'org',
        repo: 'my.cool+repo@2024',
      };

      vi.spyOn(tool as any, 'detectDefaultBranch').mockResolvedValue('main');
      vi.spyOn(tool as any, 'findAgentInstructions').mockResolvedValue(
        undefined,
      );

      const execGhCommandSpy = vi
        .spyOn(tool as any, 'execGhCommand')
        .mockResolvedValue({
          exitCode: 0,
          stdout: '',
          stderr: '',
          execPath: '/runtime-workspace/test-thread-123',
        });

      const result = await tool.invoke(args, mockConfig, mockCfg);

      const cloneCmd = (execGhCommandSpy.mock.calls[0]![0] as { cmd: string })
        .cmd;
      expect(cloneCmd).toContain('my-cool-repo-2024');
      expect(result.output.path).toContain('my-cool-repo-2024');
    });

    // fetchDefaultBranchRef: when depth is set, invoke() must call execGhCommand
    // an additional time with `git fetch --depth 1 origin <branch>` after the clone
    // so that git knows the remote tracking ref for subsequent operations.
    it('should call git fetch --depth 1 origin <branch> when depth is set and default branch is detected', async () => {
      const args: GhCloneToolSchemaType = {
        owner: 'octocat',
        repo: 'Hello-World',
        depth: 1,
      };

      vi.spyOn(tool as any, 'detectDefaultBranch').mockResolvedValue('main');
      vi.spyOn(tool as any, 'findAgentInstructions').mockResolvedValue(
        undefined,
      );

      const execGhCommandSpy = vi
        .spyOn(tool as any, 'execGhCommand')
        .mockResolvedValue({
          exitCode: 0,
          stdout: '',
          stderr: '',
          execPath: '/runtime-workspace/test-thread-123',
        });

      await tool.invoke(args, mockConfig, mockCfg);

      const allCmds = execGhCommandSpy.mock.calls.map(
        (call) => (call[0] as { cmd: string }).cmd,
      );
      const fetchCall = allCmds.find(
        (cmd) =>
          cmd.includes('fetch') &&
          cmd.includes('--depth') &&
          cmd.includes('origin'),
      );
      expect(fetchCall).toBeDefined();
      expect(fetchCall).toContain('--depth 1');
      expect(fetchCall).toContain('origin');
      expect(fetchCall).toContain('main');
    });

    it('should not call git fetch --depth when depth is not set', async () => {
      const args: GhCloneToolSchemaType = {
        owner: 'octocat',
        repo: 'Hello-World',
      };

      vi.spyOn(tool as any, 'detectDefaultBranch').mockResolvedValue('main');
      vi.spyOn(tool as any, 'findAgentInstructions').mockResolvedValue(
        undefined,
      );

      const execGhCommandSpy = vi
        .spyOn(tool as any, 'execGhCommand')
        .mockResolvedValue({
          exitCode: 0,
          stdout: '',
          stderr: '',
          execPath: '/runtime-workspace/test-thread-123',
        });

      await tool.invoke(args, mockConfig, mockCfg);

      const allCmds = execGhCommandSpy.mock.calls.map(
        (call) => (call[0] as { cmd: string }).cmd,
      );
      const fetchDepthCall = allCmds.find(
        (cmd) =>
          cmd.includes('fetch') &&
          cmd.includes('--depth') &&
          cmd.includes('origin'),
      );
      expect(fetchDepthCall).toBeUndefined();
    });

    // refspec fix: when depth is set, invoke() must reset remote.origin.fetch
    // so that subsequent `git fetch origin <branch>` calls work correctly.
    it('should reset remote.origin.fetch refspec when depth is set', async () => {
      const args: GhCloneToolSchemaType = {
        owner: 'octocat',
        repo: 'Hello-World',
        depth: 1,
      };

      vi.spyOn(tool as any, 'detectDefaultBranch').mockResolvedValue('main');
      vi.spyOn(tool as any, 'findAgentInstructions').mockResolvedValue(
        undefined,
      );

      const execGhCommandSpy = vi
        .spyOn(tool as any, 'execGhCommand')
        .mockResolvedValue({
          exitCode: 0,
          stdout: '',
          stderr: '',
          execPath: '/runtime-workspace/test-thread-123',
        });

      await tool.invoke(args, mockConfig, mockCfg);

      const allCmds = execGhCommandSpy.mock.calls.map(
        (call) => (call[0] as { cmd: string }).cmd,
      );
      const refspecCall = allCmds.find(
        (cmd) =>
          cmd.includes('git') &&
          cmd.includes('config') &&
          cmd.includes('remote.origin.fetch'),
      );
      expect(refspecCall).toBeDefined();
      expect(refspecCall).toContain('+refs/heads/*:refs/remotes/origin/*');
    });

    it('should not reset remote.origin.fetch refspec when depth is not set', async () => {
      const args: GhCloneToolSchemaType = {
        owner: 'octocat',
        repo: 'Hello-World',
      };

      vi.spyOn(tool as any, 'detectDefaultBranch').mockResolvedValue('main');
      vi.spyOn(tool as any, 'findAgentInstructions').mockResolvedValue(
        undefined,
      );

      const execGhCommandSpy = vi
        .spyOn(tool as any, 'execGhCommand')
        .mockResolvedValue({
          exitCode: 0,
          stdout: '',
          stderr: '',
          execPath: '/runtime-workspace/test-thread-123',
        });

      await tool.invoke(args, mockConfig, mockCfg);

      const allCmds = execGhCommandSpy.mock.calls.map(
        (call) => (call[0] as { cmd: string }).cmd,
      );
      const refspecCall = allCmds.find(
        (cmd) =>
          cmd.includes('git') &&
          cmd.includes('config') &&
          cmd.includes('remote.origin.fetch'),
      );
      expect(refspecCall).toBeUndefined();
    });
  });
});
