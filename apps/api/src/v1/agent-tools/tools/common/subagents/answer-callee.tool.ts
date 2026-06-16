import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import dedent from 'dedent';
import { z } from 'zod';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { ANSWER_CALLEE_TOOL_NAME } from '../../../../subagents/subagent-ask-back.types';
import { SubagentSuspendService } from '../../../../subagents/subagent-suspend.service';
import {
  BaseTool,
  ExtendedLangGraphRunnableConfig,
  ToolInvokeResult,
} from '../../base-tool';
import { SubagentsToolGroupConfig } from './subagents.types';
import {
  SubagentsRunTaskTool,
  SubagentsRunTaskToolOutput,
} from './subagents-run-task.tool';

export const AnswerCalleeToolSchema = z.object({
  purpose: z
    .string()
    .min(1)
    .describe('Brief reason for using this tool. Keep it short (< 120 chars).'),
  suspendId: z
    .string()
    .min(1)
    .describe(
      'The suspendId reported by the paused subagent — it appears in the tool result that surfaced the subagent’s question. Copy it exactly.',
    ),
  answer: z
    .string()
    .min(1)
    .describe(
      'Your answer to the subagent’s question. Be specific and complete so the subagent can resume and finish without asking again.',
    ),
});

export type AnswerCalleeToolSchemaType = z.infer<typeof AnswerCalleeToolSchema>;

/**
 * Caller-side tool to answer a subagent that paused with a question (it called
 * `ask_caller`). Looks up the durable suspend record by `suspendId` and resumes
 * the subagent from its pg-checkpoint with the answer delivered as a follow-up
 * message — the subagent continues in-session from exactly where it stopped.
 * This realizes the caller-decision "answer-in-session" branch (M4): the caller
 * answers from its own reasoning instead of escalating the question to the user.
 */
@Injectable()
export class AnswerCalleeTool extends BaseTool<
  AnswerCalleeToolSchemaType,
  SubagentsToolGroupConfig,
  SubagentsRunTaskToolOutput
> {
  public name = ANSWER_CALLEE_TOOL_NAME;
  public description =
    'Answer a subagent that paused with a question (it called ask_caller and its tool result reported a suspendId). ' +
    'Provide that suspendId and your answer; the subagent resumes in-session from where it stopped and continues to completion. ' +
    'Use this to answer from your own knowledge or context instead of interrupting the user. ' +
    'If you genuinely cannot answer and the user must decide, call finish with needsMoreInfo instead of guessing.';

  constructor(
    private readonly subagentSuspendService: SubagentSuspendService,
    private readonly subagentsRunTaskTool: SubagentsRunTaskTool,
  ) {
    super();
  }

  protected override generateTitle(args: AnswerCalleeToolSchemaType): string {
    return args.purpose;
  }

  public getDetailedInstructions(
    _config: SubagentsToolGroupConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Answer a subagent you spawned that paused to ask you a question. The
      subagent resumes from exactly where it stopped, with your answer delivered
      as a follow-up message, and continues to completion (or pauses again with a
      new question).

      ### When to Use
      A previous \`subagents_run_task\` (or \`answer_callee\`) result reported
      \`needsAnswer: true\` with a \`suspendId\` and a question, AND you can
      answer it from your own knowledge, the conversation, or the codebase.

      ### When NOT to Use
      - You genuinely cannot answer and the USER must decide -> call \`finish\`
        with \`needsMoreInfo\` and the question instead.
      - There is no pending question / suspendId -> do not call this tool.

      ### Rules
      - Pass the \`suspendId\` exactly as reported. A stale or already-answered id
        returns an error — do not retry with the same id.
      - Give a complete, specific answer so the subagent does not have to ask
        again.

      ### Example
      \`\`\`json
      {"purpose": "Answer subagent's config question", "suspendId": "subagent-...", "answer": "Modify /repo/src/auth/config.ts — legacy.config.ts is deprecated."}
      \`\`\`
    `;
  }

  public get schema() {
    return AnswerCalleeToolSchema;
  }

  public async invoke(
    args: AnswerCalleeToolSchemaType,
    config: SubagentsToolGroupConfig,
    runnableConfig: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<SubagentsRunTaskToolOutput>> {
    const title = this.generateTitle?.(args);

    const record = this.subagentSuspendService.get(args.suspendId);
    if (!record) {
      return {
        output: {
          result:
            `No paused subagent found for suspendId="${args.suspendId}". ` +
            `It may have already been answered or expired. Do NOT retry with the same id — ` +
            `continue your work, and if a question still needs the user, finish with needsMoreInfo.`,
          error: 'Unknown or expired suspendId',
        },
        messageMetadata: { __title: title },
      };
    }

    return await this.subagentsRunTaskTool.resumeSuspendedSubagent(
      record,
      args.answer,
      config,
      runnableConfig,
    );
  }
}
