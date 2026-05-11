/* eslint-disable @typescript-eslint/naming-convention -- LangChain base class methods/properties use leading underscores */
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { BindToolsInput } from '@langchain/core/language_models/chat_models';
import {
  BaseChatModel,
  type BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';

import type { MockLlmService } from './mock-llm.service';
import type { MockLlmRequest } from './mock-llm.types';
import {
  buildResponseMetadataUsage,
  buildUsageMetadata,
  extractLastTool,
  extractLastUser,
  extractSystem,
  splitIntoChunks,
  stringifyContent,
} from './mock-llm.utils';

/**
 * Sleep for `ms` milliseconds, rejecting with `AbortError` if `signal` aborts
 * before the timer elapses. Used to honour the LangChain caller's abort signal
 * when a fixture sets `delayMs`, so that `agent.stop()` (graph destroy) can
 * unblock an in-flight LLM call rather than waiting out the full delay.
 */
async function sleepWithAbort(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    throw makeAbortError(signal.reason);
  }

  return await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError(signal?.reason));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function makeAbortError(reason: unknown): Error {
  const err = new Error(
    reason instanceof Error ? reason.message : 'This operation was aborted',
  );
  err.name = 'AbortError';
  return err;
}

/**
 * LangChain `BaseChatModel` implementation backed by `MockLlmService`.
 *
 * Instances are constructed with a lazy getter for `MockLlmService` so the
 * singleton accessor is only resolved at call time, not at construction time.
 * This decouples `MockChatOpenAI` from the singleton module entirely — the
 * getter is wired up by Step 5's patch installer.
 */

export class MockChatOpenAI extends BaseChatModel {
  private readonly _mockLlmGetter: () => MockLlmService;
  private readonly _model: string;
  private readonly _params: unknown;

  /** Names of tools bound via `bindTools()`. Undefined when no tools are bound. */
  public _boundTools: string[] | undefined;

  constructor(
    mockLlmGetter: () => MockLlmService,
    opts: { model: string; params?: unknown },
    baseParams?: BaseChatModelParams,
  ) {
    super(baseParams ?? {});
    this._mockLlmGetter = mockLlmGetter;
    this._model = opts.model;
    this._params = opts.params;
  }

  _llmType(): string {
    return 'mock-chat-openai';
  }

  /**
   * Return a clone with `_boundTools` set to the names of the provided tools.
   * The clone is a proper `MockChatOpenAI` instance so all `BaseChatModel`
   * and `Runnable` methods are inherited correctly.
   */
  bindTools(
    tools: BindToolsInput[],
    _kwargs?: Partial<this['ParsedCallOptions']>,
  ): MockChatOpenAI {
    const toolNames = tools.map((t) => {
      if ('name' in t && typeof (t as { name?: unknown }).name === 'string') {
        return (t as { name: string }).name;
      }
      if (
        'function' in t &&
        t.function !== null &&
        typeof t.function === 'object' &&
        'name' in t.function &&
        typeof (t.function as { name?: unknown }).name === 'string'
      ) {
        return (t.function as { name: string }).name;
      }
      return 'unknown';
    });

    const cloned = new MockChatOpenAI(this._mockLlmGetter, {
      model: this._model,
      params: this._params,
    });
    cloned._boundTools = toolNames;
    return cloned;
  }

  private buildChatRequest(
    messages: BaseMessage[],
    callIndex: number,
  ): MockLlmRequest {
    return {
      kind: 'chat',
      model: this._model,
      messages: messages.map((m) => ({
        role: m._getType(),
        content: stringifyContent(m.content),
        name: (m as unknown as { name?: string }).name,
      })),
      systemMessage: extractSystem(messages),
      lastUserMessage: extractLastUser(messages),
      lastToolResult: extractLastTool(messages),
      boundTools: this._boundTools,
      callIndex,
    };
  }

  async _generate(
    messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const mockLlm = this._mockLlmGetter();
    const callIndex = mockLlm.nextCallIndex();
    const request = this.buildChatRequest(messages, callIndex);

    const reply = mockLlm.match(request);

    if (reply.kind === 'error') {
      throw Object.assign(new Error(reply.message), { status: reply.status });
    }

    if (reply.kind === 'embeddings') {
      throw new Error(
        'MockChatOpenAI received an embeddings reply — register via onChat instead',
      );
    }

    if ('delayMs' in reply && typeof reply.delayMs === 'number') {
      await sleepWithAbort(reply.delayMs, _options.signal);
    }

    // Defensive: kind === 'json' should not reach the chat model. Convert to text.
    if (reply.kind === 'json') {
      const textContent = JSON.stringify(reply.content);
      const usageMeta = buildUsageMetadata(reply.usage);
      const usageForMetadata = buildResponseMetadataUsage(reply.usage);
      return {
        generations: [
          {
            text: textContent,
            message: new AIMessage({
              content: textContent,
              usage_metadata: usageMeta,
              response_metadata: { usage: usageForMetadata },
            }),
          },
        ],
        llmOutput: { tokenUsage: usageForMetadata },
      };
    }

    if (reply.kind === 'text') {
      const usageMeta = buildUsageMetadata(reply.usage);
      const usageForMetadata = buildResponseMetadataUsage(reply.usage);
      return {
        generations: [
          {
            text: reply.content,
            message: new AIMessage({
              content: reply.content,
              usage_metadata: usageMeta,
              response_metadata: { usage: usageForMetadata },
            }),
          },
        ],
        llmOutput: { tokenUsage: usageForMetadata },
      };
    }

    // kind === 'toolCall'
    const usageMeta = buildUsageMetadata(reply.usage);
    const usageForMetadata = buildResponseMetadataUsage(reply.usage);
    const toolCallId = `call_${crypto.randomUUID()}`;
    return {
      generations: [
        {
          text: '',
          message: new AIMessage({
            content: '',
            tool_calls: [
              {
                id: toolCallId,
                name: reply.toolName,
                args: reply.args,
                type: 'tool_call',
              },
            ],
            usage_metadata: usageMeta,
            response_metadata: { usage: usageForMetadata },
          }),
        },
      ],
      llmOutput: { tokenUsage: usageForMetadata },
    };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const mockLlm = this._mockLlmGetter();
    const callIndex = mockLlm.nextCallIndex();
    const request = this.buildChatRequest(messages, callIndex);

    const reply = mockLlm.match(request);

    if (reply.kind === 'error') {
      throw Object.assign(new Error(reply.message), { status: reply.status });
    }

    if (reply.kind === 'embeddings') {
      throw new Error(
        'MockChatOpenAI received an embeddings reply — register via onChat instead',
      );
    }

    if ('delayMs' in reply && typeof reply.delayMs === 'number') {
      await sleepWithAbort(reply.delayMs, _options.signal);
    }

    const usageMeta = buildUsageMetadata(reply.usage);
    const usageForMetadata = buildResponseMetadataUsage(reply.usage);

    if (reply.kind === 'toolCall') {
      const toolCallId = `call_${crypto.randomUUID()}`;
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({
          content: '',
          tool_call_chunks: [
            {
              type: 'tool_call_chunk',
              id: toolCallId,
              name: reply.toolName,
              args: JSON.stringify(reply.args),
              index: 0,
            },
          ],
        }),
      });

      // Final chunk with usage
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({
          content: '',
          usage_metadata: usageMeta,
          response_metadata: { usage: usageForMetadata },
        }),
      });
      return;
    }

    // kind === 'text' or kind === 'json' (defensive)
    const textContent =
      reply.kind === 'json' ? JSON.stringify(reply.content) : reply.content;

    const textChunks = splitIntoChunks(textContent, 4);

    for (const chunk of textChunks) {
      await runManager?.handleLLMNewToken(chunk);
      yield new ChatGenerationChunk({
        text: chunk,
        message: new AIMessageChunk({ content: chunk }),
      });
    }

    // Final chunk carrying usage metadata
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk({
        content: '',
        usage_metadata: usageMeta,
        response_metadata: { usage: usageForMetadata },
      }),
    });
  }
}
