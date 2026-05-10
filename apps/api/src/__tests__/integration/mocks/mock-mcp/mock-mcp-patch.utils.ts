import type { ToolRunnableConfig } from '@langchain/core/tools';
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

import { McpStatus } from '../../../../v1/agent-mcp/agent-mcp.types';
import {
  BaseMcp,
  McpToolMetadata,
} from '../../../../v1/agent-mcp/services/base-mcp';
import { BaseMcpTool } from '../../../../v1/agent-mcp/services/base-mcp-tool';
import type { BuiltAgentTool } from '../../../../v1/agent-tools/tools/base-tool';
import type { BaseAgentConfigurable } from '../../../../v1/agents/agents.types';
import { getMockMcpService } from './mock-mcp-singleton.utils';

/**
 * Process-level patch on `BaseMcp.prototype` that intercepts `initialize` and
 * `callTool`. The patch routes both to `MockMcpService` so MCP integration
 * tests don't spawn `npx` subprocesses or hit the runtime container.
 *
 * Idempotent: calling `installMockMcpPatch()` twice is a no-op. Pair with
 * `uninstallMockMcpPatch()` to restore the original methods.
 *
 * Mirrors the shape of `installBaseAgentPatch` in `mock-llm-patch.utils.ts`.
 */

interface PatchedBaseMcp {
  __mockMcpInstalled?: boolean;
  __origInitialize?: typeof BaseMcp.prototype.initialize;
  __origCallTool?: typeof BaseMcp.prototype.callTool;
}

interface BaseMcpPrivateBag {
  config?: unknown;
  cachedTools?: BuiltAgentTool[];
  status: McpStatus;
  runtimeThreadProvider?: unknown;
  executorNodeId?: string;
  emit(event: { type: string; data: unknown }): void;
  toolsMapping?: () => Map<string, McpToolMetadata>;
  getMcpConfig(config: unknown): { name: string };
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<unknown>;
}

type ListedTool = ListToolsResult['tools'][number];

export function installMockMcpPatch(): void {
  const proto = BaseMcp.prototype as unknown as PatchedBaseMcp;
  if (proto.__mockMcpInstalled) {
    return;
  }
  proto.__mockMcpInstalled = true;
  proto.__origInitialize = BaseMcp.prototype.initialize;
  proto.__origCallTool = BaseMcp.prototype.callTool;

  BaseMcp.prototype.initialize = async function patchedInitialize(
    this: BaseMcp,
    config: unknown,
    runtimeThreadProvider: unknown,
    _runtime: unknown,
    executorNodeId: string,
  ): Promise<void> {
    const bag = this as unknown as BaseMcpPrivateBag;
    bag.config = config;
    bag.runtimeThreadProvider = runtimeThreadProvider;
    bag.executorNodeId = executorNodeId;
    bag.status = McpStatus.INITIALIZING;
    bag.emit({ type: 'initialize', data: { config } });

    try {
      const serverName = bag.getMcpConfig(config).name;
      const mockSvc = getMockMcpService();
      const declared = mockSvc.getTools(serverName);

      const mapping: Map<string, McpToolMetadata> =
        bag.toolsMapping?.() ?? new Map<string, McpToolMetadata>();
      const filtered =
        mapping.size > 0
          ? declared.filter((t) => mapping.has(t.name))
          : declared;

      const builtTools: BuiltAgentTool[] = filtered.map((t) => {
        const meta = mapping.get(t.name);
        const mcpTool = {
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema ?? {
            type: 'object',
            additionalProperties: true,
          },
        } as ListedTool;
        const tool = new BaseMcpTool(mcpTool, bag.callTool.bind(this), meta);
        return tool.build(config);
      });

      bag.cachedTools = builtTools;
      bag.status = McpStatus.READY;
      bag.emit({ type: 'ready', data: { toolCount: builtTools.length } });
    } catch (error) {
      bag.status = McpStatus.IDLE;
      bag.emit({ type: 'initialize', data: { config, error } });
      throw error;
    }
  } as typeof BaseMcp.prototype.initialize;

  BaseMcp.prototype.callTool = async function patchedCallTool(
    this: BaseMcp,
    toolName: string,
    args: Record<string, unknown>,
    _cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<unknown> {
    const bag = this as unknown as BaseMcpPrivateBag;
    if (!bag.config) {
      throw new Error('MCP config not initialized');
    }
    const serverName = bag.getMcpConfig(bag.config).name;
    return getMockMcpService().resolveCallTool({
      serverName,
      toolName,
      args,
    });
  } as typeof BaseMcp.prototype.callTool;
}

export function uninstallMockMcpPatch(): void {
  const proto = BaseMcp.prototype as unknown as PatchedBaseMcp;
  if (!proto.__mockMcpInstalled) {
    return;
  }
  if (proto.__origInitialize) {
    BaseMcp.prototype.initialize = proto.__origInitialize;
  }
  if (proto.__origCallTool) {
    BaseMcp.prototype.callTool = proto.__origCallTool;
  }
  delete proto.__origInitialize;
  delete proto.__origCallTool;
  proto.__mockMcpInstalled = false;
}
