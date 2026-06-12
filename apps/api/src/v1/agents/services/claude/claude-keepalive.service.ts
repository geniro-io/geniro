import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';

import { RuntimeInstanceDao } from '../../../runtime/dao/runtime-instance.dao';

const DEFAULT_MIN_INTERVAL_MS = 30_000;

/**
 * Refreshes a runtime instance's `lastUsedAt` while a Claude session streams,
 * so the idle reaper (`RuntimeProvider.cleanupIdleRuntimes` — pure lastUsedAt
 * staleness, no liveness check) never kills a live session. Mirrors the
 * long-running-operation keepalive in repo-index.service.ts.
 */
@Injectable()
export class ClaudeKeepaliveService {
  constructor(
    private readonly runtimeInstanceDao: RuntimeInstanceDao,
    private readonly logger: DefaultLogger,
  ) {}

  /**
   * Returns a cheap synchronous toucher for stream-event handlers: throttled
   * to one DB write per interval, fire-and-forget, never throws.
   */
  createToucher(params: {
    runtimeNodeId: string;
    threadId: string;
    minIntervalMs?: number;
  }): () => void {
    const minInterval = params.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    let lastTouch = 0;
    let inFlight = false;

    return () => {
      const now = Date.now();
      if (inFlight || now - lastTouch < minInterval) {
        return;
      }
      lastTouch = now;
      inFlight = true;
      void this.touch(params.runtimeNodeId, params.threadId).finally(() => {
        inFlight = false;
      });
    };
  }

  private async touch(nodeId: string, threadId: string): Promise<void> {
    try {
      const instance = await this.runtimeInstanceDao.getOne({
        nodeId,
        threadId,
      });
      if (instance) {
        await this.runtimeInstanceDao.updateById(instance.id, {
          lastUsedAt: new Date(),
        });
      }
    } catch (error) {
      this.logger.warn(
        `Failed to refresh runtime lastUsedAt for node ${nodeId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
