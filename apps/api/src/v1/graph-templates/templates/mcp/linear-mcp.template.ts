import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DefaultLogger } from '@packages/common';
import { z } from 'zod';

import type { BaseMcp } from '../../../agent-mcp/services/base-mcp';
import { LinearMcp } from '../../../agent-mcp/services/mcp/linear-mcp';
import type { GraphNode } from '../../../graphs/graphs.types';
import { NodeKind } from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import type { RuntimeStartParams } from '../../../runtime/runtime.types';
import { RuntimeProvider } from '../../../runtime/services/runtime-provider';
import { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
import { RegisterTemplate } from '../../decorators/register-template.decorator';
import { McpNodeBaseTemplate } from '../base-node.template';

export const LinearMcpTemplateSchema = z
  .object({
    // The config value is the NAME of the OAuth-stored secret. `secret-select`
    // makes the compiler inject its value into the runtime env; the new
    // `oauth-authenticate` marker drives the per-node Authenticate widget (it
    // is UI-only and is NOT collected by the compiler's collectSecretNames).
    token: z
      .string()
      .min(1)
      .describe(
        'Linear OAuth token — click Authenticate to connect your Linear workspace',
      )
      .meta({
        'x-ui:label': 'Linear authentication',
        'x-ui:secret-select': true,
        'x-ui:oauth-authenticate': { provider: 'linear' },
      }),
  })
  // Strip legacy/unknown fields so older configs remain valid.
  .strip();

export type LinearMcpTemplateSchemaType = z.infer<
  typeof LinearMcpTemplateSchema
>;

@Injectable()
@RegisterTemplate()
export class LinearMcpTemplate extends McpNodeBaseTemplate<
  typeof LinearMcpTemplateSchema,
  BaseMcp<LinearMcpTemplateSchemaType>
> {
  readonly id = 'linear-mcp';
  readonly name = 'Linear MCP';
  readonly description =
    'Linear integration via the remote Linear MCP server (OAuth — requires a Runtime node)';
  readonly schema = LinearMcpTemplateSchema;

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
    private readonly logger: DefaultLogger,
  ) {
    super();
  }

  public async create() {
    return {
      provide: async (_params: GraphNode<LinearMcpTemplateSchemaType>) =>
        this.createNewInstance(this.moduleRef, LinearMcp),
      configure: async (
        params: GraphNode<LinearMcpTemplateSchemaType>,
        instance: LinearMcp,
      ) => {
        const graphId = params.metadata.graphId;
        const outputNodeIds = params.outputNodeIds;
        const config = params.config;

        const runtimeNodeId = Array.from(outputNodeIds).find((nodeId) => {
          const node = this.graphRegistry.getNode(graphId, nodeId);
          return node?.type === NodeKind.Runtime;
        });

        if (!runtimeNodeId) {
          throw new Error('Linear MCP requires a Runtime node connection');
        }

        const runtimeNode = this.graphRegistry.getNode<RuntimeThreadProvider>(
          graphId,
          runtimeNodeId,
        );
        if (!runtimeNode) {
          throw new Error(
            `Runtime instance not found for node ${runtimeNodeId}`,
          );
        }

        await instance.cleanup().catch(() => {});

        const runtimeConfig = runtimeNode.config as RuntimeStartParams;
        try {
          const runtime = await instance.provideTemporaryRuntime({
            runtimeProvider: this.runtimeProvider,
            graphId,
            runtimeNodeId,
            runtimeConfig,
          });
          await instance.initialize(
            config,
            runtimeNode.instance,
            runtime,
            params.metadata.nodeId,
          );
        } catch {
          // Non-fatal: the OAuth token is injected into the RUN-time runtime by
          // the compiler's secret-select resolution, NOT this temporary
          // validation runtime — and the user may not have authenticated yet. A
          // deploy-time connect failure must NOT abort the whole graph. The
          // Claude bridge resolves + connects at run time; the SimpleAgent path
          // re-validates on the next run/redeploy once the token is present.
          // No error detail is logged (it may carry sandbox-derived content).
          this.logger.warn(
            `Linear MCP node ${params.metadata.nodeId} did not connect at deploy time; deferring validation to run time (most commonly the OAuth token is not yet authenticated or not present in the validation runtime, but any connect error is tolerated here).`,
          );
        } finally {
          await this.runtimeProvider
            .cleanupRuntimeInstance({
              graphId,
              runtimeNodeId,
              threadId: `mcp-init-${graphId}-${runtimeNodeId}`,
              type: this.runtimeProvider.getDefaultRuntimeType(),
            })
            .catch(() => {});
        }
      },
      destroy: async (instance: LinearMcp) => {
        await instance.cleanup().catch(() => {});
      },
    };
  }
}
