import { Injectable } from '@nestjs/common';

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

  // No group-level getDetailedInstructions: BaseToolGroup makes it optional, and
  // neither consumer reads result.instructions (SimpleAgent omits it; ClaudeAgent
  // spreads only result.tools). Per-tool getDetailedInstructions() is the live
  // path that actually reaches a model — see the "no system-prompt snapshot"
  // design (memory_list is the live index, not a baked overview).

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
