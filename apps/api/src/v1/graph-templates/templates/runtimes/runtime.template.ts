import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { GraphNode } from '../../../graphs/graphs.types';
import { NodeKind } from '../../../graphs/graphs.types';
import { RuntimeProvider } from '../../../runtime/services/runtime-provider';
import { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
import { RegisterTemplate } from '../../decorators/register-template.decorator';
import { RuntimeNodeBaseTemplate } from '../base-node.template';

export const RuntimeTemplateSchema = z
  .object({
    labels: z.record(z.string(), z.string()).optional().describe('Labels'),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe('Environment variables'),
    initScript: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe('Initialization commands')
      .meta({ 'x-ui:textarea': true }),
    initScriptTimeoutMs: z
      .number()
      .positive()
      .default(600_000)
      .optional()
      .describe('Timeout in milliseconds for initialization script execution'),
    secrets: z
      .array(z.string())
      .optional()
      .describe('Secrets to inject as environment variables into the runtime')
      .meta({ 'x-ui:secret-multi-select': true }),
  })
  .strip();

export type RuntimeTemplateSchemaType = z.infer<typeof RuntimeTemplateSchema>;

@Injectable()
@RegisterTemplate()
export class RuntimeTemplate extends RuntimeNodeBaseTemplate<
  typeof RuntimeTemplateSchema
> {
  readonly id = 'runtime';
  readonly name = 'Runtime';
  readonly description = 'Runtime environment for executing code';
  readonly schema = RuntimeTemplateSchema;

  readonly inputs = [
    {
      type: 'template',
      value: 'shell-tool',
      multiple: true,
    },
    {
      type: 'template',
      value: 'gh-tool',
      multiple: true,
    },
    {
      type: 'template',
      value: 'files-tool',
      multiple: true,
    },
    {
      type: 'template',
      value: 'subagents-tool',
      multiple: true,
    },
    // MCP nodes can run inside this runtime as well.
    {
      type: 'kind',
      value: NodeKind.Mcp,
      multiple: true,
    },
    // Agent nodes (SimpleAgent and SystemAgent share the same kind) can run inside this runtime.
    {
      type: 'kind',
      value: NodeKind.SimpleAgent,
      multiple: true,
    },
    // Claude Agent nodes host their Claude Code session inside this runtime.
    {
      type: 'kind',
      value: NodeKind.ClaudeAgent,
      multiple: true,
    },
  ] as const;

  constructor(private readonly runtimeProvider: RuntimeProvider) {
    super();
  }

  public async create() {
    return {
      provide: async (params: GraphNode<RuntimeTemplateSchemaType>) => {
        return new RuntimeThreadProvider(this.runtimeProvider, {
          graphId: params.metadata.graphId,
          runtimeNodeId: params.metadata.nodeId,
          runtimeStartParams: params.config,
          type: this.runtimeProvider.getDefaultRuntimeType(),
          temporary: params.metadata.temporary ?? false,
        });
      },
      configure: async (
        params: GraphNode<RuntimeTemplateSchemaType>,
        instance: RuntimeThreadProvider,
      ) => {
        instance.setParams({
          graphId: params.metadata.graphId,
          runtimeNodeId: params.metadata.nodeId,
          runtimeStartParams: params.config,
          type: this.runtimeProvider.getDefaultRuntimeType(),
          temporary: params.metadata.temporary ?? false,
        });
      },
      destroy: async (instance: RuntimeThreadProvider) => {
        await instance.cleanup();
      },
    };
  }
}
