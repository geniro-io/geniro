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
import { AgentMemoryDeleteOutput } from './agent-memory-tools.types';

export const MemoryDeleteToolSchema = z.object({
  namespace: namespaceSchema.describe('Namespace of the memory to delete.'),
  key: keySchema.describe('Key of the memory to delete within the namespace.'),
});
export type MemoryDeleteToolSchemaType = z.infer<typeof MemoryDeleteToolSchema>;

@Injectable()
export class MemoryDeleteTool extends AgentMemoryBaseTool<
  MemoryDeleteToolSchemaType,
  AgentMemoryDeleteOutput
> {
  public name = 'memory_delete';
  public description =
    'Delete a durable key/value memory from the current project by namespace and key. ' +
    'Only overwritable (saved) memories can be deleted; append-log entries are immutable. ' +
    'Deletion is shared-project-wide, so the entry disappears for every agent in the project.';

  public get schema() {
    return MemoryDeleteToolSchema;
  }

  protected override generateTitle(args: MemoryDeleteToolSchemaType): string {
    return `Memory delete: ${args.namespace}/${args.key}`;
  }

  public getDetailedInstructions(
    _config: AgentMemoryBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Removes one overwritable project memory. The change is visible to every agent in the project.

      ### When to Use
      - A saved memory is now wrong or obsolete and should not be recalled again

      ### When NOT to Use
      - To edit a value -> save over it with the same namespace + key instead
      - On append-log entries -> they are immutable and cannot be deleted
    `;
  }

  public async invoke(
    args: MemoryDeleteToolSchemaType,
    config: AgentMemoryBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<AgentMemoryDeleteOutput>> {
    this.assertWritable(config);
    const { projectId } = this.resolveContext(cfg);

    await this.agentMemoryService.deleteForProject(
      projectId,
      args.namespace,
      args.key,
    );

    return {
      output: { namespace: args.namespace, key: args.key, deleted: true },
    };
  }
}
