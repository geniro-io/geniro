import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { ThreadStoreService } from '../../../../thread-store/services/thread-store.service';
import { BaseTool } from '../../base-tool';

export type ThreadStoreBaseToolConfig = {
  /** When true, write-style operations (put/append/delete) are blocked at the tool layer. */
  readOnly?: boolean;
};

export interface ResolvedThreadStoreContext {
  userId: string;
  projectId: string;
  /** Internal DB thread id used by the service layer. */
  internalThreadId: string;
  /** Identifier stamped onto each entry (`author_agent_id`). */
  authorAgentId: string;
}

@Injectable()
export abstract class ThreadStoreBaseTool<
  TSchema,
  TResult = unknown,
> extends BaseTool<TSchema, ThreadStoreBaseToolConfig, TResult> {
  constructor(protected readonly threadStoreService: ThreadStoreService) {
    super();
  }

  protected async resolveContext(
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ResolvedThreadStoreContext> {
    const configurable = cfg.configurable;
    const userId = configurable?.thread_created_by;
    if (!userId) {
      throw new BadRequestException(
        'THREAD_STORE_MISSING_USER',
        'thread_created_by is required on the agent config to use the thread store.',
      );
    }

    const projectId = configurable?.graph_project_id;
    if (!projectId) {
      throw new BadRequestException(
        'THREAD_STORE_MISSING_PROJECT',
        'graph_project_id is required on the agent config to use the thread store.',
      );
    }

    // `parent_thread_id` carries the root thread's external id when the caller
    // is a subagent; falls back to `thread_id` when the caller is the root
    // agent itself.
    const externalThreadId =
      configurable?.parent_thread_id || configurable?.thread_id;
    if (!externalThreadId) {
      throw new BadRequestException(
        'THREAD_STORE_MISSING_THREAD',
        'thread_id is required on the agent config to use the thread store.',
      );
    }

    const internalThreadId =
      await this.threadStoreService.resolveInternalThreadId(
        userId,
        projectId,
        externalThreadId,
      );

    const authorAgentId = this.deriveAuthorAgentId(cfg);

    return { userId, projectId, internalThreadId, authorAgentId };
  }

  protected assertWritable(config: ThreadStoreBaseToolConfig): void {
    if (config.readOnly) {
      throw new BadRequestException(
        'THREAD_STORE_READ_ONLY',
        'This tool is exposed in read-only mode and cannot modify the store.',
      );
    }
  }

  private deriveAuthorAgentId(
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): string {
    const callerAgent = cfg.configurable?.caller_agent;
    if (callerAgent) {
      try {
        const agentConfig = callerAgent.getConfig() as Record<string, unknown>;
        const name = agentConfig?.name;
        if (typeof name === 'string' && name.length > 0) {
          return name;
        }
      } catch {
        // getConfig() may throw when the agent config has not yet been
        // initialized (e.g. during subagent boot ordering). Fall through to
        // the node_id fallback below.
      }
    }
    const nodeId = cfg.configurable?.node_id;
    if (typeof nodeId === 'string' && nodeId.length > 0) {
      return nodeId;
    }
    return 'unknown-agent';
  }
}
