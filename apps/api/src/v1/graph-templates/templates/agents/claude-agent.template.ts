import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { BadRequestException } from '@packages/common';
import { z } from 'zod';

import type { BaseMcp } from '../../../agent-mcp/services/base-mcp';
import type { BuiltAgentTool } from '../../../agent-tools/tools/base-tool';
import { ClaudeAgent } from '../../../agents/services/agents/claude-agent';
import type { ConnectedMcpServer } from '../../../agents/services/claude/claude-session.types';
import { ClaudeAuthMode } from '../../../agents/services/claude/claude-session.types';
import { isToolForwardableToClaude } from '../../../agents/services/claude/claude-session.utils';
import type { GraphNode } from '../../../graphs/graphs.types';
import { NodeKind } from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import type { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
import { RegisterTemplate } from '../../decorators/register-template.decorator';
import {
  ClaudeAgentNodeBaseTemplate,
  type ToolNodeOutput,
} from '../base-node.template';

export const ClaudeAgentTemplateSchema = z.object({
  name: z.string().min(1).describe('Unique name for this agent'),
  description: z
    .string()
    .min(1)
    .describe('Description of what this agent does')
    .meta({ 'x-ui:textarea': true }),
  instructions: z
    .string()
    .describe(
      'System prompt appended to the Claude Code session: role, goals, constraints, style.',
    )
    .meta({ 'x-ui:textarea': true })
    .meta({ 'x-ui:ai-suggestions': true }),
  model: z
    .string()
    .describe(
      'Claude model alias used by the session (must be registered in LiteLLM, e.g. claude-sonnet-4-6).',
    )
    .meta({ 'x-ui:show-on-node': true })
    .meta({ 'x-ui:label': 'Model' })
    .meta({ 'x-ui:litellm-models-list-select': true }),
  authMode: z
    .enum(ClaudeAuthMode)
    .default(ClaudeAuthMode.System)
    .describe(
      'LLM credential mode. "system" (default) bills this agent to the shared platform upstream. "byo-anthropic" routes this agent\'s calls to your own Anthropic API key, resolved from the secrets store and used only by this node.',
    ),
  apiKeySecretRef: z
    .string()
    .optional()
    .describe(
      'Secret holding your Anthropic API key (must start with sk-ant-). Required when authMode is "byo-anthropic". The key is resolved host-side and injected only into this node\'s sandbox — set a spend limit on it in the Anthropic Console as a backstop. That Console limit is also your only ceiling for an interrupted turn: if a run is stopped mid-turn, the in-flight spend of that turn is not captured in the platform cost rollup.',
    )
    .meta({ 'x-ui:secret-select-host': true }),
  maxTurns: z
    .number()
    .int()
    .min(1)
    .max(2500)
    .default(2500)
    .optional()
    .describe(
      'Maximum number of agentic turns the Claude session can execute during a single run.',
    ),
  effort: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .describe(
      'Reasoning effort the session spends per step. Higher means deeper reasoning and more tokens; lower is faster and cheaper. Levels the active model does not support are clamped down. Leave empty for the model default (high).',
    )
    .meta({ 'x-ui:show-on-node': true })
    .meta({ 'x-ui:label': 'Effort' }),
  maxContext: z
    .boolean()
    .optional()
    .describe(
      'Request the 1M-token context window (appends the [1m] suffix to the model). Only takes effect on models that support 1M context. Leave off for the standard window.',
    )
    .meta({ 'x-ui:show-on-node': true })
    .meta({ 'x-ui:label': '1M context' }),
  sonnetModel: z
    .string()
    .optional()
    .describe(
      'Override the model the `sonnet` alias resolves to (subagents, the model picker, opusplan execution). Must be a model registered in LiteLLM. Leave empty to use the SDK default.',
    )
    .meta({ 'x-ui:litellm-models-list-select': true })
    .meta({ 'x-ui:label': 'Sonnet model' }),
  opusModel: z
    .string()
    .optional()
    .describe(
      'Override the model the `opus` alias resolves to (subagents, opusplan plan mode). Must be a model registered in LiteLLM. Leave empty to use the SDK default.',
    )
    .meta({ 'x-ui:litellm-models-list-select': true })
    .meta({ 'x-ui:label': 'Opus model' }),
  haikuModel: z
    .string()
    .optional()
    .describe(
      'Override the model the `haiku` alias and background/utility calls (e.g. title generation) resolve to. Must be a model registered in LiteLLM. Leave empty to use claude-haiku-4-5.',
    )
    .meta({ 'x-ui:litellm-models-list-select': true })
    .meta({ 'x-ui:label': 'Haiku model' }),
  fableModel: z
    .string()
    .optional()
    .describe(
      'Override the model the `fable` alias resolves to. Must be a model registered in LiteLLM. Leave empty to use the SDK default.',
    )
    .meta({ 'x-ui:litellm-models-list-select': true })
    .meta({ 'x-ui:label': 'Fable model' }),
  plugins: z
    .array(
      z.object({
        repoUrl: z
          .string()
          .min(1)
          .describe(
            'Git repository with the plugin (https://host/repo or git@host:repo).',
          ),
        ref: z
          .string()
          .optional()
          .describe(
            'Branch, tag or commit of the repository (default branch when empty).',
          ),
        path: z
          .string()
          .optional()
          .describe(
            'Path to the plugin root inside the repository — the directory containing .claude-plugin/plugin.json (repository root when empty).',
          ),
      }),
    )
    .optional()
    .describe(
      'Claude Code plugins cloned into the runtime and loaded into the session at start. Repositories shared by several entries are cloned once.',
    ),
});

export type ClaudeAgentTemplateSchemaType = z.infer<
  typeof ClaudeAgentTemplateSchema
>;

@Injectable()
@RegisterTemplate()
export class ClaudeAgentTemplate extends ClaudeAgentNodeBaseTemplate<
  typeof ClaudeAgentTemplateSchema,
  ClaudeAgent
> {
  readonly id = 'claude-agent';
  readonly name = 'Claude agent';
  readonly description =
    'Agent backed by Claude Code (Agent SDK) running inside a connected runtime';
  readonly schema = ClaudeAgentTemplateSchema;

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
      value: NodeKind.Runtime,
      required: true,
      multiple: false,
    },
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
  ] as const;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly graphRegistry: GraphRegistry,
  ) {
    super();
  }

  public async create() {
    return {
      provide: async (_params: GraphNode<ClaudeAgentTemplateSchemaType>) =>
        this.createNewInstance(this.moduleRef, ClaudeAgent),
      configure: async (
        params: GraphNode<ClaudeAgentTemplateSchemaType>,
        instance: ClaudeAgent,
      ) => {
        // A revision deploy can land while this node has a live Claude session.
        // Re-wiring runtime/tools/config under a streaming run would strand it
        // against a swapped-out instance, so fail any live run visibly first.
        // No-op on the initial configure() (no live runs yet).
        await instance.failActiveRunsForRedeploy(
          'a new graph revision was deployed',
        );

        const graphId = params.metadata.graphId;

        const runtimeNodeId = Array.from(params.outputNodeIds).find(
          (nodeId) =>
            this.graphRegistry.getNode(graphId, nodeId)?.type ===
            NodeKind.Runtime,
        );
        if (!runtimeNodeId) {
          throw new BadRequestException(
            'CLAUDE_AGENT_NO_RUNTIME',
            'Claude Agent must be connected to a Runtime node — its Claude Code session runs inside that runtime',
          );
        }

        const runtimeNode = this.graphRegistry.getNode<RuntimeThreadProvider>(
          graphId,
          runtimeNodeId,
        );
        if (!runtimeNode) {
          throw new BadRequestException(
            'CLAUDE_AGENT_NO_RUNTIME',
            `Runtime node ${runtimeNodeId} not found in graph ${graphId}`,
          );
        }

        instance.setRuntimeProvider(runtimeNode.instance);

        // Wired tools forwarded into the SDK session via the in-bridge MCP
        // server (same walk as SimpleAgent), minus the exclusion policy.
        const forwardableTools: BuiltAgentTool[] = [];
        for (const nodeId of params.outputNodeIds) {
          const node = this.graphRegistry.getNode<
            BuiltAgentTool | BuiltAgentTool[] | ToolNodeOutput
          >(graphId, nodeId);
          if (!node || node.type !== NodeKind.Tool) {
            continue;
          }
          const inst = node.instance;
          const tools: BuiltAgentTool[] = [];
          if (inst && typeof inst === 'object' && 'tools' in inst) {
            tools.push(...(inst as ToolNodeOutput).tools);
          } else if (Array.isArray(inst)) {
            tools.push(...inst);
          } else if (inst) {
            tools.push(inst);
          }
          for (const tool of tools) {
            if (isToolForwardableToClaude(tool.name)) {
              forwardableTools.push(tool);
            }
          }
        }
        instance.resetTools();
        forwardableTools.forEach((tool) => instance.addTool(tool));

        // Connected MCP blocks (custom/filesystem/playwright/jira) reused on the
        // Claude node: collected here, then at run() each block's launch config
        // is resolved against THIS node's runtime and merged into the SDK
        // `mcpServers` map by the bridge (the SDK spawns the server itself
        // inside the runtime). The block keeps its own host-side wiring (its
        // `initialize()` ran against its own required Runtime edge); the
        // run()-time resolver re-points it at the Claude runtime so config such
        // as the filesystem workdir is computed correctly.
        const externalMcpServers: ConnectedMcpServer[] = [];
        for (const nodeId of params.outputNodeIds) {
          const node = this.graphRegistry.getNode<BaseMcp>(graphId, nodeId);
          if (!node || node.type !== NodeKind.Mcp) {
            continue;
          }
          externalMcpServers.push({
            instance: node.instance,
            config: node.config,
            nodeId,
          });
        }
        instance.setExternalMcpServers(externalMcpServers);

        instance.setConfig(params.config);
      },
      destroy: async (instance: ClaudeAgent) => {
        await instance.stop();
      },
    };
  }
}
