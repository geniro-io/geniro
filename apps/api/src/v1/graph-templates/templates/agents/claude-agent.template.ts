import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { BadRequestException } from '@packages/common';
import { z } from 'zod';

import { ClaudeAgent } from '../../../agents/services/agents/claude-agent';
import type { GraphNode } from '../../../graphs/graphs.types';
import { NodeKind } from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import type { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
import { RegisterTemplate } from '../../decorators/register-template.decorator';
import { ClaudeAgentNodeBaseTemplate } from '../base-node.template';

export const ClaudeAgentTemplateSchema = z.object({
  name: z.string().min(1).describe('Unique name for this agent'),
  description: z
    .string()
    .min(1)
    .describe('Description of what this agent does')
    .meta({ 'x-ui:textarea': true }),
  instructions: z
    .string()
    .describe(
      'System prompt appended to the Claude Code session: role, goals, constraints, style.',
    )
    .meta({ 'x-ui:textarea': true })
    .meta({ 'x-ui:ai-suggestions': true }),
  model: z
    .string()
    .describe(
      'Claude model alias used by the session (must be registered in LiteLLM, e.g. claude-sonnet-4-6).',
    )
    .meta({ 'x-ui:show-on-node': true })
    .meta({ 'x-ui:label': 'Model' }),
  maxTurns: z
    .number()
    .int()
    .min(1)
    .max(2500)
    .default(100)
    .optional()
    .describe(
      'Maximum number of agentic turns the Claude session can execute during a single run.',
    ),
  plugins: z
    .array(
      z.object({
        repoUrl: z
          .string()
          .min(1)
          .describe(
            'Git repository with the plugin (https://host/repo or git@host:repo).',
          ),
        ref: z
          .string()
          .optional()
          .describe(
            'Branch, tag or commit of the repository (default branch when empty).',
          ),
        path: z
          .string()
          .optional()
          .describe(
            'Path to the plugin root inside the repository — the directory containing .claude-plugin/plugin.json (repository root when empty).',
          ),
      }),
    )
    .optional()
    .describe(
      'Claude Code plugins cloned into the runtime and loaded into the session at start. Repositories shared by several entries are cloned once.',
    ),
});

export type ClaudeAgentTemplateSchemaType = z.infer<
  typeof ClaudeAgentTemplateSchema
>;

@Injectable()
@RegisterTemplate()
export class ClaudeAgentTemplate extends ClaudeAgentNodeBaseTemplate<
  typeof ClaudeAgentTemplateSchema,
  ClaudeAgent
> {
  readonly id = 'claude-agent';
  readonly name = 'Claude agent';
  readonly description =
    'Agent backed by Claude Code (Agent SDK) running inside a connected runtime';
  readonly schema = ClaudeAgentTemplateSchema;

  readonly inputs = [
    {
      type: 'kind',
      value: NodeKind.Trigger,
      multiple: true,
    },
  ] as const;

  readonly outputs = [
    {
      type: 'kind',
      value: NodeKind.Runtime,
      required: true,
      multiple: false,
    },
  ] as const;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly graphRegistry: GraphRegistry,
  ) {
    super();
  }

  public async create() {
    return {
      provide: async (_params: GraphNode<ClaudeAgentTemplateSchemaType>) =>
        this.createNewInstance(this.moduleRef, ClaudeAgent),
      configure: async (
        params: GraphNode<ClaudeAgentTemplateSchemaType>,
        instance: ClaudeAgent,
      ) => {
        const graphId = params.metadata.graphId;

        const runtimeNodeId = Array.from(params.outputNodeIds).find(
          (nodeId) =>
            this.graphRegistry.getNode(graphId, nodeId)?.type ===
            NodeKind.Runtime,
        );
        if (!runtimeNodeId) {
          throw new BadRequestException(
            'CLAUDE_AGENT_NO_RUNTIME',
            'Claude Agent must be connected to a Runtime node — its Claude Code session runs inside that runtime',
          );
        }

        const runtimeNode = this.graphRegistry.getNode<RuntimeThreadProvider>(
          graphId,
          runtimeNodeId,
        );
        if (!runtimeNode) {
          throw new BadRequestException(
            'CLAUDE_AGENT_NO_RUNTIME',
            `Runtime node ${runtimeNodeId} not found in graph ${graphId}`,
          );
        }

        instance.setRuntimeProvider(runtimeNode.instance);
        instance.setConfig(params.config);
      },
      destroy: async (instance: ClaudeAgent) => {
        await instance.stop();
      },
    };
  }
}
