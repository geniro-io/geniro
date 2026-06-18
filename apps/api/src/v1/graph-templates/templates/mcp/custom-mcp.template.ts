import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { NotFoundException } from '@packages/common';
import { z } from 'zod';

import type { BaseMcp } from '../../../agent-mcp/services/base-mcp';
import {
  CustomMcp,
  CustomMcpConfig,
} from '../../../agent-mcp/services/mcp/custom-mcp';
import type { GraphNode } from '../../../graphs/graphs.types';
import { NodeKind } from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import type { RuntimeStartParams } from '../../../runtime/runtime.types';
import { RuntimeProvider } from '../../../runtime/services/runtime-provider';
import { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
import { RegisterTemplate } from '../../decorators/register-template.decorator';
import { McpNodeBaseTemplate } from '../base-node.template';

export const CustomMcpTemplateSchema = z
  .object({
    command: z
      .string()
      .optional()
      .describe(
        'Full command to execute (e.g. npx -y @my-org/mcp-server --port 3000). The first token is used as the executable, the rest as arguments.',
      )
      .meta({ 'x-ui:label': 'Command' }),
    serverUrl: z
      .string()
      .optional()
      .describe('MCP server URL (SSE or Streamable HTTP endpoint)')
      .meta({ 'x-ui:label': 'Server URL' }),
    headers: z
      .record(
        z.string().regex(/^[a-zA-Z0-9\-_]+$/, 'Invalid header name'),
        z
          .string()
          .regex(/^[^\r\n]*$/, 'Header value must not contain newlines'),
      )
      .optional()
      .default({})
      .describe('HTTP headers sent with every request (e.g. Authorization)')
      .meta({ 'x-ui:label': 'Headers' }),
    env: z
      .record(z.string(), z.string())
      .optional()
      .default({})
      .describe('Environment variables inside the runtime container')
      .meta({ 'x-ui:label': 'Environment variables' }),
  })
  .strip()
  .refine(
    (data) => data.command !== undefined || data.serverUrl !== undefined,
    { message: 'Either command or serverUrl must be provided' },
  );

export type CustomMcpTemplateSchemaType = z.infer<
  typeof CustomMcpTemplateSchema
>;

@Injectable()
@RegisterTemplate()
export class CustomMcpTemplate extends McpNodeBaseTemplate<
  typeof CustomMcpTemplateSchema,
  BaseMcp<CustomMcpConfig>
> {
  readonly id = 'custom-mcp';
  readonly name = 'Custom MCP';
  readonly description =
    'Connect any MCP server — command mode (exec in runtime) or URL mode (SSE/HTTP via mcp-remote)';
  readonly schema = CustomMcpTemplateSchema;

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
      provide: async (_params: GraphNode<CustomMcpTemplateSchemaType>) =>
        this.createNewInstance(this.moduleRef, CustomMcp),
      configure: async (
        params: GraphNode<CustomMcpTemplateSchemaType>,
        instance: CustomMcp,
      ) => {
        const graphId = params.metadata.graphId;
        const outputNodeIds = params.outputNodeIds;
        const config = params.config;

        const runtimeNodeId = Array.from(outputNodeIds).find((nodeId) => {
          const node = this.graphRegistry.getNode(graphId, nodeId);
          return node?.type === NodeKind.Runtime;
        });

        if (!runtimeNodeId) {
          throw new Error('Custom MCP requires a Runtime node connection');
        }

        await instance.cleanup().catch(() => {});

        const runtimeNode = this.graphRegistry.getNode<RuntimeThreadProvider>(
          graphId,
          runtimeNodeId,
        );
        if (!runtimeNode) {
          throw new NotFoundException(
            'RUNTIME_NOT_FOUND',
            `Runtime node ${runtimeNodeId} not found in graph ${graphId}`,
          );
        }

        const runtimeConfig = runtimeNode.config as RuntimeStartParams;
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
            threadId: `mcp-init-${graphId}-${runtimeNodeId}`,
            type: this.runtimeProvider.getDefaultRuntimeType(),
          });
        }
      },
      destroy: async (instance: CustomMcp) => {
        await instance.cleanup().catch(() => {});
      },
    };
  }
}
