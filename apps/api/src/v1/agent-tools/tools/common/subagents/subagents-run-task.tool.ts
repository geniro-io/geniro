import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DefaultLogger } from '@packages/common';
import dedent from 'dedent';
import { z } from 'zod';

import { environment } from '../../../../../environments';
import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import {
  SubAgent,
  SubagentRunResult,
} from '../../../../agents/services/agents/sub-agent';
import { LlmModelsService } from '../../../../litellm/services/llm-models.service';
import { BASE_RUNTIME_WORKDIR } from '../../../../runtime/services/base-runtime';
import { RuntimeThreadProvider } from '../../../../runtime/services/runtime-thread-provider';
import { SubagentsService } from '../../../../subagents/subagents.service';
import {
  SubagentDefinition,
  SubagentPromptContext,
} from '../../../../subagents/subagents.types';
import { execRuntimeWithContext } from '../../../agent-tools.utils';
import {
  BaseTool,
  BuiltAgentTool,
  ExtendedLangGraphRunnableConfig,
  ToolInvokeResult,
  ToolInvokeStream,
} from '../../base-tool';
import { SubagentsToolGroupConfig } from './subagents.types';

export const SubagentsRunTaskToolSchema = z.object({
  agentId: z
    .string()
    .min(1)
    .describe(
      'The ID of the subagent to run. Get available IDs from subagents_list. ' +
        'Example values: "system:explorer" (read-only codebase investigation), ' +
        '"system:simple" (general-purpose with full shell and file access), ' +
        '"system:smart" (high-capability with same model as parent agent).',
    ),
  task: z
    .string()
    .min(1)
    .describe(
      'A clear, self-contained description of the task to delegate. Include all context needed: ' +
        'ABSOLUTE file paths (starting with /runtime-workspace/), specific questions, constraints, expected output format. ' +
        'Never use relative paths like "src/..." — always use absolute paths like "/runtime-workspace/repo/src/...". ' +
        'The subagent cannot ask follow-up questions — it must be able to complete the task from this description alone.',
    ),
  purpose: z
    .string()
    .min(1)
    .describe(
      'Brief reason for delegating this task. Keep it short (< 120 chars).',
    ),
});

export type SubagentsRunTaskToolSchemaType = z.infer<
  typeof SubagentsRunTaskToolSchema
>;

export interface SubagentsRunTaskToolOutput {
  result: string;
  /** Deduplicated file paths the subagent read or found during exploration. Do NOT re-read these files. */
  exploredFiles?: string[];
  statistics?: SubagentRunResult['statistics'];
  error?: string;
}

@Injectable()
export class SubagentsRunTaskTool extends BaseTool<
  SubagentsRunTaskToolSchemaType,
  SubagentsToolGroupConfig,
  SubagentsRunTaskToolOutput
> {
  public name = 'subagents_run_task';
  public description =
    'Spawn a subagent to perform a task autonomously in its own context window. ' +
    'Returns only a concise result, protecting your main context from verbose output. ' +
    'Best for: exploration, research, running commands, and small isolated edits. ' +
    'PREFER subagents for any research task spanning 3+ files or 2+ areas of the codebase — ' +
    'do NOT explore broadly yourself with repeated codebase_search/files_read calls. ' +
    'Call this tool MULTIPLE TIMES IN PARALLEL to run independent tasks simultaneously. ' +
    'Do NOT use for tasks you can do directly: reading 1-2 specific files you already know.';

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly llmModelsService: LlmModelsService,
    private readonly subagentsService: SubagentsService,
    private readonly logger: DefaultLogger,
  ) {
    super();
  }

  public get schema() {
    return SubagentsRunTaskToolSchema;
  }

  protected override generateTitle(
    args: SubagentsRunTaskToolSchemaType,
  ): string {
    return `Calling subagent: ${args.purpose}`;
  }

  public getDetailedInstructions(
    _config: SubagentsToolGroupConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Spawns a subagent with its own isolated context window. The subagent runs autonomously,
      processes all intermediate data internally, and returns only a concise result to you.

      Use subagents to **gather information and handle supporting tasks** while you focus on the core implementation.

      ### ⚠️ CRITICAL: Always Use Subagents for Broad Exploration
      **If your task requires exploring multiple areas of the codebase (3+ files, 2+ modules), delegate to subagents.**
      Each codebase_search or files_read call you make yourself adds output to YOUR context, which grows linearly and wastes tokens.
      Subagents absorb all that output internally and return only a concise summary.

      **Stop and ask yourself:** "Am I about to do a sequence of search→read→search→read? If yes, use a subagent."

      ### Your Role vs. Subagent Roles
      **You own the deliverable.** If the user asks you to implement, fix, or produce something — that's YOUR job.
      **Subagents are your research team.** They gather information, explore code, run commands, and handle isolated changes.

      Workflow:
      1. Use subagents to **gather what you need** (explore code, find patterns, understand architecture)
      2. **Produce the deliverable yourself** using the information they bring back
      3. Use subagents for **follow-up tasks** (run tests, lint, make small fixes in other files)

      ### When to Use Subagents
      Subagents are most valuable when they absorb verbose output and return a distilled summary:

      | Task | Subagent | Why |
      |------|----------|-----|
      | Broad research / architecture analysis | explorer | Prevents your context from bloating with search results |
      | Reading 3+ files to understand a pattern | explorer | File contents are huge context consumers |
      | "How does X work?" / "Find all usages of Y" | explorer | Requires reading multiple files |
      | Running commands (test, lint, build) | simple | Command output stays in subagent context |
      | Small isolated edit in a file you don't need | simple | Keeps file contents out of your context |
      | Complex independent subtask | smart | Isolated work that doesn't need your oversight |

      ### When NOT to Use Subagents — Do It Yourself
      - **You need to read 1-2 specific files** and you know the paths → use \`files_read\` directly
      - **You are searching within a specific file or 2-3 known files** → use \`files_search_text\` directly
      - **You already have the context** in your conversation → just use it, don't re-fetch
      - **Iterating on a change** → if you're tweaking code based on errors or feedback, do it yourself

      ### Choosing the Right Subagent
      - **"system:explorer"**: Read-only, fast model. Best for investigation, research, and comprehension tasks.
      - **"system:simple"**: Full access, small fast model, tiny 70k context. For quick well-defined tasks: small edits, running commands, renaming.
      - **"system:smart"**: Full access, same large model as you. For complex subtasks needing strong reasoning. Use sparingly — it's expensive.

      ### CRITICAL: Always Parallelize Independent Tasks
      You can call \`subagents_run_task\` **multiple times in a single response** — all calls run simultaneously.
      **NEVER call subagents one after another if they don't depend on each other's output.**
      Sequential subagent calls waste enormous time — each subagent takes 1-3 minutes.

      **Correct approach: plan first, then batch.**
      Before spawning any subagents, identify ALL information you need. Then send ALL independent tasks in ONE response.

      **GOOD — 3 parallel calls in one response (runs in ~2 min total):**
      Call 1: \`{"agentId": "system:explorer", "task": "Investigate how auth middleware works in ...", "purpose": "Understand auth flow"}\`
      Call 2: \`{"agentId": "system:explorer", "task": "Find all API endpoints that use rate limiting in ...", "purpose": "Map rate-limited endpoints"}\`
      Call 3: \`{"agentId": "system:explorer", "task": "Check how error handling is structured in ...", "purpose": "Understand error patterns"}\`

      **BAD — 3 sequential calls (runs in ~6 min total, 3× slower):**
      Turn 1: Call explorer for auth → wait 2 min → get result
      Turn 2: Call explorer for rate limiting → wait 2 min → get result
      Turn 3: Call explorer for error handling → wait 2 min → get result

      Only run sequentially when task B genuinely requires the output of task A (e.g., "find the file path" → "edit the file").

      ### ⚠️ CRITICAL: After Receiving Subagent Results — Do NOT Re-explore
      The subagent result includes an \`exploredFiles\` list showing every file it read or found.
      **These files have ALREADY been thoroughly analyzed by the subagent.**

      Rules after receiving a subagent result:
      - **DO NOT re-read files listed in \`exploredFiles\`** with \`files_read\` — the subagent already read them and summarized the relevant parts.
      - **DO NOT search for the same topics** with \`codebase_search\` — the subagent already searched.
      - **Trust the subagent's summary** and proceed to the next step (implementation, next subagent, etc.).
      - If the summary is missing specific details you need, **ask a NEW subagent** for those exact details rather than re-exploring yourself.
      - If you need to **edit** a file the subagent explored, you may read the specific lines you'll change — but don't re-read entire files just to "verify" the subagent's findings.

      **BAD — re-exploring after subagent returned (wastes tokens and time):**
      Subagent returns summary of \`auth.service.ts\` → You call \`files_read("auth.service.ts")\` → You search "auth middleware" → You read 3 more files the subagent already covered.

      **GOOD — trusting subagent and proceeding:**
      Subagent returns summary of \`auth.service.ts\` → You use the summary to write your implementation → You only read files the subagent did NOT cover.

      ### Writing Effective Task Descriptions
      Subagents start with a BLANK context — they know NOTHING about the project.
      **Your task description is the ONLY information the subagent has.** Include ALL relevant context:

      1. **ABSOLUTE file paths** — always use full absolute paths starting with \`${BASE_RUNTIME_WORKDIR}/\`. Subagents cannot resolve relative paths like \`src/v1/...\` because they don't know the repo root. Every path must be absolute.
      2. **The goal** — what you need to know, acceptance criteria, constraints
      3. **Specific locations** — exact directories and files, never "find the file" if you know the path
      4. **Prior knowledge** — what you've already discovered, what failed before
      5. **Expected output format** — what information you need back and how
      6. **Repository instructions** — if gh_clone returned agentInstructions (e.g., from CLAUDE.md), include the relevant sections (commands, conventions, testing rules) so the subagent can follow them

      **Rule of thumb: if you know it and it's relevant, include it.**

      **⚠️ CRITICAL: Always use ABSOLUTE paths in task descriptions**
      Subagents run in isolated contexts and have NO knowledge of your working directory. Paths like \`src/v1/agents/\` will FAIL.
      Always convert to absolute: \`${BASE_RUNTIME_WORKDIR}/repo-name/src/v1/agents/\`

      **Good — absolute paths, includes repo instructions:**
      \`\`\`json
      {"agentId": "system:explorer", "task": "In ${BASE_RUNTIME_WORKDIR}/my-repo, find all files that import from '@auth' module. The repo root is ${BASE_RUNTIME_WORKDIR}/my-repo. I already know that ${BASE_RUNTIME_WORKDIR}/my-repo/src/middleware/auth.ts and ${BASE_RUNTIME_WORKDIR}/my-repo/src/controllers/user.controller.ts use it. For each file found, list: (1) the file path, (2) the specific named imports, (3) how they are used.", "purpose": "Map auth dependencies"}
      \`\`\`

      **Bad — relative paths (subagent will fail to find files):**
      \`\`\`json
      {"agentId": "system:explorer", "task": "Explore src/v1/graphs/ and src/v1/agents/ to find entity definitions.", "purpose": "Find entities"}
      \`\`\`

      **Bad — vague, missing context the parent already has:**
      \`\`\`json
      {"agentId": "system:simple", "task": "Fix the bug in the user service", "purpose": "Fix bug"}
      \`\`\`
    `;
  }

  public async invoke(
    args: SubagentsRunTaskToolSchemaType,
    config: SubagentsToolGroupConfig,
    runnableConfig: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<SubagentsRunTaskToolOutput>> {
    const title = this.generateTitle(args);

    const definition = this.subagentsService.getById(args.agentId);

    if (!definition) {
      return {
        output: {
          result: `Unknown agent ID "${args.agentId}"`,
          error: 'Invalid agentId',
        },
        messageMetadata: { __title: title },
      };
    }

    const { subAgent } = await this.prepareSubagent(
      definition,
      config,
      runnableConfig,
    );

    const loopResult = await subAgent.runSubagent(
      [new HumanMessage(args.task)],
      runnableConfig,
    );

    return this.buildResult(loopResult, title);
  }

  /**
   * Streaming invoke: yields intermediate BaseMessage[] chunks in real-time
   * as the subagent produces them. ToolExecutorNode emits each chunk via
   * caller_agent.emit() and collects them as additionalMessages for state.
   */
  public async *streamingInvoke(
    args: SubagentsRunTaskToolSchemaType,
    config: SubagentsToolGroupConfig,
    runnableConfig: ToolRunnableConfig<BaseAgentConfigurable>,
  ): ToolInvokeStream<SubagentsRunTaskToolOutput> {
    const title = this.generateTitle(args);

    const definition = this.subagentsService.getById(args.agentId);

    if (!definition) {
      return {
        output: {
          result: `Unknown agent ID "${args.agentId}"`,
          error: 'Invalid agentId',
        },
        messageMetadata: { __title: title },
      };
    }

    const { subAgent } = await this.prepareSubagent(
      definition,
      config,
      runnableConfig,
    );

    // Queue-based message forwarding from subagent events
    const messageQueue: BaseMessage[][] = [];
    let resolveWaiting: (() => void) | null = null;
    let runDone = false;

    const unsubscribe = subAgent.subscribe((event) => {
      if (event.type === 'message' && event.data.messages.length > 0) {
        messageQueue.push(event.data.messages);
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      } else if (event.type === 'stateUpdate') {
        // Forward live cost progress to the parent agent so the parent's
        // graph-state.manager.handleAgentStateUpdate can update the UI.
        // Re-key inFlightSubagentPrice with the parent's own __toolCallId
        // (the id for this subagents_run_task call) rather than any internal key.
        const rawToolCallId = runnableConfig.configurable?.__toolCallId;
        const parentToolCallId: string | undefined =
          typeof rawToolCallId === 'string' ? rawToolCallId : undefined;
        if (!parentToolCallId) {
          return Promise.resolve();
        }
        const callId: string = parentToolCallId;
        const subagentPrice = (
          event.data.stateChange as Record<string, unknown>
        ).inFlightSubagentPrice as Record<string, number> | undefined;
        const priceValues = subagentPrice ? Object.values(subagentPrice) : [];
        const totalPrice = priceValues.length > 0 ? priceValues[0] : undefined;
        if (totalPrice === undefined) {
          return Promise.resolve();
        }
        runnableConfig.configurable?.caller_agent?.emit({
          type: 'stateUpdate',
          data: {
            ...event.data,
            stateChange: {
              ...event.data.stateChange,
              inFlightSubagentPrice: { [callId]: totalPrice },
            },
          },
        });
      }
      return Promise.resolve();
    });

    try {
      const runPromise = subAgent
        .runSubagent([new HumanMessage(args.task)], runnableConfig)
        .then((result) => {
          runDone = true;
          if (resolveWaiting) {
            resolveWaiting();
            resolveWaiting = null;
          }
          return result;
        })
        .catch((err) => {
          // Mirror runDone for the queue waiter so the yield loop unblocks.
          runDone = true;
          if (resolveWaiting) {
            resolveWaiting();
            resolveWaiting = null;
          }
          throw err;
        });

      // Yield messages as they arrive until the run completes
      while (!runDone) {
        if (messageQueue.length > 0) {
          yield messageQueue.shift()!;
        } else {
          await new Promise<void>((r) => {
            resolveWaiting = r;
          });
        }
      }

      // Drain remaining messages
      while (messageQueue.length > 0) {
        yield messageQueue.shift()!;
      }

      const loopResult = await runPromise;

      return this.buildResult(loopResult, title);
    } catch (err) {
      // SubAgent.runSubagent has its own catch that returns a SubagentRunResult
      // with `error: <message>` for known failure modes (cost limit, recursion,
      // generic LLM/provider errors). If we still reach here, the throw escaped
      // that catch (e.g. graph-level abort, runtime cancellation, unhandled
      // rejection inside the LangGraph stream). Without this branch the
      // generator would unwind without a return value, leaving the upstream
      // tool message empty so the UI shows status=stopped with no errorText.
      const message = err instanceof Error ? err.message : String(err);
      const isAbort =
        (err instanceof Error && err.name === 'AbortError') ||
        message.toLowerCase().includes('abort');
      if (!isAbort) {
        this.logger.error(
          err instanceof Error ? err : new Error(message),
          `SubagentsRunTaskTool.streamingInvoke: ${message}`,
        );
      }
      return {
        output: isAbort
          ? { result: 'Subagent was aborted.' }
          : {
              result: `Subagent execution failed: ${message}`,
              error: message,
            },
        messageMetadata: { __title: title },
      };
    } finally {
      unsubscribe();
    }
  }

  private async prepareSubagent(
    definition: SubagentDefinition,
    config: SubagentsToolGroupConfig,
    runnableConfig: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<{ subAgent: SubAgent }> {
    // Resolve tools from toolSets using definition's toolIds
    const tools: BuiltAgentTool[] = [];
    if (!config.toolSets) {
      this.logger.warn(
        'SubagentsRunTaskTool: toolSets not configured — subagent will run without tools',
      );
    } else {
      for (const toolId of definition.toolIds) {
        const toolSet = config.toolSets.get(toolId);
        if (toolSet) {
          tools.push(...toolSet);
        } else {
          this.logger.warn(
            `SubagentsRunTaskTool: toolSet "${toolId}" not found in toolSets map — skipping`,
          );
        }
      }
    }

    const parentModel = this.getParentAgentModel(runnableConfig);
    const modelOverrideContext = runnableConfig.configurable?.llmRequestContext;
    const model = await definition.model({
      parentModel,
      llmModelsService: this.llmModelsService,
      modelOverrideContext,
    });

    // Build prompt context with workspace information
    const gitRepoPath = config.runtimeProvider
      ? await this.discoverGitRepoPath(config.runtimeProvider, runnableConfig)
      : undefined;

    const promptContext: SubagentPromptContext = {
      gitRepoPath,
      resourcesInformation: config.resourcesInformation,
    };
    const systemPrompt = definition.systemPrompt(promptContext);

    // Create fresh SubAgent instance per invocation.
    // strict: false — SubAgent is registered in AgentsModule, not AgentToolsModule.
    const subAgent = await this.moduleRef.resolve(SubAgent, undefined, {
      strict: false,
    });
    subAgent.setConfig({
      instructions: systemPrompt,
      invokeModelName: model,
      maxIterations: definition.maxIterations,
      ...(definition.maxContextTokens !== undefined
        ? { maxContextTokens: definition.maxContextTokens }
        : {}),
    });
    for (const tool of tools) {
      subAgent.addTool(tool);
    }

    return { subAgent };
  }

  private buildResult(
    loopResult: SubagentRunResult,
    title: string,
  ): ToolInvokeResult<SubagentsRunTaskToolOutput> {
    return {
      output: {
        result: loopResult.result,
        ...(loopResult.exploredFiles.length > 0
          ? { exploredFiles: loopResult.exploredFiles }
          : {}),
        statistics: loopResult.statistics,
        ...(loopResult.error ? { error: loopResult.error } : {}),
      },
      messageMetadata: { __title: title },
      toolRequestUsage: loopResult.statistics.usage ?? undefined,
      ...(loopResult.stopReason === 'cost_limit'
        ? {
            stopReason: 'cost_limit' as const,
            stopCostUsd: loopResult.stopCostUsd,
          }
        : {}),
    };
  }

  private getParentAgentModel(
    runnableConfig: ToolRunnableConfig<BaseAgentConfigurable>,
  ): string {
    const callerAgent = runnableConfig.configurable?.caller_agent;
    if (callerAgent) {
      const agentConfig = callerAgent.getConfig() as Record<string, unknown>;
      if (
        agentConfig &&
        typeof agentConfig.invokeModelName === 'string' &&
        agentConfig.invokeModelName.length > 0
      ) {
        return agentConfig.invokeModelName;
      }
    }
    return environment.llmLargeModel;
  }

  /**
   * Auto-detect the git repository under the runtime workspace.
   * Returns the repo root path or undefined if none is found.
   */
  private async discoverGitRepoPath(
    runtimeProvider: RuntimeThreadProvider,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<string | undefined> {
    try {
      const runtime = await runtimeProvider.provide(cfg);
      const res = await execRuntimeWithContext(
        runtime,
        {
          cmd: `find ${BASE_RUNTIME_WORKDIR} -maxdepth 2 -name .git -type d 2>/dev/null | head -1`,
        },
        cfg,
      );
      if (res.exitCode !== 0) {
        return undefined;
      }
      const gitDir = res.stdout.trim();
      if (!gitDir) {
        return undefined;
      }
      const repoRoot = gitDir.replace(/\/\.git$/, '');
      return repoRoot.length ? repoRoot : undefined;
    } catch {
      return undefined;
    }
  }
}
