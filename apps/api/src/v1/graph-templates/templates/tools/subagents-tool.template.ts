import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';
import { z } from 'zod';

import { BuiltAgentTool } from '../../../agent-tools/tools/base-tool';
import { FilesToolGroup } from '../../../agent-tools/tools/common/files/files-tool-group';
import { ShellTool } from '../../../agent-tools/tools/common/shell.tool';
import { SubagentsToolGroup } from '../../../agent-tools/tools/common/subagents/subagents-tool-group';
import { ThreadStoreToolGroup } from '../../../agent-tools/tools/common/thread-store/thread-store-tool-group';
import { GraphNode, NodeKind } from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
import { SubagentToolId } from '../../../subagents/subagents.types';
import { RegisterTemplate } from '../../decorators/register-template.decorator';
import { ToolNodeBaseTemplate } from '../base-node.template';

export const SubagentsToolTemplateSchema = z.object({}).strip();
export type SubagentsToolTemplateSchemaType = z.infer<
  typeof SubagentsToolTemplateSchema
>;

@Injectable()
@RegisterTemplate()
export class SubagentsToolTemplate extends ToolNodeBaseTemplate<
  typeof SubagentsToolTemplateSchema
> {
  readonly id = 'subagents-tool';
  readonly name = 'Subagents';
  readonly description =
    'Spawn lightweight subagents to perform autonomous tasks';
  readonly schema = SubagentsToolTemplateSchema;

  readonly inputs = [
    {
      type: 'kind',
      value: NodeKind.SimpleAgent,
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
    private readonly subagentsToolGroup: SubagentsToolGroup,
    private readonly shellTool: ShellTool,
    private readonly filesToolGroup: FilesToolGroup,
    private readonly threadStoreToolGroup: ThreadStoreToolGroup,
    private readonly graphRegistry: GraphRegistry,
  ) {
    super();
  }

  public async create() {
    return {
      provide: async (_params: GraphNode<SubagentsToolTemplateSchemaType>) => ({
        tools: [] as BuiltAgentTool[],
        instructions: undefined as string | undefined,
      }),

      configure: async (
        params: GraphNode<SubagentsToolTemplateSchemaType>,
        instance: { tools: BuiltAgentTool[]; instructions?: string },
      ) => {
        const graphId = params.metadata.graphId;

        const runtimeNodeIds = this.graphRegistry.filterNodesByType(
          graphId,
          params.outputNodeIds,
          NodeKind.Runtime,
        );

        if (runtimeNodeIds.length === 0) {
          throw new NotFoundException(
            'NODE_NOT_FOUND',
            'Runtime node not found in output nodes',
          );
        }

        const runtimeNodeId = runtimeNodeIds[0]!;
        const runtimeNode = this.graphRegistry.getNode<RuntimeThreadProvider>(
          graphId,
          runtimeNodeId,
        );

        if (!runtimeNode) {
          throw new NotFoundException(
            'NODE_NOT_FOUND',
            `Runtime node ${runtimeNodeId} not found`,
          );
        }

        const toolSets = new Map<string, BuiltAgentTool[]>();

        const shellBuilt = this.shellTool.build({
          runtimeProvider: runtimeNode.instance,
        });
        toolSets.set(SubagentToolId.Shell, [shellBuilt]);

        // TODO(M12): ShellReadOnly relies on system-prompt enforcement; add structural
        // readOnly once ShellTool supports command-level rejection (deny/allow-list).
        // When M12 lands, replace [shellBuilt] with shellTool.build({ runtimeProvider, readOnly: true }).
        toolSets.set(SubagentToolId.ShellReadOnly, [shellBuilt]);

        const filesReadOnly = this.filesToolGroup.buildTools({
          runtimeProvider: runtimeNode.instance,
          includeEditActions: false,
        });
        toolSets.set(SubagentToolId.FilesReadOnly, filesReadOnly.tools);

        const filesFull = this.filesToolGroup.buildTools({
          runtimeProvider: runtimeNode.instance,
          includeEditActions: true,
        });
        toolSets.set(SubagentToolId.FilesFull, filesFull.tools);

        const threadStoreFull = this.threadStoreToolGroup.buildTools({});
        toolSets.set(SubagentToolId.ThreadStore, threadStoreFull.tools);

        const threadStoreReadOnly = this.threadStoreToolGroup.buildTools({
          readOnly: true,
        });
        toolSets.set(
          SubagentToolId.ThreadStoreReadOnly,
          threadStoreReadOnly.tools,
        );

        const { tools, instructions } = this.subagentsToolGroup.buildTools({
          toolSets,
          runtimeProvider: runtimeNode.instance,
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
}
