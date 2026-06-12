import type { ContextId, ModuleRef } from '@nestjs/core';
import type { Class } from 'type-fest';
import { z } from 'zod';

import type { BaseMcp } from '../../agent-mcp/services/base-mcp';
import { BuiltAgentTool } from '../../agent-tools/tools/base-tool';
import { BaseTrigger } from '../../agent-triggers/services/base-trigger';
import { ClaudeAgent } from '../../agents/services/agents/claude-agent';
import { SimpleAgent } from '../../agents/services/agents/simple-agent';
import { IBaseResourceOutput } from '../../graph-resources/graph-resources.types';
import { GraphNodeInstanceHandle, NodeKind } from '../../graphs/graphs.types';
import { RuntimeThreadProvider } from '../../runtime/services/runtime-thread-provider';

export type NodeConnection =
  | {
      type: 'kind';
      value: NodeKind;
      required?: boolean;
      requiredGroup?: string;
      multiple: boolean;
    }
  | {
      type: 'template';
      value: string;
      required?: boolean;
      requiredGroup?: string;
      multiple: boolean;
    };

export abstract class NodeBaseTemplate<
  TConfig extends z.ZodTypeAny,
  TOutput = unknown,
> {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly kind: NodeKind;
  abstract readonly schema: TConfig;

  readonly inputs: readonly NodeConnection[] = [];
  readonly outputs: readonly NodeConnection[] = [];

  /**
   * Create a per-graph node handle.
   */
  abstract create(): Promise<
    GraphNodeInstanceHandle<TOutput, z.infer<TConfig>>
  >;

  /**
   * Shared helper for templates to always create a new instance using Nest DI.
   * Prefer this over constructor-injecting node instances, which causes cross-graph reuse.
   */
  protected async createNewInstance<T>(
    moduleRef: ModuleRef,
    cls: Class<T>,
    ctx?: ContextId,
  ): Promise<T> {
    // Node instance classes are required to be Scope.TRANSIENT providers.
    // That makes ModuleRef.resolve() return a new instance per call, while still using
    // Nest's provider resolution graph (important for deep dependencies).
    //
    // NOTE: This requires the node instance class to be registered as a provider.
    // We keep `strict: false` since templates may live in a different module than
    // the node instance provider.
    return await moduleRef.resolve(cls, ctx, { strict: false });
  }
}

export abstract class RuntimeNodeBaseTemplate<
  TConfig extends z.ZodTypeAny,
> extends NodeBaseTemplate<TConfig, RuntimeThreadProvider> {
  readonly kind: NodeKind = NodeKind.Runtime;
}

export type ToolNodeOutput = {
  tools: BuiltAgentTool[];
  instructions?: string;
};

export abstract class ToolNodeBaseTemplate<
  TConfig extends z.ZodTypeAny,
> extends NodeBaseTemplate<TConfig, ToolNodeOutput> {
  readonly kind: NodeKind = NodeKind.Tool;
}

export abstract class ResourceNodeBaseTemplate<
  TConfig extends z.ZodTypeAny,
  TResult extends IBaseResourceOutput<unknown> = IBaseResourceOutput<unknown>,
> extends NodeBaseTemplate<TConfig, TResult> {
  readonly kind: NodeKind = NodeKind.Resource;
}

export abstract class SimpleAgentNodeBaseTemplate<
  TConfig extends z.ZodTypeAny,
  TResult = SimpleAgent,
> extends NodeBaseTemplate<TConfig, TResult> {
  readonly kind: NodeKind = NodeKind.SimpleAgent;
}

export abstract class ClaudeAgentNodeBaseTemplate<
  TConfig extends z.ZodTypeAny,
  TResult = ClaudeAgent,
> extends NodeBaseTemplate<TConfig, TResult> {
  readonly kind: NodeKind = NodeKind.ClaudeAgent;
}

export abstract class TriggerNodeBaseTemplate<
  TConfig extends z.ZodTypeAny,
  TResult = BaseTrigger<TConfig>,
> extends NodeBaseTemplate<TConfig, TResult> {
  readonly kind: NodeKind = NodeKind.Trigger;
}

export abstract class McpNodeBaseTemplate<
  TConfig extends z.ZodTypeAny,
  TResult extends BaseMcp = BaseMcp<unknown>,
> extends NodeBaseTemplate<TConfig, TResult> {
  readonly kind: NodeKind = NodeKind.Mcp;
}

export abstract class InstructionNodeBaseTemplate<
  TConfig extends z.ZodTypeAny,
> extends NodeBaseTemplate<TConfig, string> {
  readonly kind: NodeKind = NodeKind.Instruction;
}
