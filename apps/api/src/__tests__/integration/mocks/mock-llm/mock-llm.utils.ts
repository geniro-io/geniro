import {
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';

import type { RequestTokenUsage } from '../../../../v1/litellm/litellm.types';
import type { MockLlmReply } from './mock-llm.types';

export function stringifyContent(content: BaseMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  // Array of content blocks — join text parts
  return content
    .map((block) => {
      if (typeof block === 'string') {
        return block;
      }
      if ('text' in block && typeof block.text === 'string') {
        return block.text;
      }
      return JSON.stringify(block);
    })
    .join('');
}

export function extractSystem(messages: BaseMessage[]): string | undefined {
  const msg = messages.find(
    (m) => m._getType() === 'system' || m instanceof SystemMessage,
  );
  return msg ? stringifyContent(msg.content) : undefined;
}

export function extractLastUser(messages: BaseMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m: BaseMessage | undefined = messages[i];
    if (m && (m._getType() === 'human' || m instanceof HumanMessage)) {
      return stringifyContent(m.content);
    }
  }
  return undefined;
}

export function extractLastTool(
  messages: BaseMessage[],
): { name: string; content: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m: BaseMessage | undefined = messages[i];
    if (m && (m._getType() === 'tool' || m instanceof ToolMessage)) {
      const toolMsg = m as ToolMessage;
      const name =
        toolMsg.name ??
        (toolMsg as unknown as { tool_call_id?: string }).tool_call_id ??
        'unknown';
      return { name, content: stringifyContent(toolMsg.content) };
    }
  }
  return null;
}

export function buildUsageMetadata(
  usage: Partial<RequestTokenUsage> | undefined,
): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const total = usage?.totalTokens ?? input + output;
  return { input_tokens: input, output_tokens: output, total_tokens: total };
}

/**
 * Build the `response_metadata.usage` shape consumed by `invoke-llm-node.ts`.
 *
 * `InvokeLlmNode` reads `res.response_metadata?.usage` and looks for a
 * `cost` field (OpenRouter-style provider-reported cost). Setting it here
 * ensures that `LitellmService.extractTokenUsageFromResponse` takes the
 * provider-cost branch and returns `totalPrice` without making any network
 * call to `liteLlmClient.getModelInfo`.
 */
export function buildResponseMetadataUsage(
  usage: Partial<RequestTokenUsage> | undefined,
): Record<string, unknown> {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return {
    // LangChain normalised field names (read by extractTokenUsageFromResponse)
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage?.totalTokens ?? inputTokens + outputTokens,
    // Provider-cost field consumed by InvokeLlmNode's providerCost branch
    cost: usage?.totalPrice ?? 0,
  };
}

/**
 * Split `text` into up to `count` approximately equal chunks for streaming
 * simulation. Returns `['']` for empty input.
 */
export function splitIntoChunks(text: string, count: number): string[] {
  if (text.length === 0) {
    return [''];
  }
  // count <= 0 must return zero chunks (empty array)
  if (count <= 0) {
    return [];
  }
  const chunkSize = Math.ceil(text.length / count);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Build a `RequestTokenUsage` from a reply's optional `usage` field.
 *
 * The offline-cost rule: we never call `LitellmService.extractTokenUsageFromResponse`
 * because it always triggers a `liteLlmClient.getModelInfo` HTTP call under the
 * hood (even when a provider `cost` field is present). Instead, we read
 * `reply.usage.totalPrice` directly and return `0` when absent.
 *
 * Returns `undefined` when the reply carries no `usage` at all (matches the
 * real service behaviour when `response.usage` is absent).
 */
export function buildUsage(
  reply: Exclude<MockLlmReply, { kind: 'error' }>,
): RequestTokenUsage | undefined {
  if (!reply.usage) {
    return undefined;
  }

  const inputTokens = reply.usage.inputTokens ?? 0;
  const outputTokens = reply.usage.outputTokens ?? 0;
  const totalTokens = reply.usage.totalTokens ?? inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    totalPrice: reply.usage.totalPrice ?? 0,
    ...(reply.usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: reply.usage.cachedInputTokens }
      : {}),
    ...(reply.usage.reasoningTokens !== undefined
      ? { reasoningTokens: reply.usage.reasoningTokens }
      : {}),
    ...(reply.usage.currentContext !== undefined
      ? { currentContext: reply.usage.currentContext }
      : {}),
    ...(reply.usage.durationMs !== undefined
      ? { durationMs: reply.usage.durationMs }
      : {}),
  };
}

/**
 * Pad a vector with zeros or truncate it to exactly `dimensions` elements.
 * Ensures mock vectors conform to the expected embedding size regardless of
 * what the fixture returns.
 */
export function padOrTruncate(vec: number[], dimensions: number): number[] {
  // Non-positive dimensions must return empty array
  if (dimensions <= 0) {
    return [];
  }
  if (vec.length === dimensions) {
    return vec;
  }
  if (vec.length > dimensions) {
    return vec.slice(0, dimensions);
  }
  return [...vec, ...new Array<number>(dimensions - vec.length).fill(0)];
}
