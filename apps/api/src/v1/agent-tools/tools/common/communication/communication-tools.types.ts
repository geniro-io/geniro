import { ToolRunnableConfig } from '@langchain/core/tools';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import type { RequestTokenUsage } from '../../../../litellm/litellm.types';

/**
 * The relayed result of a communication-tool agent invocation. The shape is
 * fixed (it is NOT the callee's `AgentOutput`): the producer maps the callee
 * response into this. `calleeUsage` is a transport-only field — the callee's
 * run-scoped aggregate spend — which `communication-exec` strips from the
 * model-visible output and reports as the tool's own `toolRequestUsage` so the
 * executor folds it into caller state. The model never reads it. Both ends
 * share this type so the field cannot be silently renamed on one side.
 */
export interface CommunicationAgentResult {
  message: string;
  needsMoreInfo: boolean;
  exploredFiles?: string[];
  threadId: string;
  checkpointNs?: string;
  calleeUsage?: RequestTokenUsage;
}

export interface AgentInfo {
  name: string;
  description: string;
  invokeAgent: (
    messages: string[],
    runnableConfig: ToolRunnableConfig<BaseAgentConfigurable>,
  ) => Promise<CommunicationAgentResult>;
}

export type BaseCommunicationToolConfig = {
  agents: AgentInfo[];
};
