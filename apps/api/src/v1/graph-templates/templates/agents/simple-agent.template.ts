import { DynamicStructuredTool } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { z } from 'zod';

import type { BaseMcp } from '../../../agent-mcp/services/base-mcp';
import { BuiltAgentTool } from '../../../agent-tools/tools/base-tool';
import { NewMessageMode, ReasoningEffort } from '../../../agents/agents.types';
import { SimpleAgent } from '../../../agents/services/agents/simple-agent';
import type { GraphNode } from '../../../graphs/graphs.types';
import { NodeKind } from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import { RegisterTemplate } from '../../decorators/register-template.decorator';
import {
  SimpleAgentNodeBaseTemplate,
  ToolNodeOutput,
} from '../base-node.template';
import {
  buildAgentInstructions,
  collectDeferredToolsList,
  collectInstructionBlockContent,
  collectMcpInstructions,
  collectToolGroupInstructions,
  collectToolInstructions,
} from './agent-instructions.utils';

export const SimpleAgentTemplateSchema = z.object({
  name: z.string().min(1).describe('Unique name for this agent'),
  description: z
    .string()
    .min(1)
    .describe('Description of what this agent does')
    .meta({ 'x-ui:textarea': true }),
  summarizeMaxTokens: z
    .number()
    .catch(200000)
    .optional()
    .describe(
      'Total token budget for summary + recent context. If current history exceeds this, older messages are folded into the rolling summary.',
    ),
  summarizeKeepTokens: z
    .number()
    .default(30000)
    .optional()
    .describe(
      'Token budget reserved for the most recent messages kept verbatim when summarizing (the "tail").',
    ),
  instructions: z
    .string()
    .describe(
      'System prompt injected at the start of each turn: role, goals, constraints, style.',
    )
    .meta({ 'x-ui:textarea': true })
    .meta({ 'x-ui:ai-suggestions': true }),
  invokeModelName: z
    .string()
    .describe('Chat model used for the main reasoning/tool-call step.')
    .meta({ 'x-ui:show-on-node': true })
    .meta({ 'x-ui:label': 'Model' })
    .meta({ 'x-ui:litellm-models-list-select': true }),
  invokeModelReasoningEffort: z
    .enum(ReasoningEffort)
    .default(ReasoningEffort.None)
    .optional()
    .describe('Reasoning effort')
    .meta({ 'x-ui:show-on-node': true })
    .meta({ 'x-ui:label': 'Reasoning' }),
  maxIterations: z
    .number()
    .int()
    .min(1)
    .max(2500)
    .default(2500)
    .optional()
    .describe(
      'Maximum number of iterations the agent can execute during a single run.',
    ),
  newMessageMode: z
    .enum(NewMessageMode)
    .default(NewMessageMode.InjectAfterToolCall)
    .optional()
    .describe(
      'Controls how to handle new messages when the agent thread is already running. Inject after tool call adds the new input immediately after the next tool execution completes; wait for completion queues the message until the current run finishes.',
    ),
});

export type SimpleAgentTemplateSchemaType = z.infer<
  typeof SimpleAgentTemplateSchema
>;

@Injectable()
@RegisterTemplate()
export class SimpleAgentTemplate extends SimpleAgentNodeBaseTemplate<
  typeof SimpleAgentTemplateSchema,
  SimpleAgent
> {
  readonly id = 'simple-agent';
  readonly name = 'Simple agent';
  readonly description =
    'Configurable agent that can use connected tools and triggers';
  readonly schema = SimpleAgentTemplateSchema;

  readonly inputs = [
    {
      type: 'template',
      value: 'agent-communication-tool',
      multiple: true,
    },
    {
      type: 'kind',
      value: NodeKind.Trigger,
      multiple: true,
    },
  ] as const;

  readonly outputs = [
    {
      type: 'kind',
      value: NodeKind.Tool,
      multiple: true,
    },
    {
      type: 'kind',
      value: NodeKind.Mcp,
      multiple: true,
    },
    {
      type: 'kind',
      value: NodeKind.Instruction,
      multiple: true,
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
      provide: async (_params: GraphNode<SimpleAgentTemplateSchemaType>) =>
        this.createNewInstance(this.moduleRef, SimpleAgent),
      configure: async (
        params: GraphNode<SimpleAgentTemplateSchemaType>,
        instance: SimpleAgent,
      ) => {
        const outputNodeIds = params.outputNodeIds;
        const graphId = params.metadata.graphId;
        const config = params.config;

        const allTools: BuiltAgentTool[] = [];
        const toolGroupInstructions: string[] = [];
        const mcpOutputs: BaseMcp<unknown>[] = [];
        const instructionContents: string[] = [];

        for (const nodeId of outputNodeIds) {
          const node = this.graphRegistry.getNode<
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
            if (inst && typeof inst === 'object' && 'tools' in inst) {
              const toolNodeOutput = inst as ToolNodeOutput;
              allTools.push(...toolNodeOutput.tools);
              if (toolNodeOutput.instructions) {
                toolGroupInstructions.push(toolNodeOutput.instructions);
              }
            } else {
              const tools = Array.isArray(inst) ? inst : [inst];
              tools.forEach((tool) => allTools.push(tool as BuiltAgentTool));
            }
            continue;
          }

          if (node.type === NodeKind.Mcp) {
            const mcpService = inst as BaseMcp<unknown>;
            if (mcpService) {
              mcpOutputs.push(mcpService);
            }
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

        // Replace wiring (idempotent)
        instance.resetTools();
        allTools.forEach((tool) => instance.addTool(tool));

        const mcpInstructions = collectMcpInstructions(mcpOutputs);

        instance.setConfig(config);
        instance.setMcpServices(mcpOutputs);
        const { builtInToolGroupInstructions } =
          await instance.initTools(config);
        toolGroupInstructions.push(...builtInToolGroupInstructions);

        const toolInstructions = collectToolInstructions(
          instance.getTools() as BuiltAgentTool[],
        );
        const toolGroupInstructionsText = collectToolGroupInstructions(
          toolGroupInstructions,
        );

        const instructionBlockContent =
          collectInstructionBlockContent(instructionContents);

        const deferredToolsList = collectDeferredToolsList(
          instance.getDeferredTools(),
        );

        const finalConfig = {
          ...config,
          instructions: buildAgentInstructions(config.instructions, {
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
        await instance.stop();
      },
    };
  }
}
