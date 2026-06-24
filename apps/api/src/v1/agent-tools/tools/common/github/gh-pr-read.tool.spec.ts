import { ToolRunnableConfig } from '@langchain/core/tools';
import { Test, TestingModule } from '@nestjs/testing';
import { InternalException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { BaseRuntime } from '../../../../runtime/services/base-runtime';
import { GhBaseToolConfig } from './gh-base.tool';
import {
  GhPrReadAction,
  GhPrReadTool,
  GhPrReadToolSchemaType,
} from './gh-pr-read.tool';

describe('GhPrReadTool', () => {
  let tool: GhPrReadTool;
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
      providers: [GhPrReadTool],
    }).compile();

    tool = module.get<GhPrReadTool>(GhPrReadTool);
  });

  describe('properties', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe('gh_pr_read');
    });
  });

  describe('schema', () => {
    it('accepts a valid list action', () => {
      expect(() =>
        tool.validate({
          owner: 'acme',
          repo: 'demo',
          action: GhPrReadAction.List,
        }),
      ).not.toThrow();
    });

    it('rejects a get action without pull_number', () => {
      expect(() =>
        tool.validate({
          owner: 'acme',
          repo: 'demo',
          action: GhPrReadAction.Get,
        }),
      ).toThrow(/pull_number/);
    });
  });

  describe('invoke — fail-closed token resolution', () => {
    const args: GhPrReadToolSchemaType = {
      owner: 'acme',
      repo: 'demo',
      action: GhPrReadAction.List,
    };

    it('re-throws an InternalException from the token resolver (fail-closed — never degrades to anonymous)', async () => {
      // A configured-but-unreadable per-user PAT surfaces as an
      // InternalException from the resolver. The tool MUST re-throw it rather
      // than return the not-configured response (which would let the agent
      // silently proceed unauthenticated). This test goes red if the
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
