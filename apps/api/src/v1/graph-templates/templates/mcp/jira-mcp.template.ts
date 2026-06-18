import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { z } from 'zod';

import type { BaseMcp } from '../../../agent-mcp/services/base-mcp';
import { JiraMcp } from '../../../agent-mcp/services/mcp/jira-mcp';
import type { GraphNode } from '../../../graphs/graphs.types';
import { NodeKind } from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import type { RuntimeStartParams } from '../../../runtime/runtime.types';
import { RuntimeProvider } from '../../../runtime/services/runtime-provider';
import { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
import { RegisterTemplate } from '../../decorators/register-template.decorator';
import { McpNodeBaseTemplate } from '../base-node.template';

export const JiraMcpTemplateSchema = z
  .object({
    jiraUrl: z
      .url()
      .describe('Jira base URL (e.g. https://your-domain.atlassian.net)'),
    jiraApiKey: z.string().min(1).describe('Jira API key'),
    jiraEmail: z.string().email().describe('Jira account email'),
    projectKey: z.string().optional().describe('Optional project key filter'),
  })
  // Strip legacy/unknown fields so older configs remain valid.
  .strip();

export type JiraMcpTemplateSchemaType = z.infer<typeof JiraMcpTemplateSchema>;

@Injectable()
@RegisterTemplate()
export class JiraMcpTemplate extends McpNodeBaseTemplate<
  typeof JiraMcpTemplateSchema,
  BaseMcp
> {
  readonly id = 'jira-mcp';
  readonly name = 'Jira MCP';
  readonly description =
    'Jira integration via remote MCP (requires Docker runtime type)';
  readonly schema = JiraMcpTemplateSchema;

  readonly inputs = [
    { type: 'kind', value: NodeKind.SimpleAgent, multiple: true },
    { type: 'kind', value: NodeKind.ClaudeAgent, multiple: true },
  ] as const;

  readonly outputs = [
    { type: 'kind', value: NodeKind.Runtime, required: true, multiple: false },
  ] as const;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly graphRegistry: GraphRegistry,
    private readonly runtimeProvider: RuntimeProvider,
  ) {
    super();
  }

  public async create() {
    return {
      provide: async (_params: GraphNode<JiraMcpTemplateSchemaType>) =>
        this.createNewInstance(this.moduleRef, JiraMcp),
      configure: async (
        params: GraphNode<JiraMcpTemplateSchemaType>,
        instance: JiraMcp,
      ) => {
        const graphId = params.metadata.graphId;
        const outputNodeIds = params.outputNodeIds;
        const config = params.config;

        const runtimeNodeId = Array.from(outputNodeIds).find((nodeId) => {
          const node = this.graphRegistry.getNode(graphId, nodeId);
          return node?.type === NodeKind.Runtime;
        });

        if (!runtimeNodeId) {
          throw new Error('Jira MCP requires a Runtime node with Docker type');
        }

        // Validate that runtime exists immediately during configuration
        const runtimeNode = this.graphRegistry.getNode<RuntimeThreadProvider>(
          graphId,
          runtimeNodeId,
        );
        if (!runtimeNode) {
          throw new Error(
            `Runtime instance not found for node ${runtimeNodeId}`,
          );
        }

        // Reconfigure: cleanup then setup again
        await instance.cleanup().catch(() => {});

        const runtimeConfig = runtimeNode.config as RuntimeStartParams;
        const mcpThreadId = `mcp-init-${graphId}-${runtimeNodeId}`;
        const runtime = await instance.provideTemporaryRuntime({
          runtimeProvider: this.runtimeProvider,
          graphId,
          runtimeNodeId,
          runtimeConfig,
        });
        try {
          await instance.initialize(
            config,
            runtimeNode.instance,
            runtime,
            params.metadata.nodeId,
          );
        } finally {
          await this.runtimeProvider.cleanupRuntimeInstance({
            graphId,
            runtimeNodeId,
            threadId: mcpThreadId,
            type: this.runtimeProvider.getDefaultRuntimeType(),
          });
        }
      },
      destroy: async (instance: JiraMcp) => {
        await instance.cleanup().catch(() => {});
      },
    };
  }
}
