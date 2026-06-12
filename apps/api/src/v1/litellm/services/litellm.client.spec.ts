import type { DefaultLogger } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiteLlmClient } from './litellm.client';

vi.mock('../../../environments', () => ({
  environment: {
    llmBaseUrl: 'http://litellm:4000',
    litellmMasterKey: 'test-master-key',
  },
}));

function stubFetch(response: Partial<Response>) {
  const defaults: Response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(''),
  } as unknown as Response;

  const merged = { ...defaults, ...response };
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(merged as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const createMockLogger = () =>
  ({
    log: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }) as unknown as DefaultLogger;

describe('LiteLlmClient', () => {
  let client: LiteLlmClient;
  let mockLogger: DefaultLogger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    client = new LiteLlmClient(mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('request (via fetchModelList)', () => {
    it('rejects with an error containing status code on non-ok response', async () => {
      stubFetch({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: vi.fn().mockResolvedValue('upstream error details'),
      });

      await expect(client.fetchModelList()).rejects.toThrow(
        'LiteLLM request failed: 500 Internal Server Error',
      );
    });

    it('logs response body at debug level and excludes it from error message', async () => {
      stubFetch({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: vi.fn().mockResolvedValue('gateway timeout details'),
      });

      await expect(client.fetchModelList()).rejects.toThrow(
        'LiteLLM request failed: 502 Bad Gateway',
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'LiteLLM error response body: gateway timeout details',
      );
    });

    it('handles text() failure gracefully in error path', async () => {
      stubFetch({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: vi.fn().mockRejectedValue(new Error('read failed')),
      });

      await expect(client.fetchModelList()).rejects.toThrow(
        'LiteLLM request failed: 503 Service Unavailable',
      );
    });

    it('returns parsed JSON data on successful response', async () => {
      const modelData = [
        {
          model_name: 'gpt-4',
          litellm_params: { model: 'openai/gpt-4' },
          model_info: { key: 'gpt-4' },
        },
        {
          model_name: 'claude-3',
          litellm_params: { model: 'anthropic/claude-3' },
          model_info: { key: 'claude-3' },
        },
      ];

      stubFetch({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: vi.fn().mockResolvedValue({ data: modelData }),
      });

      const result = await client.fetchModelList();

      expect(result).toEqual(modelData);
    });

    it('sends Authorization header with bearer token', async () => {
      const fetchMock = stubFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: [] }),
      });

      await client.fetchModelList();

      expect(fetchMock).toHaveBeenCalledOnce();
      const call = fetchMock.mock.calls[0]!;
      expect(call[0]).toBe('http://litellm:4000/v1/model/info');
      expect(call[1]).toBeDefined();
      expect((call[1] as RequestInit).headers).toEqual(
        expect.objectContaining({
          Authorization: 'Bearer test-master-key',
        }),
      );
    });

    it('includes AbortSignal timeout in fetch options', async () => {
      const fetchMock = stubFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: [] }),
      });

      await client.fetchModelList();

      const call = fetchMock.mock.calls[0]!;
      expect((call[1] as RequestInit).signal).toBeDefined();
    });
  });

  describe('getModelInfo', () => {
    it('returns matching model info', async () => {
      const modelInfo = {
        model_name: 'gpt-4',
        litellm_params: { model: 'openai/gpt-4' },
        model_info: { key: 'gpt-4' },
      };

      stubFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: [modelInfo] }),
      });

      const result = await client.getModelInfo('gpt-4');

      expect(result).toEqual(modelInfo);
    });

    it('returns null when model is not found', async () => {
      stubFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: [] }),
      });

      const result = await client.getModelInfo('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('createModel', () => {
    it('sends POST to /model/new with the given payload', async () => {
      const payload = {
        model_name: 'my-model',
        litellm_params: { model: 'openai/gpt-4' },
      };
      const fetchMock = stubFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 'new-id' }),
      });

      const result = await client.createModel(payload);

      expect(result).toEqual({ id: 'new-id' });
      expect(fetchMock).toHaveBeenCalledOnce();
      const call = fetchMock.mock.calls[0]!;
      expect(call[0]).toBe('http://litellm:4000/model/new');
      expect((call[1] as RequestInit).method).toBe('POST');
      expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual(
        payload,
      );
    });
  });

  describe('deleteModel', () => {
    it('sends POST to /model/delete with { id } body', async () => {
      const fetchMock = stubFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ deleted: true }),
      });

      await client.deleteModel('model-123');

      expect(fetchMock).toHaveBeenCalledOnce();
      const call = fetchMock.mock.calls[0]!;
      expect(call[0]).toBe('http://litellm:4000/model/delete');
      expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
        id: 'model-123',
      });
    });
  });

  describe('testModel', () => {
    it('returns success with latency on successful completion', async () => {
      stubFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ choices: [] }),
      });

      const result = await client.testModel('gpt-4');

      expect(result.success).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it('returns failure without throwing on non-ok response', async () => {
      stubFetch({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: vi.fn().mockResolvedValue('invalid model'),
      });

      const result = await client.testModel('nonexistent-model');

      expect(result.success).toBe(false);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toContain('400');
    });
  });

  describe('invalidateCache', () => {
    it('causes fetchModelList to issue a new HTTP request after invalidation', async () => {
      const fetchMock = stubFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: [] }),
      });

      await client.fetchModelList();
      expect(fetchMock).toHaveBeenCalledOnce();

      // Second call should use cache
      await client.fetchModelList();
      expect(fetchMock).toHaveBeenCalledOnce();

      // Invalidate and call again — should issue a new request
      client.invalidateCache();
      await client.fetchModelList();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('key management', () => {
    it('generateKey posts alias, budget, duration and metadata to /key/generate', async () => {
      const fetchMock = stubFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ key: 'sk-virtual', expires: null }),
      });

      const result = await client.generateKey({
        keyAlias: 'geniro-thread-t1',
        maxBudgetUsd: 0.5,
        duration: '168h',
        metadata: { threadId: 't1' },
      });

      expect(result).toEqual({ key: 'sk-virtual', expires: null });
      const call = fetchMock.mock.calls[0]!;
      expect(call[0]).toBe('http://litellm:4000/key/generate');
      expect((call[1] as RequestInit).method).toBe('POST');
      expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
        key_alias: 'geniro-thread-t1',
        max_budget: 0.5,
        duration: '168h',
        metadata: { threadId: 't1' },
      });
    });

    it('generateKey omits duration and metadata when not provided', async () => {
      const fetchMock = stubFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ key: 'sk-virtual' }),
      });

      await client.generateKey({ keyAlias: 'a', maxBudgetUsd: 1 });

      const body = JSON.parse(
        (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body).toEqual({ key_alias: 'a', max_budget: 1 });
    });

    it('updateKeyBudget posts key and max_budget to /key/update', async () => {
      const fetchMock = stubFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });

      await client.updateKeyBudget('sk-virtual', 0.75);

      const call = fetchMock.mock.calls[0]!;
      expect(call[0]).toBe('http://litellm:4000/key/update');
      expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
        key: 'sk-virtual',
        max_budget: 0.75,
      });
    });

    it('deleteKeys posts the keys array to /key/delete', async () => {
      const fetchMock = stubFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });

      await client.deleteKeys(['sk-a', 'sk-b']);

      const call = fetchMock.mock.calls[0]!;
      expect(call[0]).toBe('http://litellm:4000/key/delete');
      expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
        keys: ['sk-a', 'sk-b'],
      });
    });

    it('getKeyInfo URL-encodes the key and unwraps the info envelope', async () => {
      const fetchMock = stubFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({
          info: { key_alias: 'geniro-thread-t1', max_budget: 0.5, spend: 0.1 },
        }),
      });

      const info = await client.getKeyInfo('sk-virtual/with?chars');

      expect(info).toEqual({
        key_alias: 'geniro-thread-t1',
        max_budget: 0.5,
        spend: 0.1,
      });
      expect(fetchMock.mock.calls[0]![0]).toBe(
        'http://litellm:4000/key/info?key=sk-virtual%2Fwith%3Fchars',
      );
    });
  });
});
