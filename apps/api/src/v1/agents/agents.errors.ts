// Catch handler at simple-agent.ts:1165 emits the in-flight LangChain messages so the per-thread cost rollup includes the threshold-tripping LLM call. The error type therefore depends on the LangChain object model. Accepted coupling per spec gray-area resolution.
import { BaseMessage } from '@langchain/core/messages';

export class CostLimitExceededError extends Error {
  public readonly effectiveLimitUsd: number;
  public readonly totalPriceUsd: number;
  // declare (no emitted assignment) so Object.defineProperty controls the descriptor
  declare public readonly inFlightMessages?: BaseMessage[];

  constructor(
    effectiveLimitUsd: number,
    totalPriceUsd: number,
    inFlightMessages?: BaseMessage[],
  ) {
    super('COST_LIMIT_EXCEEDED');
    this.name = 'CostLimitExceededError';
    this.effectiveLimitUsd = effectiveLimitUsd;
    this.totalPriceUsd = totalPriceUsd;
    Object.defineProperty(this, 'inFlightMessages', {
      value: inFlightMessages,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  toJSON(): {
    name: string;
    message: string;
    effectiveLimitUsd: number;
    totalPriceUsd: number;
    inFlightMessageCount: number;
  } {
    return {
      name: this.name,
      message: this.message,
      effectiveLimitUsd: this.effectiveLimitUsd,
      totalPriceUsd: this.totalPriceUsd,
      inFlightMessageCount: this.inFlightMessages?.length ?? 0,
    };
  }
}
