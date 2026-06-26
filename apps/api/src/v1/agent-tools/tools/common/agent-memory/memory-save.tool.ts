import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import dedent from 'dedent';
import { z } from 'zod';

import {
  keySchema,
  namespaceSchema,
} from '../../../../agent-memory/dto/agent-memory.dto';
import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import {
  ExtendedLangGraphRunnableConfig,
  ToolInvokeResult,
} from '../../base-tool';
import {
  AgentMemoryBaseTool,
  AgentMemoryBaseToolConfig,
} from './agent-memory-base.tool';
import { AgentMemoryWriteOutput } from './agent-memory-tools.types';

export const MemorySaveToolSchema = z.object({
  namespace: namespaceSchema.describe(
    'Namespace that groups related memories (e.g. "conventions", "decisions", "facts"). Use stable, conventional names so future sessions and other agents find them.',
  ),
  key: keySchema.describe(
    'Stable key for this memory inside the namespace. Saving the same key again overwrites the previous value.',
  ),
  title: z
    .string()
    .max(256)
    .optional()
    .describe(
      'Short human-readable label shown in the memory index (memory_list) so it is recognizable without fetching the full body.',
    ),
  value: z
    .unknown()
    .describe(
      'The content to remember. A string or any JSON-serializable object. Serialized size must be <= 32 KB.',
    ),
  tags: z
    .array(z.string().min(1).max(64))
    .max(16)
    .optional()
    .describe('Optional short labels to make the memory easier to find later.'),
});
export type MemorySaveToolSchemaType = z.infer<typeof MemorySaveToolSchema>;

@Injectable()
export class MemorySaveTool extends AgentMemoryBaseTool<
  MemorySaveToolSchemaType,
  AgentMemoryWriteOutput
> {
  public name = 'memory_save';
  public description =
    'Save a durable, overwritable key/value memory scoped to the current project. ' +
    'Project memory persists across threads and sessions and is shared by every agent in the project, ' +
    'so use it to remember facts, conventions, and decisions that should survive beyond the current run. ' +
    'Writing the same namespace+key again overwrites the prior value.';

  public get schema() {
    return MemorySaveToolSchema;
  }

  protected override generateTitle(args: MemorySaveToolSchemaType): string {
    return `Memory save: ${args.namespace}/${args.key}`;
  }

  public getDetailedInstructions(
    _config: AgentMemoryBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Upserts a durable key-value memory for the current project. The memory outlives this
      thread and is readable by any future agent run in the same project.

      ### When to Use
      - You learned a project-level fact worth keeping (a convention, a config detail, a decision)
      - You want to update an existing remembered value in place under a stable key

      ### When NOT to Use
      - Information that only matters within the current thread -> prefer the thread-local store
      - A growing log of events you never overwrite -> use the append variant instead

      ### Argument Tips
      - Pick short, predictable namespaces + keys so future sessions can find them.
      - Set a concise title so the entry is recognizable in the memory index without opening it.
      - Size limit: 32 KB per memory (serialized JSON).

      ### Example
      \`\`\`json
      {"namespace": "conventions", "key": "package-manager", "title": "Package manager", "value": "Repo uses pnpm, never npm.", "tags": ["build"]}
      \`\`\`
    `;
  }

  public async invoke(
    args: MemorySaveToolSchemaType,
    config: AgentMemoryBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<AgentMemoryWriteOutput>> {
    this.assertWritable(config);
    const { userId, projectId, authorAgentId } = this.resolveContext(cfg);

    const entry = await this.agentMemoryService.putForProject(
      userId,
      projectId,
      {
        namespace: args.namespace,
        key: args.key,
        title: args.title ?? null,
        value: args.value,
        authorAgentId,
        tags: args.tags ?? null,
      },
    );

    return {
      output: { id: entry.id, namespace: entry.namespace, key: entry.key },
    };
  }
}
