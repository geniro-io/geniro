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
import { toEntryOutput } from './thread-store-tool-utils';
import { ThreadStoreEntryOutput } from './thread-store-tools.types';

export const ThreadStoreGetToolSchema = z.object({
  namespace: namespaceSchema.describe('Namespace the entry lives under.'),
  key: keySchema.describe(
    'Exact key to read. Use thread_store_list to discover keys.',
  ),
});
export type ThreadStoreGetToolSchemaType = z.infer<
  typeof ThreadStoreGetToolSchema
>;

export type ThreadStoreGetToolOutput = {
  found: boolean;
  entry?: ThreadStoreEntryOutput;
};

@Injectable()
export class ThreadStoreGetTool extends ThreadStoreBaseTool<
  ThreadStoreGetToolSchemaType,
  ThreadStoreGetToolOutput
> {
  public name = 'thread_store_get';
  public description =
    "Fetch a single entry from the current thread's shared store by namespace and key. " +
    'Returns the value plus metadata (author agent, timestamps, tags) or {found: false} when the key is absent. ' +
    'Use when you already know the exact key; use thread_store_list to discover what is available.';

  public get schema() {
    return ThreadStoreGetToolSchema;
  }

  protected override generateTitle(args: ThreadStoreGetToolSchemaType): string {
    return `Store get: ${args.namespace}/${args.key}`;
  }

  public getDetailedInstructions(
    _config: ThreadStoreBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Reads a single entry from the thread-shared store. Prefer this over thread_store_list
      when you know the exact key — it keeps your context window small.

      ### Example
      \`\`\`json
      {"namespace": "plan", "key": "root"}
      \`\`\`
    `;
  }

  public async invoke(
    args: ThreadStoreGetToolSchemaType,
    _config: ThreadStoreBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<ThreadStoreGetToolOutput>> {
    const { userId, projectId, internalThreadId } =
      await this.resolveContext(cfg);

    const entry = await this.threadStoreService.getForUser(
      userId,
      projectId,
      internalThreadId,
      args.namespace,
      args.key,
    );

    if (!entry) {
      return { output: { found: false } };
    }

    return { output: { found: true, entry: toEntryOutput(entry) } };
  }
}
