import type { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LiteLlmClient } from './litellm.client';
import { LitellmVirtualKeyService } from './litellm-virtual-key.service';

const createMockClient = () =>
  ({
    generateKey: vi.fn(),
    updateKeyBudget: vi.fn(),
    deleteKeys: vi.fn(),
    getKeyInfo: vi.fn(),
  }) as unknown as LiteLlmClient;

const createMockLogger = () =>
  ({
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as DefaultLogger;

describe('LitellmVirtualKeyService', () => {
  let service: LitellmVirtualKeyService;
  let client: LiteLlmClient;
  let logger: DefaultLogger;

  beforeEach(() => {
    client = createMockClient();
    logger = createMockLogger();
    service = new LitellmVirtualKeyService(client, logger);
  });

  describe('issueThreadKey', () => {
    it('issues a key with a unique thread alias, default TTL and threadId metadata', async () => {
      vi.mocked(client.generateKey).mockResolvedValue({ key: 'sk-v' });

      const result = await service.issueThreadKey({
        threadId: 'thread-1',
        budgetUsd: 0.42,
      });

      expect(result).toEqual({ key: 'sk-v' });
      expect(client.generateKey).toHaveBeenCalledWith(
        expect.objectContaining({
          keyAlias: expect.stringMatching(/^geniro-thread-thread-1-/),
          maxBudgetUsd: 0.42,
          duration: '168h',
          metadata: { threadId: 'thread-1' },
        }),
      );
    });

    it('omits the budget when no cost limit is set', async () => {
      vi.mocked(client.generateKey).mockResolvedValue({ key: 'sk-v' });

      await service.issueThreadKey({ threadId: 'thread-3' });

      const params = vi.mocked(client.generateKey).mock.calls[0]![0];
      expect(params).not.toHaveProperty('maxBudgetUsd');
    });

    it('honors a custom TTL and merges extra metadata', async () => {
      vi.mocked(client.generateKey).mockResolvedValue({ key: 'sk-v' });

      await service.issueThreadKey({
        threadId: 'thread-2',
        budgetUsd: 1,
        ttl: '24h',
        metadata: { graphId: 'g1' },
      });

      expect(client.generateKey).toHaveBeenCalledWith(
        expect.objectContaining({
          keyAlias: expect.stringMatching(/^geniro-thread-thread-2-/),
          maxBudgetUsd: 1,
          duration: '24h',
          metadata: { threadId: 'thread-2', graphId: 'g1' },
        }),
      );
    });
  });

  describe('updateThreadKeyBudget', () => {
    it('delegates to the client', async () => {
      vi.mocked(client.updateKeyBudget).mockResolvedValue({});

      await service.updateThreadKeyBudget('sk-v', 0.9);

      expect(client.updateKeyBudget).toHaveBeenCalledWith('sk-v', 0.9);
    });
  });

  describe('revokeThreadKey', () => {
    it('deletes the key via the client', async () => {
      vi.mocked(client.deleteKeys).mockResolvedValue({});

      await service.revokeThreadKey('sk-v');

      expect(client.deleteKeys).toHaveBeenCalledWith(['sk-v']);
    });

    it('swallows client errors so the thread stop path never fails on revoke', async () => {
      vi.mocked(client.deleteKeys).mockRejectedValue(
        new Error('LiteLLM request failed: 404 Not Found'),
      );

      await expect(service.revokeThreadKey('sk-v')).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('404 Not Found'),
      );
    });
  });
});
