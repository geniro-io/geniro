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

export enum GhIssueCommentAction {
  GetComments = 'get_comments',
  AddComment = 'add_comment',
}

export const GhIssueCommentToolSchema = GhBaseToolSchema.extend({
  action: z
    .nativeEnum(GhIssueCommentAction)
    .describe('The action to perform on issue comments.'),
  issue_number: z.number().int().positive().describe('The issue number.'),
  comment_body: z
    .string()
    .min(1)
    .optional()
    .describe('The comment text to add. Required for add_comment.'),
}).superRefine((val, ctx) => {
  if (val.action === GhIssueCommentAction.AddComment && !val.comment_body) {
    ctx.addIssue({
      code: 'custom',
      message: "comment_body is required for action 'add_comment'",
      path: ['comment_body'],
    });
  }
});

export type GhIssueCommentToolSchemaType = z.infer<
  typeof GhIssueCommentToolSchema
>;

type GhIssueCommentToolOutput =
  | { success: true; action: GhIssueCommentAction; data: unknown }
  | { success: false; error: string };

@Injectable()
export class GhIssueCommentTool extends GhBaseTool<
  GhIssueCommentToolSchemaType,
  GhBaseToolConfig,
  GhIssueCommentToolOutput
> {
  public name = 'gh_issue_comment';
  public description =
    'Read and write comments on GitHub issues. Retrieves all comments on an issue or adds a new comment. Use this for discussion and collaboration on issues.';

  public get schema() {
    return GhIssueCommentToolSchema;
  }

  protected override generateTitle(
    args: GhIssueCommentToolSchemaType,
    _config: GhBaseToolConfig,
  ): string {
    const repo = `${args.owner}/${args.repo}`;
    switch (args.action) {
      case GhIssueCommentAction.GetComments:
        return `Getting comments on issue #${args.issue_number} in ${repo}`;
      case GhIssueCommentAction.AddComment:
        return `Adding comment to issue #${args.issue_number} in ${repo}`;
    }
  }

  public getDetailedInstructions(
    _config: GhBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Read and write comments on GitHub issues. Supports retrieving all comments on an issue and adding new comments.

      ### Actions

      **get_comments** — Get all comments on an issue.

      **add_comment** — Add a comment to an issue. Requires \`comment_body\`.

      ### Examples

      **Read all comments on an issue:**
      \`\`\`json
      { "owner": "acme", "repo": "demo", "action": "get_comments", "issue_number": 42 }
      \`\`\`

      **Add a comment:**
      \`\`\`json
      { "owner": "acme", "repo": "demo", "action": "add_comment", "issue_number": 42, "comment_body": "Fixed in PR #55." }
      \`\`\`

      ### Troubleshooting
      - 404: The issue or repository does not exist, or the token lacks access.
      - 401/403: Check PAT scopes and repository access.
    `;
  }

  public async invoke(
    args: GhIssueCommentToolSchemaType,
    config: GhBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<GhIssueCommentToolOutput>> {
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
    client: ReturnType<GhIssueCommentTool['createClient']>,
    args: GhIssueCommentToolSchemaType,
  ): Promise<unknown> {
    const { owner, repo } = args;

    switch (args.action) {
      case GhIssueCommentAction.GetComments: {
        const res = await client.issues.listComments({
          owner,
          repo,
          issue_number: args.issue_number,
        });
        return res.data.map(
          (comment: {
            id: number;
            body?: string;
            user: { login: string } | null;
            created_at: string;
            updated_at: string;
          }) => ({
            id: comment.id,
            body: comment.body,
            user: comment.user?.login,
            created_at: comment.created_at,
            updated_at: comment.updated_at,
          }),
        );
      }

      case GhIssueCommentAction.AddComment: {
        const res = await client.issues.createComment({
          owner,
          repo,
          issue_number: args.issue_number,
          body: args.comment_body!,
        });
        return {
          id: res.data.id,
          body: res.data.body,
          url: res.data.html_url,
          created_at: res.data.created_at,
        };
      }
    }
  }
}
