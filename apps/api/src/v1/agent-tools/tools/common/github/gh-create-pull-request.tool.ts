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

export const GhCreatePullRequestToolSchema = GhBaseToolSchema.extend({
  title: z
    .string()
    .min(1)
    .describe(
      'The title of the pull request. Keep it concise and descriptive (e.g., "Add user authentication endpoint").',
    ),
  body: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Markdown body/description for the PR. Include context about the changes, motivation, and testing notes.',
    ),

  head: z
    .string()
    .min(1)
    .describe(
      "The source branch containing your changes (e.g., 'feat/add-auth'). For cross-fork PRs, use 'forkOwner:branch' format. Same-repo branches are automatically qualified as 'owner:branch' by the tool.",
    ),
  base: z
    .string()
    .min(1)
    .describe(
      "The target branch to merge into (e.g., 'main', 'develop'). This is the branch that will receive the changes.",
    ),

  draft: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      'If true, create the PR as a draft that cannot be merged until marked ready. Default: false.',
    ),

  labels: z
    .array(z.string().min(1))
    .nullable()
    .optional()
    .describe(
      'Labels to apply to the PR (e.g., ["bug", "priority:high"]). Labels must already exist in the repository.',
    ),
  assignees: z
    .array(z.string().min(1))
    .nullable()
    .optional()
    .describe(
      'GitHub usernames to assign to the PR (e.g., ["octocat", "contributor1"]).',
    ),
  reviewers: z
    .array(z.string().min(1))
    .nullable()
    .optional()
    .describe(
      'GitHub usernames to request as reviewers (e.g., ["reviewer1"]). Combined with teamReviewers, cannot exceed 15 total.',
    ),
  teamReviewers: z
    .array(z.string().min(1))
    .nullable()
    .optional()
    .describe(
      'Organization team slugs to request as reviewers (e.g., ["platform-team"]). Only available for organization repositories. Combined with reviewers, cannot exceed 15 total.',
    ),

  closesIssues: z
    .array(z.number().int().positive())
    .nullable()
    .optional()
    .describe(
      'Issue numbers to auto-close when the PR is merged. Appends "Closes #N" lines to the PR body automatically if not already present.',
    ),
}).superRefine((val, ctx) => {
  const count = (val.reviewers?.length ?? 0) + (val.teamReviewers?.length ?? 0);
  if (count > 15) {
    ctx.addIssue({
      code: 'custom',
      message: 'reviewers + teamReviewers cannot exceed 15 entries',
      path: ['reviewers'],
    });

    ctx.addIssue({
      code: 'custom',
      message: 'reviewers + teamReviewers cannot exceed 15 entries',
      path: ['teamReviewers'],
    });
  }
});

export type GhCreatePullRequestToolSchemaType = z.infer<
  typeof GhCreatePullRequestToolSchema
>;

type GhCreatePullRequestToolConfig = GhBaseToolConfig & {
  /**
   * Labels that will always be applied when creating PRs, merged with `args.labels`.
   */
  additionalLabels?: string[];
};

type GhCreatePullRequestToolOutput =
  | {
      success: true;
      owner: string;
      repo: string;
      pullRequest: {
        number: number;
        id: number;
        nodeId?: string;
        url: string;
        apiUrl: string;
        state: 'open' | 'closed';
        draft: boolean;
        title: string;
        body?: string | null;
        base: { ref: string; sha?: string; repoFullName?: string };
        head: { ref: string; sha?: string; repoFullName?: string };
        createdAt?: string;
        updatedAt?: string;
      };
      applied?: {
        labels?: string[];
        assignees?: string[];
        reviewers?: string[];
        teamReviewers?: string[];
      };
      warnings?: string[];
    }
  | { success: false; error: string };

type AppliedMetadata = NonNullable<
  Extract<GhCreatePullRequestToolOutput, { success: true }>['applied']
>;

type CreatedPullRequest = {
  number: number;
  id: number;
  nodeId?: string;
  url: string;
  apiUrl: string;
  state: 'open' | 'closed';
  draft: boolean;
  title: string;
  body?: string | null;
  base: { ref: string; sha?: string; repoFullName?: string };
  head: { ref: string; sha?: string; repoFullName?: string };
  createdAt?: string;
  updatedAt?: string;
};

type GitHubLabel = { name?: string | null };

type GitHubAssignee = { login?: string | null };

type GitHubReviewer = { login?: string | null };

type GitHubTeam = { slug?: string | null };

type IssuesUpdateResponseData = {
  labels?: GitHubLabel[];
  assignees?: GitHubAssignee[];
};

type PullsRequestReviewersResponseData = {
  requested_reviewers?: GitHubReviewer[];
  requested_teams?: GitHubTeam[];
};

@Injectable()
export class GhCreatePullRequestTool extends GhBaseTool<
  GhCreatePullRequestToolSchemaType,
  GhCreatePullRequestToolConfig,
  GhCreatePullRequestToolOutput
> {
  public name = 'gh_pr_create';
  public description =
    'Create a GitHub Pull Request from a head branch into a base branch, optionally with labels, assignees, and reviewers in a single call. The branch must be pushed first with gh_push. Returns the PR URL and number on success.';

  private getLabelsToApply(
    args: GhCreatePullRequestToolSchemaType,
    config: GhCreatePullRequestToolConfig,
  ): string[] | undefined {
    return this.mergeUniqueStrings(
      config.additionalLabels,
      args.labels ?? undefined,
    );
  }

  private buildPullRequestBody(args: GhCreatePullRequestToolSchemaType) {
    const baseBody = args.body ?? undefined;
    return args.closesIssues?.length
      ? this.appendClosesIssues(baseBody, args.closesIssues)
      : baseBody;
  }

  private mergeUniqueStrings(
    ...parts: (string[] | undefined)[]
  ): string[] | undefined {
    const out: string[] = [];
    const seen = new Set<string>();

    for (const part of parts) {
      if (!part?.length) {
        continue;
      }
      for (const item of part) {
        const value = item.trim();
        if (!value) {
          continue;
        }
        if (seen.has(value)) {
          continue;
        }
        seen.add(value);
        out.push(value);
      }
    }

    return out.length ? out : undefined;
  }

  private appendClosesIssues(
    body: string | undefined,
    closesIssues: number[],
  ): string | undefined {
    if (!closesIssues.length) {
      return body;
    }

    const existingBody = body ?? '';

    const linesToAppend = closesIssues.map((n) => `Closes #${n}`);

    // If a line already exists, skip appending that issue.
    const existingLower = existingBody.toLowerCase();
    const filtered = linesToAppend.filter(
      (line) => !existingLower.includes(line.toLowerCase()),
    );

    if (!filtered.length) {
      return body;
    }

    const separator = existingBody.trim().length ? '\n\n' : '';
    return `${existingBody}${separator}${filtered.join('\n')}`;
  }

  private extractLabelNames(
    labels: GitHubLabel[] | undefined,
  ): string[] | undefined {
    const names = labels
      ?.map((l) => l.name)
      .filter(
        (name): name is string => typeof name === 'string' && name.length > 0,
      );

    return names?.length ? names : undefined;
  }

  private extractLogins(
    users: { login?: string | null }[] | undefined,
  ): string[] | undefined {
    const logins = users
      ?.map((u) => u.login)
      .filter(
        (login): login is string =>
          typeof login === 'string' && login.length > 0,
      );

    return logins?.length ? logins : undefined;
  }

  private extractTeamSlugs(
    teams: { slug?: string | null }[] | undefined,
  ): string[] | undefined {
    const slugs = teams
      ?.map((t) => t.slug)
      .filter(
        (slug): slug is string => typeof slug === 'string' && slug.length > 0,
      );

    return slugs?.length ? slugs : undefined;
  }

  private async createPullRequest(
    client: ReturnType<GhCreatePullRequestTool['createClient']>,
    args: GhCreatePullRequestToolSchemaType,
  ): Promise<CreatedPullRequest> {
    // Qualify head as "owner:branch" for same-repo PRs. GitHub resolves the
    // qualified form immediately after a push, while the unqualified form may
    // return 422 if the branch indexing hasn't completed yet.
    const qualifiedHead = args.head.includes(':')
      ? args.head
      : `${args.owner}:${args.head}`;

    const res = await client.pulls.create({
      owner: args.owner,
      repo: args.repo,
      title: args.title,
      head: qualifiedHead,
      base: args.base,
      body: this.buildPullRequestBody(args) ?? undefined,
      draft: args.draft ?? undefined,
    });

    return {
      number: res.data.number,
      id: res.data.id,
      nodeId: res.data.node_id,
      url: res.data.html_url,
      apiUrl: res.data.url,
      state: res.data.state === 'closed' ? 'closed' : 'open',
      draft: Boolean(res.data.draft),
      title: res.data.title,
      body: res.data.body,
      base: {
        ref: res.data.base.ref,
        sha: res.data.base.sha,
        repoFullName: res.data.base.repo?.full_name,
      },
      head: {
        ref: res.data.head.ref,
        sha: res.data.head.sha,
        repoFullName: res.data.head.repo?.full_name,
      },
      createdAt: res.data.created_at,
      updatedAt: res.data.updated_at,
    };
  }

  private async tryApplyIssueMetadata(params: {
    client: ReturnType<GhCreatePullRequestTool['createClient']>;
    args: GhCreatePullRequestToolSchemaType;
    pullRequestNumber: number;
    labelsToApply: string[] | undefined;
  }): Promise<
    | {
        applied?: Pick<AppliedMetadata, 'labels' | 'assignees'>;
        warning?: never;
      }
    | { applied?: never; warning: string }
    | { applied?: never; warning?: never }
  > {
    const { client, args, pullRequestNumber, labelsToApply } = params;

    if (!labelsToApply?.length && !args.assignees?.length) {
      return {};
    }

    try {
      const issueRes = await client.issues.update({
        owner: args.owner,
        repo: args.repo,
        issue_number: pullRequestNumber,
        labels: labelsToApply,
        assignees: args.assignees ?? undefined,
      });

      const data = issueRes.data as IssuesUpdateResponseData;
      return {
        applied: {
          labels: this.extractLabelNames(data.labels),
          assignees: this.extractLogins(data.assignees),
        },
      };
    } catch (error) {
      return {
        warning: `Failed to apply issue metadata: ${this.formatGitHubError(error)}`,
      };
    }
  }

  private async tryRequestReviewers(params: {
    client: ReturnType<GhCreatePullRequestTool['createClient']>;
    args: GhCreatePullRequestToolSchemaType;
    pullRequestNumber: number;
  }): Promise<
    | {
        applied?: Pick<AppliedMetadata, 'reviewers' | 'teamReviewers'>;
        warning?: never;
      }
    | { applied?: never; warning: string }
    | { applied?: never; warning?: never }
  > {
    const { client, args, pullRequestNumber } = params;

    const totalReviewers =
      (args.reviewers?.length ?? 0) + (args.teamReviewers?.length ?? 0);

    // NOTE: the combined reviewer constraint is not guaranteed to be enforced by Ajv
    // because it is defined in Zod via `superRefine`.
    if (!totalReviewers || totalReviewers > 15) {
      return {};
    }

    try {
      const reviewersRes = await client.pulls.requestReviewers({
        owner: args.owner,
        repo: args.repo,
        pull_number: pullRequestNumber,
        reviewers: args.reviewers ?? undefined,
        team_reviewers: args.teamReviewers ?? undefined,
      });

      const reviewersData =
        reviewersRes.data as PullsRequestReviewersResponseData;

      return {
        applied: {
          reviewers: this.extractLogins(reviewersData.requested_reviewers),
          teamReviewers: this.extractTeamSlugs(reviewersData.requested_teams),
        },
      };
    } catch (error) {
      return {
        warning: `Failed to request reviewers: ${this.formatGitHubError(error)}`,
      };
    }
  }

  protected override generateTitle(
    args: GhCreatePullRequestToolSchemaType,
    _config: GhBaseToolConfig,
  ): string {
    return `Creating PR ${args.owner}/${args.repo}: ${args.title}`;
  }

  public getDetailedInstructions(
    _config: GhBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Creates a Pull Request in GitHub and then optionally applies issue metadata and review requests.

      ### When to Use
      - You have pushed a branch and want to open a PR programmatically.
      - You want to set labels / assignees and request reviewers in one step.

      ### Inputs
      - \`owner\`, \`repo\`: Repository coordinates
      - \`title\`: PR title (required)
      - \`head\`: Source branch (required). The tool auto-qualifies same-repo branches as \`owner:branch\`. For cross-fork PRs, use \`forkOwner:branch-name\`.
      - \`base\`: Target branch (required)

      ### Examples
      **Create a basic PR:**
      \`\`\`json
      {
        "owner": "acme",
        "repo": "demo",
        "title": "Add search filters",
        "head": "feat/search-filters",
        "base": "main"
      }
      \`\`\`

      **Create PR + apply metadata:**
      \`\`\`json
      {
        "owner": "acme",
        "repo": "demo",
        "title": "Fix login redirect",
        "head": "fix/login-redirect",
        "base": "main",
        "labels": ["bug"],
        "assignees": ["octocat"],
        "reviewers": ["reviewer1"],
        "teamReviewers": ["platform"]
      }
      \`\`\`

      ### ⚠️ PREREQUISITE — Successful Push Required

      **Only call this tool AFTER \`gh_push\` has returned \`"success": true\`.**
      Never call \`gh_push\` and \`gh_pr_create\` in the same parallel tool batch.
      If the push failed or hasn't been attempted, the PR will point to a branch with stale or missing commits — making it empty and useless.

      ### Troubleshooting
      - 422 Validation Failed: typically means \`head\` or \`base\` is wrong, or the branch doesn't exist on the remote (push may have failed).
      - 401/403: check PAT scopes and repository access.
    `;
  }

  public get schema() {
    return GhCreatePullRequestToolSchema;
  }

  public async invoke(
    args: GhCreatePullRequestToolSchemaType,
    config: GhCreatePullRequestToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<GhCreatePullRequestToolOutput>> {
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

    const warnings: string[] = [];
    let applied: AppliedMetadata | undefined;

    // Step 1: create PR
    let created: CreatedPullRequest;
    try {
      created = await this.createPullRequest(client, validated);
    } catch (error) {
      return {
        output: { success: false, error: this.formatGitHubError(error) },
      };
    }

    const labelsToApply = this.getLabelsToApply(validated, config);

    // Step 2: apply metadata (labels/assignees)
    const issueMetaResult = await this.tryApplyIssueMetadata({
      client,
      args: validated,
      pullRequestNumber: created.number,
      labelsToApply,
    });
    if ('warning' in issueMetaResult && issueMetaResult.warning) {
      warnings.push(issueMetaResult.warning);
    } else if (issueMetaResult.applied) {
      applied = { ...(applied ?? {}), ...issueMetaResult.applied };
    }

    // Step 3: request reviewers
    const reviewersResult = await this.tryRequestReviewers({
      client,
      args: validated,
      pullRequestNumber: created.number,
    });
    if ('warning' in reviewersResult && reviewersResult.warning) {
      warnings.push(reviewersResult.warning);
    } else if (reviewersResult.applied) {
      applied = { ...(applied ?? {}), ...reviewersResult.applied };
    }

    const output: GhCreatePullRequestToolOutput = {
      success: true,
      owner: validated.owner,
      repo: validated.repo,
      pullRequest: created,
      applied,
      warnings: warnings.length ? warnings : undefined,
    };

    return {
      output,
      messageMetadata: {
        __title: this.generateTitle?.(validated, config),
      },
    };
  }
}
