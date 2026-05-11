import { zodQueryArray } from '@packages/http-server';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { MessageSchema } from '../../graphs/dto/graphs.dto';
import { GraphEdgeSchema, GraphNodeSchema } from '../../graphs/graphs.types';
import { ThreadStatus } from '../threads.types';

const ThreadStatusesQuerySchema = zodQueryArray(z.enum(ThreadStatus));

export const TokenUsageSchema = z.object({
  inputTokens: z.number().describe('Input tokens'),
  cachedInputTokens: z.number().optional().describe('Cached input tokens'),
  outputTokens: z.number().describe('Output tokens'),
  reasoningTokens: z.number().optional().describe('Reasoning tokens'),
  totalTokens: z.number().describe('Total tokens'),
  totalPrice: z.number().optional().describe('Total price in USD'),
  currentContext: z
    .number()
    .optional()
    .describe('Current context size in tokens (snapshot, not additive)'),
});

export const ThreadTokenUsageSchema = TokenUsageSchema.extend({
  byNode: z
    .record(z.string(), TokenUsageSchema)
    .optional()
    .describe('Token usage breakdown by node ID'),
});

// Usage statistics schemas

// Type declared explicitly for recursive z.lazy() self-reference
export type UsageStatisticsByTool = {
  toolName: string;
  totalTokens: number;
  totalPrice?: number;
  callCount: number;
  toolTokens?: number;
  toolPrice?: number;
  subCalls?: UsageStatisticsByTool[];
};

export const UsageStatisticsByToolSchema: z.ZodType<UsageStatisticsByTool> =
  z.object({
    toolName: z.string().describe('Tool name'),
    totalTokens: z
      .number()
      .describe('Total tokens from LLM requests related to this tool'),
    totalPrice: z
      .number()
      .optional()
      .describe('Total price from LLM requests related to this tool in USD'),
    callCount: z.number().describe('Number of times this tool was called'),
    toolTokens: z
      .number()
      .optional()
      .describe(
        "Tool's own execution token cost (e.g. subagent aggregate tokens)",
      ),
    toolPrice: z
      .number()
      .optional()
      .describe("Tool's own execution price in USD"),
    subCalls: z
      .lazy(() => z.array(UsageStatisticsByToolSchema))
      .optional()
      .describe(
        'Sub-tool calls made within this tool (e.g. tools called by a subagent)',
      ),
  });

export const UsageStatisticsAggregateSchema = TokenUsageSchema.extend({
  requestCount: z
    .number()
    .describe('Number of requests (messages with requestTokenUsage)'),
});

export const ThreadUsageStatisticsSchema = z.object({
  total: TokenUsageSchema.describe(
    'Total usage statistics for the entire thread',
  ),
  requests: z
    .number()
    .describe('Total number of requests (messages with requestTokenUsage)'),
  byNode: z
    .record(z.string(), TokenUsageSchema)
    .describe('Usage statistics breakdown by node ID'),
  byTool: z
    .array(UsageStatisticsByToolSchema)
    .describe('Usage statistics breakdown by tool name'),
  toolsAggregate: UsageStatisticsAggregateSchema.describe(
    'Aggregated statistics for all tool-related LLM requests',
  ),
  userMessageCount: z
    .number()
    .describe('Number of user (human) messages in the thread'),
  modelsUsed: z
    .array(z.string())
    .describe(
      'Distinct LLM model identifiers used across all messages in the thread',
    ),
});

export const ThreadAgentSchema = z.object({
  nodeId: z.string().describe('Graph node ID of the agent'),
  name: z.string().describe('Agent display name'),
  description: z.string().optional().describe('Agent description'),
});

// Thread schema
export const ThreadSchema = z.object({
  id: z.uuid().describe('Thread ID'),
  graphId: z.uuid().describe('Graph ID'),
  externalThreadId: z.string().describe('External thread ID from LangChain'),
  lastRunId: z
    .uuid()
    .optional()
    .nullable()
    .describe('Last LangGraph run_id observed for this thread'),
  runningStartedAt: z.iso
    .datetime()
    .nullable()
    .describe(
      'Timestamp when the thread entered Running status; null when not Running',
    ),
  totalRunningMs: z
    .number()
    .int()
    .nonnegative()
    .describe('Cumulative milliseconds the thread has spent in Running status'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .nullable()
    .describe('Additional thread metadata'),
  source: z
    .string()
    .optional()
    .nullable()
    .describe('Source of thread creation (e.g., trigger template name)'),
  name: z
    .string()
    .optional()
    .nullable()
    .describe('Thread name (auto-generated from first user message)'),
  status: z.enum(ThreadStatus).describe('Thread execution status'),
  agents: z
    .array(ThreadAgentSchema)
    .optional()
    .nullable()
    .describe('Agents in the graph this thread belongs to'),
  stopReason: z
    .string()
    .nullable()
    .optional()
    .describe('Reason a stopped thread was terminated — e.g. "cost_limit"'),
  effectiveCostLimitUsd: z
    .number()
    .nullable()
    .optional()
    .describe('Server-resolved effective USD cost limit for this thread'),
});

export const ThreadMessageSchema = z.object({
  id: z.uuid(),
  threadId: z.uuid(),
  nodeId: z.string(),
  externalThreadId: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  message: MessageSchema,
  requestTokenUsage: TokenUsageSchema.optional()
    .nullable()
    .describe(
      'Full LLM request token usage & cost (entire request, not just this message)',
    ),
  toolTokenUsage: TokenUsageSchema.optional()
    .nullable()
    .describe(
      "Tool's own execution token cost (e.g. subagent aggregate tokens). Only present on tool result messages.",
    ),
});

// Get threads query parameters
export const GetThreadsQuerySchema = z.object({
  graphId: z.uuid().describe('Filter by graph ID').optional(),
  statuses: ThreadStatusesQuerySchema.optional().describe(
    'Filter by thread statuses',
  ),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(50)
    .describe('Maximum number of threads to return'),
  offset: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(0)
    .describe('Number of threads to skip'),
});

// Get messages query parameters
export const GetMessagesQuerySchema = z.object({
  nodeId: z
    .string()
    .optional()
    .describe('Filter messages by node ID (agent node)'),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .default(100)
    .describe('Maximum number of messages to return'),
  offset: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(0)
    .describe('Number of messages to skip'),
});

// Set thread metadata
export const SetThreadMetadataSchema = z.object({
  metadata: z
    .record(z.string(), z.unknown())
    .describe('Thread metadata to set (replaces existing metadata)'),
});

// Type exports
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type ThreadTokenUsage = z.infer<typeof ThreadTokenUsageSchema>;
// UsageStatisticsByTool type is declared above (explicit for recursive z.lazy)
export type UsageStatisticsAggregate = z.infer<
  typeof UsageStatisticsAggregateSchema
>;
export type ThreadUsageStatistics = z.infer<typeof ThreadUsageStatisticsSchema>;

// Graph snapshot for export (excludes volatile runtime fields like runningThreads)
export const GraphSnapshotSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable().optional(),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema).optional().default([]),
});

export const ThreadExportSchema = z.object({
  version: z.literal('1'),
  exportedAt: z.string().datetime(),
  isRunning: z.boolean(),
  thread: ThreadSchema,
  messages: z.array(ThreadMessageSchema),
  usageStatistics: ThreadUsageStatisticsSchema,
  graph: GraphSnapshotSchema.nullable(),
});

export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;
export type ThreadExport = z.infer<typeof ThreadExportSchema>;

// DTOs
export class ThreadDto extends createZodDto(ThreadSchema) {}
export class ThreadMessageDto extends createZodDto(ThreadMessageSchema) {}
export class GetThreadsQueryDto extends createZodDto(GetThreadsQuerySchema) {}
export class GetMessagesQueryDto extends createZodDto(GetMessagesQuerySchema) {}
export class ThreadUsageStatisticsDto extends createZodDto(
  ThreadUsageStatisticsSchema,
) {}
export class SetThreadMetadataDto extends createZodDto(
  SetThreadMetadataSchema,
) {}

// Resume thread
export const ResumeThreadSchema = z.object({
  message: z
    .string()
    .optional()
    .describe('Optional message to inject instead of the stored checkPrompt'),
});
export class ResumeThreadDto extends createZodDto(ResumeThreadSchema) {}
