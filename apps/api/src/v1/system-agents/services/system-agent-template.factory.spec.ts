import { ModuleRef } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { DefaultLogger } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BuiltAgentTool } from '../../agent-tools/tools/base-tool';
import { SimpleAgent } from '../../agents/services/agents/simple-agent';
import { TemplateRegistry } from '../../graph-templates/services/template-registry';
import {
  CompiledGraphNode,
  GraphNode,
  GraphNodeInstanceHandle,
  GraphNodeStatus,
  NodeKind,
} from '../../graphs/graphs.types';
import { GraphRegistry } from '../../graphs/services/graph-registry';
import type { SystemAgentDefinition } from '../system-agents.types';
import { SystemAgentTemplateFactory } from './system-agent-template.factory';
import { SystemAgentsService } from './system-agents.service';

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

const ENGINEER_DEFINITION: SystemAgentDefinition = {
  id: 'engineer',
  name: 'Engineer',
  description: 'A software engineer agent.',
  tools: [{ id: 'shell-tool' }, { id: 'files-tool' }],
  defaultModel: null,
  instructions: 'You are a senior software engineer.',
  contentHash: 'abc123def456',
  templateId: 'system-agent-engineer',
};

describe('SystemAgentTemplateFactory', () => {
  let factory: SystemAgentTemplateFactory;
  let mockSimpleAgent: SimpleAgent;
  let mockModuleRef: ModuleRef;
  let mockGraphRegistry: GraphRegistry;
  let mockTemplateRegistry: TemplateRegistry;
  let mockSystemAgentsService: { getById: ReturnType<typeof vi.fn> };

  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(async () => {
    const addedTools: unknown[] = [];
    mockSimpleAgent = {
      addTool: vi.fn((tool: unknown) => {
        addedTools.push(tool);
      }),
      resetTools: vi.fn(),
      run: vi.fn(),
      setConfig: vi.fn(),
      initTools: vi.fn().mockResolvedValue(undefined),
      setMcpServices: vi.fn(),
      getTools: vi.fn(() => addedTools),
      getDeferredTools: vi.fn(() => new Map()),
      stop: vi.fn(),
    } as unknown as SimpleAgent;

    mockModuleRef = {
      resolve: vi.fn().mockResolvedValue(mockSimpleAgent),
    } as unknown as ModuleRef;

    mockGraphRegistry = {
      getNode: vi.fn().mockReturnValue(undefined),
      filterNodesByType: vi.fn().mockReturnValue([]),
    } as unknown as GraphRegistry;

    const templateRegistryValue = {
      getTemplate: vi.fn().mockReturnValue(undefined),
    } as unknown as TemplateRegistry;

    mockSystemAgentsService = {
      getById: vi.fn().mockReturnValue(ENGINEER_DEFINITION),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemAgentTemplateFactory,
        { provide: ModuleRef, useValue: mockModuleRef },
        { provide: GraphRegistry, useValue: mockGraphRegistry },
        { provide: TemplateRegistry, useValue: templateRegistryValue },
        { provide: SystemAgentsService, useValue: mockSystemAgentsService },
        {
          provide: DefaultLogger,
          useValue: {
            warn: vi.fn(),
            log: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
          },
        },
      ],
    }).compile();

    factory = module.get<SystemAgentTemplateFactory>(
      SystemAgentTemplateFactory,
    );
    mockTemplateRegistry = module.get<TemplateRegistry>(TemplateRegistry);
  });

  describe('createTemplate', () => {
    it('returns a template with correct id', () => {
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      expect(template.id).toBe('system-agent-engineer');
    });

    it('returns a template with correct name', () => {
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      expect(template.name).toBe('Engineer');
    });

    it('returns a template with correct description', () => {
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      expect(template.description).toBe('A software engineer agent.');
    });

    it('returns a template with SimpleAgent kind', () => {
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      expect(template.kind).toBe(NodeKind.SimpleAgent);
    });

    it('returns a template with correct inputs', () => {
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      expect(template.inputs).toEqual([
        { type: 'template', value: 'agent-communication-tool', multiple: true },
        { type: 'kind', value: NodeKind.Trigger, multiple: true },
      ]);
    });

    it('returns a template with correct outputs', () => {
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      expect(template.outputs).toEqual([
        { type: 'kind', value: NodeKind.Tool, multiple: true },
        { type: 'kind', value: NodeKind.Mcp, multiple: true },
        { type: 'kind', value: NodeKind.Runtime, multiple: false },
        { type: 'kind', value: NodeKind.Instruction, multiple: true },
      ]);
    });

    it('exposes systemAgentId metadata', () => {
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      expect(
        (template as unknown as Record<string, unknown>).systemAgentId,
      ).toBe('engineer');
    });

    it('exposes systemAgentContentHash metadata', () => {
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      expect(
        (template as unknown as Record<string, unknown>).systemAgentContentHash,
      ).toBe('abc123def456');
    });

    it('exposes systemAgentPredefinedTools metadata', () => {
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      expect(
        (template as unknown as Record<string, unknown>)
          .systemAgentPredefinedTools,
      ).toEqual(['shell-tool', 'files-tool']);
    });

    it('includes invokeModelName with defaultModel as default when def.defaultModel is set', () => {
      const defWithModel: SystemAgentDefinition = {
        ...ENGINEER_DEFINITION,
        defaultModel: 'gpt-4o',
      };
      const template = factory.createTemplate(defWithModel);
      const schema = (template as unknown as Record<string, unknown>)
        .schema as {
        shape: Record<string, { _def: { defaultValue: unknown } }>;
      };
      expect(schema.shape).toHaveProperty('invokeModelName');
      const invokeModelField = schema.shape['invokeModelName'];
      expect(invokeModelField).toBeDefined();
      expect(invokeModelField!._def.defaultValue).toBe('gpt-4o');
    });

    it('description field has the definition description as default', () => {
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const schema = (template as unknown as Record<string, unknown>)
        .schema as {
        shape: Record<
          string,
          {
            _def: { defaultValue: unknown; innerType: { meta: () => unknown } };
          }
        >;
      };
      const descriptionField = schema.shape['description'];
      expect(descriptionField).toBeDefined();
      expect(descriptionField!._def.defaultValue).toBe(
        ENGINEER_DEFINITION.description,
      );
    });

    it('instructions field does not have x-ui:readonly meta', () => {
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const schema = (template as unknown as Record<string, unknown>)
        .schema as {
        shape: Record<
          string,
          { _def: { innerType: { meta: () => Record<string, unknown> } } }
        >;
      };
      const instructionsField = schema.shape['instructions'];
      expect(instructionsField).toBeDefined();
      const meta = instructionsField!._def.innerType.meta();
      expect(meta).toBeDefined();
      expect(meta!['x-ui:textarea']).toBe(true);
      expect(meta!['x-ui:readonly']).toBeUndefined();
      expect(meta!['x-ui:ai-suggestions']).toBeUndefined();
    });
  });

  describe('template.create() — configure', () => {
    const baseConfig = {
      name: 'Engineer',
      description: 'A software engineer agent.',
      instructions: 'You are a senior software engineer.',
      invokeModelName: 'gpt-4o',
      systemAgentId: 'engineer',
      systemAgentContentHash: 'abc123def456',
    };

    const metadata = {
      graphId: 'test-graph',
      nodeId: 'test-node',
      version: '1.0.0',
      graph_created_by: 'user-1',
      graph_project_id: '11111111-1111-1111-1111-111111111111',
    };

    const createMockToolTemplate = (options: {
      id: string;
      outputs?: readonly {
        type: string;
        value: string;
        required?: boolean;
        multiple: boolean;
      }[];
      schemaParseResult?: unknown;
      schemaParseError?: Error;
      tools?: { name: string; __instructions?: string }[];
      instructions?: string;
    }) => {
      const mockToolInstance = {
        tools: options.tools ?? [
          { name: `${options.id}-tool`, __instructions: undefined },
        ],
        instructions: options.instructions,
      };
      const mockHandle = {
        provide: vi.fn().mockResolvedValue(mockToolInstance),
        configure: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn().mockResolvedValue(undefined),
      };
      return {
        template: {
          id: options.id,
          outputs: options.outputs ?? [],
          schema: {
            parse: options.schemaParseError
              ? vi.fn().mockImplementation(() => {
                  throw options.schemaParseError;
                })
              : vi.fn().mockReturnValue(options.schemaParseResult ?? {}),
          },
          create: vi.fn().mockResolvedValue(mockHandle),
        },
        handle: mockHandle,
        instance: mockToolInstance,
      };
    };

    it('provides a SimpleAgent instance', async () => {
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      expect(instance).toBe(mockSimpleAgent);
    });

    it('calls resetTools before adding tools', async () => {
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);
      expect(mockSimpleAgent.resetTools).toHaveBeenCalled();
    });

    it('uses def.instructions as base (not config.instructions) for final config', async () => {
      const configWithModifiedInstructions = {
        ...baseConfig,
        instructions: 'User-modified instructions (should be ignored)',
      };
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof configWithModifiedInstructions> = {
        config: configWithModifiedInstructions,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      const finalConfigCall = vi
        .mocked(mockSimpleAgent.setConfig)
        .mock.calls.at(1);
      expect(finalConfigCall).toBeDefined();
      const finalConfig = finalConfigCall![0] as { instructions: string };
      expect(finalConfig.instructions).toContain(
        ENGINEER_DEFINITION.instructions,
      );
    });

    it('collects content from connected instruction nodes', async () => {
      const instructionNode = buildCompiledNode({
        id: 'instruction-node-1',
        type: NodeKind.Instruction,
        template: 'custom-instruction',
        instance: 'Follow these coding rules.',
      });

      vi.mocked(mockGraphRegistry.getNode).mockImplementation((_gid, id) => {
        if (id === 'instruction-node-1') {
          return instructionNode;
        }
        return undefined;
      });

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(['instruction-node-1']),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      const finalConfigCall = vi
        .mocked(mockSimpleAgent.setConfig)
        .mock.calls.at(1);
      expect(finalConfigCall).toBeDefined();
      const finalConfig = finalConfigCall![0] as { instructions: string };
      expect(finalConfig.instructions).toContain('Follow these coding rules.');
      expect(finalConfig.instructions).toContain('<instruction_block>');
    });

    it('uses live instructions from SystemAgentsService when definition exists', async () => {
      const updatedDef = {
        ...ENGINEER_DEFINITION,
        instructions: 'Updated instructions from .md file',
      };
      mockSystemAgentsService.getById.mockReturnValue(updatedDef);

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      const finalConfigCall = vi
        .mocked(mockSimpleAgent.setConfig)
        .mock.calls.at(1);
      const finalConfig = finalConfigCall![0] as { instructions: string };
      expect(finalConfig.instructions).toContain(
        'Updated instructions from .md file',
      );
      expect(finalConfig.instructions).not.toContain(
        ENGINEER_DEFINITION.instructions,
      );
    });

    it('falls back to config.instructions when system agent definition is deleted', async () => {
      const { NotFoundException } = await import('@packages/common');
      mockSystemAgentsService.getById.mockImplementation(() => {
        throw new NotFoundException('SYSTEM_AGENT_NOT_FOUND', 'Not found');
      });

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      const finalConfigCall = vi
        .mocked(mockSimpleAgent.setConfig)
        .mock.calls.at(1);
      const finalConfig = finalConfigCall![0] as { instructions: string };
      expect(finalConfig.instructions).toContain(baseConfig.instructions);
    });

    it('collects tools from connected tool nodes', async () => {
      const tool = { name: 'shell-tool', __instructions: undefined };
      const toolNode = buildCompiledNode({
        id: 'tool-node-1',
        type: NodeKind.Tool,
        template: 'shell-tool',
        instance: [tool],
      });

      vi.mocked(mockGraphRegistry.getNode).mockImplementation((_gid, id) => {
        if (id === 'tool-node-1') {
          return toolNode;
        }
        return undefined;
      });

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(['tool-node-1']),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      expect(mockSimpleAgent.addTool).toHaveBeenCalledWith(tool);
    });

    it('calls destroy (stop) on the agent', async () => {
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.destroy(instance);

      expect(mockSimpleAgent.stop).toHaveBeenCalled();
    });

    it('instantiates predefined tools when no manual override exists', async () => {
      const shellMock = createMockToolTemplate({
        id: 'shell-tool',
        tools: [{ name: 'shell' }],
      });
      const filesMock = createMockToolTemplate({
        id: 'files-tool',
        tools: [{ name: 'files' }],
      });

      vi.mocked(mockTemplateRegistry.getTemplate).mockImplementation(
        (id: string) => {
          if (id === 'shell-tool') {
            return shellMock.template as unknown as ReturnType<
              typeof mockTemplateRegistry.getTemplate
            >;
          }
          if (id === 'files-tool') {
            return filesMock.template as unknown as ReturnType<
              typeof mockTemplateRegistry.getTemplate
            >;
          }
          return undefined;
        },
      );

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      expect(shellMock.template.create).toHaveBeenCalled();
      expect(filesMock.template.create).toHaveBeenCalled();
      expect(shellMock.handle.provide).toHaveBeenCalled();
      expect(filesMock.handle.provide).toHaveBeenCalled();
      expect(mockSimpleAgent.addTool).toHaveBeenCalledWith({ name: 'shell' });
      expect(mockSimpleAgent.addTool).toHaveBeenCalledWith({ name: 'files' });
    });

    it('skips predefined tool when manually-connected tool has same template ID', async () => {
      const shellNode = buildCompiledNode({
        id: 'manual-shell-node',
        type: NodeKind.Tool,
        template: 'shell-tool',
        instance: { tools: [{ name: 'manual-shell' }] },
      });

      vi.mocked(mockGraphRegistry.getNode).mockImplementation((_gid, id) => {
        if (id === 'manual-shell-node') {
          return shellNode;
        }
        return undefined;
      });

      const filesMock = createMockToolTemplate({
        id: 'files-tool',
        tools: [{ name: 'files' }],
      });

      vi.mocked(mockTemplateRegistry.getTemplate).mockImplementation(
        (id: string) => {
          if (id === 'files-tool') {
            return filesMock.template as unknown as ReturnType<
              typeof mockTemplateRegistry.getTemplate
            >;
          }
          return undefined;
        },
      );

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(['manual-shell-node']),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      // shell-tool should be skipped — getTemplate should never be called for it
      const getTemplateCalls = vi
        .mocked(mockTemplateRegistry.getTemplate)
        .mock.calls.map((c) => c[0]);
      expect(getTemplateCalls).not.toContain('shell-tool');

      // files-tool should still be instantiated
      expect(filesMock.template.create).toHaveBeenCalled();
    });

    it('skips predefined tool when template not found in registry', async () => {
      // Default: getTemplate returns undefined for all IDs
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);

      await expect(handle.configure(params, instance)).resolves.not.toThrow();

      expect(mockSimpleAgent.addTool).not.toHaveBeenCalled();
    });

    it('skips predefined tool when default config parsing fails', async () => {
      const parseError = new Error('Missing required field');
      const shellMock = createMockToolTemplate({
        id: 'shell-tool',
        schemaParseError: parseError,
      });

      vi.mocked(mockTemplateRegistry.getTemplate).mockImplementation(
        (id: string) => {
          if (id === 'shell-tool') {
            return shellMock.template as unknown as ReturnType<
              typeof mockTemplateRegistry.getTemplate
            >;
          }
          return undefined;
        },
      );

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);

      await expect(handle.configure(params, instance)).resolves.not.toThrow();

      expect(shellMock.template.create).not.toHaveBeenCalled();
    });

    it('skips predefined tool gracefully when create() throws', async () => {
      const shellMock = createMockToolTemplate({
        id: 'shell-tool',
        tools: [{ name: 'shell' }],
      });
      // Override create() to reject
      shellMock.template.create = vi
        .fn()
        .mockRejectedValue(new Error('create() failed'));

      const filesMock = createMockToolTemplate({
        id: 'files-tool',
        tools: [{ name: 'files' }],
      });

      vi.mocked(mockTemplateRegistry.getTemplate).mockImplementation(
        (id: string) => {
          if (id === 'shell-tool') {
            return shellMock.template as unknown as ReturnType<
              typeof mockTemplateRegistry.getTemplate
            >;
          }
          if (id === 'files-tool') {
            return filesMock.template as unknown as ReturnType<
              typeof mockTemplateRegistry.getTemplate
            >;
          }
          return undefined;
        },
      );

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);

      // Must not throw despite shell-tool's create() rejecting
      await expect(handle.configure(params, instance)).resolves.not.toThrow();

      // shell-tool's tools must not be added
      expect(mockSimpleAgent.addTool).not.toHaveBeenCalledWith({
        name: 'shell',
      });

      // files-tool should still be instantiated and its tool added
      expect(filesMock.template.create).toHaveBeenCalled();
      expect(mockSimpleAgent.addTool).toHaveBeenCalledWith({ name: 'files' });
    });

    it('skips predefined tool with unsatisfiable required template dependency', async () => {
      const shellMock = createMockToolTemplate({
        id: 'shell-tool',
        outputs: [
          {
            type: 'template',
            value: 'github-resource',
            required: true,
            multiple: false,
          },
        ],
      });

      vi.mocked(mockTemplateRegistry.getTemplate).mockImplementation(
        (id: string) => {
          if (id === 'shell-tool') {
            return shellMock.template as unknown as ReturnType<
              typeof mockTemplateRegistry.getTemplate
            >;
          }
          return undefined;
        },
      );

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      expect(shellMock.template.create).not.toHaveBeenCalled();
    });

    it('skips predefined tool with unsatisfiable required non-Runtime kind dependency', async () => {
      const shellMock = createMockToolTemplate({
        id: 'shell-tool',
        outputs: [
          {
            type: 'kind',
            value: NodeKind.Trigger,
            required: true,
            multiple: false,
          },
        ],
      });

      vi.mocked(mockTemplateRegistry.getTemplate).mockImplementation(
        (id: string) => {
          if (id === 'shell-tool') {
            return shellMock.template as unknown as ReturnType<
              typeof mockTemplateRegistry.getTemplate
            >;
          }
          return undefined;
        },
      );

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      expect(shellMock.template.create).not.toHaveBeenCalled();
    });

    it('does NOT skip predefined tool with optional template dependency', async () => {
      const shellMock = createMockToolTemplate({
        id: 'shell-tool',
        outputs: [
          {
            type: 'template',
            value: 'github-resource',
            multiple: true,
            // no required: true
          },
        ],
        tools: [{ name: 'shell' }],
      });

      vi.mocked(mockTemplateRegistry.getTemplate).mockImplementation(
        (id: string) => {
          if (id === 'shell-tool') {
            return shellMock.template as unknown as ReturnType<
              typeof mockTemplateRegistry.getTemplate
            >;
          }
          return undefined;
        },
      );

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      expect(shellMock.template.create).toHaveBeenCalled();
      expect(shellMock.handle.provide).toHaveBeenCalled();
    });

    it('passes Runtime nodes to predefined tool synthetic params', async () => {
      vi.mocked(mockGraphRegistry.filterNodesByType).mockReturnValue([
        'runtime-1',
      ]);

      const shellMock = createMockToolTemplate({
        id: 'shell-tool',
        tools: [{ name: 'shell' }],
      });

      vi.mocked(mockTemplateRegistry.getTemplate).mockImplementation(
        (id: string) => {
          if (id === 'shell-tool') {
            return shellMock.template as unknown as ReturnType<
              typeof mockTemplateRegistry.getTemplate
            >;
          }
          return undefined;
        },
      );

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      expect(shellMock.handle.configure).toHaveBeenCalled();
      const configureCall = vi.mocked(shellMock.handle.configure).mock.calls[0];
      expect(configureCall).toBeDefined();
      const syntheticParams = configureCall![0] as GraphNode<unknown>;
      expect(syntheticParams.outputNodeIds).toContain('runtime-1');
    });

    it('generates unique synthetic nodeIds per predefined tool', async () => {
      const shellMock = createMockToolTemplate({
        id: 'shell-tool',
        tools: [{ name: 'shell' }],
      });
      const filesMock = createMockToolTemplate({
        id: 'files-tool',
        tools: [{ name: 'files' }],
      });

      vi.mocked(mockTemplateRegistry.getTemplate).mockImplementation(
        (id: string) => {
          if (id === 'shell-tool') {
            return shellMock.template as unknown as ReturnType<
              typeof mockTemplateRegistry.getTemplate
            >;
          }
          if (id === 'files-tool') {
            return filesMock.template as unknown as ReturnType<
              typeof mockTemplateRegistry.getTemplate
            >;
          }
          return undefined;
        },
      );

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      const shellProvideCall = vi.mocked(shellMock.handle.provide).mock
        .calls[0];
      const filesProvideCall = vi.mocked(filesMock.handle.provide).mock
        .calls[0];

      expect(shellProvideCall).toBeDefined();
      expect(filesProvideCall).toBeDefined();

      const shellSyntheticParams = shellProvideCall![0] as GraphNode<unknown>;
      const filesSyntheticParams = filesProvideCall![0] as GraphNode<unknown>;

      expect(shellSyntheticParams.metadata.nodeId).toBe(
        'test-node:predefined:shell-tool',
      );
      expect(filesSyntheticParams.metadata.nodeId).toBe(
        'test-node:predefined:files-tool',
      );
    });

    it('destroys predefined tool instances on destroy', async () => {
      const shellMock = createMockToolTemplate({
        id: 'shell-tool',
        tools: [{ name: 'shell' }],
      });

      vi.mocked(mockTemplateRegistry.getTemplate).mockImplementation(
        (id: string) => {
          if (id === 'shell-tool') {
            return shellMock.template as unknown as ReturnType<
              typeof mockTemplateRegistry.getTemplate
            >;
          }
          return undefined;
        },
      );

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);
      await handle.destroy(instance);

      expect(shellMock.handle.destroy).toHaveBeenCalledWith(shellMock.instance);
      expect(mockSimpleAgent.stop).toHaveBeenCalled();
    });

    it('includes <available-tools> block when deferred tools exist', async () => {
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

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      const finalConfig = vi
        .mocked(mockSimpleAgent.setConfig)
        .mock.calls.at(-1)![0] as { instructions: string };
      expect(
        (finalConfig.instructions as string).includes('<available-tools>'),
      ).toBe(true);
      expect((finalConfig.instructions as string).includes('ghost')).toBe(true);
    });

    it('omits <available-tools> block when no deferred tools exist', async () => {
      // getDeferredTools already returns empty Map by default
      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      const finalConfig = vi
        .mocked(mockSimpleAgent.setConfig)
        .mock.calls.at(-1)![0] as { instructions: string };
      expect(
        (finalConfig.instructions as string).includes('<available-tools>'),
      ).toBe(false);
    });

    it('places <available-tools> block before tool-group instructions', async () => {
      const markerDef = {
        ...ENGINEER_DEFINITION,
        instructions: '__USER_INSTR_MARKER__',
      };
      mockSystemAgentsService.getById.mockReturnValue(markerDef);

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

      // Provide a tool with __instructions so collectToolInstructions yields non-undefined output
      const toolWithInstructions = {
        name: 'mock-tool',
        __instructions: 'mock instructions',
      };
      vi.mocked(mockSimpleAgent.getTools).mockReturnValue([
        toolWithInstructions,
      ] as unknown as ReturnType<typeof mockSimpleAgent.getTools>);

      const template = factory.createTemplate(ENGINEER_DEFINITION);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      const finalConfig = vi
        .mocked(mockSimpleAgent.setConfig)
        .mock.calls.at(-1)![0] as { instructions: string };
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

    it('does not include MCP template IDs in manual override set', async () => {
      const mcpNode = buildCompiledNode({
        id: 'mcp-node-1',
        type: NodeKind.Mcp,
        template: 'some-mcp',
        instance: {},
      });

      vi.mocked(mockGraphRegistry.getNode).mockImplementation((_gid, id) => {
        if (id === 'mcp-node-1') {
          return mcpNode;
        }
        return undefined;
      });

      // def.tools contains 'some-mcp' as a predefined tool ID
      const defWithMcpId: SystemAgentDefinition = {
        ...ENGINEER_DEFINITION,
        tools: [{ id: 'some-mcp' }],
      };

      const someMcpToolMock = createMockToolTemplate({
        id: 'some-mcp',
        tools: [{ name: 'mcp-as-tool' }],
      });

      vi.mocked(mockTemplateRegistry.getTemplate).mockImplementation(
        (id: string) => {
          if (id === 'some-mcp') {
            return someMcpToolMock.template as unknown as ReturnType<
              typeof mockTemplateRegistry.getTemplate
            >;
          }
          return undefined;
        },
      );

      const template = factory.createTemplate(defWithMcpId);
      const handle = await template.create();
      const params: GraphNode<typeof baseConfig> = {
        config: baseConfig,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(['mcp-node-1']),
        metadata,
      };
      const instance = await handle.provide(params);
      await handle.configure(params, instance);

      // MCP node template ID should NOT block predefined tool instantiation
      expect(someMcpToolMock.template.create).toHaveBeenCalled();
    });
  });
});
