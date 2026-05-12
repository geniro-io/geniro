import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import dedent from 'dedent';
import { z } from 'zod';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { namespaceSchema } from '../../../../thread-store/dto/thread-store.dto';
import {
  ExtendedLangGraphRunnableConfig,
  ToolInvokeResult,
} from '../../base-tool';
import {
  ThreadStoreBaseTool,
  ThreadStoreBaseToolConfig,
} from './thread-store-base.tool';

export const ThreadStoreAppendToolSchema = z.object({
  namespace: namespaceSchema.describe(
    'Namespace that groups related log entries (e.g. "learnings", "reports", "progress").',
  ),
  value: z
    .unknown()
    .describe(
      'The entry to append. May be a string or any JSON-serializable object. Serialized size must be <= 32 KB.',
    ),
  tags: z
    .array(z.string().min(1).max(64))
    .max(16)
    .optional()
    .describe(
      'Optional short labels to help downstream agents filter (e.g. ["test-failure", "fix-applied"]).',
    ),
});
export type ThreadStoreAppendToolSchemaType = z.infer<
  typeof ThreadStoreAppendToolSchema
>;

export type ThreadStoreAppendToolOutput = {
  id: string;
  namespace: string;
  key: string;
};

@Injectable()
export class ThreadStoreAppendTool extends ThreadStoreBaseTool<
  ThreadStoreAppendToolSchemaType,
  ThreadStoreAppendToolOutput
> {
  public name = 'thread_store_append';
  public description =
    "Append an immutable log entry into the current thread's shared store under the given namespace. " +
    'Each append gets an auto-generated key and cannot be overwritten or deleted. ' +
    'Use this for learnings, findings, progress notes, and reports that other agents should see in order. ' +
    'For overwritable state (plans, todo items), use thread_store_put instead.';

  public get schema() {
    return ThreadStoreAppendToolSchema;
  }

  protected override generateTitle(
    args: ThreadStoreAppendToolSchemaType,
  ): string {
    return `Store append: ${args.namespace}`;
  }

  public getDetailedInstructions(
    _config: ThreadStoreBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Appends an immutable entry (with an auto-generated timestamp-based key) into the current
      thread's shared store. All agents in the thread can read it back via thread_store_list.

      ### When to Use
      - Recording a new learning that future agents should build on
      - Posting a progress report or intermediate finding
      - Keeping an ordered event log inside a namespace (newest entries first when listed)

      ### When NOT to Use
      - State you'll need to overwrite later → use thread_store_put with a stable key
      - Data that's only meaningful within a single tool call → keep it in memory

      ### Argument Tips
      - Keep entries self-contained: a reader will see just this entry, not the conversation.
      - Use tags to help filtering (e.g. ["blocker"], ["decision"]).
      - Size limit: 32 KB per entry. 500 entries per namespace.

      ### Example
      \`\`\`json
      {"namespace": "learnings", "value": "The build script requires NODE_OPTIONS=--max-old-space-size=4096 to complete.", "tags": ["build", "ops"]}
      \`\`\`
    `;
  }

  public async invoke(
    args: ThreadStoreAppendToolSchemaType,
    config: ThreadStoreBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<ThreadStoreAppendToolOutput>> {
    this.assertWritable(config);
    const { userId, projectId, internalThreadId, authorAgentId } =
      await this.resolveContext(cfg);

    const entry = await this.threadStoreService.appendForUser(
      userId,
      projectId,
      internalThreadId,
      {
        namespace: args.namespace,
        value: args.value,
        authorAgentId,
        tags: args.tags,
      },
    );

    return {
      output: {
        id: entry.id,
        namespace: entry.namespace,
        key: entry.key,
      },
    };
  }
}
