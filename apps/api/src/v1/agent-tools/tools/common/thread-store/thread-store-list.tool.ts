import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import dedent from 'dedent';
import { z } from 'zod';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import {
  namespaceSchema,
  NamespaceSummary,
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

export const ThreadStoreListToolSchema = z.object({
  namespace: namespaceSchema
    .optional()
    .describe(
      'When provided, list all entries in this namespace (newest first). ' +
        'When omitted, return a summary of all namespaces with their entry counts.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Max number of entries to return when namespace is provided. Defaults to 50.',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Number of entries to skip before returning results. Use with limit for pagination. Defaults to 0.',
    ),
});
export type ThreadStoreListToolSchemaType = z.infer<
  typeof ThreadStoreListToolSchema
>;

export type ThreadStoreListToolOutput = {
  namespaces?: NamespaceSummary[];
  entries?: ThreadStoreEntryOutput[];
  totalCount?: number;
  truncated?: boolean;
};

@Injectable()
export class ThreadStoreListTool extends ThreadStoreBaseTool<
  ThreadStoreListToolSchemaType,
  ThreadStoreListToolOutput
> {
  public name = 'thread_store_list';
  public description =
    "Discover what is in the current thread's shared store. " +
    'Without a namespace, returns a summary of every namespace with entry counts. ' +
    'With a namespace, returns the entries (oldest first for append-mode, newest first for kv-mode, capped by limit). ' +
    'Prefer thread_store_get when you already know the exact key -- listing everything wastes context.';

  public get schema() {
    return ThreadStoreListToolSchema;
  }

  protected override generateTitle(
    args: ThreadStoreListToolSchemaType,
  ): string {
    return args.namespace ? `Store list: ${args.namespace}` : 'Store list';
  }

  public getDetailedInstructions(
    _config: ThreadStoreBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Two modes:
      - **Summary mode (no namespace)**: returns \`namespaces: [{namespace, entryCount, lastUpdatedAt}, ...]\`.
        Use this as a cheap first call to see what's available.
      - **Entries mode (namespace provided)**: returns \`entries: [...]\` sorted by createdAt ASC for
        append-mode namespaces, DESC for kv-mode, along with \`totalCount\` and \`truncated\` to
        indicate whether more entries exist.

      ### Efficiency Rules
      - Do NOT list entries at the top of every turn — you'll blow up your context window.
      - Start with summary mode; only list a specific namespace when you actually need its contents.
      - If you know the key, call thread_store_get instead.
      - Use \`offset\` together with \`limit\` to paginate through large namespaces.

      ### Examples
      Summary: \`{}\`
      Entries: \`{"namespace": "learnings", "limit": 20}\`
      Paginated: \`{"namespace": "learnings", "limit": 20, "offset": 20}\`
    `;
  }

  public async invoke(
    args: ThreadStoreListToolSchemaType,
    _config: ThreadStoreBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<ThreadStoreListToolOutput>> {
    const { userId, projectId, internalThreadId } =
      await this.resolveContext(cfg);

    if (!args.namespace) {
      const namespaces = await this.threadStoreService.listNamespacesForUser(
        userId,
        projectId,
        internalThreadId,
      );
      return { output: { namespaces } };
    }

    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;

    const [entries, totalCount] = await Promise.all([
      this.threadStoreService.listEntriesForUser(
        userId,
        projectId,
        internalThreadId,
        args.namespace,
        { limit, offset },
      ),
      this.threadStoreService.countEntriesForUser(
        userId,
        projectId,
        internalThreadId,
        args.namespace,
      ),
    ]);

    const truncated = offset + entries.length < totalCount;

    return {
      output: {
        entries: entries.map(toEntryOutput),
        totalCount,
        truncated,
      },
    };
  }
}
