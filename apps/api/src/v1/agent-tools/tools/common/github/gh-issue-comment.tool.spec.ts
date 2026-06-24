import { ToolRunnableConfig } from '@langchain/core/tools';
import { Test, TestingModule } from '@nestjs/testing';
import { InternalException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { BaseRuntime } from '../../../../runtime/services/base-runtime';
import { GhBaseToolConfig } from './gh-base.tool';
import {
  GhIssueCommentAction,
  GhIssueCommentTool,
  GhIssueCommentToolSchemaType,
} from './gh-issue-comment.tool';

describe('GhIssueCommentTool', () => {
  let tool: GhIssueCommentTool;
  let mockRuntime: BaseRuntime;
  let mockConfig: GhBaseToolConfig;

  const mockCfg: ToolRunnableConfig<BaseAgentConfigurable> = {
    configurable: { thread_id: 'test-thread-123' },
  };

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
      providers: [GhIssueCommentTool],
    }).compile();

    tool = module.get<GhIssueCommentTool>(GhIssueCommentTool);
  });

  describe('properties', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe('gh_issue_comment');
    });
  });

  describe('schema', () => {
    it('accepts a valid get_comments action', () => {
      expect(() =>
        tool.validate({
          owner: 'acme',
          repo: 'demo',
          action: GhIssueCommentAction.GetComments,
          issue_number: 42,
        }),
      ).not.toThrow();
    });

    it('rejects an add_comment action without comment_body', () => {
      expect(() =>
        tool.validate({
          owner: 'acme',
          repo: 'demo',
          action: GhIssueCommentAction.AddComment,
          issue_number: 42,
        }),
      ).toThrow(/comment_body/);
    });
  });

  describe('invoke — fail-closed token resolution', () => {
    const args: GhIssueCommentToolSchemaType = {
      owner: 'acme',
      repo: 'demo',
      action: GhIssueCommentAction.GetComments,
      issue_number: 42,
    };

    it('re-throws an InternalException from the token resolver (fail-closed — never degrades to anonymous)', async () => {
      // A configured-but-unreadable per-user PAT surfaces as an
      // InternalException from the resolver. The tool MUST re-throw it rather
      // than return the not-configured response. This test goes red if the
      // `instanceof InternalException` re-throw is removed.
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
