import { DynamicStructuredTool } from '@langchain/core/tools';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GhBranchTool } from './gh-branch.tool';
import { GhCloneTool } from './gh-clone.tool';
import { GhCommitTool } from './gh-commit.tool';
import { GhCreatePullRequestTool } from './gh-create-pull-request.tool';
import { GhIssueCommentTool } from './gh-issue-comment.tool';
import { GhIssueManageTool } from './gh-issue-manage.tool';
import { GhPrCommentTool } from './gh-pr-comment.tool';
import { GhPrReadTool } from './gh-pr-read.tool';
import { GhPushTool } from './gh-push.tool';
import { GhToolGroup, GhToolGroupConfig, GhToolType } from './gh-tool-group';

describe('GhToolGroup', () => {
  let toolGroup: GhToolGroup;
  let mockGhCloneTool: GhCloneTool;
  let mockGhCommitTool: GhCommitTool;
  let mockGhBranchTool: GhBranchTool;
  let mockGhPushTool: GhPushTool;
  let mockGhCreatePullRequestTool: GhCreatePullRequestTool;
  let mockGhIssueManageTool: GhIssueManageTool;
  let mockGhIssueCommentTool: GhIssueCommentTool;
  let mockGhPrReadTool: GhPrReadTool;
  let mockGhPrCommentTool: GhPrCommentTool;

  beforeEach(async () => {
    mockGhCloneTool = {
      build: vi.fn(),
    } as unknown as GhCloneTool;

    mockGhCommitTool = {
      build: vi.fn(),
    } as unknown as GhCommitTool;

    mockGhBranchTool = {
      build: vi.fn(),
    } as unknown as GhBranchTool;

    mockGhPushTool = {
      build: vi.fn(),
    } as unknown as GhPushTool;

    mockGhCreatePullRequestTool = {
      build: vi.fn(),
    } as unknown as GhCreatePullRequestTool;

    mockGhIssueManageTool = {
      build: vi.fn(),
    } as unknown as GhIssueManageTool;

    mockGhIssueCommentTool = {
      build: vi.fn(),
    } as unknown as GhIssueCommentTool;

    mockGhPrReadTool = {
      build: vi.fn(),
    } as unknown as GhPrReadTool;

    mockGhPrCommentTool = {
      build: vi.fn(),
    } as unknown as GhPrCommentTool;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GhToolGroup,
        {
          provide: GhCloneTool,
          useValue: mockGhCloneTool,
        },
        {
          provide: GhCommitTool,
          useValue: mockGhCommitTool,
        },
        {
          provide: GhBranchTool,
          useValue: mockGhBranchTool,
        },
        {
          provide: GhPushTool,
          useValue: mockGhPushTool,
        },
        {
          provide: GhCreatePullRequestTool,
          useValue: mockGhCreatePullRequestTool,
        },
        {
          provide: GhIssueManageTool,
          useValue: mockGhIssueManageTool,
        },
        {
          provide: GhIssueCommentTool,
          useValue: mockGhIssueCommentTool,
        },
        {
          provide: GhPrReadTool,
          useValue: mockGhPrReadTool,
        },
        {
          provide: GhPrCommentTool,
          useValue: mockGhPrCommentTool,
        },
      ],
    }).compile();

    toolGroup = module.get<GhToolGroup>(GhToolGroup);
  });

  describe('buildTools', () => {
    it('should build and return array of tools', () => {
      const mockCloneTool = { name: 'gh_clone' } as DynamicStructuredTool;
      const mockCommitTool = { name: 'gh_commit' } as DynamicStructuredTool;
      const mockBranchTool = { name: 'gh_branch' } as DynamicStructuredTool;
      mockGhCloneTool.build = vi.fn().mockReturnValue(mockCloneTool);
      mockGhCommitTool.build = vi.fn().mockReturnValue(mockCommitTool);
      mockGhBranchTool.build = vi.fn().mockReturnValue(mockBranchTool);

      const config: GhToolGroupConfig = {
        runtimeProvider: { provide: vi.fn() } as any,
        resolveTokenForOwner: vi.fn().mockResolvedValue('ghp_test_token'),
        tools: [GhToolType.Clone, GhToolType.Commit, GhToolType.Branch],
      };

      const result = toolGroup.buildTools(config);

      expect(result.tools).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBe(3);
      expect(result.tools[0]).toBe(mockCloneTool);
      expect(result.tools[1]).toBe(mockCommitTool);
      expect(result.tools[2]).toBe(mockBranchTool);
      expect(mockGhCloneTool.build).toHaveBeenCalledWith(config, undefined);
      expect(mockGhCommitTool.build).toHaveBeenCalledWith(config, undefined);
      expect(mockGhBranchTool.build).toHaveBeenCalledWith(config, undefined);
    });

    it('should build PrRead tool when specified', () => {
      const mockTool = { name: 'gh_pr_read' } as DynamicStructuredTool;
      mockGhPrReadTool.build = vi.fn().mockReturnValue(mockTool);

      const config: GhToolGroupConfig = {
        runtimeProvider: { provide: vi.fn() } as any,
        resolveTokenForOwner: vi.fn().mockResolvedValue('ghp_test_token'),
        tools: [GhToolType.PrRead],
      };

      const result = toolGroup.buildTools(config);

      expect(result.tools.length).toBe(1);
      expect(result.tools).toEqual([mockTool]);
      expect(mockGhPrReadTool.build).toHaveBeenCalledWith(config, undefined);
    });

    it('should build PrComment tool when specified', () => {
      const mockTool = { name: 'gh_pr_comment' } as DynamicStructuredTool;
      mockGhPrCommentTool.build = vi.fn().mockReturnValue(mockTool);

      const config: GhToolGroupConfig = {
        runtimeProvider: { provide: vi.fn() } as any,
        resolveTokenForOwner: vi.fn().mockResolvedValue('ghp_test_token'),
        tools: [GhToolType.PrComment],
      };

      const result = toolGroup.buildTools(config);

      expect(result.tools.length).toBe(1);
      expect(result.tools).toEqual([mockTool]);
      expect(mockGhPrCommentTool.build).toHaveBeenCalledWith(config, undefined);
    });

    it('should build Issue tool when specified', () => {
      const mockTool = { name: 'gh_issue' } as DynamicStructuredTool;
      mockGhIssueManageTool.build = vi.fn().mockReturnValue(mockTool);

      const config: GhToolGroupConfig = {
        runtimeProvider: { provide: vi.fn() } as any,
        resolveTokenForOwner: vi.fn().mockResolvedValue('ghp_test_token'),
        tools: [GhToolType.Issue],
      };

      const result = toolGroup.buildTools(config);

      expect(result.tools.length).toBe(1);
      expect(result.tools).toEqual([mockTool]);
      expect(mockGhIssueManageTool.build).toHaveBeenCalledWith(
        config,
        undefined,
      );
    });

    it('should build IssueComment tool when specified', () => {
      const mockTool = { name: 'gh_issue_comment' } as DynamicStructuredTool;
      mockGhIssueCommentTool.build = vi.fn().mockReturnValue(mockTool);

      const config: GhToolGroupConfig = {
        runtimeProvider: { provide: vi.fn() } as any,
        resolveTokenForOwner: vi.fn().mockResolvedValue('ghp_test_token'),
        tools: [GhToolType.IssueComment],
      };

      const result = toolGroup.buildTools(config);

      expect(result.tools.length).toBe(1);
      expect(result.tools).toEqual([mockTool]);
      expect(mockGhIssueCommentTool.build).toHaveBeenCalledWith(
        config,
        undefined,
      );
    });

    it('should filter to read-only tools when readOnly is true', () => {
      const mockCloneTool = { name: 'gh_clone' } as DynamicStructuredTool;
      const mockPrReadTool = { name: 'gh_pr_read' } as DynamicStructuredTool;
      const mockPrCommentTool = {
        name: 'gh_pr_comment',
      } as DynamicStructuredTool;
      const mockIssueTool = { name: 'gh_issue' } as DynamicStructuredTool;
      const mockIssueCommentTool = {
        name: 'gh_issue_comment',
      } as DynamicStructuredTool;

      mockGhCloneTool.build = vi.fn().mockReturnValue(mockCloneTool);
      mockGhPrReadTool.build = vi.fn().mockReturnValue(mockPrReadTool);
      mockGhPrCommentTool.build = vi.fn().mockReturnValue(mockPrCommentTool);
      mockGhIssueManageTool.build = vi.fn().mockReturnValue(mockIssueTool);
      mockGhIssueCommentTool.build = vi
        .fn()
        .mockReturnValue(mockIssueCommentTool);

      const config: GhToolGroupConfig = {
        runtimeProvider: { provide: vi.fn() } as any,
        resolveTokenForOwner: vi.fn().mockResolvedValue('ghp_test_token'),
        readOnly: true,
      };

      const result = toolGroup.buildTools(config);

      expect(result.tools).toEqual([
        mockCloneTool,
        mockPrReadTool,
        mockPrCommentTool,
        mockIssueTool,
        mockIssueCommentTool,
      ]);
      expect(mockGhCommitTool.build).not.toHaveBeenCalled();
      expect(mockGhBranchTool.build).not.toHaveBeenCalled();
      expect(mockGhPushTool.build).not.toHaveBeenCalled();
      expect(mockGhCreatePullRequestTool.build).not.toHaveBeenCalled();
    });

    it('should return read-only instructions when readOnly is true', () => {
      const config: GhToolGroupConfig = {
        runtimeProvider: { provide: vi.fn() } as any,
        resolveTokenForOwner: vi.fn().mockResolvedValue('ghp_test_token'),
        readOnly: true,
      };

      const result = toolGroup.buildTools(config);

      expect(result.instructions).toContain('Read-Only Mode');
      expect(result.instructions).not.toContain('Required Tool Order');
    });

    it('should build all default tools when tools property is omitted', () => {
      const mockCloneTool = { name: 'gh_clone' } as DynamicStructuredTool;
      const mockCommitTool = { name: 'gh_commit' } as DynamicStructuredTool;
      const mockBranchTool = { name: 'gh_branch' } as DynamicStructuredTool;
      const mockPushTool = { name: 'gh_push' } as DynamicStructuredTool;
      const mockCreatePrTool = {
        name: 'gh_pr_create',
      } as DynamicStructuredTool;
      const mockPrReadTool = { name: 'gh_pr_read' } as DynamicStructuredTool;
      const mockPrCommentTool = {
        name: 'gh_pr_comment',
      } as DynamicStructuredTool;
      const mockIssueTool = { name: 'gh_issue' } as DynamicStructuredTool;
      const mockIssueCommentTool = {
        name: 'gh_issue_comment',
      } as DynamicStructuredTool;

      mockGhCloneTool.build = vi.fn().mockReturnValue(mockCloneTool);
      mockGhCommitTool.build = vi.fn().mockReturnValue(mockCommitTool);
      mockGhBranchTool.build = vi.fn().mockReturnValue(mockBranchTool);
      mockGhPushTool.build = vi.fn().mockReturnValue(mockPushTool);
      mockGhCreatePullRequestTool.build = vi
        .fn()
        .mockReturnValue(mockCreatePrTool);
      mockGhPrReadTool.build = vi.fn().mockReturnValue(mockPrReadTool);
      mockGhPrCommentTool.build = vi.fn().mockReturnValue(mockPrCommentTool);
      mockGhIssueManageTool.build = vi.fn().mockReturnValue(mockIssueTool);
      mockGhIssueCommentTool.build = vi
        .fn()
        .mockReturnValue(mockIssueCommentTool);

      const config: GhToolGroupConfig = {
        runtimeProvider: { provide: vi.fn() } as any,
        resolveTokenForOwner: vi.fn().mockResolvedValue('ghp_test_token'),
      };

      const result = toolGroup.buildTools(config);

      expect(result.tools.length).toBe(9);
      expect(result.tools).toEqual([
        mockCloneTool,
        mockCommitTool,
        mockBranchTool,
        mockPushTool,
        mockCreatePrTool,
        mockPrReadTool,
        mockPrCommentTool,
        mockIssueTool,
        mockIssueCommentTool,
      ]);
      expect(mockGhCloneTool.build).toHaveBeenCalled();
      expect(mockGhCommitTool.build).toHaveBeenCalled();
      expect(mockGhBranchTool.build).toHaveBeenCalled();
      expect(mockGhPushTool.build).toHaveBeenCalled();
      expect(mockGhCreatePullRequestTool.build).toHaveBeenCalled();
      expect(mockGhPrReadTool.build).toHaveBeenCalled();
      expect(mockGhPrCommentTool.build).toHaveBeenCalled();
      expect(mockGhIssueManageTool.build).toHaveBeenCalled();
      expect(mockGhIssueCommentTool.build).toHaveBeenCalled();
    });
  });
});
