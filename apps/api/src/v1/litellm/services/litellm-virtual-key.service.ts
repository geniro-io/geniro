import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';

import { LiteLLMGeneratedKey } from '../litellm.types';
import { LiteLlmClient } from './litellm.client';

/**
 * Per-thread LiteLLM virtual-key lifecycle.
 *
 * Policy:
 * - One scoped key per thread (alias `geniro-thread-<threadId>`), issued at
 *   session start with `max_budget` = the thread's remaining cost budget
 *   (effective limit minus prior thread spend — computed by the caller).
 *   The LiteLLM master key never leaves the API host; only the scoped key is
 *   injected into a sandbox.
 * - Keys carry a server-side TTL (default 7 days). TTL expiry IS the GC
 *   mechanism for crash-orphaned keys: if the API crashes or a thread row is
 *   deleted without an explicit revoke, the key stops working on its own and
 *   LiteLLM purges it — no cross-module sweep is required.
 * - Explicit revoke on thread stop/completion is best-effort and idempotent:
 *   a key that is already deleted or expired must not fail the stop path.
 * - LiteLLM tracks key spend asynchronously (batched writes), so budget
 *   enforcement can lag a billed call by seconds; the worst-case overshoot is
 *   one in-flight turn. The thread-level cost limit remains the authoritative
 *   guard — the key budget is defense-in-depth against a hijacked sandbox.
 */
@Injectable()
export class LitellmVirtualKeyService {
  private static readonly KEY_ALIAS_PREFIX = 'geniro-thread-';
  private static readonly DEFAULT_TTL = '168h'; // 7 days

  constructor(
    private readonly client: LiteLlmClient,
    private readonly logger: DefaultLogger,
  ) {}

  async issueThreadKey(params: {
    threadId: string;
    /** Omit when the thread has no cost limit — TTL stays the only bound. */
    budgetUsd?: number;
    /**
     * LiteLLM model aliases the key may call. Always pass these for keys that
     * enter a sandbox — an unscoped key lets exfiltrated credentials bill any
     * registered model.
     */
    models?: string[];
    metadata?: Record<string, unknown>;
    ttl?: string;
  }): Promise<LiteLLMGeneratedKey> {
    return await this.client.generateKey({
      keyAlias: this.buildAlias(params.threadId),
      ...(params.budgetUsd !== undefined && { maxBudgetUsd: params.budgetUsd }),
      ...(params.models?.length && { models: params.models }),
      duration: params.ttl ?? LitellmVirtualKeyService.DEFAULT_TTL,
      metadata: { threadId: params.threadId, ...params.metadata },
    });
  }

  /** Reserved for M2 mid-run budget tightening (no production caller yet). */
  async updateThreadKeyBudget(key: string, budgetUsd: number): Promise<void> {
    await this.client.updateKeyBudget(key, budgetUsd);
  }

  async revokeThreadKey(key: string): Promise<void> {
    try {
      await this.client.deleteKeys([key]);
    } catch (err) {
      // Idempotent revoke: an already-deleted/expired key must not fail the
      // thread stop path. TTL expiry covers the leak either way.
      this.logger.warn(
        `Failed to revoke LiteLLM virtual key (ignored — TTL expiry is the backstop): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Aliases must be unique in LiteLLM; one thread issues a fresh key per turn
   * (best-effort revoke can lag), so a per-issue suffix avoids collisions.
   */
  private buildAlias(threadId: string): string {
    const suffix = Date.now().toString(36);
    return `${LitellmVirtualKeyService.KEY_ALIAS_PREFIX}${threadId}-${suffix}`;
  }
}
