import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';
import { z } from 'zod';

import { execRuntimeWithContext } from '../../../agent-tools/agent-tools.utils';
import { BuiltAgentTool } from '../../../agent-tools/tools/base-tool';
import {
  GhToolGroup,
  GhToolType,
} from '../../../agent-tools/tools/common/github/gh-tool-group';
import { IGithubResourceOutput } from '../../../graph-resources/services/github-resource';
import { GraphNode, NodeKind } from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
import { RegisterTemplate } from '../../decorators/register-template.decorator';
import { ToolNodeBaseTemplate } from '../base-node.template';

export const GhToolTemplateSchema = z
  .object({
    readOnly: z
      .boolean()
      .default(false)
      .optional()
      .describe(
        'When true, expose only read-only GH tools (clone, PR read, issues, comments); hide write tools (commit, branch, push, PR create)',
      ),
    additionalLabels: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Labels that will always be applied when creating PRs via gh_pr_create.',
      ),
  })
  .strip();

@Injectable()
@RegisterTemplate()
export class GhToolTemplate extends ToolNodeBaseTemplate<
  typeof GhToolTemplateSchema
> {
  readonly id = 'gh-tool';
  readonly name = 'GitHub Tools';
  readonly description = 'GitHub tools';
  readonly schema = GhToolTemplateSchema;

  readonly inputs = [
    {
      type: 'kind',
      value: NodeKind.SimpleAgent,
      multiple: true,
    },
  ] as const;

  readonly outputs = [
    {
      type: 'template',
      value: 'github-resource',
      multiple: false,
      required: true,
    },
    {
      type: 'kind',
      value: NodeKind.Runtime,
      required: true,
      multiple: false,
    },
  ] as const;

  constructor(
    private readonly ghToolGroup: GhToolGroup,
    private readonly graphRegistry: GraphRegistry,
  ) {
    super();
  }

  public async create() {
    let executorNodeId: string | undefined;

    return {
      provide: async (
        _params: GraphNode<z.infer<typeof GhToolTemplateSchema>>,
      ) => ({ tools: [] }),
      configure: async (
        params: GraphNode<z.infer<typeof GhToolTemplateSchema>>,
        instance: {
          tools: BuiltAgentTool[];
          instructions?: string;
          runtimeProvider?: RuntimeThreadProvider;
        },
      ) => {
        const graphId = params.metadata.graphId;
        executorNodeId = params.metadata.nodeId;
        const outputNodeIds = params.outputNodeIds;
        const config = params.config;

        const runtimeNodeIds = this.graphRegistry.filterNodesByType(
          graphId,
          outputNodeIds,
          NodeKind.Runtime,
        );

        if (runtimeNodeIds.length === 0) {
          throw new NotFoundException(
            'NODE_NOT_FOUND',
            `Runtime node not found in output nodes`,
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

        const resourceNodeIds = this.graphRegistry.filterNodesByTemplate(
          graphId,
          outputNodeIds,
          'github-resource',
        );
        const ghResourceId = resourceNodeIds[0];

        const ghResourceNode =
          this.graphRegistry.getNode<IGithubResourceOutput>(
            graphId,
            ghResourceId || '',
          );

        if (!ghResourceNode) {
          throw new NotFoundException(
            'RESOURCE_NOT_FOUND',
            `No GitHub resource nodes found in output nodes`,
          );
        }

        const ghResource = ghResourceNode.instance;

        const initScript = ghResource.data.initScript;
        const initScriptTimeout = ghResource.data.initScriptTimeout;
        const resolveEnv = ghResource.data.resolveEnv;
        const currentRuntimeParams = runtimeNode.instance.getParams();
        const baseTimeout =
          currentRuntimeParams.runtimeStartParams.initScriptTimeoutMs ?? 0;
        const initScriptList = Array.isArray(initScript)
          ? initScript
          : initScript
            ? [initScript]
            : [];
        const initScriptTimeoutMs = Math.max(
          baseTimeout,
          initScriptTimeout ?? 0,
        );
        if (initScriptList.length > 0) {
          runtimeNode.instance.registerJob(
            executorNodeId,
            `gh-init:${executorNodeId}`,
            async (runtime, cfg) => {
              const resourceEnv = await resolveEnv(cfg);
              for (const script of initScriptList) {
                const result = await execRuntimeWithContext(
                  runtime,
                  {
                    cmd: script,
                    timeoutMs: initScriptTimeoutMs || undefined,
                    env: resourceEnv,
                  },
                  cfg,
                );
                if (result.fail) {
                  throw new Error(
                    `GitHub init script failed (exit ${result.exitCode}): ${result.stderr}`,
                  );
                }
              }
            },
          );
        }

        const parsedConfig = GhToolTemplateSchema.parse(config);
        const additionalLabels = parsedConfig.additionalLabels?.length
          ? parsedConfig.additionalLabels
          : undefined;

        const { tools: builtTools, instructions } = this.ghToolGroup.buildTools(
          {
            runtimeProvider: runtimeNode.instance,
            readOnly: parsedConfig.readOnly,
            additionalLabels,
            resolveTokenForOwner: ghResource.resolveToken,
          },
        );

        instance.tools.length = 0;
        instance.tools.push(...builtTools);
        instance.instructions = instructions;
        instance.runtimeProvider = runtimeNode.instance;
      },
      destroy: async (instance: {
        tools: BuiltAgentTool[];
        runtimeProvider?: RuntimeThreadProvider;
      }) => {
        if (instance.runtimeProvider && executorNodeId) {
          instance.runtimeProvider.removeExecutor(executorNodeId);
        }
        instance.tools.length = 0;
      },
    };
  }
}
