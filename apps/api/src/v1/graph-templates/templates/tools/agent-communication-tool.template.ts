import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import { InternalException, NotFoundException } from '@packages/common';
import { isObject } from 'lodash';
import { z } from 'zod';

import { BuiltAgentTool } from '../../../agent-tools/tools/base-tool';
import { CommunicationToolGroup } from '../../../agent-tools/tools/common/communication/communication-tool-group';
import {
  AgentInfo,
  CommunicationAgentResult,
} from '../../../agent-tools/tools/common/communication/communication-tools.types';
import type { RunnableAgent } from '../../../agents/agents.types';
import { BaseAgentConfigurable } from '../../../agents/agents.types';
import { extractExploredFilesFromMessages } from '../../../agents/agents.utils';
import { GraphNode, NodeKind } from '../../../graphs/graphs.types';
import { parseStructuredContent } from '../../../graphs/graphs.utils';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import { RegisterTemplate } from '../../decorators/register-template.decorator';
import { ToolNodeBaseTemplate } from '../base-node.template';

export const AgentCommunicationToolTemplateSchema = z
  .object({})
  // Strip legacy/unknown fields so older configs remain valid.
  .strip();

@Injectable()
@RegisterTemplate()
export class AgentCommunicationToolTemplate extends ToolNodeBaseTemplate<
  typeof AgentCommunicationToolTemplateSchema
> {
  readonly id = 'agent-communication-tool';
  readonly name = 'Agent communication';
  readonly description =
    'Allows an agent to initiate communication with another agent via an internal request pipeline.';
  readonly schema = AgentCommunicationToolTemplateSchema;

  readonly inputs = [
    {
      type: 'kind',
      value: NodeKind.SimpleAgent,
      multiple: true,
    },
    {
      type: 'kind',
      value: NodeKind.ClaudeAgent,
      multiple: true,
    },
  ] as const;

  readonly outputs = [
    {
      type: 'kind',
      value: NodeKind.SimpleAgent,
      multiple: true,
    },
    {
      type: 'kind',
      value: NodeKind.ClaudeAgent,
      multiple: true,
    },
  ] as const;

  constructor(
    private readonly communicationToolGroup: CommunicationToolGroup,
    private readonly graphRegistry: GraphRegistry,
  ) {
    super();
  }

  public async create() {
    return {
      provide: async (
        _params: GraphNode<
          z.infer<typeof AgentCommunicationToolTemplateSchema>
        >,
      ) => ({ tools: [] }),
      configure: async (
        params: GraphNode<z.infer<typeof AgentCommunicationToolTemplateSchema>>,
        instance: { tools: BuiltAgentTool[]; instructions?: string },
      ) => {
        const outputNodeIds = params.outputNodeIds;
        const metadata = params.metadata;

        const agentNodeIds = this.graphRegistry.filterAgentNodeIds(
          metadata.graphId,
          outputNodeIds,
        );

        if (agentNodeIds.length === 0) {
          throw new NotFoundException(
            'TARGET_AGENT_NOT_FOUND',
            'No agent nodes found in output nodes for communication',
          );
        }

        const agentInfos: AgentInfo[] = agentNodeIds.map((agentNodeId) => {
          const agentNode = this.graphRegistry.getNode<RunnableAgent>(
            metadata.graphId,
            agentNodeId,
          );

          if (!agentNode) {
            throw new NotFoundException(
              'TARGET_AGENT_NOT_FOUND',
              `Agent node ${agentNodeId} not found in graph ${metadata.graphId}`,
            );
          }

          const agentConfig = agentNode.config as {
            name: string;
            description: string;
          };

          if (!agentConfig.name || !agentConfig.description) {
            throw new NotFoundException(
              'AGENT_CONFIG_INVALID',
              `Agent node ${agentNodeId} must have name and description configured`,
            );
          }

          const invokeAgent = async (
            messages: string[],
            runnableConfig: ToolRunnableConfig<BaseAgentConfigurable>,
          ): Promise<CommunicationAgentResult> => {
            const currentAgentNode = this.graphRegistry.getNode<RunnableAgent>(
              metadata.graphId,
              agentNodeId,
            );

            if (!currentAgentNode) {
              throw new NotFoundException(
                'TARGET_AGENT_NOT_FOUND',
                `Agent node ${agentNodeId} not found in graph ${metadata.graphId}`,
              );
            }

            const agent = currentAgentNode.instance;

            const rootParentThreadId =
              runnableConfig.configurable?.parent_thread_id ||
              runnableConfig.configurable?.thread_id ||
              `inter-agent-${Date.now()}`;

            const effectiveThreadId = `${rootParentThreadId}__${metadata.nodeId}__${agentConfig.name}`;

            const preparedMessages = messages.map(
              (msg) =>
                new HumanMessage({
                  content: msg,
                  additional_kwargs: {
                    __isAgentInstructionMessage: true,
                    __interAgentCommunication: true,
                    __sourceAgentNodeId: runnableConfig.configurable?.node_id,
                    __createdAt: new Date().toISOString(),
                  },
                }),
            );

            const checkpointNs = `${effectiveThreadId}:${agentNodeId}`;

            const enrichedConfig: ToolRunnableConfig<BaseAgentConfigurable> = {
              ...runnableConfig,
              configurable: {
                ...runnableConfig.configurable,
                thread_id: effectiveThreadId,
                graph_id: metadata.graphId,
                node_id: agentNodeId,
                parent_thread_id: rootParentThreadId,
                checkpoint_ns: checkpointNs,
                graph_created_by:
                  runnableConfig.configurable?.graph_created_by ??
                  metadata.graph_created_by,
                graph_project_id:
                  runnableConfig.configurable?.graph_project_id ??
                  metadata.graph_project_id,
                // Inter-agent communication metadata to propagate to all messages
                __interAgentCommunication: true,
                __sourceAgentNodeId: runnableConfig.configurable?.node_id,
              },
            };

            const response = await agent.runOrAppend(
              effectiveThreadId,
              preparedMessages,
              undefined,
              enrichedConfig,
            );

            if (response.waiting === true) {
              throw new InternalException(
                'WAIT_FOR_LEAKED_FROM_CALLEE',
                `Callee agent "${agentConfig.name}" returned with waiting=true. ` +
                  'This is a bug — the wait_for guard in wait-for.tool.ts should have blocked it.',
              );
            }

            const lastMessage = this.findLastNonSystemMessage(
              response.messages,
            );
            const { responseMessage, needsMoreInfo } =
              this.extractMessageContent(lastMessage);

            const exploredFiles = extractExploredFilesFromMessages(
              response.messages,
            );

            // Checkpoint-less callees (ClaudeAgent) signal questions via the
            // AgentOutput flag rather than a finish-tool message — honor both.
            //
            // Cost fold uses ONLY the callee's run-scoped statistics: summing
            // response.messages would re-count a checkpointed callee's whole
            // history on repeat invocations. A callee that doesn't report
            // statistics (SimpleAgent today) keeps its existing
            // own-thread-only cost accounting.
            const calleeUsage = response.statistics?.usage;

            return {
              message: responseMessage || 'No response message available',
              needsMoreInfo: needsMoreInfo || response.needsMoreInfo === true,
              ...(exploredFiles.length > 0 ? { exploredFiles } : {}),
              threadId: response.threadId,
              checkpointNs: response.checkpointNs,
              ...(calleeUsage ? { calleeUsage } : {}),
            };
          };

          return {
            name: agentConfig.name,
            description: agentConfig.description,
            invokeAgent,
          };
        });

        const { tools, instructions } = this.communicationToolGroup.buildTools({
          agents: agentInfos,
        });

        instance.tools.length = 0;
        instance.tools.push(...tools);
        instance.instructions = instructions;
      },
      destroy: async (instance: { tools: BuiltAgentTool[] }) => {
        instance.tools.length = 0;
      },
    };
  }

  private findLastNonSystemMessage(
    messages: BaseMessage[],
  ): BaseMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.type !== 'system') {
        return msg;
      }
    }
    return undefined;
  }

  private extractMessageContent(message: BaseMessage | undefined): {
    responseMessage: string | undefined;
    needsMoreInfo: boolean;
  } {
    if (!message) {
      return { responseMessage: undefined, needsMoreInfo: false };
    }

    if (message.type === 'tool' && message.name === 'finish') {
      return this.extractFinishToolContent(message);
    }

    if (message.type === 'ai' || message.type === 'human') {
      return {
        responseMessage: this.stringifyContent(message.content),
        needsMoreInfo: false,
      };
    }

    return { responseMessage: undefined, needsMoreInfo: false };
  }

  private extractFinishToolContent(message: BaseMessage): {
    responseMessage: string;
    needsMoreInfo: boolean;
  } {
    const content = this.stringifyContent(message.content);
    const parsedContent = parseStructuredContent(content);

    if (!isObject(parsedContent)) {
      return { responseMessage: content, needsMoreInfo: false };
    }

    const rec = parsedContent as Record<string, unknown>;
    const parsedMessage = rec.message;

    if (typeof parsedMessage === 'string' && parsedMessage.length > 0) {
      return {
        responseMessage: parsedMessage,
        needsMoreInfo: rec.needsMoreInfo === true,
      };
    }

    return {
      responseMessage: content,
      needsMoreInfo: rec.needsMoreInfo === true,
    };
  }

  private stringifyContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    return JSON.stringify(content);
  }
}
