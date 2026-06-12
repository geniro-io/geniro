import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';

import { environment } from '../../../environments';
import {
  LiteLLMGeneratedKey,
  LiteLLMKeyGenerateParams,
  LiteLLMKeyInfo,
  LiteLLMModelInfo,
} from '../litellm.types';

@Injectable()
export class LiteLlmClient {
  private static readonly MODEL_LIST_TTL_MS = 5 * 60 * 1000; // 5min
  private static readonly MAX_ERROR_MESSAGE_LENGTH = 200;

  constructor(private readonly logger: DefaultLogger) {}

  private modelListCache: {
    expiresAt: number;
    data: LiteLLMModelInfo[];
  } | null = null;
  private modelListInFlight: Promise<LiteLLMModelInfo[]> | null = null;

  private async request<T>(
    path: string,
    options?: { method?: string; body?: unknown },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${environment.litellmMasterKey}`,
    };
    if (options?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const fetchOptions: RequestInit = {
      headers,
      signal: AbortSignal.timeout(30_000),
    };
    if (options?.method) {
      fetchOptions.method = options.method;
    }
    if (options?.body !== undefined) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(
      `${environment.llmBaseUrl}${path}`,
      fetchOptions,
    );

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      if (bodyText) {
        this.logger.debug(`LiteLLM error response body: ${bodyText}`);
      }
      throw new Error(
        `LiteLLM request failed: ${response.status} ${response.statusText}`,
      );
    }

    return response.json() as Promise<T>;
  }

  invalidateCache(): void {
    this.modelListCache = null;
    this.modelListInFlight = null;
  }

  async createModel(payload: unknown): Promise<unknown> {
    return this.request('/model/new', { method: 'POST', body: payload });
  }

  async updateModel(payload: unknown): Promise<unknown> {
    return this.request('/model/update', { method: 'POST', body: payload });
  }

  async deleteModel(id: string): Promise<unknown> {
    return this.request('/model/delete', { method: 'POST', body: { id } });
  }

  async testModel(
    model: string,
  ): Promise<{ success: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await this.request('/v1/chat/completions', {
        method: 'POST',
        body: {
          model,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 16,
        },
      });
      return { success: true, latencyMs: Date.now() - start };
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const sanitizedError =
        rawMessage.length > LiteLlmClient.MAX_ERROR_MESSAGE_LENGTH
          ? rawMessage.slice(0, LiteLlmClient.MAX_ERROR_MESSAGE_LENGTH) + '...'
          : rawMessage;
      return {
        success: false,
        latencyMs: Date.now() - start,
        error: sanitizedError,
      };
    }
  }

  async generateKey(
    params: LiteLLMKeyGenerateParams,
  ): Promise<LiteLLMGeneratedKey> {
    const body: Record<string, unknown> = {
      key_alias: params.keyAlias,
    };
    if (params.maxBudgetUsd !== undefined) {
      body['max_budget'] = params.maxBudgetUsd;
    }
    if (params.models?.length) {
      body['models'] = params.models;
    }
    if (params.duration) {
      body['duration'] = params.duration;
    }
    if (params.metadata) {
      body['metadata'] = params.metadata;
    }
    return this.request('/key/generate', { method: 'POST', body });
  }

  async updateKeyBudget(key: string, maxBudgetUsd: number): Promise<unknown> {
    return this.request('/key/update', {
      method: 'POST',
      body: { key, max_budget: maxBudgetUsd },
    });
  }

  async deleteKeys(keys: string[]): Promise<unknown> {
    return this.request('/key/delete', { method: 'POST', body: { keys } });
  }

  /**
   * Reserved for M2 spend verification / key GC audits (no production caller
   * yet). Before wiring a caller, switch to the POST `/key/info` body form —
   * a key in the query string can surface in proxy access logs.
   */
  async getKeyInfo(key: string): Promise<LiteLLMKeyInfo> {
    const response = await this.request<{ info: LiteLLMKeyInfo }>(
      `/key/info?key=${encodeURIComponent(key)}`,
    );
    return response.info;
  }

  async listCredentials(): Promise<{ credential_name: string }[]> {
    const response = await this.request<{
      credentials: { credential_name: string }[];
    }>('/credentials');
    return Array.isArray(response.credentials) ? response.credentials : [];
  }

  async createCredential(payload: {
    credential_name: string;
    credential_values: Record<string, string>;
  }): Promise<unknown> {
    return this.request('/credentials', {
      method: 'POST',
      body: { ...payload, credential_info: {} },
    });
  }

  async deleteCredential(name: string): Promise<unknown> {
    return this.request(`/credentials/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  }

  /**
   * Test a model connection by calling the provider's API directly,
   * bypassing the LiteLLM proxy (no model registration needed).
   */
  async testModelDirect(params: {
    model: string;
    apiKey: string;
    apiBase?: string;
  }): Promise<{ success: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      // Parse provider prefix and model ID from LiteLLM model string
      // e.g. "openrouter/google/gemini-3-flash" → provider="openrouter", modelId="google/gemini-3-flash"
      const slashIndex = params.model.indexOf('/');
      const modelId =
        slashIndex > 0 ? params.model.slice(slashIndex + 1) : params.model;

      // Use provided apiBase, or fall back to LiteLLM proxy
      const baseUrl = params.apiBase ?? `${environment.llmBaseUrl}`;
      const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 16,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        const errorMsg = bodyText
          ? `${response.status}: ${bodyText.slice(0, LiteLlmClient.MAX_ERROR_MESSAGE_LENGTH)}`
          : `${response.status} ${response.statusText}`;
        return {
          success: false,
          latencyMs: Date.now() - start,
          error: errorMsg,
        };
      }

      return { success: true, latencyMs: Date.now() - start };
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const sanitizedError =
        rawMessage.length > LiteLlmClient.MAX_ERROR_MESSAGE_LENGTH
          ? rawMessage.slice(0, LiteLlmClient.MAX_ERROR_MESSAGE_LENGTH) + '...'
          : rawMessage;
      return {
        success: false,
        latencyMs: Date.now() - start,
        error: sanitizedError,
      };
    }
  }

  /**
   * Test a model via the LiteLLM proxy using a temporary model registration.
   * Creates a temp model with the given params, sends a test request, then deletes it.
   * This allows testing with saved credentials that only LiteLLM can resolve.
   */
  async testModelViaProxy(params: {
    model: string;
    apiBase?: string;
    litellmCredentialName?: string;
  }): Promise<{ success: boolean; latencyMs: number; error?: string }> {
    const tempModelName = `__test_${crypto.randomUUID()}`;
    const start = Date.now();
    let modelId: string | undefined;

    try {
      const litellmParams: Record<string, unknown> = {
        model: params.model,
      };
      if (params.apiBase) {
        litellmParams['api_base'] = params.apiBase;
      }
      if (params.litellmCredentialName) {
        litellmParams['litellm_credential_name'] = params.litellmCredentialName;
      }

      const createResult = await this.request<{
        model_info?: { id?: string };
      }>('/model/new', {
        method: 'POST',
        body: { model_name: tempModelName, litellm_params: litellmParams },
      });
      modelId = createResult.model_info?.id;

      // Send a test completion through the proxy — LiteLLM resolves the credential
      await this.request('/v1/chat/completions', {
        method: 'POST',
        body: {
          model: tempModelName,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 16,
        },
      });

      return { success: true, latencyMs: Date.now() - start };
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const sanitizedError =
        rawMessage.length > LiteLlmClient.MAX_ERROR_MESSAGE_LENGTH
          ? rawMessage.slice(0, LiteLlmClient.MAX_ERROR_MESSAGE_LENGTH) + '...'
          : rawMessage;
      return {
        success: false,
        latencyMs: Date.now() - start,
        error: sanitizedError,
      };
    } finally {
      // Always clean up the temporary model
      if (modelId) {
        await this.deleteModel(modelId).catch((err) => {
          this.logger.error(
            `Failed to delete temp test model ${tempModelName}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      this.invalidateCache();
    }
  }

  async getModelInfo(model: string): Promise<LiteLLMModelInfo | null> {
    const models = await this.fetchModelList();
    const match = models.find((m) => m.model_name === model);
    if (!match || !match.model_name) {
      return null;
    }

    return match;
  }

  /**
   * Fetches the full model info list from LiteLLM, with in-memory caching
   * and in-flight deduplication to avoid redundant HTTP requests.
   */
  async fetchModelList(): Promise<LiteLLMModelInfo[]> {
    const now = Date.now();
    if (this.modelListCache && this.modelListCache.expiresAt > now) {
      return this.modelListCache.data;
    }

    if (this.modelListInFlight) {
      return this.modelListInFlight;
    }

    const promise = (async () => {
      const response = await this.request<{ data: LiteLLMModelInfo[] }>(
        '/v1/model/info',
      );
      const models = Array.isArray(response.data) ? response.data : [];
      this.modelListCache = {
        expiresAt: Date.now() + LiteLlmClient.MODEL_LIST_TTL_MS,
        data: models,
      };
      return models;
    })().finally(() => {
      this.modelListInFlight = null;
    });

    this.modelListInFlight = promise;
    return promise;
  }
}
