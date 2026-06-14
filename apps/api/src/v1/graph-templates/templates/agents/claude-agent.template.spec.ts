import { ModuleRef } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BuiltAgentTool } from '../../../agent-tools/tools/base-tool';
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
      setConfig: vi.fn(),
      stop: vi.fn(),
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
      ],
    }).compile();

    template = module.get<ClaudeAgentTemplate>(ClaudeAgentTemplate);
  });

  describe('properties', () => {
    it('has the Claude agent name and kind', () => {
      expect(template.name).toBe('Claude agent');
      expect(template.kind).toBe(NodeKind.ClaudeAgent);
    });

    it('requires a Runtime output and accepts Tool outputs', () => {
      expect(template.outputs).toEqual([
        {
          type: 'kind',
          value: NodeKind.Runtime,
          required: true,
          multiple: false,
        },
        { type: 'kind', value: NodeKind.Tool, multiple: true },
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

    it('throws when no Runtime node is connected', async () => {
      vi.mocked(mockGraphRegistry.getNode).mockReturnValue(undefined);

      const handle = await template.create();
      const init = makeInit(new Set(['tool-node']));
      const instance = await handle.provide(init);

      await expect(handle.configure(init, instance)).rejects.toThrow(
        /Runtime/i,
      );
    });

    it('forwards only forwardable wired tools, resetting tools first, dropping excluded ones', async () => {
      const forwardableTool = {
        name: 'knowledge_search_docs',
      } as unknown as BuiltAgentTool;
      // communication_exec is agent-context-bound — never forwarded into the SDK.
      const excludedTool = {
        name: 'communication_exec',
      } as unknown as BuiltAgentTool;

      const toolNode = buildCompiledNode<ToolNodeOutput>({
        id: 'tool-node',
        type: NodeKind.Tool,
        template: 'tools',
        instance: { tools: [forwardableTool, excludedTool] },
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
      expect(mockClaudeAgent.addTool).toHaveBeenCalledTimes(1);
      expect(mockClaudeAgent.addTool).toHaveBeenCalledWith(forwardableTool);
      expect(mockClaudeAgent.addTool).not.toHaveBeenCalledWith(excludedTool);

      // resetTools must run before any addTool, or it would wipe forwarded tools.
      const resetOrder = vi.mocked(mockClaudeAgent.resetTools).mock
        .invocationCallOrder[0]!;
      const addOrder = vi.mocked(mockClaudeAgent.addTool).mock
        .invocationCallOrder[0]!;
      expect(resetOrder).toBeLessThan(addOrder);
    });
  });
});
