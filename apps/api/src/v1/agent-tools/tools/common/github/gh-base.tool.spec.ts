import { ToolRunnableConfig } from '@langchain/core/tools';
import { InternalException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { ToolInvokeResult } from '../../base-tool';
import { GhBaseTool, GhBaseToolConfig } from './gh-base.tool';

type ResolveTokenForOwnerFn = NonNullable<
  GhBaseToolConfig['resolveTokenForOwner']
>;

// Minimal concrete subclass to test the protected resolveToken method
class TestGhTool extends GhBaseTool<unknown> {
  public name = 'test_gh_tool';
  public description = 'test';
  public get schema() {
    return z.object({});
  }
  public async invoke(): Promise<ToolInvokeResult<unknown>> {
    return { output: {} };
  }

  public async testResolveToken(
    config: GhBaseToolConfig,
    owner?: string,
    cfg?: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<string> {
    return this.resolveToken(config, owner, cfg);
  }

  public async testExecGhCommand(
    params: { cmd: string[] | string; owner?: string },
    config: GhBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ) {
    return this.execGhCommand(params, config, cfg);
  }
}

describe('GhBaseTool.resolveToken', () => {
  let tool: TestGhTool;
  let mockResolveTokenForOwner: ReturnType<
    typeof vi.fn<ResolveTokenForOwnerFn>
  >;

  beforeEach(() => {
    tool = new TestGhTool();
    mockResolveTokenForOwner = vi.fn<ResolveTokenForOwnerFn>();
  });

  it('resolves token using thread_created_by when present', async () => {
    mockResolveTokenForOwner.mockResolvedValue('ghs_thread_token');
    const config: GhBaseToolConfig = {
      runtimeProvider: {} as never,
      resolveTokenForOwner: mockResolveTokenForOwner,
    };
    const cfg: ToolRunnableConfig<BaseAgentConfigurable> = {
      configurable: {
        thread_created_by: 'thread-user',
        graph_created_by: 'graph-owner',
      },
    };

    const token = await tool.testResolveToken(config, 'my-org', cfg);

    expect(token).toBe('ghs_thread_token');
    expect(mockResolveTokenForOwner).toHaveBeenCalledWith(
      'my-org',
      'thread-user',
    );
  });

  it('does NOT fall back to graph_created_by when thread_created_by is absent', async () => {
    // Use a discriminating mock: returns a real token for graph-owner but null
    // for undefined. If the implementation incorrectly used graph_created_by,
    // it would get a token back and NOT throw — catching the regression.
    mockResolveTokenForOwner.mockImplementation(
      async (_owner: string, userId?: string) => {
        if (userId === 'graph-owner') {
          return 'ghs_graph_owner_token';
        }
        return null;
      },
    );
    const config: GhBaseToolConfig = {
      runtimeProvider: {} as never,
      resolveTokenForOwner: mockResolveTokenForOwner,
    };
    const cfg: ToolRunnableConfig<BaseAgentConfigurable> = {
      configurable: {
        graph_created_by: 'graph-owner',
      },
    };

    await expect(tool.testResolveToken(config, 'my-org', cfg)).rejects.toThrow(
      'No GitHub token available',
    );
    expect(mockResolveTokenForOwner).toHaveBeenCalledWith('my-org', undefined);
  });

  it('throws when no userId is present and no token resolver is configured', async () => {
    const config: GhBaseToolConfig = {
      runtimeProvider: {} as never,
    };

    await expect(tool.testResolveToken(config, 'my-org', {})).rejects.toThrow(
      'No GitHub token available',
    );
  });

  // The implicit-token fallback inside execGhCommand (used by gh_push / gh_commit
  // which do not pass an explicit resolvedToken) must fail CLOSED on a PAT
  // misconfiguration: an InternalException from token resolution surfaces (the
  // command never runs anonymously). A benign "no token" plain Error is still
  // swallowed so plain git/find/cat work without GH_TOKEN.
  it('execGhCommand fails CLOSED: surfaces an InternalException from token resolution instead of running anonymously', async () => {
    const config: GhBaseToolConfig = {
      runtimeProvider: {
        provide: vi.fn().mockResolvedValue({} as never),
      } as never,
      resolveTokenForOwner: vi
        .fn<ResolveTokenForOwnerFn>()
        .mockRejectedValue(
          new InternalException(
            'GITHUB_USER_PAT_UNREADABLE',
            'A GitHub PAT is configured but its value could not be read',
          ),
        ),
    };
    const cfg: ToolRunnableConfig<BaseAgentConfigurable> = {
      configurable: { thread_created_by: 'u1' },
    };

    const res = await tool.testExecGhCommand(
      { cmd: ['git', 'push'], owner: 'my-org' },
      config,
      cfg,
    );

    // The PAT-misconfig error is surfaced (caught by execGhCommand's outer
    // handler into a failed result) — NOT swallowed into an anonymous run.
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('could not be read');
  });
});
