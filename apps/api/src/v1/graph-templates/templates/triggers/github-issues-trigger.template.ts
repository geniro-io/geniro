import { HumanMessage } from '@langchain/core/messages';
import { RunnableConfig } from '@langchain/core/runnables';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  BadRequestException,
  DefaultLogger,
  NotFoundException,
} from '@packages/common';
import safe from 'safe-regex2';
import { v4 } from 'uuid';
import { z } from 'zod';

import {
  GitHubIssuesTrigger,
  GitHubIssuesTriggerConfig,
} from '../../../agent-triggers/services/github-issues-trigger';
import type { RunnableAgent } from '../../../agents/agents.types';
import { BaseAgentConfigurable } from '../../../agents/agents.types';
import { GitPatModeService } from '../../../git-auth/services/git-pat-mode.service';
import { GitHubWebhookSubscriptionService } from '../../../git-auth/services/webhook-subscription-registry.service';
import { GitRepositoriesDao } from '../../../git-repositories/dao/git-repositories.dao';
import { GraphNode, NodeKind } from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import { OAuthRunPreflightService } from '../../../graphs/services/oauth-run-preflight.service';
import { RegisterTemplate } from '../../decorators/register-template.decorator';
import { TriggerNodeBaseTemplate } from '../base-node.template';

export const GitHubIssuesTriggerTemplateSchema = z
  .object({
    repositoryIds: z
      .array(z.string().uuid())
      .min(1)
      .meta({ 'x-ui:github-repos-select': true }),
    labels: z.array(z.string()).optional(),
    titleRegexp: z.string().max(500).optional(),
  })
  .strip();

export type GitHubIssuesTriggerTemplateSchemaType = z.infer<
  typeof GitHubIssuesTriggerTemplateSchema
>;

@Injectable()
@RegisterTemplate()
export class GitHubIssuesTriggerTemplate extends TriggerNodeBaseTemplate<
  typeof GitHubIssuesTriggerTemplateSchema,
  GitHubIssuesTrigger
> {
  readonly id = 'github-issues-trigger';
  readonly name = 'GitHub Issues';
  readonly description =
    'Triggers an agent workflow when GitHub issues are created or updated';
  readonly schema = GitHubIssuesTriggerTemplateSchema;

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
    private readonly gitRepositoriesDao: GitRepositoriesDao,
    private readonly registry: GitHubWebhookSubscriptionService,
    private readonly oauthPreflight: OAuthRunPreflightService,
    private readonly gitPatModeService: GitPatModeService,
  ) {
    super();
  }

  public async create() {
    return {
      provide: async (
        _params: GraphNode<GitHubIssuesTriggerTemplateSchemaType>,
      ) => this.createNewInstance(this.moduleRef, GitHubIssuesTrigger),
      configure: async (
        params: GraphNode<GitHubIssuesTriggerTemplateSchemaType>,
        instance: GitHubIssuesTrigger,
      ) => {
        const outputNodeIds = params.outputNodeIds;
        const metadata = params.metadata;

        if (outputNodeIds.size === 0) {
          throw new NotFoundException(
            'AGENT_NOT_FOUND',
            'No output connections found for trigger',
          );
        }

        const agentNodeId = Array.from(outputNodeIds)[0]!;

        // Resolve repositories from DB
        const repos = await this.gitRepositoriesDao.getAll({
          id: { $in: params.config.repositoryIds },
        });

        if (repos.length === 0) {
          throw new NotFoundException(
            'REPOSITORY_NOT_FOUND',
            'None of the configured repositories were found',
          );
        }

        const watchedRepoFullNames = repos.map((r) => `${r.owner}/${r.repo}`);

        // Validate titleRegexp at compile time — reject invalid or unsafe patterns
        if (params.config.titleRegexp) {
          let compiledRegexp: RegExp;
          try {
            compiledRegexp = new RegExp(params.config.titleRegexp);
          } catch {
            throw new BadRequestException(
              'INVALID_REGEXP',
              `The title regexp pattern is invalid: "${params.config.titleRegexp}"`,
            );
          }

          if (!safe(compiledRegexp)) {
            throw new BadRequestException(
              'UNSAFE_REGEXP',
              'The title regexp pattern is potentially unsafe (catastrophic backtracking). Please simplify it.',
            );
          }
        }

        // Use the first repo's installationId for reconciliation auth
        const repoWithInstallation = repos.find(
          (r) => r.installationId !== null,
        );
        const installationId = repoWithInstallation?.installationId ?? null;

        if (installationId === null) {
          // App-installation-based reconciliation polling is inactive without an
          // installation id. In pat mode this is BY DESIGN (a deployment-wide PAT
          // has no installations); in app mode it means the repo was added
          // without an App installation. Either way the trigger still fires via
          // webhook push receipt, which is mode-agnostic.
          const reason = this.gitPatModeService.isPatMode()
            ? 'GITHUB_AUTH_MODE=pat: GitHub App reconciliation polling is App-only and inactive'
            : 'No installation ID found for these repos';
          this.logger.log(
            `${reason} for trigger repos [${watchedRepoFullNames.join(', ')}]. Reconciliation polling will be skipped; the trigger will still fire via webhook push.`,
          );
        }

        const triggerConfig: GitHubIssuesTriggerConfig = {
          repositoryIds: params.config.repositoryIds,
          watchedRepoFullNames,
          labels: params.config.labels,
          titleRegexp: params.config.titleRegexp,
        };

        const triggerId = `${metadata.graphId}:${metadata.nodeId}`;

        instance.initialize(
          triggerId,
          triggerConfig,
          this.registry,
          installationId,
        );

        // Wire up agent invocation — follows ManualTriggerTemplate pattern
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

            // Run-start OAuth pre-flight: pause + fan `auth_required` instead of
            // running when a connected OAuth-MCP credential is missing/expired
            // (mirrors ManualTriggerTemplate). A `credential.acquired` resume
            // picks it back up. Placed before the async fork below.
            const paused = await this.oauthPreflight.checkAndPauseIfNeeded({
              graphId: metadata.graphId,
              externalThreadId: threadId,
              createdBy:
                runnableConfig.configurable?.thread_created_by ??
                metadata.graph_created_by,
              agentNodeId,
              pendingMessageText: messages
                .map((m) => (typeof m.content === 'string' ? m.content : ''))
                .filter(Boolean)
                .join('\n\n'),
            });
            if (paused) {
              return { messages: [], threadId, checkpointNs };
            }

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
      destroy: async (instance: GitHubIssuesTrigger) => {
        await instance.stop().catch(() => {});
      },
    };
  }
}
