import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import { AgentMemoryService } from '../../../../agent-memory/services/agent-memory.service';
import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { BaseTool } from '../../base-tool';

export type AgentMemoryBaseToolConfig = {
  /** When true, write-style operations (save/append/delete) are blocked at the tool layer. */
  readOnly?: boolean;
};

export interface ResolvedAgentMemoryContext {
  userId: string;
  projectId: string;
  /** Identifier stamped onto each entry (`author_agent_id`) for provenance. */
  authorAgentId: string;
}

@Injectable()
export abstract class AgentMemoryBaseTool<
  TSchema,
  TResult = unknown,
> extends BaseTool<TSchema, AgentMemoryBaseToolConfig, TResult> {
  constructor(protected readonly agentMemoryService: AgentMemoryService) {
    super();
  }

  /**
   * Resolve the run context for a project-scoped memory operation. Unlike the
   * thread-store equivalent, this does NOT resolve a thread — durable memory is
   * keyed on the project (`graph_project_id`), which is present on the agent
   * config at run time without any thread.
   */
  protected resolveContext(
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): ResolvedAgentMemoryContext {
    const configurable = cfg.configurable;
    const userId = configurable?.thread_created_by;
    if (!userId) {
      throw new BadRequestException(
        'AGENT_MEMORY_MISSING_USER',
        'thread_created_by is required on the agent config to use project memory.',
      );
    }

    const projectId = configurable?.graph_project_id;
    if (!projectId) {
      throw new BadRequestException(
        'AGENT_MEMORY_MISSING_PROJECT',
        'graph_project_id is required on the agent config to use project memory.',
      );
    }

    return { userId, projectId, authorAgentId: this.deriveAuthorAgentId(cfg) };
  }

  protected assertWritable(config: AgentMemoryBaseToolConfig): void {
    if (config.readOnly) {
      throw new BadRequestException(
        'AGENT_MEMORY_READ_ONLY',
        'This tool is exposed in read-only mode and cannot modify project memory.',
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
          // Clamp to the author_agent_id column width so an over-long name never
          // fails the insert mid-transaction.
          return name.slice(0, 128);
        }
      } catch {
        // getConfig() may throw during subagent boot ordering. Fall through.
      }
    }
    const nodeId = cfg.configurable?.node_id;
    if (typeof nodeId === 'string' && nodeId.length > 0) {
      return nodeId;
    }
    return 'unknown-agent';
  }
}
