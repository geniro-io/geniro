import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { DefaultLogger } from '@packages/common';

import {
  RequestTokenUsage,
  UsageMetadata,
} from '../../../litellm/litellm.types';
import { LitellmService } from '../../../litellm/services/litellm.service';
import {
  BaseAgentConfigurable,
  BaseAgentState,
  BaseAgentStateChange,
  LLMRequestContext,
} from '../../agents.types';
import {
  extractTextFromResponseContent,
  filterMessagesForLlm,
  markMessageHideForLlm,
  updateMessagesListWithMetadata,
} from '../../agents.utils';
import { BaseNode } from './base-node';

type SummarizeOpts = {
  keepTokens: number;
  maxTokens: number;
  /**
   * The model whose tokenizer should be used for budgeting (summary + tail).
   * This should match the model used by the main invoke node, not the summarizer model.
   */
  tokenCountModel: string;
  systemNote?: string;
};

export class SummarizeNode extends BaseNode<
  BaseAgentState,
  BaseAgentStateChange
> {
  constructor(
    private readonly litellmService: LitellmService,
    private llmResolver: (
      currentContext?: number,
      llmRequestContext?: LLMRequestContext,
    ) => ChatOpenAI,
    private opts: SummarizeOpts,
    private readonly logger?: DefaultLogger,
  ) {
    super();
  }

  async invoke(
    state: BaseAgentState,
    cfg: LangGraphRunnableConfig<BaseAgentConfigurable>,
  ): Promise<BaseAgentStateChange> {
    const { maxTokens, keepTokens } = this.opts;
    if (maxTokens <= 0) {
      return {};
    }

    // Estimate the effective context size for the NEXT LLM call.
    //
    // `state.currentContext` is the provider-reported input token count from the
    // last LLM invocation. However, new messages may have been added since then
    // (tool results, inter-agent communication messages, injected pending messages).
    // These aren't reflected in `currentContext` and can push the actual prompt
    // over the limit, causing a 400 "prompt too long" error.
    //
    // We estimate the token cost of messages added after the last LLM response
    // and add them to `currentContext` for a more accurate threshold check.
    const estimatedContext = await this.estimateEffectiveContext(state);
    if (estimatedContext <= maxTokens) {
      return {};
    }

    // Step 1: Integrity checks (guard rails)
    // Detect pending tool calls - never summarize if tools are in flight
    if (this.hasPendingToolCalls(state.messages)) {
      return {};
    }

    // Build LLM-visible history:
    // - keep system messages as-is (never fold them)
    // - remove hidden-for-LLM messages
    // - remove dangling tool-call traces
    const promptVisibleRaw = filterMessagesForLlm(state.messages);

    // Drop transient/internal messages from compaction so they don't get pinned forever.
    const promptVisible = promptVisibleRaw.filter((m) => {
      const kw = m.additional_kwargs as unknown as Record<string, unknown>;
      return kw.__hideForSummary !== true && kw.hideForSummary !== true;
    });

    const pinnedSystem = promptVisible.filter(
      (m) => m instanceof SystemMessage,
    );

    // Candidates for compaction are all non-system messages (human/ai/tool/etc).
    // System prompts/instructions are pinned and never folded.
    const candidates = promptVisible.filter(
      (m) => !(m instanceof SystemMessage),
    );

    if (candidates.length === 0) {
      return {};
    }

    // Step 4 & 5: Pick raw tail and determine older slice, respecting tool-call atomicity
    // keepTokens semantics:
    // - maxTokens: threshold (trigger) based on provider-reported currentContext
    // - keepTokens: target size (summary + recent raw messages) after compaction
    //
    // We pin system messages outside this budget and never fold them.
    // First pass: fold (previous summary text + older non-system messages), then size the raw tail
    // so that (summary + tail) ~= keepTokens.
    const messagesForKeep = await this.trimLastRespectingToolCalls(
      candidates,
      keepTokens,
    );
    let messagesForSummarize = candidates.slice(
      0,
      candidates.length - messagesForKeep.length,
    );

    // If the provider reports we're over budget, we must fold *something* even if our
    // local token estimator says everything fits into keepTokens. Force folding of
    // the older part while preserving the newest message block.
    if (messagesForSummarize.length === 0) {
      const split = this.splitKeepingLastBlock(candidates);
      if (split) {
        messagesForSummarize = split.older;
      }
    }

    // If there's nothing eligible to fold (e.g. only one block exists), we still
    // return the summary field so downstream consumers don't treat it as "unset".
    if (messagesForSummarize.length === 0) {
      return { summary: state.summary };
    }

    // Step 6: Update summary using delta-folding
    // Pass previous summary as TEXT, not as message
    const llmRequestContext = cfg.configurable?.llmRequestContext;
    const summaryData = await this.fold(
      state.summary,
      messagesForSummarize,
      state.currentContext,
      llmRequestContext,
    );

    // Step 7: Write back state atomically
    const summaryMarker = this.buildHiddenSummaryMarker(summaryData.summary);

    const messagesToReturn: BaseMessage[] = [
      ...(summaryMarker ? [summaryMarker] : []),
      ...pinnedSystem,
      ...messagesForKeep,
    ];

    // Cumulative state.totalPrice is number; unknown pricing (null) is coerced
    // to 0 when accumulating. See matching handling in invoke-llm-node.
    const usageForState = summaryData.usage
      ? {
          ...summaryData.usage,
          totalPrice:
            typeof summaryData.usage.totalPrice === 'number'
              ? summaryData.usage.totalPrice
              : 0,
        }
      : {};

    return {
      messages: {
        mode: 'replace',
        items: updateMessagesListWithMetadata(messagesToReturn, cfg),
      },
      // Keep raw summary text in state; InvokeLlmNode formats it into an LLM-facing memory message.
      summary: summaryData.summary,
      toolUsageGuardActivated: false,
      toolUsageGuardActivatedCount: 0,
      ...usageForState,
    };
  }

  private buildHiddenSummaryMarker(summary: string): BaseMessage | null {
    const trimmed = summary.trim();
    if (!trimmed) {
      return null;
    }

    // UI-only marker. The actual summary text is stored in `state.summary`.
    const msg = new SystemMessage('Conversation history was summarized.');
    msg.additional_kwargs = {
      ...(msg.additional_kwargs ?? {}),
      __hideForSummary: true,
    };
    return markMessageHideForLlm(msg);
  }

  private splitKeepingLastBlock(
    messages: BaseMessage[],
  ): { older: BaseMessage[]; tail: BaseMessage[] } | null {
    const blocks = this.identifyMessageBlocks(messages);
    if (blocks.length <= 1) {
      return null;
    }
    const tail = blocks[blocks.length - 1]!.messages;
    const older = blocks.slice(0, -1).flatMap((b) => b.messages);
    if (older.length === 0) {
      return null;
    }
    return { older, tail };
  }

  /**
   * Step 1: Check for pending tool calls (guard rail)
   * Returns true if any AIMessage has tool_calls without corresponding ToolMessages
   * Checks both msg.tool_calls AND msg.additional_kwargs.tool_calls for compatibility
   */
  private hasPendingToolCalls(messages: BaseMessage[]): boolean {
    // Build set of all tool_call_ids that have results
    const answeredToolIds = new Set(
      messages
        .filter((m) => m instanceof ToolMessage)
        .map((m) => (m as ToolMessage).tool_call_id),
    );

    // Check if any AI message has unanswered tool calls
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!(msg instanceof AIMessage)) {
        continue;
      }

      const toolCallIds = this.getToolCallIdsFromAiMessage(msg);
      if (toolCallIds.length === 0) {
        continue;
      }

      // If any tool call doesn't have a result, we have pending tools
      const hasPending = toolCallIds.some((id) => !answeredToolIds.has(id));

      if (hasPending) {
        return true;
      }
    }

    return false;
  }

  /**
   * Estimate the effective context size for the next LLM invocation.
   *
   * `state.currentContext` captures the prompt size at the last LLM call, but
   * messages added afterwards (tool results, inter-agent messages, injected
   * pending messages) aren't reflected. This method estimates the token cost
   * of those newer messages and projects the total context for the next call.
   */
  private async estimateEffectiveContext(
    state: BaseAgentState,
  ): Promise<number> {
    const { currentContext, messages } = state;

    // First invocation for this thread — no provider-reported context yet.
    // Estimate from all non-system messages so we can still trigger
    // summarization if the conversation was seeded with a large payload.
    if (!currentContext || currentContext <= 0) {
      const candidates = messages.filter((m) => !(m instanceof SystemMessage));
      if (candidates.length === 0) {
        return 0;
      }
      return this.estimateBlockTokens(candidates);
    }

    // Find the last AI message with __requestUsage — this is the response from
    // the most recent LLM invocation. All messages after it are "new" and their
    // token cost isn't captured by currentContext.
    let lastInvokeIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (
        msg instanceof AIMessage &&
        (msg.additional_kwargs as Record<string, unknown>)?.__requestUsage
      ) {
        lastInvokeIndex = i;
        break;
      }
    }

    // No AI response found or it's the last message — currentContext is accurate
    if (lastInvokeIndex === -1 || lastInvokeIndex >= messages.length - 1) {
      return currentContext;
    }

    // Estimate tokens for messages added after the last LLM response
    const newMessages = messages.slice(lastInvokeIndex + 1);
    const newTokens = await this.estimateBlockTokens(newMessages);

    return currentContext + newTokens;
  }

  private async safeGetNumTokens(text: string): Promise<number> {
    if (!text) {
      return 0;
    }
    try {
      return await this.litellmService.countTokens(
        this.opts.tokenCountModel,
        text,
      );
    } catch {
      return Math.max(0, Math.ceil(text.length / 4));
    }
  }

  /**
   * Step 4: Trim to keep the most recent messages, but respect tool-call atomicity
   * Thinks in terms of blocks: normal messages vs tool-roundtrip blocks
   * A tool-roundtrip block = AIMessage(with tool_calls) + all its ToolMessages
   * Blocks are atomic: we keep them whole or exclude them whole
   */
  private async trimLastRespectingToolCalls(
    messages: BaseMessage[],
    maxTokens: number,
  ): Promise<BaseMessage[]> {
    if (maxTokens <= 0) {
      // Keep the last *block*, not the last message, so we never return a dangling ToolMessage.
      const blocks = this.identifyMessageBlocks(messages);
      const last = blocks[blocks.length - 1];
      return last ? last.messages : [];
    }

    // Step 1: Identify tool-roundtrip blocks
    const blocks = this.identifyMessageBlocks(messages);

    // Step 2: Greedily select blocks from the end until we exceed maxTokens
    const selectedBlocks: (typeof blocks)[0][] = [];
    let estimatedTokens = 0;

    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]!;
      const blockTokens = await this.estimateBlockTokens(block.messages);

      if (selectedBlocks.length === 0) {
        // Always include at least the last block
        selectedBlocks.unshift(block);
        estimatedTokens += blockTokens;
      } else if (estimatedTokens + blockTokens <= maxTokens) {
        selectedBlocks.unshift(block);
        estimatedTokens += blockTokens;
      } else {
        // Would exceed budget, stop here
        break;
      }
    }

    // Step 3: Flatten selected blocks back into messages
    return selectedBlocks.flatMap((b) => b.messages);
  }

  /**
   * Identify message blocks for atomic trimming
   * Returns an array of blocks, each containing one or more messages
   */
  private identifyMessageBlocks(
    messages: BaseMessage[],
  ): { type: 'normal' | 'tool-roundtrip'; messages: BaseMessage[] }[] {
    const blocks: {
      type: 'normal' | 'tool-roundtrip';
      messages: BaseMessage[];
    }[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;

      if (msg instanceof AIMessage) {
        const toolCallIds = new Set(this.getToolCallIdsFromAiMessage(msg));
        if (toolCallIds.size > 0) {
          // Start of a tool-roundtrip block
          // Safer invariant:
          // tool-roundtrip block = AI(tool_calls) plus everything up to the last
          // matching ToolMessage for those tool_call_ids. Stop scanning at the next
          // AIMessage (any AI message) or end-of-list.
          const stopAt = (() => {
            for (let j = i + 1; j < messages.length; j++) {
              if (messages[j] instanceof AIMessage) {
                return j;
              }
            }
            return messages.length;
          })();

          let endInclusive = i;
          for (let j = i + 1; j < stopAt; j++) {
            const next = messages[j]!;
            if (
              next instanceof ToolMessage &&
              toolCallIds.has(next.tool_call_id)
            ) {
              endInclusive = j;
            }
          }

          // Include any interleaved messages up to endInclusive to preserve integrity.
          blocks.push({
            type: 'tool-roundtrip',
            messages: messages.slice(i, endInclusive + 1),
          });
          i = endInclusive;
          continue;
        }
      }

      // Normal message (standalone)
      blocks.push({ type: 'normal', messages: [msg] });
    }

    return blocks;
  }

  private getToolCallIdsFromAiMessage(msg: AIMessage): string[] {
    const ids: string[] = [];

    // LangChain-native
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc && typeof tc.id === 'string' && tc.id.length > 0) {
          ids.push(tc.id);
        }
      }
    }

    // OpenAI / LC transport (can differ by provider)
    const kwToolCalls = (msg.additional_kwargs as { tool_calls?: unknown })
      ?.tool_calls;
    if (Array.isArray(kwToolCalls)) {
      for (const tc of kwToolCalls) {
        const id = (tc as { id?: unknown })?.id;
        if (typeof id === 'string' && id.length > 0) {
          ids.push(id);
        }
      }
    }

    // De-dupe while preserving order
    return Array.from(new Set(ids));
  }

  /**
   * Estimate token count for a block of messages
   */
  private async estimateBlockTokens(messages: BaseMessage[]): Promise<number> {
    // Best-effort: include message content + tool call payloads/ids, since tool args can be large.
    // This is still an estimate (provider formatting differs), but tighter than content-only.
    let total = 0;
    for (const msg of messages) {
      total += await this.safeGetNumTokens(this.stringifyForTokenEstimate(msg));
    }
    return total;
  }

  private stringifyForTokenEstimate(msg: BaseMessage): string {
    const parts: string[] = [];

    const content =
      typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
    // Keep the content at the start so existing token-counter mocks in tests (and
    // many heuristics) that key off message text still behave sensibly.
    if (content) {
      parts.push(content);
    }

    parts.push(`TYPE:${String((msg as { type?: unknown })?.type ?? '')}`);

    if (msg instanceof ToolMessage) {
      parts.push(`TOOL_CALL_ID:${msg.tool_call_id}`);
    }

    if (msg instanceof AIMessage) {
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        parts.push(`TOOL_CALLS:${JSON.stringify(msg.tool_calls)}`);
      }
    }

    // Include additional_kwargs.tool_calls for all message types.
    // AIMessage may store tool calls here as well; other implementations
    // may also use this field.
    const kwToolCalls = (msg.additional_kwargs as { tool_calls?: unknown })
      ?.tool_calls;
    if (Array.isArray(kwToolCalls) && kwToolCalls.length > 0) {
      parts.push(`KW_TOOL_CALLS:${JSON.stringify(kwToolCalls)}`);
    }

    return parts.join('\n');
  }

  /**
   * Step 6: Delta-folding to update summary
   * Takes previous summary TEXT (not message) and new messages to fold in
   * Returns updated summary text - this is the core of preventing drift/duplication
   */
  private async fold(
    previousSummaryText: string | undefined,
    newMessages: BaseMessage[],
    currentContext?: number,
    llmRequestContext?: LLMRequestContext,
  ): Promise<{
    summary: string;
    usage: RequestTokenUsage | null;
  }> {
    const llm = this.llmResolver(currentContext, llmRequestContext);
    const sys = new SystemMessage(
      this.opts.systemNote ||
        'You update a running summary of a conversation. Keep key facts, goals, decisions, constraints, names, deadlines, and follow-ups. Be concise; use compact sentences; omit chit-chat.',
    );
    const lines = newMessages
      .map(
        (m) =>
          `${m.type.toUpperCase()}: ${
            typeof m.content === 'string'
              ? m.content
              : JSON.stringify(m.content)
          }`,
      )
      .join('\n');
    const human = new HumanMessage(
      `Previous summary:\n${previousSummaryText ?? '(none)'}\n\nFold in the following messages:\n${lines}\n\nReturn only the updated summary.`,
    );
    const res = (await llm.invoke([sys, human])) as AIMessage;
    const model = String(llm.model);
    const rawUsage = res.response_metadata?.usage as
      | Record<string, unknown>
      | undefined;
    // llm.invoke() here is non-streaming — LangChain's streaming-aggregation
    // 2× doubling bug (see invoke-llm-node.ts) does not apply. Forward any
    // provider-reported cost as-is without compensation.
    const providerCost =
      typeof rawUsage?.cost === 'number' ? rawUsage.cost : undefined;
    const usageMetadata = {
      ...(res.usage_metadata ?? rawUsage ?? {}),
      ...(providerCost !== undefined ? { cost: providerCost } : {}),
    };

    const usage = await this.litellmService.extractTokenUsageFromResponse(
      model,
      usageMetadata as UsageMetadata,
    );
    const extracted = extractTextFromResponseContent(res.content);
    if (extracted !== undefined) {
      return { summary: extracted, usage };
    }
    return {
      summary:
        typeof res.content === 'string'
          ? res.content
          : JSON.stringify(res.content),
      usage,
    };
  }
}
