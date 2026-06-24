import { ToolRunnableConfig } from '@langchain/core/tools';
import { Test, TestingModule } from '@nestjs/testing';
import { InternalException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { BaseRuntime } from '../../../../runtime/services/base-runtime';
import { GhBaseToolConfig } from './gh-base.tool';
import {
  GhCreatePullRequestTool,
  GhCreatePullRequestToolSchemaType,
} from './gh-create-pull-request.tool';

type MockOctokit = {
  pulls: {
    create: ReturnType<typeof vi.fn>;
    requestReviewers: ReturnType<typeof vi.fn>;
  };
  issues: {
    update: ReturnType<typeof vi.fn>;
  };
};

describe('GhCreatePullRequestTool', () => {
  let tool: GhCreatePullRequestTool;
  let mockRuntime: BaseRuntime;
  let mockConfig: GhBaseToolConfig & { additionalLabels?: string[] };

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
      providers: [GhCreatePullRequestTool],
    }).compile();

    tool = module.get<GhCreatePullRequestTool>(GhCreatePullRequestTool);
  });

  describe('properties', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe('gh_pr_create');
    });

    it('should have correct description', () => {
      expect(tool.description).toContain('Create a GitHub Pull Request');
    });
  });

  describe('schema', () => {
    it('should validate required fields', () => {
      const validData = {
        owner: 'acme',
        repo: 'demo',
        title: 'Add search filters',
        head: 'feat/search-filters',
        base: 'main',
      };

      expect(() => tool.validate(validData)).not.toThrow();
    });

    it('should reject missing required fields', () => {
      expect(() =>
        tool.validate({
          owner: 'acme',
          repo: 'demo',
          title: 't',
          head: 'h',
        }),
      ).toThrow();
    });

    it('should reject empty strings for required fields', () => {
      expect(() =>
        tool.validate({
          owner: '',
          repo: 'demo',
          title: 't',
          head: 'h',
          base: 'main',
        }),
      ).toThrow();
    });

    it('should allow larger assignee lists via schema', () => {
      expect(() =>
        tool.validate({
          owner: 'acme',
          repo: 'demo',
          title: 'PR',
          head: 'feat/x',
          base: 'main',
          assignees: new Array(11).fill('octocat'),
        }),
      ).not.toThrow();
    });

    it('should reject too many combined reviewers via schema', () => {
      // NOTE: Tool input validation is performed via the JSON schema (Ajv), not Zod.
      // The combined constraint is enforced in Zod via superRefine, which currently
      // doesn't flow into our generated JSON schema.
      expect(() =>
        tool.validate({
          owner: 'acme',
          repo: 'demo',
          title: 'PR',
          head: 'feat/x',
          base: 'main',
          reviewers: new Array(16).fill('r'),
        }),
      ).toThrow();
    });
  });

  describe('invoke', () => {
    const mockCfg: ToolRunnableConfig<BaseAgentConfigurable> = {
      configurable: {
        thread_id: 'test-thread-123',
      },
    };

    it('should create PR and apply metadata in order', async () => {
      const args: GhCreatePullRequestToolSchemaType = {
        owner: 'acme',
        repo: 'demo',
        title: 'Add feature',
        body: 'Body',
        head: 'feat/add-feature',
        base: 'main',
        labels: ['bug'],
        assignees: ['octocat'],
        reviewers: ['reviewer1'],
        teamReviewers: ['platform'],
        closesIssues: [12],
      };

      const pullsCreate = vi.fn().mockResolvedValue({
        data: {
          number: 101,
          id: 999,
          node_id: 'NODE',
          html_url: 'https://github.com/acme/demo/pull/101',
          url: 'https://api.github.com/repos/acme/demo/pulls/101',
          state: 'open',
          draft: false,
          title: 'Add feature',
          body: 'Body\n\nCloses #12',
          base: {
            ref: 'main',
            sha: 'BASESHA',
            repo: { full_name: 'acme/demo' },
          },
          head: {
            ref: 'feat/add-feature',
            sha: 'HEADSHA',
            repo: { full_name: 'acme/demo' },
          },
          created_at: '2020-01-01T00:00:00Z',
          updated_at: '2020-01-02T00:00:00Z',
        },
      });

      const issuesUpdate = vi.fn().mockResolvedValue({
        data: {
          labels: [{ name: 'bug' }],
          assignees: [{ login: 'octocat' }],
        },
      });

      const pullsRequestReviewers = vi.fn().mockResolvedValue({
        data: {
          requested_reviewers: [{ login: 'reviewer1' }],
          requested_teams: [{ slug: 'platform' }],
        },
      });

      const mockClient: MockOctokit = {
        pulls: {
          create: pullsCreate,
          requestReviewers: pullsRequestReviewers,
        },
        issues: {
          update: issuesUpdate,
        },
      };

      const toolWithCreateClient = tool as unknown as {
        createClient: (token: string) => MockOctokit;
      };
      const createClientSpy = vi
        .spyOn(toolWithCreateClient, 'createClient')
        .mockReturnValue(mockClient as any);

      const { output } = await tool.invoke(
        args,
        { ...mockConfig, additionalLabels: ['team'] },
        mockCfg,
      );

      expect(createClientSpy).toHaveBeenCalledWith('ghp_test_token');
      expect(pullsCreate).toHaveBeenCalledTimes(1);
      expect(issuesUpdate).toHaveBeenCalledTimes(1);
      expect(pullsRequestReviewers).toHaveBeenCalledTimes(1);
      expect(issuesUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: ['team', 'bug'],
        }),
      );

      // Sequencing: create PR first
      expect(pullsCreate.mock.invocationCallOrder[0]!).toBeLessThan(
        issuesUpdate.mock.invocationCallOrder[0]!,
      );
      expect(issuesUpdate.mock.invocationCallOrder[0]!).toBeLessThan(
        pullsRequestReviewers.mock.invocationCallOrder[0]!,
      );

      // Body should include closes issue line
      expect(pullsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Closes #12'),
        }),
      );

      expect(output.success).toBe(true);
      if (output.success !== true) {
        throw new Error('Expected success output');
      }

      expect(output.pullRequest.number).toBe(101);
      expect(output.pullRequest.url).toContain('/pull/101');
      expect(output.applied?.labels).toEqual(['bug']);
      expect(output.applied?.assignees).toEqual(['octocat']);
      expect(output.applied?.reviewers).toEqual(['reviewer1']);
      expect(output.applied?.teamReviewers).toEqual(['platform']);
      expect(output.warnings).toBeUndefined();
    });

    it('should always apply additionalLabels even when labels are not provided', async () => {
      const args: GhCreatePullRequestToolSchemaType = {
        owner: 'acme',
        repo: 'demo',
        title: 'Add feature',
        head: 'feat/add-feature',
        base: 'main',
      };

      const pullsCreate = vi.fn().mockResolvedValue({
        data: {
          number: 101,
          id: 999,
          node_id: 'NODE',
          html_url: 'https://github.com/acme/demo/pull/101',
          url: 'https://api.github.com/repos/acme/demo/pulls/101',
          state: 'open',
          draft: false,
          title: 'Add feature',
          body: null,
          base: { ref: 'main', sha: 'BASE', repo: { full_name: 'acme/demo' } },
          head: {
            ref: 'feat/add-feature',
            sha: 'HEAD',
            repo: { full_name: 'acme/demo' },
          },
          created_at: '2020-01-01T00:00:00Z',
          updated_at: '2020-01-02T00:00:00Z',
        },
      });

      const issuesUpdate = vi.fn().mockResolvedValue({
        data: {
          labels: [{ name: 'team' }],
          assignees: [],
        },
      });

      const mockClient: MockOctokit = {
        pulls: { create: pullsCreate, requestReviewers: vi.fn() },
        issues: { update: issuesUpdate },
      };

      const toolWithCreateClient = tool as unknown as {
        createClient: (token: string) => MockOctokit;
      };
      vi.spyOn(toolWithCreateClient, 'createClient').mockReturnValue(
        mockClient as any,
      );

      const { output } = await tool.invoke(
        args,
        { ...mockConfig, additionalLabels: ['team'] },
        mockCfg,
      );

      expect(output.success).toBe(true);
      if (output.success !== true) {
        throw new Error('Expected success output');
      }

      expect(issuesUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: ['team'],
        }),
      );
      expect(output.applied?.labels).toEqual(['team']);
    });

    it('should return success with warnings if metadata application fails', async () => {
      const args: GhCreatePullRequestToolSchemaType = {
        owner: 'acme',
        repo: 'demo',
        title: 'Add feature',
        head: 'feat/add-feature',
        base: 'main',
        labels: ['bug'],
      };

      const pullsCreate = vi.fn().mockResolvedValue({
        data: {
          number: 101,
          id: 999,
          node_id: 'NODE',
          html_url: 'https://github.com/acme/demo/pull/101',
          url: 'https://api.github.com/repos/acme/demo/pulls/101',
          state: 'open',
          draft: false,
          title: 'Add feature',
          body: null,
          base: { ref: 'main', sha: 'BASE', repo: { full_name: 'acme/demo' } },
          head: {
            ref: 'feat/add-feature',
            sha: 'HEAD',
            repo: { full_name: 'acme/demo' },
          },
          created_at: '2020-01-01T00:00:00Z',
          updated_at: '2020-01-02T00:00:00Z',
        },
      });

      const issuesUpdate = vi.fn().mockRejectedValue(new Error('boom'));

      const mockClient: MockOctokit = {
        pulls: {
          create: pullsCreate,
          requestReviewers: vi.fn(),
        },
        issues: {
          update: issuesUpdate,
        },
      };

      const toolWithCreateClient = tool as unknown as {
        createClient: (token: string) => MockOctokit;
      };
      vi.spyOn(toolWithCreateClient, 'createClient').mockReturnValue(
        mockClient as any,
      );

      const { output } = await tool.invoke(args, mockConfig, mockCfg);

      expect(output.success).toBe(true);
      if (output.success !== true) {
        throw new Error('Expected success output');
      }

      expect(output.pullRequest.number).toBe(101);
      expect(output.warnings?.length).toBe(1);
      expect(output.warnings?.[0]).toContain('Failed to apply issue metadata');
    });

    it('should return success with warnings if reviewer request fails and still preserve applied issue metadata', async () => {
      const args: GhCreatePullRequestToolSchemaType = {
        owner: 'acme',
        repo: 'demo',
        title: 'Add feature',
        head: 'feat/add-feature',
        base: 'main',
        labels: ['bug'],
        assignees: ['octocat'],
        reviewers: ['reviewer1'],
      };

      const pullsCreate = vi.fn().mockResolvedValue({
        data: {
          number: 101,
          id: 999,
          node_id: 'NODE',
          html_url: 'https://github.com/acme/demo/pull/101',
          url: 'https://api.github.com/repos/acme/demo/pulls/101',
          state: 'open',
          draft: false,
          title: 'Add feature',
          body: null,
          base: { ref: 'main', sha: 'BASE', repo: { full_name: 'acme/demo' } },
          head: {
            ref: 'feat/add-feature',
            sha: 'HEAD',
            repo: { full_name: 'acme/demo' },
          },
          created_at: '2020-01-01T00:00:00Z',
          updated_at: '2020-01-02T00:00:00Z',
        },
      });

      const issuesUpdate = vi.fn().mockResolvedValue({
        data: {
          labels: [{ name: 'bug' }],
          assignees: [{ login: 'octocat' }],
        },
      });

      const pullsRequestReviewers = vi
        .fn()
        .mockRejectedValue(new Error('nope'));

      const mockClient: MockOctokit = {
        pulls: {
          create: pullsCreate,
          requestReviewers: pullsRequestReviewers,
        },
        issues: {
          update: issuesUpdate,
        },
      };

      const toolWithCreateClient = tool as unknown as {
        createClient: (token: string) => MockOctokit;
      };
      vi.spyOn(toolWithCreateClient, 'createClient').mockReturnValue(
        mockClient as any,
      );

      const { output } = await tool.invoke(args, mockConfig, mockCfg);

      expect(output.success).toBe(true);
      if (output.success !== true) {
        throw new Error('Expected success output');
      }

      expect(output.applied?.labels).toEqual(['bug']);
      expect(output.applied?.assignees).toEqual(['octocat']);
      expect(output.warnings?.[0]).toContain('Failed to request reviewers');
    });

    it('should return structured error if create PR fails', async () => {
      const args: GhCreatePullRequestToolSchemaType = {
        owner: 'acme',
        repo: 'demo',
        title: 'Add feature',
        head: 'feat/add-feature',
        base: 'main',
      };

      const pullsCreate = vi
        .fn()
        .mockRejectedValue(new Error('Validation Failed'));

      const mockClient: MockOctokit = {
        pulls: {
          create: pullsCreate,
          requestReviewers: vi.fn(),
        },
        issues: {
          update: vi.fn(),
        },
      };

      const toolWithCreateClient = tool as unknown as {
        createClient: (token: string) => MockOctokit;
      };
      vi.spyOn(toolWithCreateClient, 'createClient').mockReturnValue(
        mockClient as any,
      );

      const { output } = await tool.invoke(args, mockConfig, mockCfg);

      expect(output.success).toBe(false);
      if (output.success !== false) {
        throw new Error('Expected error output');
      }

      expect(output.error).toContain('GitHubError:');
    });

    it('re-throws an InternalException from the token resolver (fail-closed — never degrades to anonymous)', async () => {
      const args: GhCreatePullRequestToolSchemaType = {
        owner: 'acme',
        repo: 'demo',
        title: 'Add feature',
        head: 'feat/add-feature',
        base: 'main',
      };

      // A configured-but-unreadable per-user PAT surfaces as an
      // InternalException from the resolver. The tool MUST re-throw it rather
      // than return the not-configured response (which would let the agent
      // silently proceed unauthenticated).
      const failClosedConfig: GhBaseToolConfig = {
        ...mockConfig,
        resolveTokenForOwner: vi
          .fn()
          .mockRejectedValue(
            new InternalException(
              'GITHUB_USER_PAT_UNREADABLE',
              'present but unreadable',
            ),
          ),
      };

      await expect(
        tool.invoke(args, failClosedConfig, mockCfg),
      ).rejects.toThrow(InternalException);
    });

    it('returns a not-configured error (does NOT throw) when no token is available', async () => {
      const args: GhCreatePullRequestToolSchemaType = {
        owner: 'acme',
        repo: 'demo',
        title: 'Add feature',
        head: 'feat/add-feature',
        base: 'main',
      };

      // The benign "no credential available" case: resolveTokenForOwner yields
      // null, resolveToken throws a plain Error, and the tool falls through to
      // the structured not-configured response (NOT a fail-closed throw).
      const noTokenConfig: GhBaseToolConfig = {
        ...mockConfig,
        resolveTokenForOwner: vi.fn().mockResolvedValue(null),
      };

      const { output } = await tool.invoke(args, noTokenConfig, mockCfg);

      expect(output.success).toBe(false);
      if (output.success !== false) {
        throw new Error('Expected error output');
      }
      expect(output.error).toContain('No GitHub token available');
    });
  });
});
