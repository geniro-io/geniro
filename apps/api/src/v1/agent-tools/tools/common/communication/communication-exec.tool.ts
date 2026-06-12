import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';
import dedent from 'dedent';
import { z } from 'zod';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import type { RequestTokenUsage } from '../../../../litellm/litellm.types';
import {
  BaseTool,
  ExtendedLangGraphRunnableConfig,
  ToolInvokeResult,
} from '../../base-tool';
import {
  AgentInfo,
  BaseCommunicationToolConfig,
} from './communication-tools.types';

export const CommunicationExecSchema = z.object({
  message: z
    .string()
    .min(1)
    .describe(
      'The message to send to the target agent. Be clear and provide necessary context.',
    ),
  purpose: z
    .string()
    .min(1)
    .describe('Brief reason for using this tool. Keep it short (< 120 chars).'),
  agent: z
    .string()
    .min(1)
    .describe(
      'The name of the target agent. Must match one of the connected agents listed in the instructions.',
    ),
});

export type CommunicationExecSchemaType = z.infer<
  typeof CommunicationExecSchema
>;

@Injectable()
export class CommunicationExecTool extends BaseTool<
  CommunicationExecSchemaType,
  BaseCommunicationToolConfig
> {
  public name = 'communication_exec';
  public description =
    'Send a message to another agent in the system and receive their response. Use this for multi-agent collaboration — delegating specialized tasks, getting reviews, or breaking complex work across multiple agents. The agent parameter must exactly match one of the connected agent names listed in the detailed instructions. Provide clear, context-rich messages with file paths, specific requirements, and expected outputs for best results.';

  private normalizeAgentName(name: string): string {
    // Normalize for matching:
    // - trim
    // - case-insensitive
    // - drop role suffix in parentheses: "Elias Rainer (Software Architect)" -> "Elias Rainer"
    return name
      .trim()
      .replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  private resolveAgent(
    requested: string,
    config: BaseCommunicationToolConfig,
  ): AgentInfo | undefined {
    if (!config?.agents?.length) {
      return undefined;
    }

    // 1) Exact match
    const exact = config.agents.find((a) => a.name === requested);
    if (exact) {
      return exact;
    }

    // 2) Case-insensitive exact match
    const lower = requested.trim().toLowerCase();
    const ciExact = config.agents.find(
      (a) => a.name.trim().toLowerCase() === lower,
    );
    if (ciExact) {
      return ciExact;
    }

    // 3) Normalized match (strip role suffix, collapse spaces)
    const normRequested = this.normalizeAgentName(requested);
    const normMatches = config.agents.filter(
      (a) => this.normalizeAgentName(a.name) === normRequested,
    );
    if (normMatches.length === 1) {
      return normMatches[0];
    }

    // 4) Prefix match on normalized name (helps when model sends just first/last name)
    const prefixMatches = config.agents.filter((a) =>
      this.normalizeAgentName(a.name).startsWith(normRequested),
    );
    if (prefixMatches.length === 1) {
      return prefixMatches[0];
    }

    return undefined;
  }

  protected override generateTitle(
    args: CommunicationExecSchemaType,
    _config: BaseCommunicationToolConfig,
  ): string {
    return `Asking ${args.agent}: ${args.purpose}`;
  }

  public getDetailedInstructions(
    config: BaseCommunicationToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    const availableAgents = config?.agents?.length
      ? config.agents
          .map((agent) => `####${agent.name}\n${agent.description}\n`)
          .join('\n')
      : '- No agents configured.';

    return dedent`
      ### Overview
      Sends a message to another agent in the system and returns their response. Enables multi-agent collaboration where different agents specialize in different tasks.

      ### Connected Agents
      ${availableAgents}

      ### When to Use
      - Delegating specialized tasks to expert agents
      - Getting a second opinion or review from another agent
      - Executing tasks that another agent is better suited for
      - Breaking down complex work across multiple agents

      ### When NOT to Use
      - You can handle the task yourself → work directly
      - You don't know which agent to use → pick from Connected Agents above
      - Task is too simple → direct execution is faster

      ### \`message\` examples

      **Good messages:**
      \`\`\`json
      {
        "message": "Please review the changes in /repo/src/auth/login.ts and check for security vulnerabilities. Focus on input validation and token handling."
      }
      \`\`\`

      \`\`\`json
      {
        "message": "Implement unit tests for the UserService class located at /repo/src/services/user.service.ts. Cover the createUser and updateUser methods."
      }
      \`\`\`

      **Include:**
      - Clear task description
      - Relevant file paths or context
      - Specific focus areas or requirements
      - Expected output or deliverable

      ### Best Practices

      **1. Review connected agents:**
      Choose the most appropriate agent from the Connected Agents list above.

      **2. Provide complete context:**
      \`\`\`json
      {
        "agent": "test-writer",
        "message": "Write tests for the PaymentService class at /repo/src/services/payment.service.ts. The class handles credit card processing. Use Jest with TypeScript. Mock external payment API calls.",
        "purpose": "Generate unit tests for payment processing"
      }
      \`\`\`

      **3. Be specific about expectations:**
      \`\`\`json
      {
        "agent": "documenter",
        "message": "Generate JSDoc comments for all public methods in /repo/src/utils/validators.ts. Include parameter descriptions, return types, and usage examples.",
        "purpose": "Add API documentation"
      }
      \`\`\`

      **4. Handle responses appropriately:**
      The agent will return a response. Process it and continue your workflow.

      ### Output Format
      Returns the response from the target agent. Format varies by agent but typically includes their results, output, or completion status.

      ### Common Patterns

      **Delegate and continue:**
      \`\`\`
      1. Identify task that another agent handles better
      2. Call communication_exec with task details
      3. Process the response
      4. Continue with your workflow
      \`\`\`

      **Chain of agents:**
      \`\`\`
      1. Agent A starts work
      2. A delegates to Agent B for specialized task
      3. B returns results to A
      4. A integrates B's work and continues
      \`\`\`

      ### Error Handling
      - "Agent not found" → Check the name matches one of the connected agents
      - "No agents configured" → No agents are available for communication
      - Empty response → Agent may have failed or returned no output
      - "WAIT_FOR_FORBIDDEN_IN_CALLEE" → The target agent tried to call \`wait_for\` while running as a callee; this is not allowed. If your workflow requires a wait, call \`wait_for\` yourself (on the root thread) after collecting the callee's response.

      ### Integration with Workflows
      Callees (agents invoked via this tool) cannot pause with \`wait_for\` — they must finish synchronously and return a response. If a wait is needed, you (the caller) must schedule it on the root thread after the callee returns.

      Use communication when:
      - A task falls outside your expertise
      - Parallel work is possible
      - Another agent has specific capabilities you lack
      - Complex tasks benefit from division of labor

      ### ⚠️ CRITICAL: After Receiving an Agent's Response — Do NOT Re-explore
      The response may include an \`exploredFiles\` list of every file the target agent read or found.
      **These files have ALREADY been thoroughly analyzed by the target agent.**

      Rules after receiving a response from another agent:
      - **DO NOT re-read files listed in \`exploredFiles\`** with \`files_read\` or \`codebase_search\`
      - **Trust the agent's analysis** — their response already contains all relevant findings
      - If the agent provided an architectural spec with file paths, **proceed directly to implementation**
      - If you need to **edit** a file, you may read only the specific lines you will change
      - If the response is missing critical details, **ask the same agent again** rather than re-exploring yourself

      **BAD — re-exploring after receiving agent response:**
      Agent returns analysis of \`auth.service.ts\` → You call \`files_read("auth.service.ts")\` → You search "auth middleware"

      **GOOD — trusting agent and proceeding:**
      Agent returns analysis of \`auth.service.ts\` → You use their analysis to write your implementation plan or edits
    `;
  }

  public get schema() {
    return CommunicationExecSchema;
  }

  public async invoke(
    args: CommunicationExecSchemaType,
    config: BaseCommunicationToolConfig,
    runnableConfig: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<unknown>> {
    const title = this.generateTitle?.(args, config);

    if (!config?.agents || config.agents.length === 0) {
      throw new BadRequestException(
        undefined,
        'No agents configured for communication',
      );
    }

    const targetAgent = this.resolveAgent(args.agent, config);

    if (!targetAgent) {
      throw new BadRequestException(
        undefined,
        `Agent "${args.agent}" not found. Check available connected agents in tool instructions.`,
      );
    }

    const communicationRunnableConfig: ToolRunnableConfig<BaseAgentConfigurable> =
      {
        ...runnableConfig,
        configurable: {
          ...(runnableConfig.configurable ?? {}),
          __interAgentCommunication: true,
          __sourceAgentNodeId: runnableConfig.configurable?.node_id,
        },
      };

    try {
      const output = await targetAgent.invokeAgent(
        [args.message],
        communicationRunnableConfig,
      );
      // The callee's aggregate spend is a transport field, not part of the
      // response the model reads: strip it from `output` and report it as
      // this tool's own usage so the executor folds it into caller state.
      const { calleeUsage, ...visibleOutput } = output as Record<
        string,
        unknown
      > & { calleeUsage?: RequestTokenUsage };
      return {
        output: visibleOutput,
        ...(calleeUsage ? { toolRequestUsage: calleeUsage } : {}),
        messageMetadata: {
          __title: title,
          __interAgentCommunication: true,
          __sourceAgentNodeId: runnableConfig.configurable?.node_id,
        },
      };
    } catch (error: unknown) {
      if (this.isPromptTooLongError(error)) {
        return {
          output: {
            error: true,
            message: dedent`
              CONTEXT OVERFLOW: The target agent "${args.agent}" has exceeded its context window limit.
              The conversation history with this agent is too large to send a new message.

              REQUIRED ACTIONS:
              1. Do NOT retry with the same message — it will fail again.
              2. Summarize the conversation so far into a concise recap (key decisions, current state, remaining work).
              3. Send a shorter message containing ONLY:
                 - A brief recap of what was accomplished (2-3 sentences)
                 - The specific remaining task
                 - Any critical context (file paths, branch name, error messages)
              4. If the remaining task is trivial (e.g. a single line fix), provide the exact change needed so the agent can apply it without needing full conversation history.
            `,
          },
          messageMetadata: {
            __title: title,
            __interAgentCommunication: true,
            __sourceAgentNodeId: runnableConfig.configurable?.node_id,
          },
        };
      }
      throw error;
    }
  }

  private isPromptTooLongError(error: unknown): boolean {
    const message =
      error instanceof Error
        ? error.message
        : typeof (error as { message?: unknown })?.message === 'string'
          ? (error as { message: string }).message
          : '';
    const lower = message.toLowerCase();
    return (
      lower.includes('prompt is too long') ||
      lower.includes('maximum context length') ||
      lower.includes('context_length_exceeded') ||
      lower.includes('too many tokens')
    );
  }
}
