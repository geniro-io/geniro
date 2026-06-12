import { z } from 'zod';

import type { LLMRequestContext } from '../agents/agents.types';
import type { GraphStateManager } from './services/graph-state.manager';

export interface GraphSettings {
  costLimitUsd?: number | null;
  [key: string]: unknown;
}

export enum NodeKind {
  Runtime = 'runtime',
  Tool = 'tool',
  SimpleAgent = 'simpleAgent',
  ClaudeAgent = 'claudeAgent',
  Trigger = 'trigger',
  Resource = 'resource',
  Mcp = 'mcp',
  Instruction = 'instruction',
}

/**
 * Node kinds whose compiled instances implement the `RunnableAgent` surface
 * (run/runOrAppend/stopThread/subscribe/emit/getGraphNodeMetadata). Every
 * agent-dispatch site (stop fan-out, listener attach, thread resume, trigger
 * invocation, inter-agent communication) filters by this set instead of a
 * single kind — add new agent kinds here and they join all of those paths.
 */
export const AGENT_NODE_KINDS: ReadonlySet<NodeKind> = new Set([
  NodeKind.SimpleAgent,
  NodeKind.ClaudeAgent,
]);

export enum MessageRole {
  Human = 'human',
  AI = 'ai',
  Reasoning = 'reasoning',
  System = 'system',
  Tool = 'tool',
}

export enum GraphStatus {
  Created = 'created',
  Compiling = 'compiling',
  Running = 'running',
  Stopped = 'stopped',
  Error = 'error',
}

export enum GraphNodeStatus {
  Stopped = 'stopped',
  Starting = 'starting',
  Running = 'running',
  Idle = 'idle',
}

export enum GraphRevisionStatus {
  Pending = 'pending',
  Applying = 'applying',
  Applied = 'applied',
  Failed = 'failed',
}

export interface GraphNode<TConfig = unknown> {
  config: TConfig;
  inputNodeIds: Set<string>;
  outputNodeIds: Set<string>;
  metadata: GraphMetadataSchemaType & { nodeId: string };
}

export interface GraphNodeInstanceHandle<
  TInstance = unknown,
  TConfig = unknown,
> {
  provide(params: GraphNode<TConfig>): Promise<TInstance>;
  configure(params: GraphNode<TConfig>, instance: TInstance): Promise<void>;
  destroy(instance: TInstance): Promise<void>;
}

export interface CompiledGraphNode<TInstance = unknown, TConfig = unknown> {
  id: string;
  type: NodeKind;
  template: string;
  handle: GraphNodeInstanceHandle<TInstance, TConfig>;
  instance: TInstance;
  config: TConfig;
}

export interface GraphExecutionMetadata {
  threadId?: string;
  runId?: string;
  parentThreadId?: string;
}

export interface GraphNodeStateSnapshot {
  id: string;
  name: string;
  template: string;
  type: NodeKind;
  status: GraphNodeStatus;
  config: unknown;
  error?: string | null;
  threadId?: string;
  runId?: string;
  metadata?: GraphExecutionMetadata;
  additionalNodeMetadata?: Record<string, unknown>;
}

export interface CompiledGraph {
  metadata: GraphMetadataSchemaType;
  nodes: Map<string, CompiledGraphNode>;
  edges: {
    from: string;
    to: string;
    label?: string;
  }[];
  state: GraphStateManager;
  status: GraphStatus;
  /**
   * Destroys the graph and cleans up all resources
   * - Stops all triggers
   * - Destroys all runtimes
   */
  destroy: () => Promise<void>;
}

export interface GraphAgentInfo {
  nodeId: string;
  name: string;
  description?: string;
}

// Node configuration schema
export const GraphNodeSchema = z.object({
  id: z.string().describe('Unique identifier for this node'),
  template: z.string().describe('Template id registered in TemplateRegistry'),
  config: z
    .record(z.string(), z.unknown())
    .describe('Template-specific configuration'),
});

// Edge configuration schema
export const GraphEdgeSchema = z.object({
  from: z.string().describe('Source node ID'),
  to: z.string().describe('Target node ID'),
  label: z.string().optional().describe('Optional edge label'),
});

export const GraphMetadataSchema = z.object({
  graphId: z.string(),
  name: z.string().optional(),
  version: z.string(),
  temporary: z.boolean().optional(),
  graph_created_by: z.string(),
  graph_project_id: z.string(),
  llmRequestContext: z.custom<LLMRequestContext>().optional(),
});

// Complete graph schema
export const GraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema).optional(),
});

export type GraphSchemaType = z.infer<typeof GraphSchema>;
export type GraphNodeSchemaType = z.infer<typeof GraphNodeSchema>;
export type GraphEdgeSchemaType = z.infer<typeof GraphEdgeSchema>;
export type GraphMetadataSchemaType = z.infer<typeof GraphMetadataSchema>;
