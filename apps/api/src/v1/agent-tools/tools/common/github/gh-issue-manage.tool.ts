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

export enum GhIssueManageAction {
  List = 'list',
  Get = 'get',
  Create = 'create',
  Update = 'update',
  Close = 'close',
  Reopen = 'reopen',
}

export const GhIssueManageToolSchema = GhBaseToolSchema.extend({
  action: z
    .enum(GhIssueManageAction)
    .describe('The action to perform on a GitHub issue.'),
  issue_number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'The issue number. Required for get, update, close, and reopen actions.',
    ),
  title: z
    .string()
    .min(1)
    .optional()
    .describe('The title of the issue. Required for create.'),
  body: z
    .string()
    .nullable()
    .optional()
    .describe('The body/description of the issue in Markdown.'),
  labels: z
    .array(z.string().min(1))
    .nullable()
    .optional()
    .describe(
      'Labels to apply to the issue (e.g., ["bug", "priority:high"]). For list action, filters issues by these labels.',
    ),
  assignees: z
    .array(z.string().min(1))
    .nullable()
    .optional()
    .describe('GitHub usernames to assign to the issue (e.g., ["octocat"]).'),
  milestone: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe('Milestone number to associate with the issue.'),
  state: z
    .enum(['open', 'closed', 'all'])
    .optional()
    .describe(
      'Filter issues by state. Only used for the list action. Default: open.',
    ),
  assignee: z
    .string()
    .optional()
    .describe(
      'Filter issues by assignee username. Only used for the list action.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Maximum number of issues to return for the list action. Default: 30, max: 100.',
    ),
}).superRefine((val, ctx) => {
  const actionsRequiringIssueNumber: GhIssueManageAction[] = [
    GhIssueManageAction.Get,
    GhIssueManageAction.Update,
    GhIssueManageAction.Close,
    GhIssueManageAction.Reopen,
  ];

  if (
    actionsRequiringIssueNumber.includes(val.action) &&
    val.issue_number == null
  ) {
    ctx.addIssue({
      code: 'custom',
      message: `issue_number is required for action '${val.action}'`,
      path: ['issue_number'],
    });
  }

  if (val.action === GhIssueManageAction.Create && !val.title) {
    ctx.addIssue({
      code: 'custom',
      message: "title is required for action 'create'",
      path: ['title'],
    });
  }
});

export type GhIssueManageToolSchemaType = z.infer<
  typeof GhIssueManageToolSchema
>;

type GhIssueManageToolOutput =
  | { success: true; action: GhIssueManageAction; data: unknown }
  | { success: false; error: string };

@Injectable()
export class GhIssueManageTool extends GhBaseTool<
  GhIssueManageToolSchemaType,
  GhBaseToolConfig,
  GhIssueManageToolOutput
> {
  public name = 'gh_issue';
  public description =
    'Manage GitHub issues: list, get details, create, update, close, and reopen. Supports filtering by state, labels, and assignee. Use this tool for issue tracking and project management workflows.';

  public get schema() {
    return GhIssueManageToolSchema;
  }

  protected override generateTitle(
    args: GhIssueManageToolSchemaType,
    _config: GhBaseToolConfig,
  ): string {
    const repo = `${args.owner}/${args.repo}`;
    switch (args.action) {
      case GhIssueManageAction.List:
        return `Listing issues in ${repo}`;
      case GhIssueManageAction.Get:
        return `Getting issue #${args.issue_number} in ${repo}`;
      case GhIssueManageAction.Create:
        return `Creating issue in ${repo}: ${args.title}`;
      case GhIssueManageAction.Update:
        return `Updating issue #${args.issue_number} in ${repo}`;
      case GhIssueManageAction.Close:
        return `Closing issue #${args.issue_number} in ${repo}`;
      case GhIssueManageAction.Reopen:
        return `Reopening issue #${args.issue_number} in ${repo}`;
    }
  }

  public getDetailedInstructions(
    _config: GhBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Manage GitHub issues in a repository. Supports listing, reading, creating, updating, closing, and reopening issues.

      ### Actions

      **list** — List issues in a repository with optional filters.
      - \`state\`: Filter by "open", "closed", or "all". Default: "open".
      - \`labels\`: Filter by label names (issues must have all listed labels).
      - \`assignee\`: Filter by assignee username.
      - \`limit\`: Max results (1-100). Default: 30.

      **get** — Get a single issue by number. Returns full details including body and metadata.

      **create** — Create a new issue. Requires \`title\`. Optionally set \`body\`, \`labels\`, \`assignees\`, and \`milestone\`.

      **update** — Update an existing issue. Pass only the fields you want to change (\`title\`, \`body\`, \`labels\`, \`assignees\`, \`milestone\`).

      **close** — Close an issue.

      **reopen** — Reopen a closed issue.

      ### Examples

      **List open bugs:**
      \`\`\`json
      { "owner": "acme", "repo": "demo", "action": "list", "labels": ["bug"], "state": "open" }
      \`\`\`

      **Create an issue:**
      \`\`\`json
      { "owner": "acme", "repo": "demo", "action": "create", "title": "Fix login page", "body": "The login page crashes on mobile.", "labels": ["bug"] }
      \`\`\`

      **Close an issue:**
      \`\`\`json
      { "owner": "acme", "repo": "demo", "action": "close", "issue_number": 42 }
      \`\`\`

      ### Troubleshooting
      - 404: The issue or repository does not exist, or the token lacks access.
      - 401/403: Check PAT scopes and repository access.
      - 422: Validation error — check that required fields are provided and valid.
    `;
  }

  public async invoke(
    args: GhIssueManageToolSchemaType,
    config: GhBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<GhIssueManageToolOutput>> {
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
    client: ReturnType<GhIssueManageTool['createClient']>,
    args: GhIssueManageToolSchemaType,
  ): Promise<unknown> {
    const { owner, repo } = args;

    switch (args.action) {
      case GhIssueManageAction.List: {
        const res = await client.issues.listForRepo({
          owner,
          repo,
          state: args.state ?? 'open',
          labels: args.labels?.join(','),
          assignee: args.assignee,
          per_page: args.limit ?? 30,
        });
        // Filter out pull requests — GitHub's issues API includes them
        return res.data
          .filter((issue: { pull_request?: unknown }) => !issue.pull_request)
          .map(
            (issue: {
              number: number;
              title: string;
              state: string;
              url: string;
              html_url: string;
              created_at: string;
              updated_at: string;
              labels: ({ name?: string } | string)[];
              assignees?: ({ login?: string } | null)[] | null;
            }) => ({
              number: issue.number,
              title: issue.title,
              state: issue.state,
              url: issue.html_url,
              created_at: issue.created_at,
              updated_at: issue.updated_at,
              labels: issue.labels
                .map((l) => (typeof l === 'string' ? l : l.name))
                .filter(Boolean),
              assignees: (issue.assignees ?? [])
                .map((a) => a?.login)
                .filter(Boolean),
            }),
          );
      }

      case GhIssueManageAction.Get: {
        const res = await client.issues.get({
          owner,
          repo,
          issue_number: args.issue_number!,
        });
        const issue = res.data;
        return {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          url: issue.html_url,
          body: issue.body,
          labels: (issue.labels ?? [])
            .map((l: { name?: string } | string) =>
              typeof l === 'string' ? l : l.name,
            )
            .filter(Boolean),
          assignees: (issue.assignees ?? [])
            .map((a: { login?: string } | null) => a?.login)
            .filter(Boolean),
          milestone: issue.milestone
            ? { number: issue.milestone.number, title: issue.milestone.title }
            : null,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
        };
      }

      case GhIssueManageAction.Create: {
        const res = await client.issues.create({
          owner,
          repo,
          title: args.title!,
          body: args.body ?? undefined,
          labels: args.labels ?? undefined,
          assignees: args.assignees ?? undefined,
          milestone: args.milestone ?? undefined,
        });
        const issue = res.data;
        return {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          url: issue.html_url,
          created_at: issue.created_at,
        };
      }

      case GhIssueManageAction.Update: {
        const res = await client.issues.update({
          owner,
          repo,
          issue_number: args.issue_number!,
          title: args.title ?? undefined,
          body: args.body ?? undefined,
          labels: args.labels ?? undefined,
          assignees: args.assignees ?? undefined,
          milestone: args.milestone ?? undefined,
        });
        const issue = res.data;
        return {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          url: issue.html_url,
          updated_at: issue.updated_at,
        };
      }

      case GhIssueManageAction.Close: {
        const res = await client.issues.update({
          owner,
          repo,
          issue_number: args.issue_number!,
          state: 'closed',
        });
        return {
          number: res.data.number,
          state: res.data.state,
          url: res.data.html_url,
        };
      }

      case GhIssueManageAction.Reopen: {
        const res = await client.issues.update({
          owner,
          repo,
          issue_number: args.issue_number!,
          state: 'open',
        });
        return {
          number: res.data.number,
          state: res.data.state,
          url: res.data.html_url,
        };
      }
    }
  }
}
