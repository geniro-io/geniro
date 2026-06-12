import { HumanMessage } from '@langchain/core/messages';
import { RunnableConfig } from '@langchain/core/runnables';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DefaultLogger, NotFoundException } from '@packages/common';
import { v4 } from 'uuid';
import { z } from 'zod';

import { ManualTrigger } from '../../../agent-triggers/services/manual-trigger';
import type { RunnableAgent } from '../../../agents/agents.types';
import { BaseAgentConfigurable } from '../../../agents/agents.types';
import { GraphNode, NodeKind } from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import { RegisterTemplate } from '../../decorators/register-template.decorator';
import { TriggerNodeBaseTemplate } from '../base-node.template';

/**
 * Manual trigger template schema
 */
export const ManualTriggerTemplateSchema = z
  .object({})
  // Strip legacy/unknown fields so older configs remain valid.
  .strip();

export type ManualTriggerTemplateSchemaType = z.infer<
  typeof ManualTriggerTemplateSchema
>;

@Injectable()
@RegisterTemplate()
export class ManualTriggerTemplate extends TriggerNodeBaseTemplate<
  typeof ManualTriggerTemplateSchema,
  ManualTrigger
> {
  readonly id = 'manual-trigger';
  readonly name = 'Manual';
  readonly description = 'Manual trigger for direct agent invocation';
  readonly schema = ManualTriggerTemplateSchema;

  // Neither agent kind is `required` individually — the trigger needs at
  // least one agent of EITHER kind, expressed via the shared `requiredGroup`
  // (OR-validated by the graph compiler). configure() still throws
  // AGENT_NOT_FOUND as a backstop when no agent is connected.
  readonly outputs = [
    {
      type: 'kind',
      value: NodeKind.SimpleAgent,
      requiredGroup: 'agent',
      multiple: true,
    },
    {
      type: 'kind',
      value: NodeKind.ClaudeAgent,
      requiredGroup: 'agent',
      multiple: true,
    },
  ] as const;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly logger: DefaultLogger,
    private readonly graphRegistry: GraphRegistry,
  ) {
    super();
  }

  public async create() {
    return {
      provide: async (_params: GraphNode<ManualTriggerTemplateSchemaType>) =>
        this.createNewInstance(this.moduleRef, ManualTrigger),
      configure: async (
        params: GraphNode<ManualTriggerTemplateSchemaType>,
        instance: ManualTrigger,
      ) => {
        const outputNodeIds = params.outputNodeIds;
        const metadata = params.metadata;

        if (outputNodeIds.size === 0) {
          throw new NotFoundException(
            'AGENT_NOT_FOUND',
            `No output connections found for trigger`,
          );
        }

        const agentNodeId = Array.from(outputNodeIds)[0]!;

        instance.setInvokeAgent(
          async (
            messages: HumanMessage[],
            runnableConfig: RunnableConfig<BaseAgentConfigurable>,
          ) => {
            const currentAgentNode = this.graphRegistry.getNode<RunnableAgent>(
              metadata.graphId,
              agentNodeId,
            );

            if (!currentAgentNode) {
              throw new NotFoundException(
                'AGENT_NOT_FOUND',
                `Agent node ${agentNodeId} not found in graph ${metadata.graphId}`,
              );
            }

            const agent = currentAgentNode.instance;

            const threadId = `${metadata.graphId}:${runnableConfig.configurable?.thread_id || v4()}`;
            const checkpointNs = `${threadId}:${agentNodeId}`;
            const parentThreadId = threadId;

            const enrichedConfig: RunnableConfig<BaseAgentConfigurable> = {
              ...runnableConfig,
              configurable: {
                ...runnableConfig.configurable,
                graph_id: metadata.graphId,
                node_id: agentNodeId,
                thread_id: threadId,
                checkpoint_ns: checkpointNs,
                parent_thread_id: parentThreadId,
                source: `${this.name} (${this.kind})`,
                graph_created_by: metadata.graph_created_by,
                thread_created_by:
                  runnableConfig.configurable?.thread_created_by,
                graph_project_id: metadata.graph_project_id,
                llmRequestContext: metadata.llmRequestContext,
              },
            };

            const promise = agent.runOrAppend(
              threadId,
              messages,
              undefined,
              enrichedConfig,
            );

            if (runnableConfig.configurable?.async) {
              void promise.catch((err) => {
                this.logger.error(err);
              });

              return {
                messages: [],
                threadId,
                checkpointNs,
              };
            }

            return await promise;
          },
        );

        if (!instance.isStarted) {
          await instance.start();
        }
      },
      destroy: async (instance: ManualTrigger) => {
        await instance.stop().catch(() => {});
      },
    };
  }
}
