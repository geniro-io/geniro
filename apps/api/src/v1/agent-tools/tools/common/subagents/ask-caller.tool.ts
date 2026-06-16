import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import dedent from 'dedent';
import { z } from 'zod';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { ASK_CALLER_TOOL_NAME } from '../../../../subagents/subagent-ask-back.types';
import {
  BaseTool,
  ExtendedLangGraphRunnableConfig,
  ToolInvokeResult,
} from '../../base-tool';

export const AskCallerToolSchema = z.object({
  purpose: z
    .string()
    .min(1)
    .describe('Brief reason for asking. Keep it short (< 120 chars).'),
  question: z
    .string()
    .min(1)
    .describe(
      'The single, specific question to ask the agent that delegated this task to you. ' +
        'Be precise and self-contained — include the options or the exact detail you need. ' +
        'Your run pauses here until the caller answers, so ask only when you genuinely cannot proceed.',
    ),
});

export type AskCallerToolSchemaType = z.infer<typeof AskCallerToolSchema>;

export type AskCallerToolOutput = {
  /** Always true — confirms to the model that the question was forwarded. */
  forwarded: true;
  question: string;
};

/**
 * Lets a subagent ask its CALLER (the agent that delegated the task) a single
 * question instead of guessing or finishing prematurely. Calling this tool
 * durably suspends the subagent (M4 ask-back): the run pauses at this point, the
 * caller answers in-session via `answer_callee`, and the subagent resumes from
 * its pg-checkpoint with the answer delivered as a follow-up message. The
 * SubAgent loop detects this tool call and routes to its suspend exit — this
 * tool itself only forwards the question; it does not block.
 */
@Injectable()
export class AskCallerTool extends BaseTool<AskCallerToolSchemaType> {
  public name = ASK_CALLER_TOOL_NAME;
  public description =
    'Ask the agent that delegated this task to you a single, specific question when you genuinely cannot proceed without it. ' +
    'Your run PAUSES until the caller answers — their answer arrives as a follow-up message and you continue from where you stopped. ' +
    'Prefer completing autonomously with reasonable assumptions; only ask when a required detail or decision is missing and cannot be inferred from the task. ' +
    'Ask ONE focused question at a time and never call this alongside other tools.';

  protected override generateTitle(args: AskCallerToolSchemaType): string {
    return args.purpose;
  }

  public getDetailedInstructions(
    _config: Record<PropertyKey, unknown>,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Ask your caller (the agent that delegated this task) one specific question.
      Calling this tool pauses your run; the caller answers in-session and you
      resume from exactly where you stopped, with their answer delivered as a
      follow-up message.

      ### When to Use
      Only when a required detail or decision is genuinely missing and you cannot
      reasonably infer it from the task description. Examples: an ambiguous choice
      with materially different outcomes, a missing path/identifier you cannot
      discover, or a constraint the task left unspecified that changes the result.

      ### When NOT to Use
      - You can pick a sensible default or make a reasonable assumption -> just proceed.
      - The detail is discoverable yourself (search/read the codebase) -> discover it.
      - You are merely confirming something already implied by the task -> proceed.

      ### Rules
      - Ask ONE focused, self-contained question. Include the options or the exact
        detail you need so the caller can answer in a single message.
      - Never call this alongside other tools — it must be the sole tool call.
      - Asking has a cost (a round-trip to your caller) — prefer completion.

      ### Example
      \`\`\`json
      {"purpose": "Confirm target file", "question": "There are two auth configs — /repo/src/auth/config.ts and /repo/src/auth/legacy.config.ts. Which should I modify?"}
      \`\`\`
    `;
  }

  public get schema() {
    return AskCallerToolSchema;
  }

  public invoke(
    args: AskCallerToolSchemaType,
    _config: Record<PropertyKey, unknown>,
    _cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): ToolInvokeResult<AskCallerToolOutput> {
    const title = this.generateTitle?.(args);

    // The tool only forwards the question. The SubAgent loop inspects the
    // triggering AIMessage for this tool name and routes to its durable suspend
    // exit; the caller's answer arrives as a follow-up message on resume.
    return {
      output: { forwarded: true, question: args.question },
      messageMetadata: { __title: title },
    };
  }
}
