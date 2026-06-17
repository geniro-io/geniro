import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';

import {
  CreateLiteLlmCredentialDto,
  CreateLiteLlmModelDto,
  LiteLlmModelInfoItemDto,
  TestModelConnectionDto,
  TestModelResponseDto,
  UpdateLiteLlmModelDto,
} from '../dto/models.dto';
import { LiteLlmProviderEntry } from '../litellm.types';
import { FALLBACK_PROVIDERS } from '../litellm-providers.fallback';
import { LiteLlmClient } from './litellm.client';

const PROVIDERS_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/proxy/public_endpoints/provider_create_fields.json';
const PROVIDERS_TTL_MS = 60 * 60 * 1000; // 1 hour

interface RawProviderField {
  litellm_provider: string;
  provider_display_name: string;
  default_model_placeholder?: string;
}

@Injectable()
export class LiteLlmAdminService {
  private providersCache: {
    expiresAt: number;
    data: LiteLlmProviderEntry[];
  } | null = null;

  private providersInFlight: Promise<LiteLlmProviderEntry[]> | null = null;

  constructor(
    private readonly liteLlmClient: LiteLlmClient,
    private readonly logger: DefaultLogger,
  ) {}

  async listModelsInfo(): Promise<LiteLlmModelInfoItemDto[]> {
    const models = await this.liteLlmClient.fetchModelList();
    return models
      .filter((m) => m.model_info?.id)
      .map((m) => ({
        id: m.model_info!.id!,
        modelName: m.model_name,
        providerModel: m.litellm_params.model,
        apiBase: m.litellm_params.api_base,
        customLlmProvider: m.litellm_params.custom_llm_provider as
          | string
          | undefined,
        supportsToolCalling:
          m.model_info?.supports_function_calling ?? undefined,
        supportsStreaming: m.model_info?.supports_native_streaming ?? undefined,
        supportsReasoning: m.model_info?.supports_reasoning ?? undefined,
      }));
  }

  async createModel(dto: CreateLiteLlmModelDto): Promise<void> {
    const payload: Record<string, unknown> = {
      model_name: dto.modelName,
      litellm_params: this.mapLitellmParams(dto.litellmParams),
    };
    const modelInfo = this.buildModelInfo(dto.tags, dto.modelInfo);
    if (modelInfo) {
      payload['model_info'] = modelInfo;
    }
    await this.liteLlmClient.createModel(payload);
    this.liteLlmClient.invalidateCache();
  }

  async updateModel(dto: UpdateLiteLlmModelDto): Promise<void> {
    const payload: Record<string, unknown> = { model_id: dto.modelId };
    if (dto.modelName) {
      payload['model_name'] = dto.modelName;
    }
    if (dto.litellmParams) {
      payload['litellm_params'] = this.mapLitellmParams(dto.litellmParams);
    }
    const modelInfo = this.buildModelInfo(dto.tags, dto.modelInfo);
    if (modelInfo) {
      payload['model_info'] = modelInfo;
    }
    await this.liteLlmClient.updateModel(payload);
    this.liteLlmClient.invalidateCache();
  }

  async deleteModel(id: string): Promise<void> {
    await this.liteLlmClient.deleteModel(id);
    this.liteLlmClient.invalidateCache();
  }

  async testModel(model: string): Promise<TestModelResponseDto> {
    return this.liteLlmClient.testModel(model);
  }

  async testModelConnection(
    dto: TestModelConnectionDto,
  ): Promise<TestModelResponseDto> {
    if (!dto.apiKey && !dto.litellmCredentialName) {
      return {
        success: false,
        latencyMs: 0,
        error: 'Either an API key or a saved credential is required to test',
      };
    }

    // When an inline API key is provided, call the provider directly (fastest path)
    if (dto.apiKey) {
      return this.liteLlmClient.testModelDirect({
        model: dto.litellmModel,
        apiKey: dto.apiKey,
        apiBase: dto.apiBase,
      });
    }

    // When only a credential name is given, route through LiteLLM proxy
    // via a temporary model so LiteLLM can resolve the credential
    return this.liteLlmClient.testModelViaProxy({
      model: dto.litellmModel,
      apiBase: dto.apiBase,
      litellmCredentialName: dto.litellmCredentialName,
    });
  }

  async listProviders(): Promise<{ providers: LiteLlmProviderEntry[] }> {
    const providers = await this.fetchProviders();
    return { providers };
  }

  private async fetchProviders(): Promise<LiteLlmProviderEntry[]> {
    const now = Date.now();
    if (this.providersCache && this.providersCache.expiresAt > now) {
      return this.providersCache.data;
    }

    if (this.providersInFlight) {
      return this.providersInFlight;
    }

    const promise = (async () => {
      try {
        const response = await fetch(PROVIDERS_URL, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          throw new Error(
            `Failed to fetch providers: ${response.status} ${response.statusText}`,
          );
        }
        const raw = (await response.json()) as unknown;
        if (!Array.isArray(raw)) {
          throw new Error('Provider list response was not a JSON array');
        }
        const providers = this.mapProviders(raw as RawProviderField[]);
        this.providersCache = {
          expiresAt: Date.now() + PROVIDERS_TTL_MS,
          data: providers,
        };
        return providers;
      } catch (err) {
        this.logger.error(
          `Failed to fetch LiteLLM providers: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Fall back to the bundled snapshot (never to an empty list) so the
        // provider picker stays populated through a transient fetch failure.
        // Not cached, so the next call retries the live source.
        return this.providersCache?.data ?? FALLBACK_PROVIDERS;
      }
    })().finally(() => {
      this.providersInFlight = null;
    });

    this.providersInFlight = promise;
    return promise;
  }

  // Upstream provider_create_fields.json carries multiple entries that collapse
  // to the same litellm_provider id (e.g. `openai` chat + its OpenAI-Compatible
  // variant). Dedupe by id so consumers never receive colliding keys.
  private mapProviders(raw: RawProviderField[]): LiteLlmProviderEntry[] {
    const seen = new Set<string>();
    const providers: LiteLlmProviderEntry[] = [];
    for (const p of raw) {
      if (seen.has(p.litellm_provider)) {
        continue;
      }
      seen.add(p.litellm_provider);
      providers.push({
        name: p.litellm_provider,
        label: p.provider_display_name,
        modelHint: p.default_model_placeholder ?? '',
      });
    }
    return providers;
  }

  async listCredentials() {
    const raw = await this.liteLlmClient.listCredentials();
    return {
      credentials: raw.map((c) => ({ credentialName: c.credential_name })),
    };
  }

  async createCredential(dto: CreateLiteLlmCredentialDto): Promise<void> {
    await this.liteLlmClient.createCredential({
      credential_name: dto.credentialName,
      credential_values: dto.credentialValues,
    });
  }

  async deleteCredential(name: string): Promise<void> {
    await this.liteLlmClient.deleteCredential(name);
  }

  private buildModelInfo(
    tags?: string[],
    modelInfo?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!tags?.length && !modelInfo) {
      return undefined;
    }
    return { ...modelInfo, ...(tags?.length ? { tags } : {}) };
  }

  private mapLitellmParams(
    params: Partial<CreateLiteLlmModelDto['litellmParams']>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (params.model) {
      out['model'] = params.model;
    }
    if (params.apiKey) {
      out['api_key'] = params.apiKey;
    }
    if (params.apiBase) {
      out['api_base'] = params.apiBase;
    }
    if (params.customLlmProvider) {
      out['custom_llm_provider'] = params.customLlmProvider;
    }
    if (params.maxTokens != null) {
      out['max_tokens'] = params.maxTokens;
    }
    if (params.temperature != null) {
      out['temperature'] = params.temperature;
    }
    if (params.requestTimeout != null) {
      out['request_timeout'] = params.requestTimeout;
    }
    if (params.customHeaders) {
      out['headers'] = params.customHeaders;
    }
    if (params.litellmCredentialName) {
      out['litellm_credential_name'] = params.litellmCredentialName;
    }
    return out;
  }
}
