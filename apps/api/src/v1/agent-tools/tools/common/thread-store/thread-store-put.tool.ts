import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import dedent from 'dedent';
import { z } from 'zod';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import {
  keySchema,
  namespaceSchema,
} from '../../../../thread-store/dto/thread-store.dto';
import {
  ExtendedLangGraphRunnableConfig,
  ToolInvokeResult,
} from '../../base-tool';
import {
  ThreadStoreBaseTool,
  ThreadStoreBaseToolConfig,
} from './thread-store-base.tool';

export const ThreadStorePutToolSchema = z.object({
  namespace: namespaceSchema.describe(
    'Namespace that groups related entries (e.g. "todo", "plan", "decisions"). ' +
      'Use conventional names so other agents on this thread can find your entries.',
  ),
  key: keySchema.describe(
    'Stable key for this entry inside the namespace. Writing the same key again overwrites the previous value.',
  ),
  value: z
    .unknown()
    .describe(
      'The value to store. May be a string or any JSON-serializable object. Serialized size must be <= 32 KB.',
    ),
  tags: z
    .array(z.string().min(1).max(64))
    .max(16)
    .optional()
    .describe(
      'Optional short labels to help downstream agents filter (e.g. ["plan", "critical"]).',
    ),
});
export type ThreadStorePutToolSchemaType = z.infer<
  typeof ThreadStorePutToolSchema
>;

export type ThreadStorePutToolOutput = {
  id: string;
  namespace: string;
  key: string;
};

@Injectable()
export class ThreadStorePutTool extends ThreadStoreBaseTool<
  ThreadStorePutToolSchemaType,
  ThreadStorePutToolOutput
> {
  public name = 'thread_store_put';
  public description =
    "Write (upsert) a named key/value entry into the current thread's shared store. " +
    'Entries are visible to the parent agent and every subagent that runs in the same thread. ' +
    'Use this for state that needs a stable key you can overwrite later (plans, todo items, decisions). ' +
    'For immutable log entries (learnings, findings), use thread_store_append instead.';

  public get schema() {
    return ThreadStorePutToolSchema;
  }

  protected override generateTitle(args: ThreadStorePutToolSchemaType): string {
    return `Store put: ${args.namespace}/${args.key}`;
  }

  public getDetailedInstructions(
    _config: ThreadStoreBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Upserts a key-value entry into the current thread's shared store. All agents in the thread
      (parent + subagents) can read it back via thread_store_get / thread_store_list.

      ### When to Use
      - You need to record state that another agent step should be able to look up later by a stable key
      - You're updating an existing planning/todo item in place
      - You want to overwrite previous content under the same key

      ### When NOT to Use
      - Recording a new learning or progress note → use thread_store_append (immutable log)
      - Temporary scratch data only used within a single tool call → keep it in memory

      ### Argument Tips
      - Choose short, predictable keys so peers can guess them (e.g. "plan", "current_step", "next_task").
      - Pass structured JSON (object/array) when it helps; strings are fine for short notes.
      - Size limit: 32 KB per entry (serialized JSON). 500 entries per namespace.

      ### Example
      \`\`\`json
      {"namespace": "plan", "key": "root", "value": {"goal": "refactor auth", "steps": ["audit", "rename", "tests"]}, "tags": ["plan"]}
      \`\`\`
    `;
  }

  public async invoke(
    args: ThreadStorePutToolSchemaType,
    config: ThreadStoreBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<ThreadStorePutToolOutput>> {
    this.assertWritable(config);
    const { userId, projectId, internalThreadId, authorAgentId } =
      await this.resolveContext(cfg);

    const entry = await this.threadStoreService.putForUser(
      userId,
      projectId,
      internalThreadId,
      {
        namespace: args.namespace,
        key: args.key,
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
