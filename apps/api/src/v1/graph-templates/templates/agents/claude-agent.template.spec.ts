import { ModuleRef } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BuiltAgentTool } from '../../../agent-tools/tools/base-tool';
import { AgentMemoryToolGroup } from '../../../agent-tools/tools/common/agent-memory/agent-memory-tool-group';
import { ClaudeAgent } from '../../../agents/services/agents/claude-agent';
import {
  CompiledGraphNode,
  GraphNode,
  GraphNodeInstanceHandle,
  GraphNodeStatus,
  NodeKind,
} from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import type { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
import { ToolNodeOutput } from '../base-node.template';
import {
  ClaudeAgentTemplate,
  ClaudeAgentTemplateSchema,
} from './claude-agent.template';

const makeHandle = <TInstance>(
  instance: TInstance,
): GraphNodeInstanceHandle<TInstance, unknown> => ({
  provide: async () => instance,
  configure: async () => {},
  destroy: async () => {},
});

const buildCompiledNode = <TInstance>(options: {
  id: string;
  type: NodeKind;
  template: string;
  instance: TInstance;
  config?: unknown;
}): CompiledGraphNode<TInstance> =>
  ({
    ...options,
    handle: makeHandle(options.instance),
    config: options.config ?? {},
    getStatus: () => GraphNodeStatus.Idle,
  }) as unknown as CompiledGraphNode<TInstance>;

describe('ClaudeAgentTemplate', () => {
  let template: ClaudeAgentTemplate;
  let mockClaudeAgent: ClaudeAgent;
  let mockRuntimeProvider: RuntimeThreadProvider;
  let mockModuleRef: ModuleRef;
  let mockGraphRegistry: GraphRegistry;

  beforeEach(async () => {
    mockClaudeAgent = {
      setRuntimeProvider: vi.fn(),
      resetTools: vi.fn(),
      addTool: vi.fn(),
      setExternalMcpServers: vi.fn(),
      setGithubResource: vi.fn(),
      setConfig: vi.fn(),
      stop: vi.fn(),
      failActiveRunsForRedeploy: vi.fn().mockResolvedValue(undefined),
    } as unknown as ClaudeAgent;

    mockRuntimeProvider = {} as unknown as RuntimeThreadProvider;

    mockModuleRef = {
      resolve: vi.fn().mockResolvedValue(mockClaudeAgent),
    } as unknown as ModuleRef;

    mockGraphRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn(),
      getNode: vi.fn(),
      destroy: vi.fn(),
    } as unknown as GraphRegistry;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaudeAgentTemplate,
        { provide: ModuleRef, useValue: mockModuleRef },
        { provide: GraphRegistry, useValue: mockGraphRegistry },
        {
          provide: AgentMemoryToolGroup,
          useValue: { buildTools: vi.fn().mockReturnValue({ tools: [] }) },
        },
      ],
    }).compile();

    template = module.get<ClaudeAgentTemplate>(ClaudeAgentTemplate);
  });

  describe('properties', () => {
    it('has the Claude agent name and kind', () => {
      expect(template.name).toBe('Claude agent');
      expect(template.kind).toBe(NodeKind.ClaudeAgent);
    });

    it('requires a Runtime output and accepts Tool + Mcp + a single GitHub Resource output', () => {
      expect(template.outputs).toEqual([
        {
          type: 'kind',
          value: NodeKind.Runtime,
          required: true,
          multiple: false,
        },
        { type: 'kind', value: NodeKind.Tool, multiple: true },
        { type: 'kind', value: NodeKind.Mcp, multiple: true },
        // At most one GitHub resource — the sole source of the agent's git/gh auth.
        { type: 'kind', value: NodeKind.Resource, multiple: false },
      ]);
    });
  });

  describe('schema validation', () => {
    it('validates required fields', () => {
      expect(() =>
        ClaudeAgentTemplateSchema.parse({
          name: 'Claude',
          description: 'A claude agent',
          instructions: 'Be helpful',
          model: 'claude-sonnet-4-6',
        }),
      ).not.toThrow();
    });

    it('rejects a config missing the model', () => {
      expect(() =>
        ClaudeAgentTemplateSchema.parse({
          name: 'Claude',
          description: 'A claude agent',
          instructions: 'Be helpful',
        }),
      ).toThrow();
    });

    it('defaults authMode to system and accepts byo-anthropic + apiKeySecretRef', () => {
      const parsed = ClaudeAgentTemplateSchema.parse({
        name: 'Claude',
        description: 'A claude agent',
        instructions: 'Be helpful',
        model: 'claude-sonnet-4-6',
      });
      expect(parsed.authMode).toBe('system');

      const byo = ClaudeAgentTemplateSchema.parse({
        name: 'Claude',
        description: 'A claude agent',
        instructions: 'Be helpful',
        model: 'claude-sonnet-4-6',
        authMode: 'byo-anthropic',
        apiKeySecretRef: 'my-anthropic-key',
      });
      expect(byo.authMode).toBe('byo-anthropic');
      expect(byo.apiKeySecretRef).toBe('my-anthropic-key');
    });

    it('marks apiKeySecretRef with the HOST-ONLY secret marker the compiler does not collect', () => {
      // The graph compiler's collectSecretNames matches ONLY x-ui:secret-select /
      // x-ui:secret-multi-select and injects those into the sandbox secretEnv.
      // The BYO key MUST carry a distinct host-only marker so it is never
      // injected generically — it reaches the sandbox only as ANTHROPIC_API_KEY
      // via buildClaudeSessionEnv. A regression to x-ui:secret-select here would
      // leak the raw key into the generic sandbox env path.
      const meta = ClaudeAgentTemplateSchema.shape.apiKeySecretRef.meta() as
        | Record<string, unknown>
        | undefined;
      expect(meta?.['x-ui:secret-select-host']).toBe(true);
      expect(meta?.['x-ui:secret-select']).toBeUndefined();
      expect(meta?.['x-ui:secret-multi-select']).toBeUndefined();
    });
  });

  describe('create / configure', () => {
    const config = ClaudeAgentTemplateSchema.parse({
      name: 'Test Claude',
      description: 'A test claude agent',
      instructions: 'You are a test agent',
      model: 'claude-sonnet-4-6',
    });

    const metadata = {
      graphId: 'test-graph',
      nodeId: 'claude-node',
      version: '1.0.0',
      graph_created_by: 'user-1',
      graph_project_id: '11111111-1111-1111-1111-111111111111',
    };

    const runtimeNode = buildCompiledNode({
      id: 'runtime-node',
      type: NodeKind.Runtime,
      template: 'runtime',
      instance: undefined as unknown,
    });

    beforeEach(() => {
      // The runtime node's instance is the provider configure() forwards.
      (runtimeNode as { instance: unknown }).instance = mockRuntimeProvider;
    });

    const makeInit = (
      outputNodeIds: Set<string>,
    ): GraphNode<typeof config> => ({
      config,
      inputNodeIds: new Set(),
      outputNodeIds,
      metadata,
    });

    it('resolves a fresh ClaudeAgent instance via ModuleRef', async () => {
      vi.mocked(mockGraphRegistry.getNode).mockImplementation((_gid, id) =>
        id === 'runtime-node' ? runtimeNode : undefined,
      );

      const handle = await template.create();
      const init = makeInit(new Set(['runtime-node']));
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockModuleRef.resolve).toHaveBeenCalledWith(
        ClaudeAgent,
        undefined,
        {
          strict: false,
        },
      );
      expect(instance).toBe(mockClaudeAgent);
      expect(mockClaudeAgent.setRuntimeProvider).toHaveBeenCalledWith(
        mockRuntimeProvider,
      );
    });

    it('fails any live run before re-wiring on reconfigure (revision deploy while live)', async () => {
      vi.mocked(mockGraphRegistry.getNode).mockImplementation((_gid, id) =>
        id === 'runtime-node' ? runtimeNode : undefined,
      );

      const handle = await template.create();
      const init = makeInit(new Set(['runtime-node']));
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockClaudeAgent.failActiveRunsForRedeploy).toHaveBeenCalledWith(
        expect.stringContaining('revision'),
      );
      // It must run BEFORE config/runtime are swapped under a live run.
      const failOrder = vi.mocked(mockClaudeAgent.failActiveRunsForRedeploy)
        .mock.invocationCallOrder[0]!;
      const setConfigOrder = vi.mocked(mockClaudeAgent.setConfig).mock
        .invocationCallOrder[0]!;
      const setRuntimeOrder = vi.mocked(mockClaudeAgent.setRuntimeProvider).mock
        .invocationCallOrder[0]!;
      expect(failOrder).toBeLessThan(setConfigOrder);
      expect(failOrder).toBeLessThan(setRuntimeOrder);
    });

    it('throws when no Runtime node is connected', async () => {
      vi.mocked(mockGraphRegistry.getNode).mockReturnValue(undefined);

      const handle = await template.create();
      const init = makeInit(new Set(['tool-node']));
      const instance = await handle.provide(init);

      await expect(handle.configure(init, instance)).rejects.toThrow(
        /Runtime/i,
      );
    });

    it('forwards forwardable wired tools (incl. communication_exec for peer calls), resetting tools first, dropping context-bound ones', async () => {
      const forwardableTool = {
        name: 'knowledge_search_docs',
      } as unknown as BuiltAgentTool;
      // communication_exec IS forwarded so a Claude agent wired to a
      // communication-tool node can call its connected peers (no SDK-native
      // equivalent for peer communication).
      const commTool = {
        name: 'communication_exec',
      } as unknown as BuiltAgentTool;
      // subagents_run_task is agent-context-bound — the SDK has its own native
      // subagent mechanism, so ours is never forwarded.
      const excludedTool = {
        name: 'subagents_run_task',
      } as unknown as BuiltAgentTool;

      const toolNode = buildCompiledNode<ToolNodeOutput>({
        id: 'tool-node',
        type: NodeKind.Tool,
        template: 'tools',
        instance: { tools: [forwardableTool, commTool, excludedTool] },
      });

      vi.mocked(mockGraphRegistry.getNode).mockImplementation((_gid, id) => {
        if (id === 'runtime-node') {
          return runtimeNode;
        }
        if (id === 'tool-node') {
          return toolNode;
        }
        return undefined;
      });

      const handle = await template.create();
      const init = makeInit(new Set(['runtime-node', 'tool-node']));
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockClaudeAgent.resetTools).toHaveBeenCalled();
      expect(mockClaudeAgent.addTool).toHaveBeenCalledTimes(2);
      expect(mockClaudeAgent.addTool).toHaveBeenCalledWith(forwardableTool);
      expect(mockClaudeAgent.addTool).toHaveBeenCalledWith(commTool);
      expect(mockClaudeAgent.addTool).not.toHaveBeenCalledWith(excludedTool);

      // resetTools must run before any addTool, or it would wipe forwarded tools.
      const resetOrder = vi.mocked(mockClaudeAgent.resetTools).mock
        .invocationCallOrder[0]!;
      const addOrder = vi.mocked(mockClaudeAgent.addTool).mock
        .invocationCallOrder[0]!;
      expect(resetOrder).toBeLessThan(addOrder);
    });

    it('collects connected MCP output nodes and hands them to the agent', async () => {
      const mcpInstance = { id: 'custom-mcp-block' } as unknown;
      const mcpNode = buildCompiledNode({
        id: 'mcp-node',
        type: NodeKind.Mcp,
        template: 'custom-mcp',
        instance: mcpInstance,
        config: { command: 'npx -y srv' },
      });

      vi.mocked(mockGraphRegistry.getNode).mockImplementation((_gid, id) => {
        if (id === 'runtime-node') {
          return runtimeNode;
        }
        if (id === 'mcp-node') {
          return mcpNode;
        }
        return undefined;
      });

      const handle = await template.create();
      const init = makeInit(new Set(['runtime-node', 'mcp-node']));
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockClaudeAgent.setExternalMcpServers).toHaveBeenCalledWith([
        {
          instance: mcpInstance,
          config: { command: 'npx -y srv' },
          nodeId: 'mcp-node',
        },
      ]);
    });

    it('hands the agent an empty MCP list when no MCP node is connected', async () => {
      vi.mocked(mockGraphRegistry.getNode).mockImplementation((_gid, id) =>
        id === 'runtime-node' ? runtimeNode : undefined,
      );

      const handle = await template.create();
      const init = makeInit(new Set(['runtime-node']));
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockClaudeAgent.setExternalMcpServers).toHaveBeenCalledWith([]);
    });

    it('collects a connected GitHub resource and hands its token resolver + identity to the agent', async () => {
      const resolveEnv = vi.fn().mockResolvedValue({ GH_TOKEN: 'ghs_x' });
      const resourceNode = buildCompiledNode({
        id: 'gh-resource-node',
        type: NodeKind.Resource,
        template: 'github-resource',
        instance: { kind: 'Shell', information: '', data: { resolveEnv } },
        config: { name: 'Jane Dev', email: 'jane@example.com' },
      });

      vi.mocked(mockGraphRegistry.getNode).mockImplementation((_gid, id) => {
        if (id === 'runtime-node') {
          return runtimeNode;
        }
        if (id === 'gh-resource-node') {
          return resourceNode;
        }
        return undefined;
      });

      const handle = await template.create();
      const init = makeInit(new Set(['runtime-node', 'gh-resource-node']));
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockClaudeAgent.setGithubResource).toHaveBeenCalledWith({
        resolveEnv,
        name: 'Jane Dev',
        email: 'jane@example.com',
      });
    });

    it('hands the agent no GitHub resource when none is connected', async () => {
      vi.mocked(mockGraphRegistry.getNode).mockImplementation((_gid, id) =>
        id === 'runtime-node' ? runtimeNode : undefined,
      );

      const handle = await template.create();
      const init = makeInit(new Set(['runtime-node']));
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockClaudeAgent.setGithubResource).toHaveBeenCalledWith(undefined);
    });
  });
});
