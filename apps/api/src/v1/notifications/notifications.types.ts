import { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';

import type { TriggerNodeInfoType } from '../graphs/dto/graphs.dto';
import { GraphRevisionEntity } from '../graphs/entity/graph-revision.entity';
import {
  GraphExecutionMetadata,
  GraphNodeStatus,
  GraphSchemaType,
  GraphStatus,
} from '../graphs/graphs.types';
import {
  RuntimeErrorCode,
  RuntimeInstanceStatus,
  RuntimeStartingPhase,
} from '../runtime/runtime.types';
import { ThreadSchema } from '../threads/dto/threads.dto';
import { ThreadEntity } from '../threads/entity/thread.entity';
import { ThreadStatus } from '../threads/threads.types';

export enum NotificationEvent {
  Graph = 'graph.update',
  AgentMessage = 'agent.message',
  AgentInvoke = 'agent.invoke',
  AgentStateUpdate = 'agent.state.update',
  ThreadCreate = 'thread.create',
  ThreadUpdate = 'thread.update',
  ThreadDelete = 'thread.delete',
  GraphNodeUpdate = 'graph.node.update',
  GraphRevisionCreate = 'graph.revision.create',
  GraphRevisionApplying = 'graph.revision.applying',
  GraphRevisionApplied = 'graph.revision.applied',
  GraphRevisionFailed = 'graph.revision.failed',
  GraphRevisionProgress = 'graph.revision.progress',
  RuntimeStatus = 'runtime.status',
  GraphPreview = 'graph.preview',
}

// ---------------------------------------------------------------------------
// Shared envelope fields — present on every notification. Payloads that carry
// entity instances or complex LangChain types are represented via
// `z.instanceof(...)` / `z.custom(...)` so the validator catches "wrong shape
// entirely" mistakes without duplicating entity field definitions.
// ---------------------------------------------------------------------------

const EnvelopeShape = {
  graphId: z.string(),
  projectId: z.string().optional(),
  nodeId: z.string().optional(),
  threadId: z.string().optional(),
  parentThreadId: z.string().optional(),
  runId: z.string().optional(),
};

export interface INotification<T> {
  type: NotificationEvent;
  data: T;
  graphId: string;
  projectId?: string;
  nodeId?: string;
  threadId?: string;
  parentThreadId?: string;
  runId?: string;
}

// ---------------------------------------------------------------------------
// Per-event schemas
// ---------------------------------------------------------------------------

export const GraphNotificationDataSchema = z.object({
  status: z.nativeEnum(GraphStatus),
  schema: z.custom<GraphSchemaType>().optional(),
});
export const GraphNotificationSchema = z.object({
  type: z.literal(NotificationEvent.Graph),
  data: GraphNotificationDataSchema,
  ...EnvelopeShape,
});
export type IGraphNotification = z.infer<typeof GraphNotificationSchema>;

export const AgentMessageDataSchema = z.object({
  messages: z.array(z.custom<BaseMessage>((v) => v instanceof BaseMessage)),
});
export const AgentMessageNotificationSchema = z.object({
  type: z.literal(NotificationEvent.AgentMessage),
  data: AgentMessageDataSchema,
  ...EnvelopeShape,
  nodeId: z.string(),
  threadId: z.string(),
  parentThreadId: z.string(),
});
export type IAgentMessageData = z.infer<typeof AgentMessageDataSchema>;
export type IAgentMessageNotification = z.infer<
  typeof AgentMessageNotificationSchema
>;

export const AgentInvokeDataSchema = z.object({
  messages: z.array(z.custom<BaseMessage>((v) => v instanceof BaseMessage)),
});
export const AgentInvokeNotificationSchema = z.object({
  type: z.literal(NotificationEvent.AgentInvoke),
  data: AgentInvokeDataSchema,
  ...EnvelopeShape,
  nodeId: z.string(),
  threadId: z.string(),
  parentThreadId: z.string(),
  source: z.string().optional(),
  threadMetadata: z.record(z.string(), z.unknown()).optional(),
  effectiveCostLimitUsd: z.number().nullable().optional(),
});
export type IAgentInvokeData = z.infer<typeof AgentInvokeDataSchema>;
export type IAgentInvokeNotification = z.infer<
  typeof AgentInvokeNotificationSchema
>;

export const AgentStateUpdateDataSchema = z.object({
  summary: z.string().optional(),
  done: z.boolean().optional(),
  needsMoreInfo: z.boolean().optional(),
  toolUsageGuardActivated: z.boolean().optional(),
  toolUsageGuardActivatedCount: z.number().optional(),
  inputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  totalPrice: z.number().optional(),
  currentContext: z.number().optional(),
  effectiveCostLimitUsd: z.number().nullable().optional(),
  inFlightSubagentPrice: z.record(z.string(), z.number()).optional(),
});
export const AgentStateUpdateNotificationSchema = z.object({
  type: z.literal(NotificationEvent.AgentStateUpdate),
  data: AgentStateUpdateDataSchema,
  ...EnvelopeShape,
  nodeId: z.string(),
  threadId: z.string(),
  parentThreadId: z.string(),
});
export type IAgentStateUpdateData = z.infer<typeof AgentStateUpdateDataSchema>;
export type IAgentStateUpdateNotification = z.infer<
  typeof AgentStateUpdateNotificationSchema
>;

export const ThreadCreateNotificationSchema = z.object({
  type: z.literal(NotificationEvent.ThreadCreate),
  data: z.instanceof(ThreadEntity),
  ...EnvelopeShape,
  threadId: z.string(),
  parentThreadId: z.string().optional(),
  internalThreadId: z.string(),
});
export type IThreadCreateNotification = z.infer<
  typeof ThreadCreateNotificationSchema
>;

export const ThreadUpdateDataSchema = z.object({
  status: z.nativeEnum(ThreadStatus).optional(),
  name: z.string().optional(),
  scheduledResumeAt: z.string().optional(),
  waitReason: z.string().optional(),
  stopReason: z.string().nullable().optional(),
  stopCostUsd: z.number().nullable().optional(),
  costLimitHit: z.boolean().nullable().optional(),
});
export const ThreadUpdateNotificationDataSchema = z.union([
  ThreadSchema, // tried first — full thread DTO
  ThreadUpdateDataSchema, // fallback for partial updates
]);
export const ThreadUpdateNotificationSchema = z.object({
  type: z.literal(NotificationEvent.ThreadUpdate),
  data: ThreadUpdateNotificationDataSchema,
  ...EnvelopeShape,
  nodeId: z.string().optional(),
  threadId: z.string(),
  parentThreadId: z.string().optional(),
});
export type IThreadUpdateData = z.infer<typeof ThreadUpdateDataSchema>;
export type ThreadUpdateNotificationData = z.infer<
  typeof ThreadUpdateNotificationDataSchema
>;
export type IThreadUpdateNotification = z.infer<
  typeof ThreadUpdateNotificationSchema
>;

export const ThreadDeleteNotificationSchema = z.object({
  type: z.literal(NotificationEvent.ThreadDelete),
  data: z.instanceof(ThreadEntity),
  ...EnvelopeShape,
  threadId: z.string(),
  internalThreadId: z.string(),
});
export type IThreadDeleteNotification = z.infer<
  typeof ThreadDeleteNotificationSchema
>;

export const GraphNodeUpdateDataSchema = z.object({
  status: z.nativeEnum(GraphNodeStatus),
  error: z.string().nullable().optional(),
  metadata: z.custom<GraphExecutionMetadata>().optional(),
  additionalNodeMetadata: z.record(z.string(), z.unknown()).optional(),
});
export const GraphNodeUpdateNotificationSchema = z.object({
  type: z.literal(NotificationEvent.GraphNodeUpdate),
  data: GraphNodeUpdateDataSchema,
  ...EnvelopeShape,
  nodeId: z.string(),
});
export type IGraphNodeUpdateData = z.infer<typeof GraphNodeUpdateDataSchema>;
export type IGraphNodeUpdateNotification = z.infer<
  typeof GraphNodeUpdateNotificationSchema
>;

export const GraphRevisionCreateNotificationSchema = z.object({
  type: z.literal(NotificationEvent.GraphRevisionCreate),
  data: z.instanceof(GraphRevisionEntity),
  ...EnvelopeShape,
});
export const GraphRevisionApplyingNotificationSchema = z.object({
  type: z.literal(NotificationEvent.GraphRevisionApplying),
  data: z.instanceof(GraphRevisionEntity),
  ...EnvelopeShape,
});
export const GraphRevisionAppliedNotificationSchema = z.object({
  type: z.literal(NotificationEvent.GraphRevisionApplied),
  data: z.instanceof(GraphRevisionEntity),
  ...EnvelopeShape,
});
export const GraphRevisionFailedNotificationSchema = z.object({
  type: z.literal(NotificationEvent.GraphRevisionFailed),
  data: z.instanceof(GraphRevisionEntity),
  ...EnvelopeShape,
});
export type IGraphRevisionNotification = z.infer<
  | typeof GraphRevisionCreateNotificationSchema
  | typeof GraphRevisionApplyingNotificationSchema
  | typeof GraphRevisionAppliedNotificationSchema
  | typeof GraphRevisionFailedNotificationSchema
>;

export const GraphRevisionProgressDataSchema = z.object({
  revisionId: z.string(),
  graphId: z.string(),
  toVersion: z.string(),
  currentNode: z.number(),
  totalNodes: z.number(),
  nodeId: z.string(),
  phase: z.union([z.literal('rebuilding'), z.literal('completed')]),
});
export const GraphRevisionProgressNotificationSchema = z.object({
  type: z.literal(NotificationEvent.GraphRevisionProgress),
  data: GraphRevisionProgressDataSchema,
  ...EnvelopeShape,
});
export type IGraphRevisionProgressData = z.infer<
  typeof GraphRevisionProgressDataSchema
>;
export type IGraphRevisionProgressNotification = z.infer<
  typeof GraphRevisionProgressNotificationSchema
>;

export const RuntimeStatusDataSchema = z.object({
  runtimeId: z.string(),
  threadId: z.string(),
  nodeId: z.string(),
  status: z.nativeEnum(RuntimeInstanceStatus),
  runtimeType: z.string(),
  message: z.string().optional(),
  startingPhase: z.nativeEnum(RuntimeStartingPhase).nullable().optional(),
  errorCode: z.nativeEnum(RuntimeErrorCode).nullable().optional(),
  lastError: z.string().nullable().optional(),
});
export const RuntimeStatusNotificationSchema = z.object({
  type: z.literal(NotificationEvent.RuntimeStatus),
  data: RuntimeStatusDataSchema,
  ...EnvelopeShape,
});
export type IRuntimeStatusData = z.infer<typeof RuntimeStatusDataSchema>;
export type IRuntimeStatusNotification = z.infer<
  typeof RuntimeStatusNotificationSchema
>;

export const GraphPreviewPayloadSchema = z.object({
  id: z.string(),
  status: z.string(),
  triggerNodes: z.array(z.custom<TriggerNodeInfoType>()),
  nodeDisplayNames: z.record(z.string(), z.string()),
  nodeCount: z.number(),
  edgeCount: z.number(),
  agents: z.array(
    z.object({
      nodeId: z.string(),
      name: z.string(),
      description: z.string().optional(),
    }),
  ),
  version: z.string(),
  targetVersion: z.string(),
  error: z.string().nullable().optional(),
});
export const GraphPreviewNotificationSchema = z.object({
  type: z.literal(NotificationEvent.GraphPreview),
  data: GraphPreviewPayloadSchema,
  ...EnvelopeShape,
});
export type GraphPreviewPayload = z.infer<typeof GraphPreviewPayloadSchema>;
export type IGraphPreviewNotification = z.infer<
  typeof GraphPreviewNotificationSchema
>;

// ---------------------------------------------------------------------------
// Top-level union — discriminated by `type` for fast dispatch.
// ---------------------------------------------------------------------------

export const NotificationSchema = z.discriminatedUnion('type', [
  GraphNotificationSchema,
  AgentMessageNotificationSchema,
  AgentInvokeNotificationSchema,
  AgentStateUpdateNotificationSchema,
  ThreadCreateNotificationSchema,
  ThreadUpdateNotificationSchema,
  ThreadDeleteNotificationSchema,
  GraphNodeUpdateNotificationSchema,
  GraphRevisionCreateNotificationSchema,
  GraphRevisionApplyingNotificationSchema,
  GraphRevisionAppliedNotificationSchema,
  GraphRevisionFailedNotificationSchema,
  GraphRevisionProgressNotificationSchema,
  RuntimeStatusNotificationSchema,
  GraphPreviewNotificationSchema,
]);

export type Notification = z.infer<typeof NotificationSchema>;
