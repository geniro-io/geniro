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
import { AgentMemoryEntryOutput } from './agent-memory-tools.types';

export const MemoryGetToolSchema = z.object({
  namespace: namespaceSchema.describe('Namespace of the memory to fetch.'),
  key: keySchema.describe('Key of the memory to fetch within the namespace.'),
});
export type MemoryGetToolSchemaType = z.infer<typeof MemoryGetToolSchema>;

@Injectable()
export class MemoryGetTool extends AgentMemoryBaseTool<
  MemoryGetToolSchemaType,
  AgentMemoryEntryOutput | null
> {
  public name = 'memory_get';
  public description =
    'Fetch the full content of one durable project memory by namespace and key. ' +
    'Use this after the memory index (from memory_list) tells you a relevant entry exists, ' +
    'to read its complete value. Returns null when no such memory exists.';

  public get schema() {
    return MemoryGetToolSchema;
  }

  protected override generateTitle(args: MemoryGetToolSchemaType): string {
    return `Memory get: ${args.namespace}/${args.key}`;
  }

  public getDetailedInstructions(
    _config: AgentMemoryBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Returns the full stored value for one project memory, or null if it does not exist.

      ### When to Use
      - The memory index showed an entry whose body you now need
      - You know the exact namespace + key of a memory to read

      ### Argument Tips
      - List the index first if you are unsure which keys exist; do not guess repeatedly.
    `;
  }

  public async invoke(
    args: MemoryGetToolSchemaType,
    _config: AgentMemoryBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<AgentMemoryEntryOutput | null>> {
    const { projectId } = this.resolveContext(cfg);
    const entry = await this.agentMemoryService.getForProject(
      projectId,
      args.namespace,
      args.key,
    );
    return {
      output: entry
        ? {
            namespace: entry.namespace,
            key: entry.key,
            title: entry.title,
            value: entry.value,
            mode: entry.mode,
            authorAgentId: entry.authorAgentId,
            tags: entry.tags,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          }
        : null,
    };
  }
}
