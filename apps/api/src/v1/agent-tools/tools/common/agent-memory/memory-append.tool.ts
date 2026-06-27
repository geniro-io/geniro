import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import dedent from 'dedent';
import { z } from 'zod';

import {
  namespaceSchema,
  tagsSchema,
  titleSchema,
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

export const MemoryAppendToolSchema = z.object({
  namespace: namespaceSchema.describe(
    'Namespace for this log (e.g. "learnings", "progress"). Append entries accumulate under an auto-generated key.',
  ),
  title: titleSchema
    .optional()
    .describe('Short human-readable label shown in the memory index.'),
  value: z
    .unknown()
    .describe(
      'The content to append. A string or any JSON-serializable object. Serialized size must be <= 32 KB.',
    ),
  tags: tagsSchema
    .optional()
    .describe('Optional short labels to make the memory easier to find later.'),
});
export type MemoryAppendToolSchemaType = z.infer<typeof MemoryAppendToolSchema>;

@Injectable()
export class MemoryAppendTool extends AgentMemoryBaseTool<
  MemoryAppendToolSchemaType,
  AgentMemoryWriteOutput
> {
  public name = 'memory_append';
  public description =
    'Append an immutable entry to a durable, project-scoped memory log. ' +
    'Project memory persists across threads and sessions and is shared by every agent in the project. ' +
    'Append entries get an auto-generated key and cannot be overwritten or individually deleted (the oldest are ' +
    'pruned only when a capacity limit is exceeded), so use this for an accumulating record of learnings, ' +
    'findings, or progress that later sessions should be able to read back in order.';

  public get schema() {
    return MemoryAppendToolSchema;
  }

  protected override generateTitle(args: MemoryAppendToolSchemaType): string {
    return `Memory append: ${args.namespace}`;
  }

  public getDetailedInstructions(
    _config: AgentMemoryBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Adds an immutable entry to a durable project memory log under an auto-generated key.
      The log outlives this thread and is readable by any future agent run in the project.

      ### When to Use
      - Recording a new learning, finding, or progress note you never need to overwrite
      - Building a chronological record later sessions should read in order

      ### When NOT to Use
      - State you will update in place under a stable key -> use the overwritable save variant
      - Thread-only scratch data -> prefer the thread-local store

      ### Argument Tips
      - Group related entries under one namespace (e.g. "learnings") so they read as a single log.
      - Size limit: 32 KB per entry (serialized JSON).

      ### Example
      \`\`\`json
      {"namespace": "learnings", "title": "<short label>", "value": "<a project-specific learning worth remembering>", "tags": ["<topic>"]}
      \`\`\`
    `;
  }

  public async invoke(
    args: MemoryAppendToolSchemaType,
    config: AgentMemoryBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<AgentMemoryWriteOutput>> {
    this.assertWritable(config);
    const { userId, projectId, authorAgentId } = this.resolveContext(cfg);

    const { entry, embedUsage } =
      await this.agentMemoryService.appendForProject(userId, projectId, {
        namespace: args.namespace,
        title: args.title ?? null,
        value: args.value,
        authorAgentId,
        tags: args.tags ?? null,
      });

    // Attribute the embed-on-write (M2) token cost to this tool call so the
    // thread's totalPrice accounts for it. Undefined when no embed ran.
    return {
      output: { id: entry.id, namespace: entry.namespace, key: entry.key },
      ...(embedUsage ? { toolRequestUsage: embedUsage } : {}),
    };
  }
}
