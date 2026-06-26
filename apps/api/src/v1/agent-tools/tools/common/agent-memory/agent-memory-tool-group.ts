import { Injectable } from '@nestjs/common';
import dedent from 'dedent';

import {
  BuiltAgentTool,
  ExtendedLangGraphRunnableConfig,
} from '../../base-tool';
import { BaseToolGroup } from '../../base-tool-group';
import { AgentMemoryBaseToolConfig } from './agent-memory-base.tool';
import { MemoryAppendTool } from './memory-append.tool';
import { MemoryDeleteTool } from './memory-delete.tool';
import { MemoryGetTool } from './memory-get.tool';
import { MemoryListTool } from './memory-list.tool';
import { MemorySaveTool } from './memory-save.tool';

@Injectable()
export class AgentMemoryToolGroup extends BaseToolGroup<AgentMemoryBaseToolConfig> {
  constructor(
    private readonly saveTool: MemorySaveTool,
    private readonly appendTool: MemoryAppendTool,
    private readonly getTool: MemoryGetTool,
    private readonly listTool: MemoryListTool,
    private readonly deleteTool: MemoryDeleteTool,
  ) {
    super();
  }

  public getDetailedInstructions(
    config: AgentMemoryBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    const readOnlyNote = config.readOnly
      ? '\n\n⚠️ Read-only mode: memory_save / memory_append / memory_delete are disabled for this agent.'
      : '';

    return dedent`
      ## Project Memory (durable, shared across sessions)

      Project memory is a key-value + append-only store scoped to the current project. Unlike the
      thread-local store, it persists across threads and sessions and is shared by every agent in the
      project — so it is where long-lived knowledge accumulates.

      ### Start every non-trivial task by listing the index
      Call \`memory_list\` first. It returns an always-fresh map (namespace/key/title/tags, no bodies)
      of everything the project remembers. Use it to avoid re-deriving facts the project already knows,
      then fetch the relevant entries in full before doing redundant work.

      ### When to Use
      - You learned a project-level fact, convention, or decision worth keeping for future sessions
      - You want to check what the project already knows before starting

      ### When NOT to Use
      - State that only matters within the current thread -> use the thread-local store
      - The final answer for the user -> return it in your message, not memory

      ### Modes
      - \`memory_save\` -> overwritable key-value memory. Save the same key again to update it.
      - \`memory_append\` -> immutable log entry (auto-generated key) for accumulating learnings.
      - \`memory_list\` / \`memory_get\` -> read. List the index first, then get bodies you need.
      - \`memory_delete\` -> remove an overwritable memory (append entries are immutable).

      ### Suggested Namespaces (freeform, not enforced)
      - \`conventions\` — durable project conventions (use save)
      - \`decisions\` — irreversible decisions with rationale (use append)
      - \`facts\` — stable facts about the project (use save)
      - \`learnings\` — accumulating lessons (use append)

      ### Limits
      - 32 KB per memory (serialized JSON).
      - Oldest memories are pruned automatically when a namespace or the project exceeds its cap.${readOnlyNote}
    `;
  }

  protected buildToolsInternal(
    config: AgentMemoryBaseToolConfig,
    lgConfig?: ExtendedLangGraphRunnableConfig,
  ): BuiltAgentTool[] {
    const tools: BuiltAgentTool[] = [
      this.getTool.build(config, lgConfig),
      this.listTool.build(config, lgConfig),
    ];

    if (!config.readOnly) {
      tools.push(
        this.saveTool.build(config, lgConfig),
        this.appendTool.build(config, lgConfig),
        this.deleteTool.build(config, lgConfig),
      );
    }

    return tools;
  }
}
