import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import dedent from 'dedent';
import { z } from 'zod';

import { environment } from '../../../../../environments';
import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import {
  ExtendedLangGraphRunnableConfig,
  ToolInvokeResult,
} from '../../base-tool';
import {
  AgentMemoryBaseTool,
  AgentMemoryBaseToolConfig,
} from './agent-memory-base.tool';
import { AgentMemorySearchOutput } from './agent-memory-tools.types';

export const MemorySearchToolSchema = z.object({
  query: z
    .string()
    .min(1)
    // Bounded to mirror the REST search DTO (agent-memory.dto.ts) so both read
    // entry points are capped — an unbounded query reaches the (fail-loud) embed
    // call and a value over the model's token limit would 400 the agent instead
    // of a graceful result.
    .max(2048)
    .describe(
      'Natural-language description of what you are trying to recall. Matched by meaning against stored memories, so phrase it as the idea you want, not an exact key.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(environment.agentMemorySearchMaxLimit)
    .optional()
    .describe(
      `Maximum number of matches to return (default ${environment.agentMemorySearchDefaultLimit}, max ${environment.agentMemorySearchMaxLimit}).`,
    ),
});
export type MemorySearchToolSchemaType = z.infer<typeof MemorySearchToolSchema>;

@Injectable()
export class MemorySearchTool extends AgentMemoryBaseTool<
  MemorySearchToolSchemaType,
  AgentMemorySearchOutput
> {
  public name = 'memory_search';
  public description =
    'Find durable project memories by meaning rather than by exact key. ' +
    'Embeds your query and returns the most semantically similar memories in the current project ' +
    '(namespace, key, and title only — no bodies). Use it when you know roughly what you are looking for ' +
    'but not the exact key; then call memory_get on a result to read its full value.';

  public get schema() {
    return MemorySearchToolSchema;
  }

  protected override generateTitle(args: MemorySearchToolSchemaType): string {
    return `Memory search: ${args.query}`;
  }

  public getDetailedInstructions(
    _config: AgentMemoryBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Semantic recall over the project's durable memory. Returns the closest matches by
      meaning (namespace + key + title, no bodies), scoped to the current project.

      ### When to Use
      - You remember the gist of a stored fact but not its exact namespace/key
      - The memory index (memory_list) is long and you want the entries relevant to a topic

      ### When NOT to Use
      - You already know the exact namespace + key -> call memory_get directly
      - You want the full list of everything stored -> use memory_list

      ### Argument Tips
      - Phrase the query as the concept you want to recall, in natural language.
      - Read a hit's full body with memory_get(namespace, key); search returns no values.
    `;
  }

  public async invoke(
    args: MemorySearchToolSchemaType,
    _config: AgentMemoryBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<AgentMemorySearchOutput>> {
    const { projectId } = this.resolveContext(cfg);
    const { entries, usage } = await this.agentMemoryService.searchForProject(
      projectId,
      args.query,
      args.limit ?? environment.agentMemorySearchDefaultLimit,
    );

    // Attribute the query-embedding (M2) token cost to this tool call. Undefined
    // when the embed produced no usage.
    return {
      output: {
        results: entries.map((entry) => ({
          namespace: entry.namespace,
          key: entry.key,
          title: entry.title,
        })),
      },
      ...(usage ? { toolRequestUsage: usage } : {}),
    };
  }
}
