import { BaseMessage, BaseMessageChunk } from '@langchain/core/messages';
import { ChatOpenAICompletions, OpenAIClient } from '@langchain/openai';

/**
 * Extends `ChatOpenAICompletions` to capture `reasoning_content` from providers
 * that return it as a non-standard field (e.g. DeepSeek via LiteLLM).
 *
 * `@langchain/openai` ignores `reasoning_content` because it only targets the
 * official OpenAI API spec. When `reasoning_content` is present, this subclass:
 *   1. Copies it to `additional_kwargs.reasoning_content`
 *   2. Sets `response_metadata.model_provider` to `"deepseek"`
 *
 * Step 2 causes the native `ChatDeepSeekTranslator` in `@langchain/core` to
 * handle `contentBlocks`, producing `{ type: "reasoning", reasoning: "..." }`
 * blocks automatically — no manual extraction needed downstream.
 */
export class ReasoningAwareChatCompletions extends ChatOpenAICompletions {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  override _convertCompletionsMessageToBaseMessage(
    message: OpenAIClient.ChatCompletionMessage,
    rawResponse: OpenAIClient.ChatCompletion,
  ): BaseMessage {
    const base = super._convertCompletionsMessageToBaseMessage(
      message,
      rawResponse,
    );
    return this.injectReasoning(
      base,
      message as unknown as Record<string, unknown>,
    );
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention
  override _convertCompletionsDeltaToBaseMessageChunk(
    delta: Record<string, unknown>,
    rawResponse: OpenAIClient.ChatCompletionChunk,
    defaultRole?: OpenAIClient.Chat.ChatCompletionRole,
  ): BaseMessageChunk {
    const base = super._convertCompletionsDeltaToBaseMessageChunk(
      delta,
      rawResponse,
      defaultRole,
    );
    return this.injectReasoning(base, delta);
  }

  private injectReasoning<T extends BaseMessage>(
    msg: T,
    source: Record<string, unknown>,
  ): T {
    const reasoning = this.extractReasoningText(source);
    if (!reasoning) {
      // Newer @langchain/openai sets additional_kwargs.reasoning_content to
      // an empty string when the upstream payload contains an empty value.
      // Drop it so consumers can rely on `undefined` meaning "no reasoning".
      if (
        msg.additional_kwargs &&
        msg.additional_kwargs.reasoning_content === ''
      ) {
        const { reasoning_content: _empty, ...rest } = msg.additional_kwargs;
        msg.additional_kwargs = rest;
      }
      return msg;
    }

    msg.additional_kwargs = {
      ...msg.additional_kwargs,
      reasoning_content: reasoning,
    };

    // Switch model_provider so the native ChatDeepSeekTranslator handles
    // contentBlocks and produces { type: "reasoning" } blocks.
    if (msg.response_metadata) {
      msg.response_metadata = {
        ...msg.response_metadata,
        model_provider: 'deepseek',
      };
    }

    return msg;
  }

  private extractReasoningText(source: Record<string, unknown>): string | null {
    // Primary: top-level reasoning_content (DeepSeek, Qwen)
    if (
      typeof source.reasoning_content === 'string' &&
      source.reasoning_content
    ) {
      return source.reasoning_content;
    }

    // Fallback: LiteLLM may wrap it in provider_specific_fields
    const psf = source.provider_specific_fields as
      | Record<string, unknown>
      | undefined;
    if (
      psf &&
      typeof psf.reasoning_content === 'string' &&
      psf.reasoning_content
    ) {
      return psf.reasoning_content;
    }

    return null;
  }
}
