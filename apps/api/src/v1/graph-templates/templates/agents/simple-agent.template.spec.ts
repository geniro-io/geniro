import { DynamicStructuredTool } from '@langchain/core/tools';
import { ModuleRef } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BuiltAgentTool } from '../../../agent-tools/tools/base-tool';
import { ReasoningEffort } from '../../../agents/agents.types';
import { SimpleAgent } from '../../../agents/services/agents/simple-agent';
import {
  CompiledGraphNode,
  GraphNode,
  GraphNodeInstanceHandle,
  GraphNodeStatus,
  NodeKind,
} from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import {
  SimpleAgentTemplate,
  SimpleAgentTemplateSchema,
} from './simple-agent.template';

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

describe('SimpleAgentTemplate', () => {
  let template: SimpleAgentTemplate;
  let mockSimpleAgent: SimpleAgent;
  let mockModuleRef: ModuleRef;
  let mockGraphRegistry: GraphRegistry;

  beforeEach(async () => {
    const addedTools: unknown[] = [];
    mockSimpleAgent = {
      addTool: vi.fn((tool: unknown) => {
        addedTools.push(tool);
      }),
      resetTools: vi.fn(),
      run: vi.fn(),
      setConfig: vi.fn(),
      initTools: vi
        .fn()
        .mockResolvedValue({ builtInToolGroupInstructions: [] }),
      setMcpServices: vi.fn(),
      ensureGraphBuilt: vi.fn(),
      updateToolsSnapshot: vi.fn(),
      getTools: vi.fn(() => addedTools),
      getDeferredTools: vi.fn(() => new Map()),
      getConfig: vi.fn(),
      buildLLM: vi.fn(),
      stop: vi.fn(),
    } as unknown as SimpleAgent;

    mockModuleRef = {
      resolve: vi.fn().mockResolvedValue(mockSimpleAgent),
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
        SimpleAgentTemplate,
        {
          provide: ModuleRef,
          useValue: mockModuleRef,
        },
        {
          provide: GraphRegistry,
          useValue: mockGraphRegistry,
        },
      ],
    }).compile();

    template = module.get<SimpleAgentTemplate>(SimpleAgentTemplate);
  });

  describe('properties', () => {
    it('should have correct name', () => {
      expect(template.name).toBe('Simple agent');
    });

    it('should have correct description', () => {
      expect(template.description).toBe(
        'Configurable agent that can use connected tools and triggers',
      );
    });

    it('should have correct kind', () => {
      expect(template.kind).toBe(NodeKind.SimpleAgent);
    });

    it('should have correct schema', () => {
      expect(template.schema).toBe(SimpleAgentTemplateSchema);
    });

    it('should expose tool and MCP connections', () => {
      expect(template.outputs).toEqual([
        { type: 'kind', value: NodeKind.Tool, multiple: true },
        { type: 'kind', value: NodeKind.Mcp, multiple: true },
        { type: 'kind', value: NodeKind.Instruction, multiple: true },
      ]);
    });
  });

  describe('schema validation', () => {
    it('should validate required SimpleAgent fields', () => {
      const validConfig = {
        name: 'Test Agent',
        description: 'A test agent',
        instructions: 'You are a test agent',
        invokeModelName: 'gpt-4o',
      };

      expect(() => SimpleAgentTemplateSchema.parse(validConfig)).not.toThrow();
    });

    it('should reject missing required fields', () => {
      const invalidConfig = {
        name: 'Test Agent',
        // missing description, instructions, invokeModelName
      };

      expect(() => SimpleAgentTemplateSchema.parse(invalidConfig)).toThrow();
    });

    it('should validate valid configuration', () => {
      const config = {
        name: 'Agent',
        description: 'Desc',
        instructions: 'Prompt',
        invokeModelName: 'gpt-4o',
      };
      expect(() => SimpleAgentTemplateSchema.parse(config)).not.toThrow();
    });

    it('should ignore legacy/unknown fields', () => {
      const configWithExtra = {
        name: 'Agent',
        description: 'Desc',
        instructions: 'Prompt',
        invokeModelName: 'gpt-4o',
        oldField: 'legacy',
      };
      const parsed = SimpleAgentTemplateSchema.parse(configWithExtra);
      expect(parsed.name).toBe('Agent');
      expect(parsed).not.toHaveProperty('oldField');
    });

    it('should accept reasoningEffort field', () => {
      const config = {
        name: 'Agent',
        description: 'Desc',
        instructions: 'Prompt',
        invokeModelName: 'o1',
        invokeModelReasoningEffort: ReasoningEffort.High,
      };
      const parsed = SimpleAgentTemplateSchema.parse(config);
      expect(parsed.invokeModelReasoningEffort).toBe(ReasoningEffort.High);
    });

    // Note: temperature is not part of the schema yet.
  });

  describe('create', () => {
    const baseConfig = {
      name: 'Test Agent',
      description: 'A test agent',
      instructions: 'You are a test agent',
      invokeModelName: 'gpt-4o',
    };
    const config = SimpleAgentTemplateSchema.parse(baseConfig);

    const metadata = {
      graphId: 'test-graph',
      nodeId: 'test-node',
      version: '1.0.0',
      graph_created_by: 'user-1',
      graph_project_id: '11111111-1111-1111-1111-111111111111',
    };

    it('should create agent instance with ModuleRef', async () => {
      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockModuleRef.resolve).toHaveBeenCalledWith(
        SimpleAgent,
        undefined,
        { strict: false },
      );
      expect(instance).toBe(mockSimpleAgent);
    });

    it('should set configuration on agent', async () => {
      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockSimpleAgent.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          name: config.name,
          invokeModelName: config.invokeModelName,
        }),
      );
    });

    it('should collect and add tools from connected nodes', async () => {
      const tool1 = { name: 'tool-1' } as DynamicStructuredTool;
      const tool2 = { name: 'tool-2' } as DynamicStructuredTool;

      const toolNode1 = buildCompiledNode({
        id: 'tool-node-1',
        type: NodeKind.Tool,
        template: 't1',
        instance: [tool1],
      });

      const toolNode2 = buildCompiledNode({
        id: 'tool-node-2',
        type: NodeKind.Tool,
        template: 't2',
        instance: [tool2],
      });

      vi.mocked(mockGraphRegistry.getNode).mockImplementation((_gid, id) => {
        if (id === 'tool-node-1') {
          return toolNode1;
        }
        if (id === 'tool-node-2') {
          return toolNode2;
        }
        return undefined;
      });

      const outputNodeIds = new Set(['tool-node-1', 'tool-node-2']);
      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockSimpleAgent.resetTools).toHaveBeenCalledWith();
      expect(mockSimpleAgent.addTool).toHaveBeenCalledWith(tool1);
      expect(mockSimpleAgent.addTool).toHaveBeenCalledWith(tool2);
    });

    it('should initialize agent tools after configuration', async () => {
      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockSimpleAgent.initTools).toHaveBeenCalled();
    });

    it('places <available-tools> block before tool/MCP blocks when deferred tools exist', async () => {
      mockSimpleAgent.addTool({
        name: 'mock-tool',
        __instructions: 'mock instructions',
      } as unknown as BuiltAgentTool);

      vi.mocked(mockSimpleAgent.getDeferredTools).mockReturnValue(
        new Map([
          [
            'ghost',
            {
              description: 'placeholder tool',
              tool: {} as unknown as BuiltAgentTool,
            },
          ],
        ]),
      );

      const markerConfig = SimpleAgentTemplateSchema.parse({
        ...baseConfig,
        instructions: '__USER_INSTR_MARKER__',
      });

      const handle = await template.create();
      const init: GraphNode<typeof markerConfig> = {
        config: markerConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      const finalConfig = vi
        .mocked(mockSimpleAgent.setConfig)
        .mock.calls.at(1)![0];
      const output = finalConfig.instructions as string;
      const userInstructionsIdx = output.indexOf('__USER_INSTR_MARKER__');
      const availableIdx = output.indexOf('<available-tools>');
      const toolInstrIdx = output.indexOf('## Tool Instructions');
      expect(userInstructionsIdx).toBeGreaterThan(-1);
      expect(availableIdx).toBeGreaterThan(-1);
      expect(toolInstrIdx).toBeGreaterThan(-1);
      expect(userInstructionsIdx).toBeLessThan(availableIdx);
      expect(availableIdx).toBeLessThan(toolInstrIdx);
    });

    it('should configure reasoning effort if provided', async () => {
      const configWithReasoning = SimpleAgentTemplateSchema.parse({
        ...baseConfig,
        invokeModelName: 'o1',
        invokeModelReasoningEffort: ReasoningEffort.High,
      });
      const handle = await template.create();
      const init: GraphNode<typeof configWithReasoning> = {
        config: configWithReasoning,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockSimpleAgent.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          invokeModelReasoningEffort: ReasoningEffort.High,
        }),
      );
    });
  });
});
