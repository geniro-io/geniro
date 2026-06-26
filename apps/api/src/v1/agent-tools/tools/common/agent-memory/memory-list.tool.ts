import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import dedent from 'dedent';
import { z } from 'zod';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import {
  ExtendedLangGraphRunnableConfig,
  ToolInvokeResult,
} from '../../base-tool';
import {
  AgentMemoryBaseTool,
  AgentMemoryBaseToolConfig,
} from './agent-memory-base.tool';
import { AgentMemoryListOutput } from './agent-memory-tools.types';

const DEFAULT_INDEX_LIMIT = 100;
const MAX_INDEX_LIMIT = 500;

export const MemoryListToolSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_INDEX_LIMIT)
    .optional()
    .describe(
      `Maximum number of index rows to return, most-recently-updated first. Defaults to ${DEFAULT_INDEX_LIMIT}.`,
    ),
});
export type MemoryListToolSchemaType = z.infer<typeof MemoryListToolSchema>;

@Injectable()
export class MemoryListTool extends AgentMemoryBaseTool<
  MemoryListToolSchemaType,
  AgentMemoryListOutput
> {
  public name = 'memory_list';
  public description =
    "Return the current project's memory index: the namespace, key, title, mode, and tags of each durable memory, " +
    'newest first, WITHOUT the full bodies. This is a live read, so it always reflects what is stored right now. ' +
    'Call it at the start of a task to discover what the project already knows, then fetch the entries you need in full.';

  public get schema() {
    return MemoryListToolSchema;
  }

  protected override generateTitle(): string {
    return 'Memory list';
  }

  public getDetailedInstructions(
    _config: AgentMemoryBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Returns a compact, always-fresh index of the project's durable memory — one row per entry
      with its namespace, key, title, mode, and tags, but not the body. This is the map of what
      the project remembers.

      ### When to Use
      - At the start of a task, to see what the project already knows before doing redundant work
      - To find which namespaces + keys exist so you can fetch the relevant ones in full

      ### Workflow
      1. Call this to load the current index.
      2. Identify the entries whose titles/tags look relevant.
      3. Fetch those entries' full bodies one by one.

      ### Notes
      - The index is read live, so it reflects memories written in earlier (and the current) sessions.
      - Bodies are omitted to keep the index small; fetch them only when needed.
    `;
  }

  public async invoke(
    args: MemoryListToolSchemaType,
    _config: AgentMemoryBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<AgentMemoryListOutput>> {
    const { projectId } = this.resolveContext(cfg);
    const limit = args.limit ?? DEFAULT_INDEX_LIMIT;
    const rows = await this.agentMemoryService.getIndexForProject(
      projectId,
      limit,
    );
    return {
      output: {
        entries: rows.map((row) => ({
          namespace: row.namespace,
          key: row.key,
          title: row.title,
          mode: row.mode,
          tags: row.tags,
          updatedAt: row.updatedAt,
        })),
      },
    };
  }
}
