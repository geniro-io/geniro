import type { DefaultLogger } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';

import type { RuntimeInstanceDao } from '../../../runtime/dao/runtime-instance.dao';
import { ClaudeKeepaliveService } from './claude-keepalive.service';

describe('ClaudeKeepaliveService', () => {
  let dao: {
    getOne: ReturnType<typeof vi.fn>;
    updateById: ReturnType<typeof vi.fn>;
  };
  let logger: DefaultLogger;
  let service: ClaudeKeepaliveService;

  beforeEach(() => {
    vi.useFakeTimers();
    dao = {
      getOne: vi.fn().mockResolvedValue({ id: 'ri-1' }),
      updateById: vi.fn().mockResolvedValue(1),
    };
    logger = mockDeep<DefaultLogger>();
    service = new ClaudeKeepaliveService(
      dao as unknown as RuntimeInstanceDao,
      logger,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const flushAsync = async () => {
    await vi.advanceTimersByTimeAsync(0);
  };

  it('throttles to at most one DB write per interval', async () => {
    const toucher = service.createToucher({
      runtimeNodeId: 'node-1',
      threadId: 't-1',
      minIntervalMs: 30_000,
    });

    toucher();
    toucher();
    toucher();
    await flushAsync();
    expect(dao.updateById).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_000);
    toucher();
    await flushAsync();
    expect(dao.updateById).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    toucher();
    await flushAsync();
    expect(dao.updateById).toHaveBeenCalledTimes(2);
  });

  it('updates lastUsedAt on the matching runtime instance', async () => {
    const toucher = service.createToucher({
      runtimeNodeId: 'node-1',
      threadId: 't-1',
    });

    toucher();
    await flushAsync();

    expect(dao.getOne).toHaveBeenCalledWith({
      nodeId: 'node-1',
      threadId: 't-1',
    });
    expect(dao.updateById).toHaveBeenCalledWith('ri-1', {
      lastUsedAt: expect.any(Date),
    });
  });

  it('skips the write when no runtime instance row matches', async () => {
    dao.getOne.mockResolvedValue(null);
    const toucher = service.createToucher({
      runtimeNodeId: 'node-1',
      threadId: 't-1',
    });

    toucher();
    await flushAsync();

    expect(dao.updateById).not.toHaveBeenCalled();
  });

  it('swallows DAO failures (logs a warning, never throws)', async () => {
    dao.getOne.mockRejectedValue(new Error('db gone'));
    const toucher = service.createToucher({
      runtimeNodeId: 'node-1',
      threadId: 't-1',
      minIntervalMs: 1_000,
    });

    expect(() => toucher()).not.toThrow();
    await flushAsync();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('node-1'));

    // A failed touch is retried on the next interval, not before.
    await vi.advanceTimersByTimeAsync(1_001);
    dao.getOne.mockResolvedValue({ id: 'ri-1' });
    toucher();
    await flushAsync();
    expect(dao.updateById).toHaveBeenCalledTimes(1);
  });
});
