import type { DefaultLogger } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiteLLMModelInfo } from '../litellm.types';
import type { LiteLlmClient } from './litellm.client';
import { LiteLlmAdminService } from './litellm-admin.service';

const createMockClient = () => ({
  fetchModelList: vi
    .fn<() => Promise<LiteLLMModelInfo[]>>()
    .mockResolvedValue([]),
  createModel: vi.fn().mockResolvedValue({}),
  updateModel: vi.fn().mockResolvedValue({}),
  deleteModel: vi.fn().mockResolvedValue({}),
  testModel: vi.fn().mockResolvedValue({ success: true, latencyMs: 42 }),
  invalidateCache: vi.fn(),
  listCredentials: vi.fn().mockResolvedValue([]),
  createCredential: vi.fn().mockResolvedValue({}),
  deleteCredential: vi.fn().mockResolvedValue({}),
});

const createMockLogger = () =>
  ({
    log: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }) as unknown as DefaultLogger;

describe('LiteLlmAdminService', () => {
  let service: LiteLlmAdminService;
  let client: ReturnType<typeof createMockClient>;
  let logger: DefaultLogger;

  beforeEach(() => {
    client = createMockClient();
    logger = createMockLogger();
    service = new LiteLlmAdminService(
      client as unknown as LiteLlmClient,
      logger,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listModelsInfo', () => {
    it('maps LiteLLM response fields to camelCase DTO correctly', async () => {
      const models: LiteLLMModelInfo[] = [
        {
          model_name: 'my-gpt4',
          litellm_params: {
            model: 'openai/gpt-4',
            api_base: 'https://custom.api.com',
            custom_llm_provider: 'azure',
          },
          model_info: {
            id: 'db-id-1',
            key: 'gpt-4',
            supports_function_calling: true,
            supports_native_streaming: true,
            supports_reasoning: false,
          },
        },
      ];
      client.fetchModelList.mockResolvedValue(models);

      const result = await service.listModelsInfo();

      expect(result).toEqual([
        {
          id: 'db-id-1',
          modelName: 'my-gpt4',
          providerModel: 'openai/gpt-4',
          apiBase: 'https://custom.api.com',
          customLlmProvider: 'azure',
          supportsToolCalling: true,
          supportsStreaming: true,
          supportsReasoning: false,
        },
      ]);
    });

    it('filters out models without model_info.id', async () => {
      const models: LiteLLMModelInfo[] = [
        {
          model_name: 'has-id',
          litellm_params: { model: 'openai/gpt-4' },
          model_info: { id: 'db-id-1', key: 'gpt-4' },
        },
        {
          model_name: 'no-id',
          litellm_params: { model: 'openai/gpt-3.5' },
          model_info: { key: 'gpt-3.5' },
        },
        {
          model_name: 'null-info',
          litellm_params: { model: 'openai/gpt-3' },
          model_info: null,
        },
      ];
      client.fetchModelList.mockResolvedValue(models);

      const result = await service.listModelsInfo();

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('db-id-1');
    });
  });

  describe('createModel', () => {
    it('calls client with snake_case payload and invalidates cache', async () => {
      const dto = {
        modelName: 'my-model',
        litellmParams: {
          model: 'openai/gpt-4o',
          apiKey: 'sk-test',
          apiBase: 'https://api.example.com',
          maxTokens: 4096,
        },
      };

      await service.createModel(dto);

      expect(client.createModel).toHaveBeenCalledWith({
        model_name: 'my-model',
        litellm_params: {
          model: 'openai/gpt-4o',
          api_key: 'sk-test',
          api_base: 'https://api.example.com',
          max_tokens: 4096,
        },
      });
      expect(client.invalidateCache).toHaveBeenCalledOnce();
    });
  });

  describe('createModel — tags and modelInfo', () => {
    it('includes tags in model_info when provided', async () => {
      await service.createModel({
        modelName: 'tagged-model',
        litellmParams: { model: 'openai/gpt-4o' },
        tags: ['production', 'fast'],
      });

      expect(client.createModel).toHaveBeenCalledWith(
        expect.objectContaining({
          model_info: { tags: ['production', 'fast'] },
        }),
      );
    });

    it('includes modelInfo in model_info when provided', async () => {
      await service.createModel({
        modelName: 'info-model',
        litellmParams: { model: 'openai/gpt-4o' },
        modelInfo: { mode: 'chat', max_input_tokens: 128000 },
      });

      expect(client.createModel).toHaveBeenCalledWith(
        expect.objectContaining({
          model_info: { mode: 'chat', max_input_tokens: 128000 },
        }),
      );
    });

    it('includes both tags and modelInfo when both are provided', async () => {
      await service.createModel({
        modelName: 'full-model',
        litellmParams: { model: 'openai/gpt-4o' },
        tags: ['staging'],
        modelInfo: { mode: 'chat' },
      });

      expect(client.createModel).toHaveBeenCalledWith(
        expect.objectContaining({
          model_info: { mode: 'chat', tags: ['staging'] },
        }),
      );
    });

    it('omits model_info when neither tags nor modelInfo are provided', async () => {
      await service.createModel({
        modelName: 'plain-model',
        litellmParams: { model: 'openai/gpt-4o' },
      });

      const payload = client.createModel.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(payload).not.toHaveProperty('model_info');
    });

    it('maps litellmCredentialName to litellm_credential_name', async () => {
      await service.createModel({
        modelName: 'cred-model',
        litellmParams: {
          model: 'openai/gpt-4o',
          litellmCredentialName: 'my-credential',
        },
      });

      expect(client.createModel).toHaveBeenCalledWith(
        expect.objectContaining({
          litellm_params: expect.objectContaining({
            litellm_credential_name: 'my-credential',
          }),
        }),
      );
    });
  });

  describe('updateModel', () => {
    it('calls client with model_id and snake_case params', async () => {
      const dto = {
        modelId: 'db-id-1',
        modelName: 'updated-name',
        litellmParams: { temperature: 0.5 },
      };

      await service.updateModel(dto);

      expect(client.updateModel).toHaveBeenCalledWith({
        model_id: 'db-id-1',
        model_name: 'updated-name',
        litellm_params: { temperature: 0.5 },
      });
      expect(client.invalidateCache).toHaveBeenCalledOnce();
    });

    it('includes tags and modelInfo in model_info when provided', async () => {
      await service.updateModel({
        modelId: 'db-id-1',
        tags: ['prod'],
        modelInfo: { mode: 'embedding' },
      });

      expect(client.updateModel).toHaveBeenCalledWith(
        expect.objectContaining({
          model_info: { mode: 'embedding', tags: ['prod'] },
        }),
      );
    });
  });

  describe('deleteModel', () => {
    it('calls client and invalidates cache', async () => {
      await service.deleteModel('db-id-1');

      expect(client.deleteModel).toHaveBeenCalledWith('db-id-1');
      expect(client.invalidateCache).toHaveBeenCalledOnce();
    });
  });

  describe('testModel', () => {
    it('delegates to client and returns result', async () => {
      const expected = { success: true, latencyMs: 42 };
      client.testModel.mockResolvedValue(expected);

      const result = await service.testModel('gpt-4');

      expect(client.testModel).toHaveBeenCalledWith('gpt-4');
      expect(result).toEqual(expected);
    });
  });

  describe('listProviders', () => {
    it('fetches providers from GitHub and caches them', async () => {
      const mockProviders = [
        {
          litellm_provider: 'openai',
          provider_display_name: 'OpenAI',
          default_model_placeholder: 'gpt-4o',
        },
        {
          litellm_provider: 'anthropic',
          provider_display_name: 'Anthropic',
          default_model_placeholder: 'claude-sonnet-4-20250514',
        },
      ];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockProviders),
      } as Response);

      const result = await service.listProviders();

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(result.providers).toEqual([
        { name: 'openai', label: 'OpenAI', modelHint: 'gpt-4o' },
        {
          name: 'anthropic',
          label: 'Anthropic',
          modelHint: 'claude-sonnet-4-20250514',
        },
      ]);

      // Second call should use cache
      const result2 = await service.listProviders();
      expect(fetchSpy).toHaveBeenCalledOnce(); // still 1 call
      expect(result2.providers).toEqual(result.providers);

      fetchSpy.mockRestore();
    });

    it('dedupes providers that share the same litellm_provider id', async () => {
      const mockProviders = [
        {
          litellm_provider: 'openai',
          provider_display_name: 'OpenAI',
          default_model_placeholder: 'gpt-4o',
        },
        {
          litellm_provider: 'openai',
          provider_display_name: 'OpenAI-Compatible Endpoints',
        },
        {
          litellm_provider: 'anthropic',
          provider_display_name: 'Anthropic',
          default_model_placeholder: 'claude-3-opus',
        },
      ];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockProviders),
      } as Response);

      const result = await service.listProviders();

      const names = result.providers.map((p) => p.name);
      expect(names).toEqual(['openai', 'anthropic']);
      expect(new Set(names).size).toBe(names.length);
      expect(result.providers[0]).toEqual({
        name: 'openai',
        label: 'OpenAI',
        modelHint: 'gpt-4o',
      });

      fetchSpy.mockRestore();
    });

    it('rethrows and logs on fetch failure when there is no cache', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Network error'));

      await expect(service.listProviders()).rejects.toThrow('Network error');
      expect(logger.error as ReturnType<typeof vi.fn>).toHaveBeenCalled();

      fetchSpy.mockRestore();
    });

    it('rethrows and logs when the response is not a JSON array (no cache)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ not: 'an-array' }),
      } as Response);

      await expect(service.listProviders()).rejects.toThrow(
        'Provider list response was not a JSON array',
      );
      expect(logger.error as ReturnType<typeof vi.fn>).toHaveBeenCalled();

      fetchSpy.mockRestore();
    });

    it('serves a stale cache (does not throw) when a refresh fails', async () => {
      const cached = [{ name: 'cached', label: 'Cached', modelHint: 'm' }];
      (
        service as unknown as {
          providersCache: { expiresAt: number; data: typeof cached };
        }
      ).providersCache = { expiresAt: Date.now() - 1_000, data: cached };

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Network error'));

      const result = await service.listProviders();

      expect(result.providers).toEqual(cached);
      expect(logger.error as ReturnType<typeof vi.fn>).toHaveBeenCalled();

      fetchSpy.mockRestore();
    });
  });

  describe('listCredentials', () => {
    it('maps credential_name to camelCase credentialName', async () => {
      client.listCredentials.mockResolvedValue([
        { credential_name: 'azure-prod' },
      ]);
      const result = await service.listCredentials();
      expect(result.credentials).toEqual([{ credentialName: 'azure-prod' }]);
    });

    it('returns empty array when LiteLLM returns empty list', async () => {
      client.listCredentials.mockResolvedValue([]);
      const result = await service.listCredentials();
      expect(result.credentials).toHaveLength(0);
    });
  });

  describe('createCredential', () => {
    it('calls client with snake_case payload', async () => {
      await service.createCredential({
        credentialName: 'openai-prod',
        credentialValues: { api_key: 'sk-test' },
      });
      expect(client.createCredential).toHaveBeenCalledWith({
        credential_name: 'openai-prod',
        credential_values: { api_key: 'sk-test' },
      });
    });
  });

  describe('deleteCredential', () => {
    it('delegates to client with the credential name', async () => {
      await service.deleteCredential('azure-prod');
      expect(client.deleteCredential).toHaveBeenCalledWith('azure-prod');
    });
  });
});
