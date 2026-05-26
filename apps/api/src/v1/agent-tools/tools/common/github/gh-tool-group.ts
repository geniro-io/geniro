import { Injectable } from '@nestjs/common';
import dedent from 'dedent';

import {
  BuiltAgentTool,
  ExtendedLangGraphRunnableConfig,
} from '../../base-tool';
import { BaseToolGroup } from '../../base-tool-group';
import { GhBaseToolConfig } from './gh-base.tool';
import { GhBranchTool } from './gh-branch.tool';
import { GhCloneTool } from './gh-clone.tool';
import { GhCommitTool } from './gh-commit.tool';
import { GhCreatePullRequestTool } from './gh-create-pull-request.tool';
import { GhIssueCommentTool } from './gh-issue-comment.tool';
import { GhIssueManageTool } from './gh-issue-manage.tool';
import { GhPrCommentTool } from './gh-pr-comment.tool';
import { GhPrReadTool } from './gh-pr-read.tool';
import { GhPushTool } from './gh-push.tool';

export enum GhToolType {
  Clone = 'clone',
  Commit = 'commit',
  Branch = 'branch',
  Push = 'push',
  PrCreate = 'pr_create',
  PrRead = 'pr_read',
  PrComment = 'pr_comment',
  Issue = 'issue',
  IssueComment = 'issue_comment',
}

const READ_ONLY_TOOLS: ReadonlySet<GhToolType> = new Set([
  GhToolType.Clone,
  GhToolType.PrRead,
  GhToolType.PrComment,
  GhToolType.Issue,
  GhToolType.IssueComment,
]);

export type GhToolGroupConfig = GhBaseToolConfig & {
  tools?: GhToolType[];
  readOnly?: boolean;
  /**
   * Labels that will always be applied when creating PRs via `gh_pr_create`.
   * These are merged with any labels passed at invocation time.
   */
  additionalLabels?: string[];
};

@Injectable()
export class GhToolGroup extends BaseToolGroup<GhToolGroupConfig> {
  constructor(
    private readonly ghCloneTool: GhCloneTool,
    private readonly ghCommitTool: GhCommitTool,
    private readonly ghBranchTool: GhBranchTool,
    private readonly ghPushTool: GhPushTool,
    private readonly ghCreatePullRequestTool: GhCreatePullRequestTool,
    private readonly ghIssueManageTool: GhIssueManageTool,
    private readonly ghIssueCommentTool: GhIssueCommentTool,
    private readonly ghPrReadTool: GhPrReadTool,
    private readonly ghPrCommentTool: GhPrCommentTool,
  ) {
    super();
  }

  public getDetailedInstructions(
    config: GhToolGroupConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    if (config.readOnly) {
      return dedent`
        ## GitHub Tools — Read-Only Mode

        You have read-only access to the GitHub repository. Use \`gh_clone\` to clone and inspect code,
        \`gh_pr_read\` to review pull requests, and the issue/comment tools to read issues and discussions.

        You cannot create branches, commit, push, or open pull requests.
      `;
    }

    return dedent`
      ## Git Workflow — Required Tool Order

      Follow this exact sequence when delivering code via Git:

      1. \`gh_clone\` → clone the repository
      2. \`gh_branch\` → create and checkout a feature branch
      3. Make changes with file tools
      4. \`gh_commit\` → commit changes
      5. \`gh_push\` → push the branch to remote
      6. **Wait for \`gh_push\` result** — check that \`"success": true\`
      7. \`gh_pr_create\` → open a PR (only after push succeeded)

      ### ⚠️ CRITICAL — Sequential Dependency Rules

      **\`gh_push\` and \`gh_pr_create\` must NEVER be called in the same parallel batch.**
      These tools have a strict sequential dependency: the PR can only reference commits that exist on the remote.
      If you call both in parallel, the PR may be created before the push completes — pointing to a branch with stale or missing commits.

      **If \`gh_push\` returns \`"success": false\`:**
      - Do NOT call \`gh_pr_create\`.
      - Do NOT call \`finish\` or report the task as complete.
      - Diagnose the push failure and attempt recovery (see \`gh_push\` instructions for details).
      - Only after a successful push should you proceed to create a PR.

      **A PR created from an unpushed branch is empty and useless** — it points to commits that don't exist on the remote. This is worse than no PR at all.
    `;
  }

  protected buildToolsInternal(
    config: GhToolGroupConfig,
    lgConfig?: ExtendedLangGraphRunnableConfig,
  ): BuiltAgentTool[] {
    let selectedTools = config.tools ?? [
      GhToolType.Clone,
      GhToolType.Commit,
      GhToolType.Branch,
      GhToolType.Push,
      GhToolType.PrCreate,
      GhToolType.PrRead,
      GhToolType.PrComment,
      GhToolType.Issue,
      GhToolType.IssueComment,
    ];

    if (config.readOnly) {
      selectedTools = selectedTools.filter((t) => READ_ONLY_TOOLS.has(t));
    }

    const tools: BuiltAgentTool[] = [];

    for (const toolType of selectedTools) {
      switch (toolType) {
        case GhToolType.Clone:
          tools.push(this.ghCloneTool.build(config, lgConfig));
          break;
        case GhToolType.Commit:
          tools.push(this.ghCommitTool.build(config, lgConfig));
          break;
        case GhToolType.Branch:
          tools.push(this.ghBranchTool.build(config, lgConfig));
          break;
        case GhToolType.Push:
          tools.push(this.ghPushTool.build(config, lgConfig));
          break;
        case GhToolType.PrCreate:
          tools.push(this.ghCreatePullRequestTool.build(config, lgConfig));
          break;
        case GhToolType.PrRead:
          tools.push(this.ghPrReadTool.build(config, lgConfig));
          break;
        case GhToolType.PrComment:
          tools.push(this.ghPrCommentTool.build(config, lgConfig));
          break;
        case GhToolType.Issue:
          tools.push(this.ghIssueManageTool.build(config, lgConfig));
          break;
        case GhToolType.IssueComment:
          tools.push(this.ghIssueCommentTool.build(config, lgConfig));
          break;
      }
    }

    return tools;
  }
}
