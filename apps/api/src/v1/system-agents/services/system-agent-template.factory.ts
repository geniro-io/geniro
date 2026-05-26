import { DynamicStructuredTool } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DefaultLogger } from '@packages/common';
import { z } from 'zod';

import type { BaseMcp } from '../../agent-mcp/services/base-mcp';
import { BuiltAgentTool } from '../../agent-tools/tools/base-tool';
import { SimpleAgent } from '../../agents/services/agents/simple-agent';
import { TemplateRegistry } from '../../graph-templates/services/template-registry';
import {
  buildAgentInstructions,
  collectDeferredToolsList,
  collectInstructionBlockContent,
  collectMcpInstructions,
  collectToolGroupInstructions,
  collectToolInstructions,
} from '../../graph-templates/templates/agents/agent-instructions.utils';
import { SimpleAgentTemplateSchema } from '../../graph-templates/templates/agents/simple-agent.template';
import {
  NodeConnection,
  SimpleAgentNodeBaseTemplate,
  ToolNodeOutput,
} from '../../graph-templates/templates/base-node.template';
import type {
  GraphNode,
  GraphNodeInstanceHandle,
} from '../../graphs/graphs.types';
import { NodeKind } from '../../graphs/graphs.types';
import { GraphRegistry } from '../../graphs/services/graph-registry';
import type { SystemAgentDefinition } from '../system-agents.types';
import { SystemAgentsService } from './system-agents.service';

type SystemAgentSchemaType = z.infer<typeof SimpleAgentTemplateSchema> & {
  systemAgentId: string;
  systemAgentContentHash: string;
};

@Injectable()
export class SystemAgentTemplateFactory {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly graphRegistry: GraphRegistry,
    private readonly templateRegistry: TemplateRegistry,
    private readonly logger: DefaultLogger,
    private readonly systemAgentsService: SystemAgentsService,
  ) {}

  createTemplate(
    def: SystemAgentDefinition,
  ): SimpleAgentNodeBaseTemplate<z.ZodTypeAny, SimpleAgent> {
    const schema = SimpleAgentTemplateSchema.extend({
      name: z
        .string()
        .min(1)
        .describe('Unique name for this agent')
        .default(def.name),
      description: z
        .string()
        .min(1)
        .describe('Description of what this agent does')
        .meta({ 'x-ui:textarea': true })
        .default(def.description),
      instructions: z
        .string()
        .describe(
          'System prompt injected at the start of each turn: role, goals, constraints, style.',
        )
        .meta({ 'x-ui:textarea': true })
        .default(def.instructions),
      ...(def.defaultModel
        ? {
            invokeModelName: z
              .string()
              .describe(
                'Chat model used for the main reasoning/tool-call step.',
              )
              .meta({ 'x-ui:show-on-node': true })
              .meta({ 'x-ui:label': 'Model' })
              .meta({ 'x-ui:litellm-models-list-select': true })
              .default(def.defaultModel),
          }
        : {}),
      systemAgentId: z.string().default(def.id),
      systemAgentContentHash: z.string().default(def.contentHash),
    });

    const moduleRef = this.moduleRef;
    const graphRegistry = this.graphRegistry;
    const templateRegistry = this.templateRegistry;
    const logger = this.logger;
    const systemAgentsService = this.systemAgentsService;

    const template = new (class extends SimpleAgentNodeBaseTemplate<
      typeof schema,
      SimpleAgent
    > {
      readonly id = def.templateId;
      readonly name = def.name;
      readonly description = def.description;
      readonly schema = schema;
      readonly systemAgentId = def.id;
      readonly systemAgentContentHash = def.contentHash;
      readonly systemAgentPredefinedTools = def.tools.map((t) => t.id);

      readonly inputs = [
        {
          type: 'template' as const,
          value: 'agent-communication-tool',
          multiple: true,
        },
        { type: 'kind' as const, value: NodeKind.Trigger, multiple: true },
      ] as const;

      readonly outputs = [
        { type: 'kind' as const, value: NodeKind.Tool, multiple: true },
        { type: 'kind' as const, value: NodeKind.Mcp, multiple: true },
        { type: 'kind' as const, value: NodeKind.Runtime, multiple: false },
        { type: 'kind' as const, value: NodeKind.Instruction, multiple: true },
      ] as const;

      async create() {
        const predefinedHandles: {
          handle: GraphNodeInstanceHandle<unknown, unknown>;
          toolInstance: unknown;
        }[] = [];

        return {
          provide: async (_params: GraphNode<SystemAgentSchemaType>) =>
            await this.createNewInstance(moduleRef, SimpleAgent),

          configure: async (
            params: GraphNode<SystemAgentSchemaType>,
            instance: SimpleAgent,
          ) => {
            const outputNodeIds = params.outputNodeIds;
            const graphId = params.metadata.graphId;
            const config = params.config;

            const allTools: BuiltAgentTool[] = [];
            const toolGroupInstructions: string[] = [];
            const mcpOutputs: BaseMcp<unknown>[] = [];
            const instructionContents: string[] = [];
            const manualToolTemplateIds = new Set<string>();

            for (const nodeId of outputNodeIds) {
              const node = graphRegistry.getNode<
                | BuiltAgentTool
                | BuiltAgentTool[]
                | ToolNodeOutput
                | DynamicStructuredTool
                | DynamicStructuredTool[]
                | BaseMcp<unknown>
              >(graphId, nodeId);

              if (!node) {
                continue;
              }

              const inst = node.instance;

              if (node.type === NodeKind.Tool) {
                manualToolTemplateIds.add(node.template);
                if (inst && typeof inst === 'object' && 'tools' in inst) {
                  const toolNodeOutput = inst as ToolNodeOutput;
                  allTools.push(...toolNodeOutput.tools);
                  if (toolNodeOutput.instructions) {
                    toolGroupInstructions.push(toolNodeOutput.instructions);
                  }
                } else {
                  const tools = Array.isArray(inst) ? inst : [inst];
                  tools.forEach((tool) =>
                    allTools.push(tool as BuiltAgentTool),
                  );
                }
                continue;
              }

              if (node.type === NodeKind.Mcp) {
                mcpOutputs.push(inst as BaseMcp<unknown>);
                continue;
              }

              if (node.type === NodeKind.Instruction) {
                const content = node.instance as unknown as string;
                if (content) {
                  instructionContents.push(content);
                }
                continue;
              }
            }

            const runtimeNodeIds = graphRegistry.filterNodesByType(
              graphId,
              outputNodeIds,
              NodeKind.Runtime,
            );

            predefinedHandles.length = 0;
            for (const toolEntry of def.tools) {
              const toolId = toolEntry.id;

              if (manualToolTemplateIds.has(toolId)) {
                continue;
              }

              const toolTemplate = templateRegistry.getTemplate<
                z.ZodTypeAny,
                ToolNodeOutput
              >(toolId);
              if (!toolTemplate) {
                logger.warn(
                  `Predefined tool template '${toolId}' not found in registry — skipping`,
                );
                continue;
              }

              let unsatisfiable = false;
              for (const output of toolTemplate.outputs as readonly NodeConnection[]) {
                if (output.required !== true) {
                  continue;
                }
                if (output.type === 'template') {
                  logger.warn(
                    `Predefined tool '${toolId}' requires a template output connection that cannot be satisfied — skipping`,
                  );
                  unsatisfiable = true;
                  break;
                }
                if (
                  output.type === 'kind' &&
                  output.value !== NodeKind.Runtime
                ) {
                  logger.warn(
                    `Predefined tool '${toolId}' requires a kind='${output.value}' output connection that cannot be satisfied — skipping`,
                  );
                  unsatisfiable = true;
                  break;
                }
              }

              if (unsatisfiable) {
                continue;
              }

              let defaultConfig: unknown;
              try {
                defaultConfig = toolTemplate.schema.parse(
                  toolEntry.config ?? {},
                );
              } catch (err) {
                logger.warn(
                  `Predefined tool '${toolId}' has no parseable default config — skipping: ${String(err)}`,
                );
                continue;
              }

              const syntheticNodeId = `${params.metadata.nodeId}:predefined:${toolId}`;
              const syntheticParams = {
                config: defaultConfig,
                inputNodeIds: new Set<string>(),
                outputNodeIds: new Set(runtimeNodeIds),
                metadata: { ...params.metadata, nodeId: syntheticNodeId },
              } as GraphNode<z.ZodTypeAny>;

              let handle: GraphNodeInstanceHandle<unknown, unknown>;
              let toolInstance: unknown;
              try {
                handle =
                  (await toolTemplate.create()) as GraphNodeInstanceHandle<
                    unknown,
                    unknown
                  >;
                toolInstance = await handle.provide(syntheticParams);
                await handle.configure(syntheticParams, toolInstance);
              } catch (err) {
                logger.warn(
                  `Predefined tool '${toolId}' failed to instantiate — skipping: ${String(err)}`,
                );
                continue;
              }

              predefinedHandles.push({ handle, toolInstance });

              const output = toolInstance as {
                tools: BuiltAgentTool[];
                instructions?: string;
              };
              if (output.tools) {
                allTools.push(...output.tools);
              }
              if (output.instructions) {
                toolGroupInstructions.push(output.instructions);
              }
            }

            instance.resetTools();
            allTools.forEach((tool) => instance.addTool(tool));

            const mcpInstructions = collectMcpInstructions(mcpOutputs);

            instance.setConfig(config);
            instance.setMcpServices(mcpOutputs);
            await instance.initTools(config);

            const toolInstructions = collectToolInstructions(
              instance.getTools() as BuiltAgentTool[],
            );
            const toolGroupInstructionsText = collectToolGroupInstructions(
              toolGroupInstructions,
            );

            let liveInstructions: string;
            try {
              const latestDef = systemAgentsService.getById(def.id);
              liveInstructions = latestDef.instructions;
            } catch {
              liveInstructions = config.instructions;
            }

            const instructionBlockContent =
              collectInstructionBlockContent(instructionContents);

            const deferredToolsList = collectDeferredToolsList(
              instance.getDeferredTools(),
            );

            const finalConfig = {
              ...config,
              instructions: buildAgentInstructions(liveInstructions, {
                instructionBlockContent,
                deferredToolsList,
                toolGroupInstructionsText,
                toolInstructions,
                mcpInstructions,
              }),
            };

            instance.setConfig(finalConfig);
          },

          destroy: async (instance: SimpleAgent) => {
            for (const { handle, toolInstance } of predefinedHandles) {
              await handle.destroy(toolInstance);
            }
            await instance.stop();
          },
        };
      }
    })();

    return template;
  }
}
