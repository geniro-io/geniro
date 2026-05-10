import { z } from 'zod';

import type { LoadedFixture } from './ws-replay.types';

// Per-event schemas — each uses z.literal for the discriminator field
// and .passthrough() to allow extra envelope fields from BaseNotification
// (ownerId, scope, runId, etc.) without failing validation.

// Strict schema for per-request token usage. z.number().finite() rejects
// Infinity/-Infinity/NaN (which z.number() alone allows) and also rejects
// string-typed values that a Decimal serializer might emit. totalPrice is
// intentionally not .nonnegative() because refund credits can produce negative
// values; token counts are always zero-or-positive.
const TokenUsageSchema = z.object({
  inputTokens: z.number().finite().nonnegative().optional(),
  cachedInputTokens: z.number().finite().nonnegative().optional(),
  outputTokens: z.number().finite().nonnegative().optional(),
  reasoningTokens: z.number().finite().nonnegative().optional(),
  totalTokens: z.number().finite().nonnegative().optional(),
  totalPrice: z.number().finite().optional(),
  currentContext: z.number().finite().nonnegative().optional(),
});

const AgentMessageEventSchema = z
  .object({
    type: z.literal('agent.message'),
    internalThreadId: z.string(),
    threadId: z.string(),
    nodeId: z.string(),
    graphId: z.string(),
    data: z
      .object({
        id: z.string(),
        threadId: z.string(),
        createdAt: z.string(),
        nodeId: z.string(),
        message: z.object({ role: z.string() }).passthrough(),
        requestTokenUsage: TokenUsageSchema.nullish(),
        toolTokenUsage: TokenUsageSchema.nullish(),
      })
      .passthrough(),
  })
  .passthrough();

const AgentStateUpdateEventSchema = z
  .object({
    type: z.literal('agent.state.update'),
    threadId: z.string(),
    nodeId: z.string(),
    graphId: z.string(),
    data: z
      .object({
        currentContext: z.number().optional(),
        effectiveCostLimitUsd: z.number().nullish(),
        // Keyed by toolCallId; value is cumulative in-flight spend for that
        // subagent invocation. A value of 0 acts as a sentinel to clear the
        // live suffix from the thread header once the subagent tool result
        // lands. Present only on the __subagentCommunication: true path.
        inFlightSubagentPrice: z.record(z.string(), z.number()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const ThreadDtoNarrowSchema = z
  .object({
    id: z.string(),
    graphId: z.string(),
    status: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const ThreadCreateEventSchema = z
  .object({
    type: z.literal('thread.create'),
    threadId: z.string(),
    internalThreadId: z.string(),
    graphId: z.string(),
    data: ThreadDtoNarrowSchema,
  })
  .passthrough();

const ThreadUpdateEventSchema = z
  .object({
    type: z.literal('thread.update'),
    threadId: z.string(),
    internalThreadId: z.string(),
    graphId: z.string(),
    data: ThreadDtoNarrowSchema,
  })
  .passthrough();

const ThreadDeleteEventSchema = z
  .object({
    type: z.literal('thread.delete'),
    threadId: z.string(),
    internalThreadId: z.string(),
    graphId: z.string(),
    data: ThreadDtoNarrowSchema,
  })
  .passthrough();

const GraphNodeUpdateEventSchema = z
  .object({
    type: z.literal('graph.node.update'),
    nodeId: z.string(),
    graphId: z.string(),
    threadId: z.string().optional(),
    data: z
      .object({
        status: z.string(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const GraphPreviewEventSchema = z
  .object({
    type: z.literal('graph.preview'),
    graphId: z.string(),
    data: z
      .object({
        status: z.string(),
        agents: z.array(z.record(z.string(), z.unknown())),
        triggerNodes: z.array(z.record(z.string(), z.unknown())),
        nodeDisplayNames: z.record(z.string(), z.string()),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Discriminated union of all supported fixture event types.
 * Using z.discriminatedUnion (not z.union) per zod-schemas.md to avoid
 * ordering-dependent parse ambiguity.
 */
export const EventSchema = z.discriminatedUnion('type', [
  AgentMessageEventSchema,
  AgentStateUpdateEventSchema,
  ThreadCreateEventSchema,
  ThreadUpdateEventSchema,
  ThreadDeleteEventSchema,
  GraphNodeUpdateEventSchema,
  GraphPreviewEventSchema,
]);

export const FixtureSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  threadId: z.string(),
  graphId: z.string(),
  events: z
    .array(
      z.object({
        delayMs: z.number().int().nonnegative(),
        event: EventSchema,
      }),
    )
    .min(1),
});

// Re-export LoadedFixture from the types file so callers can import from either module.
export type { LoadedFixture } from './ws-replay.types';

/**
 * Parse and validate a raw fixture object loaded from JSON.
 *
 * On failure throws an Error listing only the issue paths and messages —
 * never the payload content (per zod-schemas.md §Validation Failure Logging).
 */
export function parseFixture(raw: unknown, filename: string): LoadedFixture {
  const parsed = FixtureSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid fixture ${filename}: ${issues}`);
  }
  // Cast via unknown: Zod's passthrough() adds an index signature to the
  // inferred type that is structurally incompatible with SocketNotification
  // even though the shapes match at runtime. LoadedFixture is the authoritative
  // type; Zod only validates the required fields.
  return parsed.data as unknown as LoadedFixture;
}
