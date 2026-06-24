import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import { RequestError } from '@octokit/request-error';
import { Octokit } from '@octokit/rest';
import { InternalException } from '@packages/common';
import { isPlainObject } from 'lodash';
import { z } from 'zod';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { RuntimeThreadProvider } from '../../../../runtime/services/runtime-thread-provider';
import { execRuntimeWithContext } from '../../../agent-tools.utils';
import { BaseTool } from '../../base-tool';

export const GhBaseToolSchema = z.object({
  owner: z
    .string()
    .min(1)
    .describe('GitHub organization or user that owns the repository.'),
  repo: z.string().min(1).describe('Repository name (without .git).'),
});
export type GhBaseToolSchemaType = z.infer<typeof GhBaseToolSchema>;

export type GhBaseToolConfig = {
  runtimeProvider: RuntimeThreadProvider;
  resolveTokenForOwner?: (
    owner: string,
    userId?: string,
  ) => Promise<string | null>;
};

@Injectable()
export abstract class GhBaseTool<
  TSchema,
  TConfig extends GhBaseToolConfig = GhBaseToolConfig,
  TResult = unknown,
> extends BaseTool<TSchema, TConfig, TResult> {
  protected createClient(token: string): Octokit {
    return new Octokit({ auth: token });
  }

  protected async resolveToken(
    config: GhBaseToolConfig,
    owner?: string,
    cfg?: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<string> {
    if (owner && config.resolveTokenForOwner) {
      const userId = cfg?.configurable?.thread_created_by;
      const token = await config.resolveTokenForOwner(owner, userId);
      if (token) {
        return token;
      }
    }
    throw new Error(
      'No GitHub token available. Install the GitHub App to authenticate.',
    );
  }

  protected async execGhCommand(
    params: {
      cmd: string[] | string;
      owner?: string;
      resolvedToken?: string | null;
    },
    config: GhBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ) {
    try {
      const runtime = await config.runtimeProvider.provide(cfg);

      // Resolve a token for GH_TOKEN injection.
      // When `resolvedToken` is provided (even null meaning "no token"), use it
      // directly to avoid a redundant resolveToken call. When it is undefined
      // (not provided), fall back to the internal resolveToken call for
      // backwards-compatible callers (e.g. detectDefaultBranch, findAgentInstructions).
      const env: Record<string, string> = {
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '/bin/false',
        SSH_ASKPASS: '/bin/false',
        GH_PROMPT_DISABLED: '1',
        GCM_INTERACTIVE: 'never',
      };
      if (params.resolvedToken !== undefined) {
        if (params.resolvedToken !== null) {
          env.GH_TOKEN = params.resolvedToken;
        }
        // null means "no token" — GH_TOKEN is intentionally omitted.
      } else {
        try {
          const token = await this.resolveToken(config, params.owner, cfg);
          env.GH_TOKEN = token;
        } catch (error) {
          // A configured-but-broken credential (the token resolver throwing an
          // InternalException — e.g. a per-user PAT present but unreadable) MUST
          // fail CLOSED: surface it instead of silently running git anonymously
          // (which would push/commit/PR as an unauthenticated user and fail
          // opaquely). The benign "no GitHub App token" case throws a plain
          // Error from resolveToken and still falls through so plain
          // git/find/cat commands work without GH_TOKEN.
          if (error instanceof InternalException) {
            throw error;
          }
        }
      }

      const res = await execRuntimeWithContext(
        runtime,
        {
          cmd: params.cmd,
          env,
        },
        cfg,
      );

      return {
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        execPath: res.execPath,
      };
    } catch (error) {
      // Handle runtime errors by returning them in the expected RuntimeExecResult format
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return {
        exitCode: 1,
        stdout: '',
        stderr: errorMessage,
        execPath: '',
      };
    }
  }

  protected formatGitHubError(error: unknown): string {
    if (error instanceof RequestError) {
      const status: number = error.status;
      const message: string = error.message;

      const responseData: unknown = error.response?.data;
      const responseRecord: Record<string, unknown> | undefined = isPlainObject(
        responseData,
      )
        ? (responseData as Record<string, unknown>)
        : undefined;
      const responseMessage: unknown = responseRecord?.['message'];
      const responseErrors: unknown = responseRecord?.['errors'];

      const parts: string[] = [`GitHubError(${status}):`, message];

      if (typeof responseMessage === 'string' && responseMessage.length) {
        parts.push(`- ${responseMessage}`);
      }

      if (Array.isArray(responseErrors) && responseErrors.length) {
        parts.push(
          `- errors: ${JSON.stringify(responseErrors).slice(0, 2000)}`,
        );
      }

      if (status === 401 || status === 403) {
        parts.push('- Not authorized. Check PAT scopes and repo access.');

        const remaining = error.response?.headers?.['x-ratelimit-remaining'];
        const reset = error.response?.headers?.['x-ratelimit-reset'];

        if (remaining === '0' && typeof reset === 'string') {
          parts.push(`- Rate limit exceeded. Reset: ${reset}`);
        }
      }

      return parts.join(' ');
    }

    if (error instanceof Error) {
      return `GitHubError: ${error.message}`;
    }

    return `GitHubError: ${String(error)}`;
  }
}
