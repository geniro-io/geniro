import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import { InternalException } from '@packages/common';
import dedent from 'dedent';
import { z } from 'zod';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import {
  ExtendedLangGraphRunnableConfig,
  ToolInvokeResult,
} from '../../base-tool';
import { GhBaseTool, GhBaseToolConfig, GhBaseToolSchema } from './gh-base.tool';

export enum GhPrReadAction {
  List = 'list',
  Get = 'get',
}

export const GhPrReadToolSchema = GhBaseToolSchema.extend({
  action: z
    .nativeEnum(GhPrReadAction)
    .describe('The action to perform on a GitHub pull request.'),
  pull_number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The pull request number. Required for the get action.'),
  state: z
    .enum(['open', 'closed', 'all'])
    .optional()
    .describe(
      'Filter pull requests by state. Only used for the list action. Default: open.',
    ),
  head: z
    .string()
    .optional()
    .describe(
      'Filter pull requests by head branch. Format: "owner:branch" or "branch". Only used for list.',
    ),
  base: z
    .string()
    .optional()
    .describe(
      'Filter pull requests by base branch (e.g., "main"). Only used for list.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Maximum number of pull requests to return for the list action. Default: 30, max: 100.',
    ),
}).superRefine((val, ctx) => {
  if (val.action === GhPrReadAction.Get && val.pull_number == null) {
    ctx.addIssue({
      code: 'custom',
      message: `pull_number is required for action '${val.action}'`,
      path: ['pull_number'],
    });
  }
});

export type GhPrReadToolSchemaType = z.infer<typeof GhPrReadToolSchema>;

type GhPrReadToolOutput =
  | { success: true; action: GhPrReadAction; data: unknown }
  | { success: false; error: string };

@Injectable()
export class GhPrReadTool extends GhBaseTool<
  GhPrReadToolSchemaType,
  GhBaseToolConfig,
  GhPrReadToolOutput
> {
  public name = 'gh_pr_read';
  public description =
    'Read GitHub pull requests: list PRs with filters or get detailed information about a specific PR including diff stats and mergeability. Use this for code review workflows and PR management.';

  public get schema() {
    return GhPrReadToolSchema;
  }

  protected override generateTitle(
    args: GhPrReadToolSchemaType,
    _config: GhBaseToolConfig,
  ): string {
    const repo = `${args.owner}/${args.repo}`;
    switch (args.action) {
      case GhPrReadAction.List:
        return `Listing pull requests in ${repo}`;
      case GhPrReadAction.Get:
        return `Getting PR #${args.pull_number} in ${repo}`;
    }
  }

  public getDetailedInstructions(
    _config: GhBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Read GitHub pull requests. Supports listing PRs with filters and getting detailed PR information including diff stats.

      ### Actions

      **list** — List pull requests with optional filters. Returns lightweight data (no diff stats).
      - \`state\`: Filter by "open", "closed", or "all". Default: "open".
      - \`head\`: Filter by head branch (format: "owner:branch" or "branch").
      - \`base\`: Filter by base branch (e.g., "main").
      - \`limit\`: Max results (1-100). Default: 30.

      **get** — Get a single pull request by number. Returns rich detail including diff stats (additions, deletions, changed_files), mergeability, and full body.

      ### Examples

      **List open PRs targeting main:**
      \`\`\`json
      { "owner": "acme", "repo": "demo", "action": "list", "base": "main", "state": "open" }
      \`\`\`

      **Get PR details with diff stats:**
      \`\`\`json
      { "owner": "acme", "repo": "demo", "action": "get", "pull_number": 42 }
      \`\`\`

      ### Troubleshooting
      - 404: The pull request or repository does not exist, or the token lacks access.
      - 401/403: Check PAT scopes and repository access.
    `;
  }

  public async invoke(
    args: GhPrReadToolSchemaType,
    config: GhBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<GhPrReadToolOutput>> {
    const validated = this.validate(args);

    let token: string;
    try {
      token = await this.resolveToken(config, validated.owner, cfg);
    } catch (error) {
      // Fail-closed: a configured-but-unreadable per-user PAT surfaces as an
      // InternalException from the token resolver — re-throw it instead of
      // degrading to an anonymous/App path. The benign "no credential
      // available" case throws a plain Error and falls through to the
      // not-configured response below.
      if (error instanceof InternalException) {
        throw error;
      }
      return {
        output: {
          success: false,
          error:
            'No GitHub token available. Configure a PAT or install the GitHub App.',
        },
      };
    }

    const client = this.createClient(token);

    try {
      const data = await this.executeAction(client, validated);
      return {
        output: { success: true, action: validated.action, data },
        messageMetadata: {
          __title: this.generateTitle(validated, config),
        },
      };
    } catch (error) {
      return {
        output: { success: false, error: this.formatGitHubError(error) },
      };
    }
  }

  private async executeAction(
    client: ReturnType<GhPrReadTool['createClient']>,
    args: GhPrReadToolSchemaType,
  ): Promise<unknown> {
    const { owner, repo } = args;

    switch (args.action) {
      case GhPrReadAction.List: {
        const res = await client.pulls.list({
          owner,
          repo,
          state: args.state ?? 'open',
          head: args.head,
          base: args.base,
          per_page: args.limit ?? 30,
        });
        return res.data.map(
          (pr: {
            number: number;
            title: string;
            state: string;
            draft?: boolean;
            html_url: string;
            head: { ref: string; label?: string | null };
            base: { ref: string; label?: string | null };
            created_at: string;
            updated_at: string;
          }) => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            draft: Boolean(pr.draft),
            url: pr.html_url,
            head: pr.head.ref,
            base: pr.base.ref,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
          }),
        );
      }

      case GhPrReadAction.Get: {
        const res = await client.pulls.get({
          owner,
          repo,
          pull_number: args.pull_number!,
        });
        const pr = res.data;
        return {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: Boolean(pr.draft),
          url: pr.html_url,
          body: pr.body,
          mergeable: pr.mergeable,
          additions: pr.additions,
          deletions: pr.deletions,
          changed_files: pr.changed_files,
          base: pr.base.ref,
          head: pr.head.ref,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
        };
      }
    }
  }
}
