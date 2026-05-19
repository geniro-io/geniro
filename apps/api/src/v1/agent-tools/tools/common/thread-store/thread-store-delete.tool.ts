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

export const ThreadStoreDeleteToolSchema = z.object({
  namespace: namespaceSchema.describe('Namespace the entry lives under.'),
  key: keySchema.describe(
    'Key of the KV entry to delete. Append-only entries cannot be deleted.',
  ),
});
export type ThreadStoreDeleteToolSchemaType = z.infer<
  typeof ThreadStoreDeleteToolSchema
>;

export type ThreadStoreDeleteToolOutput = {
  success: boolean;
};

@Injectable()
export class ThreadStoreDeleteTool extends ThreadStoreBaseTool<
  ThreadStoreDeleteToolSchemaType,
  ThreadStoreDeleteToolOutput
> {
  public name = 'thread_store_delete';
  public description =
    "Delete a KV entry from the current thread's shared store. " +
    'Only entries written with thread_store_put can be deleted; append entries are immutable.';

  public get schema() {
    return ThreadStoreDeleteToolSchema;
  }

  protected override generateTitle(
    args: ThreadStoreDeleteToolSchemaType,
  ): string {
    return `Store delete: ${args.namespace}/${args.key}`;
  }

  public getDetailedInstructions(
    _config: ThreadStoreBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Removes a KV entry. Append entries (created by thread_store_append) are immutable — use
      an append with a status update (e.g. "retracted") instead of deletion for those.

      ### Example
      \`\`\`json
      {"namespace": "todo", "key": "verify-migration"}
      \`\`\`
    `;
  }

  public async invoke(
    args: ThreadStoreDeleteToolSchemaType,
    config: ThreadStoreBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<ThreadStoreDeleteToolOutput>> {
    this.assertWritable(config);
    const { userId, projectId, internalThreadId } =
      await this.resolveContext(cfg);

    await this.threadStoreService.deleteForUser(
      userId,
      projectId,
      internalThreadId,
      args.namespace,
      args.key,
    );

    return { output: { success: true } };
  }
}
