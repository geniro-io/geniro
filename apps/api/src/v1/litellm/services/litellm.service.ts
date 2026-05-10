import { encodingForModel, getEncoding } from '@langchain/core/utils/tiktoken';
import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Tiktoken, TiktokenModel } from 'js-tiktoken/lite';

import { LiteLlmModelDto } from '../dto/models.dto';
import {
  AggregatedTokenUsage,
  LiteLLMModelInfo,
  LLMTokenCostRates,
  RequestTokenUsage,
  UsageMetadata,
} from '../litellm.types';
import { LiteLlmClient } from './litellm.client';

@Injectable()
export class LitellmService {
  private static readonly MODEL_INFO_TTL_MS = 12 * 60 * 60 * 1000; // 12h

  private modelInfoCache = new Map<
    string,
    { expiresAt: number; data: LiteLLMModelInfo }
  >();
  private modelInfoInFlight = new Map<
    string,
    Promise<LiteLLMModelInfo | null>
  >();

  private tiktokenCache = new Map<string, Tiktoken>();

  constructor(private readonly liteLlmClient: LiteLlmClient) {}

  async getTokenizer(model: string): Promise<Tiktoken> {
    const key = model.trim() || 'cl100k_base';
    const cached = this.tiktokenCache.get(key);
    if (cached) {
      return cached;
    }
    let tiktoken: Tiktoken | null = null;
    if (model.length > 0) {
      try {
        tiktoken = await encodingForModel(model as TiktokenModel);
      } catch {
        tiktoken = null;
      }
    }
    if (!tiktoken) {
      tiktoken = await getEncoding('cl100k_base');
    }

    this.tiktokenCache.set(key, tiktoken);

    return tiktoken;
  }

  async listModels(): Promise<LiteLlmModelDto[]> {
    const models = await this.liteLlmClient.fetchModelList();

    return models.map((m) => ({
      id: m.model_name,
      ownedBy: m.litellm_params?.model ?? m.model_name,
      supportsEmbedding: this.isEmbeddingModel(m),
    }));
  }

  private isEmbeddingModel(m: LiteLLMModelInfo): boolean {
    if (m.model_info?.mode) {
      return m.model_info.mode === 'embedding';
    }
    return /embed/i.test(m.model_name);
  }

  async countTokens(model: string, content: unknown): Promise<number> {
    const text =
      typeof content === 'string' ? content : JSON.stringify(content ?? '');
    const tiktoken = await this.getTokenizer(model as TiktokenModel);
    return tiktoken.encode(text).length;
  }

  /**
   * Sums an array of per-request token usages into a single aggregate.
   *
   * Returns `null` when no input usage was provided (all elements are null/undefined).
   * When non-null, `totalPrice` is always a number (zero-coerced from missing/unknown
   * pricing inputs via `Decimal.toNumber()`). Callers MUST NOT need `?? 0` or
   * `typeof === 'number'` guards on the returned `totalPrice`. This contract widens
   * `RequestTokenUsage.totalPrice` (which is `number | undefined`) for the sum-result
   * use case only — per-message ingestion paths still preserve `undefined` to distinguish
   * unpriced calls.
   */
  sumTokenUsages(
    usages: (RequestTokenUsage | null | undefined)[],
  ): AggregatedTokenUsage | null {
    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let totalTokens = 0;
    let totalPriceDecimal = new Decimal(0);
    let currentContext = 0;
    let sawAny = false;
    let sawContext = false;

    for (const usage of usages) {
      if (!usage) {
        continue;
      }
      sawAny = true;
      inputTokens += usage.inputTokens;
      cachedInputTokens += usage.cachedInputTokens ?? 0;
      outputTokens += usage.outputTokens;
      reasoningTokens += usage.reasoningTokens ?? 0;
      totalTokens += usage.totalTokens;
      totalPriceDecimal = totalPriceDecimal.plus(usage.totalPrice ?? 0);
      if (typeof usage.currentContext === 'number') {
        currentContext = Math.max(currentContext, usage.currentContext);
        sawContext = true;
      }
    }

    if (!sawAny) {
      return null;
    }

    return {
      inputTokens,
      ...(cachedInputTokens ? { cachedInputTokens } : {}),
      outputTokens,
      ...(reasoningTokens ? { reasoningTokens } : {}),
      totalTokens,
      totalPrice: totalPriceDecimal.toNumber(),
      ...(sawContext ? { currentContext } : {}),
    };
  }

  /**
   * Extract token usage and cost from LangChain's ChatOpenAI response.
   * Automatically recalculates price when cached or reasoning tokens are present.
   *
   * Prefers the provider-reported cost (e.g. OpenRouter's `usage.cost`) when
   * available, as it reflects the actual upstream charge including any markup
   * or pricing differences. Falls back to a calculated price from per-token
   * model rates when the provider does not report a cost.
   */
  async extractTokenUsageFromResponse(
    model: string,
    usageMetadata?: UsageMetadata,
  ): Promise<RequestTokenUsage | null> {
    const inputTokens =
      usageMetadata?.input_tokens ?? usageMetadata?.prompt_tokens ?? 0;
    const outputTokens =
      usageMetadata?.output_tokens ?? usageMetadata?.completion_tokens ?? 0;

    const inputTokensDetails =
      usageMetadata?.input_tokens_details ||
      usageMetadata?.input_token_details ||
      usageMetadata?.prompt_tokens_details;
    const cachedInputTokens =
      inputTokensDetails?.cached_tokens ?? inputTokensDetails?.cache_read ?? 0;

    const reasoningTokens =
      usageMetadata?.output_tokens_details?.reasoning_tokens ??
      usageMetadata?.output_tokens_details?.reasoning ??
      usageMetadata?.completion_tokens_details?.reasoning_tokens ??
      usageMetadata?.completion_tokens_details?.reasoning ??
      usageMetadata?.output_token_details?.reasoning_tokens ??
      usageMetadata?.output_token_details?.reasoning ??
      0;

    // cachedInputTokens is a subset of inputTokens, and reasoningTokens is a subset
    // of outputTokens — do not add them again or the total will be inflated.
    const totalTokens = inputTokens + outputTokens;

    // Prefer the provider-reported cost when available — it represents the
    // actual upstream charge (e.g. OpenRouter includes markup, tiered pricing,
    // or per-model rates that may differ from LiteLLM's pricing database).
    // Fall back to our calculated price from per-token model rates when the
    // provider does not report a cost (e.g. direct OpenAI/Azure calls).
    const providerCost =
      typeof usageMetadata?.cost === 'number' ? usageMetadata.cost : null;

    const calculatedPrice = await this.estimateThreadTotalPriceFromModelRates({
      model,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningTokens,
    });

    const totalPrice = providerCost ?? calculatedPrice ?? 0;

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      currentContext: inputTokens,
      cachedInputTokens,
      reasoningTokens,
      totalPrice,
    };
  }

  async getTokenCostRatesForModel(
    model: string,
  ): Promise<LLMTokenCostRates | null> {
    const entry = await this.getLiteLLMModelInfo(model);
    const modelInfo = entry?.model_info ?? null;
    if (!modelInfo) {
      return null;
    }

    const inputCostPerToken = Number(modelInfo.input_cost_per_token);
    const outputCostPerToken = Number(modelInfo.output_cost_per_token);
    if (isNaN(inputCostPerToken) || isNaN(outputCostPerToken)) {
      return null;
    }

    const inputCostPerCachedToken = Number(
      modelInfo.input_cost_per_token_cache_hit ??
        modelInfo.cache_read_input_token_cost,
    );
    const outputCostPerReasoningToken = Number(
      modelInfo.output_cost_per_reasoning_token,
    );

    return {
      inputCostPerToken,
      outputCostPerToken,
      ...(!isNaN(inputCostPerCachedToken) ? { inputCostPerCachedToken } : {}),
      ...(!isNaN(outputCostPerReasoningToken)
        ? { outputCostPerReasoningToken }
        : {}),
    };
  }

  private static readonly RESPONSES_API_PROVIDERS = new Set([
    'openai',
    'azure',
    'azure_ai',
  ]);

  async supportsResponsesApi(model: string): Promise<boolean> {
    const entry = await this.getLiteLLMModelInfo(model);
    if (!entry) {
      return false;
    }

    if (!entry.model_info?.supports_response_schema) {
      return false;
    }

    const provider = entry.model_info?.litellm_provider?.toLowerCase();
    return !!provider && LitellmService.RESPONSES_API_PROVIDERS.has(provider);
  }

  async supportsReasoning(model: string): Promise<boolean> {
    const entry = await this.getLiteLLMModelInfo(model);
    if (!entry) {
      return false;
    }

    return !!entry.model_info?.supports_reasoning;
  }

  async supportsParallelToolCall(model: string): Promise<boolean> {
    const entry = await this.getLiteLLMModelInfo(model);
    if (!entry) {
      return true;
    }

    return !!entry.model_info?.supports_parallel_function_calling;
  }

  async supportsStreaming(model: string): Promise<boolean> {
    const entry = await this.getLiteLLMModelInfo(model);
    if (!entry) {
      return true;
    }

    return !!entry.model_info?.supports_native_streaming;
  }

  async supportsAssistantPrefill(model: string): Promise<boolean> {
    const entry = await this.getLiteLLMModelInfo(model);
    if (!entry) {
      return true;
    }

    // Default to true — most providers accept assistant prefill.
    // Only return false when explicitly configured as false in model_info.
    return entry.model_info?.supports_assistant_prefill !== false;
  }

  async estimateThreadTotalPriceFromModelRates(args: {
    model: string;
    inputTokens: number;
    cachedInputTokens?: number;
    outputTokens: number;
    reasoningTokens?: number;
  }): Promise<number | null> {
    const rates = await this.getTokenCostRatesForModel(args.model);
    if (!rates) {
      return null;
    }

    const cached = Math.max(0, args.cachedInputTokens ?? 0);
    const input = Math.max(0, args.inputTokens);
    const nonCached = Math.max(0, input - cached);
    const output = Math.max(0, args.outputTokens);
    const reasoning = Math.max(0, args.reasoningTokens ?? 0);

    const cachedRate = rates.inputCostPerCachedToken ?? rates.inputCostPerToken;
    const reasoningRate = rates.outputCostPerReasoningToken ?? 0;

    const inputCost = new Decimal(nonCached).times(rates.inputCostPerToken);
    const cachedCost = new Decimal(cached).times(cachedRate);
    const outputCost = new Decimal(output).times(rates.outputCostPerToken);
    const reasoningCost = new Decimal(reasoning).times(reasoningRate);

    return inputCost
      .plus(cachedCost)
      .plus(outputCost)
      .plus(reasoningCost)
      .toNumber();
  }

  private async getLiteLLMModelInfo(
    model: string,
  ): Promise<LiteLLMModelInfo | null> {
    if (!model) {
      return null;
    }

    const now = Date.now();
    const cached = this.modelInfoCache.get(model);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const inFlight = this.modelInfoInFlight.get(model);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const entry = await this.liteLlmClient.getModelInfo(model);
      if (!entry) {
        return null;
      }
      this.modelInfoCache.set(model, {
        expiresAt: Date.now() + LitellmService.MODEL_INFO_TTL_MS,
        data: entry,
      });
      return entry;
    })().finally(() => {
      this.modelInfoInFlight.delete(model);
    });

    this.modelInfoInFlight.set(model, promise);
    return promise;
  }
}
