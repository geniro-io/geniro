import { raw } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { RequestTokenUsage } from '../../litellm/litellm.types';
import { MessageEntity } from '../entity/message.entity';

@Injectable()
export class MessagesDao extends BaseDao<MessageEntity> {
  constructor(em: EntityManager) {
    super(em, MessageEntity);
  }

  /**
   * Aggregates requestTokenUsage for all messages whose nodeId contains the
   * subagent surrogate separator ('::sub::'), grouped by nodeId.
   *
   * Numeric columns come back as strings from Postgres numeric aggregates —
   * each value is explicitly coerced via Number().
   *
   * currentContext and durationMs are intentionally excluded: they are
   * point-in-time measurements that cannot be meaningfully summed.
   */
  async aggregateUsageBySubagentNodeId(
    threadId: string,
    txEm?: EntityManager,
  ): Promise<Map<string, RequestTokenUsage>> {
    const rows = await (txEm ?? this.em)
      .createQueryBuilder(MessageEntity, 'm')
      .select([
        'm.nodeId',
        raw(
          `coalesce(sum((m.request_token_usage->>'inputTokens')::numeric), 0) as input_tokens`,
        ),
        raw(
          `coalesce(sum((m.request_token_usage->>'cachedInputTokens')::numeric), 0) as cached_input_tokens`,
        ),
        raw(
          `coalesce(sum((m.request_token_usage->>'outputTokens')::numeric), 0) as output_tokens`,
        ),
        raw(
          `coalesce(sum((m.request_token_usage->>'reasoningTokens')::numeric), 0) as reasoning_tokens`,
        ),
        raw(
          `coalesce(sum((m.request_token_usage->>'totalTokens')::numeric), 0) as total_tokens`,
        ),
        raw(
          `coalesce(sum((m.request_token_usage->>'totalPrice')::numeric), 0) as total_price`,
        ),
      ])
      .where({
        threadId,
        nodeId: { $like: '%::sub::%' },
        requestTokenUsage: { $ne: null },
      })
      .groupBy('m.nodeId')
      .execute<
        {
          nodeId: string;
          input_tokens: string;
          cached_input_tokens: string;
          output_tokens: string;
          reasoning_tokens: string;
          total_tokens: string;
          total_price: string;
        }[]
      >();

    const result = new Map<string, RequestTokenUsage>();
    for (const row of rows) {
      result.set(row.nodeId, {
        inputTokens: Number(row.input_tokens),
        cachedInputTokens: Number(row.cached_input_tokens),
        outputTokens: Number(row.output_tokens),
        reasoningTokens: Number(row.reasoning_tokens),
        totalTokens: Number(row.total_tokens),
        totalPrice: Number(row.total_price),
      });
    }
    return result;
  }
}
