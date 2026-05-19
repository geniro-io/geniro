import { Injectable } from '@nestjs/common';
import dedent from 'dedent';

import {
  BuiltAgentTool,
  ExtendedLangGraphRunnableConfig,
} from '../../base-tool';
import { BaseToolGroup } from '../../base-tool-group';
import { ThreadStoreAppendTool } from './thread-store-append.tool';
import { ThreadStoreBaseToolConfig } from './thread-store-base.tool';
import { ThreadStoreDeleteTool } from './thread-store-delete.tool';
import { ThreadStoreGetTool } from './thread-store-get.tool';
import { ThreadStoreListTool } from './thread-store-list.tool';
import { ThreadStorePutTool } from './thread-store-put.tool';

@Injectable()
export class ThreadStoreToolGroup extends BaseToolGroup<ThreadStoreBaseToolConfig> {
  constructor(
    private readonly putTool: ThreadStorePutTool,
    private readonly appendTool: ThreadStoreAppendTool,
    private readonly getTool: ThreadStoreGetTool,
    private readonly listTool: ThreadStoreListTool,
    private readonly deleteTool: ThreadStoreDeleteTool,
  ) {
    super();
  }

  public getDetailedInstructions(
    config: ThreadStoreBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    const readOnlyNote = config.readOnly
      ? '\n\n⚠️ Read-only mode: thread_store_put / thread_store_append / thread_store_delete are disabled for this agent.'
      : '';

    return dedent`
      ## Thread Store (shared memory for this thread)

      Every agent that runs on the current thread — the root agent and every subagent — shares
      the same key-value + append-only store. Use it to coordinate across agent steps and
      subagent delegations instead of trying to squeeze everything through tool return values.

      ### When to Use
      - You want a plan or todo that subsequent agent turns can update
      - You discover a fact that later agents should build on (e.g. "repo uses pnpm, not npm")
      - You want to leave structured notes for a sibling subagent
      - You need to hand off partial results between spawning agents without polluting the chat log

      ### When NOT to Use
      - Ephemeral scratch data that dies after one tool call — keep it in memory
      - The final answer the user expects — return it in your message, not the store
      - Huge payloads (>32 KB serialized JSON per entry) — summarize first

      ### Modes
      - \`thread_store_put\` → upsertable KV. Overwrites previous values at the same key.
      - \`thread_store_append\` → immutable log. Auto-generated key, newest first on list.
      - \`thread_store_get\` / \`thread_store_list\` → read. Prefer \`get\` when the key is known.
      - \`thread_store_delete\` → remove a KV entry (append entries are immutable).

      ### Suggested Namespaces (freeform, not enforced)
      - \`plan\` — current plan, overwritable (use \`put\`)
      - \`todo\` — todo items keyed by slug (use \`put\`)
      - \`learnings\` — immutable lessons (use \`append\`)
      - \`reports\` — intermediate findings / reports (use \`append\`)
      - \`decisions\` — irreversible decisions with rationale (use \`append\`)

      ### Anti-patterns
      - ❌ Listing every namespace at the top of every turn. Use summary mode once, then \`get\`.
      - ❌ Storing the full tool output (files, logs) — summarize to a few hundred bytes.
      - ❌ Duplicating entries because you forgot a previous key. Prefer predictable key names.

      ### Limits
      - 32 KB per entry (serialized JSON).
      - 500 entries per \`(thread, namespace)\`. Delete or rotate when the namespace fills up.${readOnlyNote}
    `;
  }

  protected buildToolsInternal(
    config: ThreadStoreBaseToolConfig,
    lgConfig?: ExtendedLangGraphRunnableConfig,
  ): BuiltAgentTool[] {
    const tools: BuiltAgentTool[] = [
      this.getTool.build(config, lgConfig),
      this.listTool.build(config, lgConfig),
    ];

    if (!config.readOnly) {
      tools.push(
        this.putTool.build(config, lgConfig),
        this.appendTool.build(config, lgConfig),
        this.deleteTool.build(config, lgConfig),
      );
    }

    return tools;
  }
}
