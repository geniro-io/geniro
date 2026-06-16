import { Injectable } from '@nestjs/common';
import dedent from 'dedent';

import {
  BuiltAgentTool,
  ExtendedLangGraphRunnableConfig,
} from '../../base-tool';
import { BaseToolGroup } from '../../base-tool-group';
import { SubagentsToolGroupConfig } from './subagents.types';
import { SubagentsListTool } from './subagents-list.tool';
import { SubagentsRunTaskTool } from './subagents-run-task.tool';

@Injectable()
export class SubagentsToolGroup extends BaseToolGroup<SubagentsToolGroupConfig> {
  constructor(
    private readonly subagentsListTool: SubagentsListTool,
    private readonly subagentsRunTaskTool: SubagentsRunTaskTool,
  ) {
    super();
  }

  protected buildToolsInternal(
    config: SubagentsToolGroupConfig,
    lgConfig?: ExtendedLangGraphRunnableConfig,
  ): BuiltAgentTool[] {
    return [
      this.subagentsListTool.build(config, lgConfig),
      this.subagentsRunTaskTool.build(config, lgConfig),
    ];
  }

  public getDetailedInstructions(): string {
    return dedent`
      ### Subagents — Smart Delegation for Token Efficiency
      Subagents are autonomous agents that run in their own context window.
      Each subagent runs independently, processes potentially large outputs internally, and returns only a concise summary to you.
      Using subagents effectively saves your main context window for the work that matters most.

      ### ⚠️ CRITICAL: Use Subagents for Research-Heavy Tasks
      **If your task is primarily research, exploration, or understanding code — you MUST delegate to subagents.**
      Do NOT perform broad exploration yourself using repeated codebase_search / files_read calls.
      Every search result and file you read directly grows your context linearly and wastes tokens.

      **Rule of thumb:** If you need to explore more than 3-5 files or search more than 2-3 areas, use subagent explorers.

      **Example — BAD (agent explores directly, context grows to 130K+ tokens):**
      Turn 1: codebase_search("graph compiler") → read results (context: 25K)
      Turn 2: files_read(graph-compiler.ts) → (context: 50K)
      Turn 3: codebase_search("runtime provider") → (context: 65K)
      Turn 4: files_read(runtime-provider.ts) → (context: 85K)
      ... 35 more turns → (context: 130K, $0.96 wasted)

      **Example — GOOD (agent delegates research, stays lean):**
      Turn 1: Spawn 3-4 parallel explorer subagents covering different areas
      Turn 2: Receive concise summaries → context stays at ~20K
      Turn 3: Synthesize findings and produce the deliverable

      ### Your Role vs. Subagent Roles
      **You are the architect and implementer.** You own the core task: understanding the user's goal, planning the approach, and implementing the main feature or fix.
      **Subagents are your assistants.** They gather information, run commands, and handle small isolated changes.

      ### When to Delegate
      Use subagents for tasks that would waste your context with verbose output:
      - **Broad research / exploration**: Understanding architecture, mapping modules, investigating how things work → spawn MULTIPLE "system:explorer" in PARALLEL
      - **Reading multiple files**: When you need to review 3+ files to understand a pattern → "system:explorer"
      - **Search tasks**: Finding usages, tracing imports, locating definitions across the codebase → "system:explorer"
      - **Architectural analysis / specs**: When you need to understand multiple modules to produce a design document → delegate exploration, synthesize yourself
      - **Running commands**: Lint, test, build, install (output can be large) → "system:simple"
      - **Small isolated edits**: Quick fixes in files you don't need to see in your context → "system:simple"
      - **Independent subtasks**: Well-defined work that doesn't need your ongoing oversight → "system:smart"

      ### When NOT to Delegate
      Do NOT use subagents in these situations — do the work yourself:
      - **You need to read 1-2 specific files** and you know the paths — just use \`files_read\` directly
      - **You are searching within a specific file or 2-3 files** — use \`files_search_text\` directly
      - **You already have the context** — if file contents are in your context from a previous step, just use them
      - **Iterating on a change** — if you're tweaking code based on errors or feedback, do it yourself

      ### CRITICAL: Always Parallelize Independent Tasks
      You can call \`subagents_run_task\` **multiple times in a single response** — all calls run simultaneously.
      **NEVER call subagents one after another if they don't depend on each other's output.**
      Sequential subagent calls when parallel is possible wastes enormous time — each subagent takes 1-3 minutes.

      **Before spawning subagents, plan ALL your information needs first, then batch them into ONE parallel call.**

      Examples of what to parallelize (must be in a single response):
      - Need to understand module A and module B → spawn 2 explorers in parallel
      - Need to gather info from different areas of the codebase → spawn multiple explorers in parallel
      - Need to run tests AND lint → spawn 2 simple agents in parallel
      - Need to explore architecture of 4 modules → spawn 4 explorers in parallel, not 4 sequential calls

      Only run sequentially when task B genuinely depends on the output of task A.

      ### Choosing the Right Subagent
      - **"system:explorer"** — READ-ONLY, fast model. Best for investigation, research, and understanding tasks. Cheap and safe.
      - **"system:simple"** — FULL ACCESS, small fast model, tiny 70k context. For quick well-defined tasks: small edits, running a command, renaming, adding an import.
      - **"system:smart"** — FULL ACCESS, same large model as you. For complex subtasks requiring strong reasoning. Use sparingly — it's expensive and uses the same model as you.

      ### Context Is Everything — Give Subagents Maximum Context
      Subagents start with a BLANK context window. They know NOTHING about the project, the user's request, or what you have already discovered.
      **Every piece of context you omit forces the subagent to waste tokens rediscovering it — or worse, to guess wrong and produce incorrect results.**

      Always include in the task description:
      - **What you already know**: file paths, function/class names, module structure, patterns, error messages, code snippets
      - **What the user wants**: the original goal, acceptance criteria, constraints, preferences
      - **Where to look**: specific directories, file paths — never say "find the file" if you already know the path
      - **What you've already tried**: if a previous approach failed, explain what and why
      - **Expected output format**: what information you need back and in what structure

      Think of it this way: **if you know something relevant, include it.** Extra context is cheap (subagent's context is isolated). Missing context is expensive (wrong results, wasted tokens).

      ### Workflow
      1. Call \`subagents_list\` once at the start to see available subagent types.
      2. **Plan all information needs upfront.** Identify all areas you need to explore.
      3. **Spawn all independent explorers in a single parallel batch.** Do NOT chain them sequentially.
      4. Use the gathered information to implement the main task yourself.
      5. Delegate follow-up tasks (tests, lint, small fixes) in another parallel batch if needed.
    `;
  }
}
