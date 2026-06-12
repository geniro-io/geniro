import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  LoggerModule,
  NotFoundException,
} from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { TemplateRegistry } from '../../graph-templates/services/template-registry';
import {
  NodeBaseTemplate,
  NodeConnection,
} from '../../graph-templates/templates/base-node.template';
import { LlmModelsService } from '../../litellm/services/llm-models.service';
import { ProjectsDao } from '../../projects/dao/projects.dao';
import { RuntimeThreadProvider } from '../../runtime/services/runtime-thread-provider';
import { SecretsService } from '../../secrets/services/secrets.service';
import { GraphEntity } from '../entity/graph.entity';
import { GraphSchemaType, GraphStatus, NodeKind } from '../graphs.types';
import { GraphCompiler } from './graph-compiler';
import { GraphRegistry } from './graph-registry';
import { GraphStateFactory } from './graph-state.factory';

// Mock DockerRuntime
vi.mock('../../runtime/services/docker-runtime', () => ({
  DockerRuntime: {
    cleanupByLabels: vi.fn(),
  },
}));

describe('GraphCompiler', () => {
  let compiler: GraphCompiler;
  let templateRegistry: TemplateRegistry;
  let _mockGraphRegistry: GraphRegistry;
  let secretsService: {
    resolveSecretValue: ReturnType<typeof vi.fn>;
    batchResolveSecretValues: ReturnType<typeof vi.fn>;
  };
  let mockGraphStateManager: {
    registerNode: ReturnType<typeof vi.fn>;
    attachGraphNode: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };

  const createMockHandle = (instance: unknown) => ({
    provide: vi.fn().mockResolvedValue(instance),
    configure: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  });

  const createMockTemplate = (kind: NodeKind) => {
    let inputs: NodeConnection[] = [];
    let outputs: NodeConnection[] = [];

    if (kind === NodeKind.Tool) {
      inputs = [{ type: 'kind', value: NodeKind.SimpleAgent, multiple: true }];
      outputs = [
        { type: 'kind', value: NodeKind.Runtime, multiple: false },
        { type: 'kind', value: NodeKind.Resource, multiple: true },
      ];
    } else if (kind === NodeKind.SimpleAgent) {
      outputs = [
        { type: 'kind', value: NodeKind.Tool, multiple: true },
        { type: 'kind', value: NodeKind.Runtime, multiple: true },
      ];
    } else if (kind === NodeKind.Runtime) {
      inputs = [
        { type: 'kind', value: NodeKind.Tool, multiple: true },
        { type: 'kind', value: NodeKind.SimpleAgent, multiple: true },
      ];
    } else if (kind === NodeKind.Resource) {
      inputs = [{ type: 'kind', value: NodeKind.Tool, multiple: false }];
    }

    return {
      id: `mock-${kind}`,
      name: `mock-${kind}`,
      description: `Mock ${kind} template`,
      kind,
      schema: z.object({}),
      inputs,
      outputs,
      create: vi
        .fn()
        .mockImplementation(() => Promise.resolve(createMockHandle({}))),
    } as unknown as NodeBaseTemplate<z.ZodTypeAny, unknown>;
  };

  const createMockGraphEntity = (
    schema: GraphSchemaType,
    id = 'test-graph',
    name = 'Test Graph',
    version = '1.0.0',
  ): GraphEntity =>
    ({
      id,
      name,
      version,
      targetVersion: version,
      description: 'Test Description',
      schema,
      status: GraphStatus.Created,
      createdBy: 'test-user',
      projectId: 'project-123',
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      deletedAt: null,
      temporary: false,
    }) as unknown as GraphEntity;

  beforeEach(async () => {
    mockGraphStateManager = {
      registerNode: vi.fn(),
      attachGraphNode: vi.fn(),
      destroy: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({
          appName: 'test',
          appVersion: '1.0.0',
          environment: 'test',
          prettyPrint: true,
          level: 'debug',
        }),
      ],
      providers: [
        GraphCompiler,
        {
          provide: TemplateRegistry,
          useValue: {
            getTemplate: vi.fn(),
            hasTemplate: vi.fn().mockReturnValue(true),
            validateTemplateConfig: vi.fn().mockImplementation((_t, c) => c),
          },
        },
        {
          provide: GraphRegistry,
          useValue: {
            getOrCompile: vi.fn(
              async (_graphId: string, factory: () => Promise<unknown>) =>
                factory(),
            ),
            register: vi.fn(),
            unregister: vi.fn(),
            setStatus: vi.fn(),
          },
        },
        {
          provide: GraphStateFactory,
          useValue: {
            create: vi.fn().mockReturnValue(mockGraphStateManager),
          },
        },
        {
          provide: LlmModelsService,
          useValue: {
            buildLLMRequestContext: vi
              .fn()
              .mockResolvedValue({ models: undefined }),
          },
        },
        {
          provide: ProjectsDao,
          useValue: {
            getOne: vi.fn().mockResolvedValue({ settings: {} }),
          },
        },
        {
          provide: SecretsService,
          useValue: {
            resolveSecretValue: vi.fn().mockResolvedValue('resolved-secret'),
            batchResolveSecretValues: vi.fn().mockResolvedValue(new Map()),
          },
        },
      ],
    }).compile();

    compiler = module.get<GraphCompiler>(GraphCompiler);
    templateRegistry = module.get<TemplateRegistry>(TemplateRegistry);
    _mockGraphRegistry = module.get<GraphRegistry>(GraphRegistry);
    secretsService = module.get<{
      resolveSecretValue: ReturnType<typeof vi.fn>;
      batchResolveSecretValues: ReturnType<typeof vi.fn>;
    }>(SecretsService);
  });

  describe('compile', () => {
    it('should compile a valid graph schema with single runtime', async () => {
      const schema: GraphSchemaType = {
        nodes: [
          {
            id: 'runtime-1',
            template: 'runtime',
            config: { image: 'node:18' },
          },
        ],
        edges: [],
      };

      const mockTemplate = createMockTemplate(NodeKind.Runtime);
      const mockHandle = createMockHandle({ container: 'runtime-instance' });
      vi.mocked(mockTemplate.create).mockResolvedValue(mockHandle as any);
      vi.mocked(templateRegistry.getTemplate).mockReturnValue(mockTemplate);

      const graph = createMockGraphEntity(schema);
      const compiled = await compiler.compile(graph);

      expect(compiled.nodes.size).toBe(1);
      const node = compiled.nodes.get('runtime-1');
      expect(node).toBeDefined();
      expect(node?.id).toBe('runtime-1');
      expect(node?.handle).toBe(mockHandle);
      expect(mockHandle.configure).toHaveBeenCalled();
      expect(mockGraphStateManager.registerNode).toHaveBeenCalledWith(
        'runtime-1',
      );
      expect(mockGraphStateManager.attachGraphNode).toHaveBeenCalledWith(
        'runtime-1',
        expect.anything(),
      );
    });

    it('should compile graph with runtime and tool', async () => {
      const schema: GraphSchemaType = {
        nodes: [
          {
            id: 'runtime-1',
            template: 'runtime',
            config: {},
          },
          {
            id: 'tool-1',
            template: 'shell-tool',
            config: {},
          },
        ],
        edges: [{ from: 'tool-1', to: 'runtime-1' }],
      };

      const runtimeTemplate = createMockTemplate(NodeKind.Runtime);
      const toolTemplate = createMockTemplate(NodeKind.Tool);

      const runtimeHandle = createMockHandle({ id: 'rt' });
      const toolHandle = createMockHandle({ id: 'tool' });

      vi.mocked(runtimeTemplate.create).mockResolvedValue(runtimeHandle as any);
      vi.mocked(toolTemplate.create).mockResolvedValue(toolHandle as any);

      vi.mocked(templateRegistry.getTemplate).mockImplementation(
        (templateId) => {
          if (templateId === 'runtime') {
            return runtimeTemplate;
          }
          if (templateId === 'shell-tool') {
            return toolTemplate;
          }
          return undefined;
        },
      );

      const graph = createMockGraphEntity(schema);
      const compiled = await compiler.compile(graph);

      expect(compiled.nodes.size).toBe(2);
      expect(runtimeHandle.configure).toHaveBeenCalled();
      expect(toolHandle.configure).toHaveBeenCalled();

      // Edge semantics: tool depends on runtime, so runtime is built first
      // When tool is configured, runtime is already in compiledNodes
      const toolInit = vi.mocked(toolHandle.configure).mock.calls[0]![0] as any;
      expect(toolInit.outputNodeIds).toContain('runtime-1');
    });

    it('should compile complex graph with multiple runtimes, tools, and agents', async () => {
      const schema: GraphSchemaType = {
        nodes: [
          { id: 'rt1', template: 'rt', config: {} },
          { id: 'rt2', template: 'rt', config: {} },
          { id: 'tool1', template: 'tool', config: {} },
          { id: 'agent1', template: 'agent', config: {} },
        ],
        edges: [
          { from: 'tool1', to: 'rt1' },
          { from: 'agent1', to: 'tool1' },
          { from: 'agent1', to: 'rt2' },
        ],
      };

      const rtTemplate = createMockTemplate(NodeKind.Runtime);
      const toolTemplate = createMockTemplate(NodeKind.Tool);
      const agentTemplate = createMockTemplate(NodeKind.SimpleAgent);

      vi.mocked(templateRegistry.getTemplate).mockImplementation((id) => {
        if (id === 'rt') {
          return rtTemplate;
        }
        if (id === 'tool') {
          return toolTemplate;
        }
        if (id === 'agent') {
          return agentTemplate;
        }
        return undefined;
      });

      const graph = createMockGraphEntity(schema);
      const compiled = await compiler.compile(graph);

      expect(compiled.nodes.size).toBe(4);
      expect(mockGraphStateManager.registerNode).toHaveBeenCalledTimes(4);
    });

    it('should build nodes in correct dependency order', async () => {
      const schema: GraphSchemaType = {
        nodes: [
          { id: 'agent', template: 'agent', config: {} },
          { id: 'tool', template: 'tool', config: {} },
          { id: 'rt', template: 'rt', config: {} },
        ],
        edges: [
          { from: 'agent', to: 'tool' },
          { from: 'tool', to: 'rt' },
        ],
      };

      const rtTemplate = createMockTemplate(NodeKind.Runtime);
      const toolTemplate = createMockTemplate(NodeKind.Tool);
      const agentTemplate = createMockTemplate(NodeKind.SimpleAgent);

      vi.mocked(templateRegistry.getTemplate).mockImplementation((id) => {
        if (id === 'rt') {
          return rtTemplate;
        }
        if (id === 'tool') {
          return toolTemplate;
        }
        if (id === 'agent') {
          return agentTemplate;
        }
        return undefined;
      });

      const graph = createMockGraphEntity(schema);
      await compiler.compile(graph);

      const registerOrder = mockGraphStateManager.registerNode.mock.calls.map(
        (call) => call[0],
      );

      // Edge semantics: edge.from depends on edge.to
      // agent -> tool means agent depends on tool
      // tool -> rt means tool depends on rt
      // Build order: rt (0 dependencies), tool (depends on rt), agent (depends on tool)
      expect(registerOrder).toEqual(['rt', 'tool', 'agent']);
    });

    it('should handle graph without edges', async () => {
      const schema: GraphSchemaType = {
        nodes: [
          { id: 'n1', template: 't', config: {} },
          { id: 'n2', template: 't', config: {} },
        ],
        edges: [],
      };

      const template = createMockTemplate(NodeKind.Runtime);
      vi.mocked(templateRegistry.getTemplate).mockReturnValue(template);

      const graph = createMockGraphEntity(schema);
      const compiled = await compiler.compile(graph);

      expect(compiled.nodes.size).toBe(2);
    });

    it('should pass config and metadata to handle.provide', async () => {
      const schema: GraphSchemaType = {
        nodes: [{ id: 'node-1', template: 't', config: { some: 'config' } }],
        edges: [],
      };

      const template = createMockTemplate(NodeKind.Runtime);
      const mockHandle = createMockHandle({ instance: 'test' });
      vi.mocked(template.create).mockResolvedValue(mockHandle as any);
      vi.mocked(templateRegistry.getTemplate).mockReturnValue(template);

      const graph = createMockGraphEntity(schema, 'g1', 'G1', 'V1');
      await compiler.compile(graph);

      expect(template.create).toHaveBeenCalledWith();
      expect(mockHandle.provide).toHaveBeenCalledWith(
        expect.objectContaining({
          config: { some: 'config' },
          metadata: expect.objectContaining({
            graphId: 'g1',
            nodeId: 'node-1',
            version: 'V1',
          }),
        }),
      );
    });
  });

  describe('secret resolution', () => {
    it('should resolve secrets and inject env vars into connected RuntimeThreadProvider', async () => {
      const mockAddEnvVariables = vi.fn();
      const mockRuntimeInstance = Object.create(
        RuntimeThreadProvider.prototype,
      ) as RuntimeThreadProvider;
      mockRuntimeInstance.addEnvVariables = mockAddEnvVariables;

      const runtimeTemplate = createMockTemplate(NodeKind.Runtime);
      const toolTemplateBase = createMockTemplate(NodeKind.Tool);
      const toolTemplate = Object.assign(toolTemplateBase, {
        schema: z.object({
          apiKey: z.string().meta({ 'x-ui:secret-select': true }),
        }),
      });

      const runtimeHandle = createMockHandle(mockRuntimeInstance);
      const toolHandle = createMockHandle({ id: 'tool' });

      vi.mocked(runtimeTemplate.create).mockResolvedValue(runtimeHandle as any);
      vi.mocked(toolTemplate.create).mockResolvedValue(toolHandle as any);

      vi.mocked(templateRegistry.getTemplate).mockImplementation((id) => {
        if (id === 'runtime') {
          return runtimeTemplate;
        }
        if (id === 'tool') {
          return toolTemplate;
        }
        return undefined;
      });

      const schema: GraphSchemaType = {
        nodes: [
          { id: 'runtime-1', template: 'runtime', config: {} },
          { id: 'tool-1', template: 'tool', config: { apiKey: 'MY_API_KEY' } },
        ],
        edges: [{ from: 'tool-1', to: 'runtime-1' }],
      };

      secretsService.batchResolveSecretValues.mockResolvedValue(
        new Map([['MY_API_KEY', 'resolved-secret']]),
      );

      const graph = createMockGraphEntity(schema);
      await compiler.compile(graph);

      expect(mockAddEnvVariables).toHaveBeenCalledWith({
        MY_API_KEY: 'resolved-secret',
      });
    });

    it('should skip secret resolution when template has no schema', async () => {
      const mockAddEnvVariables = vi.fn();
      const mockRuntimeInstance = Object.create(
        RuntimeThreadProvider.prototype,
      ) as RuntimeThreadProvider;
      mockRuntimeInstance.addEnvVariables = mockAddEnvVariables;

      const runtimeTemplate = Object.assign(
        createMockTemplate(NodeKind.Runtime),
        {
          schema: undefined as any,
        },
      );
      const runtimeHandle = createMockHandle(mockRuntimeInstance);
      vi.mocked(runtimeTemplate.create).mockResolvedValue(runtimeHandle as any);
      vi.mocked(templateRegistry.getTemplate).mockReturnValue(runtimeTemplate);

      const schema: GraphSchemaType = {
        nodes: [{ id: 'runtime-1', template: 'runtime', config: {} }],
        edges: [],
      };

      const graph = createMockGraphEntity(schema);
      await compiler.compile(graph);

      expect(mockAddEnvVariables).not.toHaveBeenCalled();
    });

    it('should not inject env vars when no connected runtime node exists', async () => {
      const mockAddEnvVariables = vi.fn();

      const toolTemplate = Object.assign(createMockTemplate(NodeKind.Tool), {
        schema: z.object({
          apiKey: z.string().meta({ 'x-ui:secret-select': true }),
        }),
      });
      const toolHandle = createMockHandle({ id: 'tool' });
      vi.mocked(toolTemplate.create).mockResolvedValue(toolHandle as any);
      vi.mocked(templateRegistry.getTemplate).mockReturnValue(toolTemplate);

      const schema: GraphSchemaType = {
        nodes: [
          { id: 'tool-1', template: 'tool', config: { apiKey: 'MY_KEY' } },
        ],
        edges: [],
      };

      const graph = createMockGraphEntity(schema);
      await compiler.compile(graph);

      expect(mockAddEnvVariables).not.toHaveBeenCalled();
    });

    it('should not call resolveSecretValue when config value is an empty string', async () => {
      const toolTemplate = Object.assign(createMockTemplate(NodeKind.Tool), {
        schema: z.object({
          apiKey: z.string().meta({ 'x-ui:secret-select': true }),
        }),
      });
      const toolHandle = createMockHandle({ id: 'tool' });
      vi.mocked(toolTemplate.create).mockResolvedValue(toolHandle as any);
      vi.mocked(templateRegistry.getTemplate).mockReturnValue(toolTemplate);

      const schema: GraphSchemaType = {
        nodes: [{ id: 'tool-1', template: 'tool', config: { apiKey: '' } }],
        edges: [],
      };

      const graph = createMockGraphEntity(schema);
      await compiler.compile(graph);

      expect(secretsService.resolveSecretValue).not.toHaveBeenCalled();
    });

    it('should not call resolveSecretValue when config key is absent (undefined)', async () => {
      const toolTemplate = Object.assign(createMockTemplate(NodeKind.Tool), {
        schema: z.object({
          apiKey: z.string().meta({ 'x-ui:secret-select': true }),
        }),
      });
      const toolHandle = createMockHandle({ id: 'tool' });
      vi.mocked(toolTemplate.create).mockResolvedValue(toolHandle as any);
      vi.mocked(templateRegistry.getTemplate).mockReturnValue(toolTemplate);

      const schema: GraphSchemaType = {
        nodes: [{ id: 'tool-1', template: 'tool', config: {} }],
        edges: [],
      };

      const graph = createMockGraphEntity(schema);
      await compiler.compile(graph);

      expect(secretsService.resolveSecretValue).not.toHaveBeenCalled();
    });

    it('should propagate error thrown by batchResolveSecretValues during compile', async () => {
      const resolveError = new NotFoundException(
        'SECRET_NOT_FOUND',
        'Secret not found',
      );
      secretsService.batchResolveSecretValues.mockRejectedValue(resolveError);

      const runtimeTemplate = createMockTemplate(NodeKind.Runtime);
      const toolTemplate = Object.assign(createMockTemplate(NodeKind.Tool), {
        schema: z.object({
          apiKey: z.string().meta({ 'x-ui:secret-select': true }),
        }),
      });

      const runtimeHandle = createMockHandle({});
      const toolHandle = createMockHandle({ id: 'tool' });

      vi.mocked(runtimeTemplate.create).mockResolvedValue(runtimeHandle as any);
      vi.mocked(toolTemplate.create).mockResolvedValue(toolHandle as any);

      vi.mocked(templateRegistry.getTemplate).mockImplementation((id) => {
        if (id === 'runtime') {
          return runtimeTemplate;
        }
        if (id === 'tool') {
          return toolTemplate;
        }
        return undefined;
      });

      const schema: GraphSchemaType = {
        nodes: [
          { id: 'runtime-1', template: 'runtime', config: {} },
          { id: 'tool-1', template: 'tool', config: { apiKey: 'MY_API_KEY' } },
        ],
        edges: [{ from: 'tool-1', to: 'runtime-1' }],
      };

      const graph = createMockGraphEntity(schema);

      await expect(compiler.compile(graph)).rejects.toThrow(NotFoundException);
    });

    it('should resolve secrets from array field (x-ui:secret-multi-select)', async () => {
      const mockAddEnvVariables = vi.fn();
      const mockRuntimeInstance = Object.create(
        RuntimeThreadProvider.prototype,
      ) as RuntimeThreadProvider;
      mockRuntimeInstance.addEnvVariables = mockAddEnvVariables;

      const runtimeTemplate = createMockTemplate(NodeKind.Runtime);
      const toolTemplate = Object.assign(createMockTemplate(NodeKind.Tool), {
        schema: z.object({
          secrets: z
            .array(z.string())
            .meta({ 'x-ui:secret-multi-select': true }),
        }),
      });

      const runtimeHandle = createMockHandle(mockRuntimeInstance);
      const toolHandle = createMockHandle({ id: 'tool' });

      vi.mocked(runtimeTemplate.create).mockResolvedValue(runtimeHandle as any);
      vi.mocked(toolTemplate.create).mockResolvedValue(toolHandle as any);

      vi.mocked(templateRegistry.getTemplate).mockImplementation((id) => {
        if (id === 'runtime') {
          return runtimeTemplate;
        }
        if (id === 'tool') {
          return toolTemplate;
        }
        return undefined;
      });

      const schema: GraphSchemaType = {
        nodes: [
          { id: 'runtime-1', template: 'runtime', config: {} },
          {
            id: 'tool-1',
            template: 'tool',
            config: { secrets: ['SECRET_A', 'SECRET_B'] },
          },
        ],
        edges: [{ from: 'tool-1', to: 'runtime-1' }],
      };

      secretsService.batchResolveSecretValues.mockResolvedValue(
        new Map([
          ['SECRET_A', 'val-a'],
          ['SECRET_B', 'val-b'],
        ]),
      );

      const graph = createMockGraphEntity(schema);
      await compiler.compile(graph);

      expect(mockAddEnvVariables).toHaveBeenCalledWith({
        SECRET_A: 'val-a',
        SECRET_B: 'val-b',
      });
    });

    it('should inject secrets directly when the node itself is a runtime', async () => {
      const mockAddEnvVariables = vi.fn();
      const mockRuntimeInstance = Object.create(
        RuntimeThreadProvider.prototype,
      ) as RuntimeThreadProvider;
      mockRuntimeInstance.addEnvVariables = mockAddEnvVariables;

      const runtimeTemplate = Object.assign(
        createMockTemplate(NodeKind.Runtime),
        {
          schema: z.object({
            secrets: z
              .array(z.string())
              .meta({ 'x-ui:secret-multi-select': true }),
          }),
        },
      );

      const runtimeHandle = createMockHandle(mockRuntimeInstance);
      vi.mocked(runtimeTemplate.create).mockResolvedValue(runtimeHandle as any);
      vi.mocked(templateRegistry.getTemplate).mockReturnValue(runtimeTemplate);

      const schema: GraphSchemaType = {
        nodes: [
          {
            id: 'runtime-1',
            template: 'runtime',
            config: { secrets: ['MY_SECRET'] },
          },
        ],
        edges: [],
      };

      secretsService.batchResolveSecretValues.mockResolvedValue(
        new Map([['MY_SECRET', 'resolved-value']]),
      );

      const graph = createMockGraphEntity(schema);
      await compiler.compile(graph);

      expect(mockAddEnvVariables).toHaveBeenCalledWith({
        MY_SECRET: 'resolved-value',
      });
    });

    it('should handle mixed single and multi-select secrets', async () => {
      const mockAddEnvVariables = vi.fn();
      const mockRuntimeInstance = Object.create(
        RuntimeThreadProvider.prototype,
      ) as RuntimeThreadProvider;
      mockRuntimeInstance.addEnvVariables = mockAddEnvVariables;

      const runtimeTemplate = createMockTemplate(NodeKind.Runtime);
      const toolATemplate = Object.assign(createMockTemplate(NodeKind.Tool), {
        schema: z.object({
          apiKey: z.string().meta({ 'x-ui:secret-select': true }),
        }),
      });
      const toolBTemplate = Object.assign(createMockTemplate(NodeKind.Tool), {
        schema: z.object({
          secrets: z
            .array(z.string())
            .meta({ 'x-ui:secret-multi-select': true }),
        }),
      });

      const runtimeHandle = createMockHandle(mockRuntimeInstance);
      const toolAHandle = createMockHandle({ id: 'tool-a' });
      const toolBHandle = createMockHandle({ id: 'tool-b' });

      vi.mocked(runtimeTemplate.create).mockResolvedValue(runtimeHandle as any);
      vi.mocked(toolATemplate.create).mockResolvedValue(toolAHandle as any);
      vi.mocked(toolBTemplate.create).mockResolvedValue(toolBHandle as any);

      vi.mocked(templateRegistry.getTemplate).mockImplementation((id) => {
        if (id === 'runtime') {
          return runtimeTemplate;
        }
        if (id === 'tool-a') {
          return toolATemplate;
        }
        if (id === 'tool-b') {
          return toolBTemplate;
        }
        return undefined;
      });

      const schema: GraphSchemaType = {
        nodes: [
          { id: 'runtime-1', template: 'runtime', config: {} },
          { id: 'tool-a-1', template: 'tool-a', config: { apiKey: 'KEY_A' } },
          {
            id: 'tool-b-1',
            template: 'tool-b',
            config: { secrets: ['KEY_B', 'KEY_C'] },
          },
        ],
        edges: [
          { from: 'tool-a-1', to: 'runtime-1' },
          { from: 'tool-b-1', to: 'runtime-1' },
        ],
      };

      secretsService.batchResolveSecretValues.mockResolvedValue(
        new Map([
          ['KEY_A', 'val-a'],
          ['KEY_B', 'val-b'],
          ['KEY_C', 'val-c'],
        ]),
      );

      const graph = createMockGraphEntity(schema);
      await compiler.compile(graph);

      expect(secretsService.batchResolveSecretValues).toHaveBeenCalledWith(
        'project-123',
        expect.arrayContaining(['KEY_A', 'KEY_B', 'KEY_C']),
      );
      expect(mockAddEnvVariables).toHaveBeenCalledWith({ KEY_A: 'val-a' });
      expect(mockAddEnvVariables).toHaveBeenCalledWith({
        KEY_B: 'val-b',
        KEY_C: 'val-c',
      });
    });

    it('should skip empty arrays in multi-select secrets', async () => {
      const toolTemplate = Object.assign(createMockTemplate(NodeKind.Tool), {
        schema: z.object({
          secrets: z
            .array(z.string())
            .meta({ 'x-ui:secret-multi-select': true }),
        }),
      });
      const toolHandle = createMockHandle({ id: 'tool' });
      vi.mocked(toolTemplate.create).mockResolvedValue(toolHandle as any);
      vi.mocked(templateRegistry.getTemplate).mockReturnValue(toolTemplate);

      const schema: GraphSchemaType = {
        nodes: [{ id: 'tool-1', template: 'tool', config: { secrets: [] } }],
        edges: [],
      };

      const graph = createMockGraphEntity(schema);
      await compiler.compile(graph);

      expect(secretsService.batchResolveSecretValues).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('should validate unique node IDs', () => {
      const schema: GraphSchemaType = {
        nodes: [
          { id: 'n1', template: 't', config: {} },
          { id: 'n1', template: 't', config: {} },
        ],
        edges: [],
      };
      expect(() => compiler.validateSchema(schema)).toThrow(
        BadRequestException,
      );
    });

    it('should validate edge references', () => {
      const schema: GraphSchemaType = {
        nodes: [{ id: 'n1', template: 't', config: {} }],
        edges: [{ from: 'n1', to: 'n2' }],
      };
      expect(() => compiler.validateSchema(schema)).toThrow(
        BadRequestException,
      );
    });
  });

  describe('requiredGroup validation (OR-groups)', () => {
    // Trigger requires at least one agent of EITHER kind — exactly the rule
    // shape manual-trigger / github-issues-trigger ship with.
    const triggerTemplate = {
      kind: NodeKind.Trigger,
      inputs: [] as NodeConnection[],
      outputs: [
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
      ] as NodeConnection[],
    };
    const agentInputs = [
      { type: 'kind', value: NodeKind.Trigger, multiple: true },
    ] as NodeConnection[];
    const simpleAgentTemplate = {
      kind: NodeKind.SimpleAgent,
      inputs: agentInputs,
      outputs: [] as NodeConnection[],
    };
    const claudeAgentTemplate = {
      kind: NodeKind.ClaudeAgent,
      inputs: agentInputs,
      outputs: [] as NodeConnection[],
    };

    const registerTemplates = () => {
      vi.mocked(templateRegistry.getTemplate).mockImplementation(
        (id: string) => {
          if (id === 'trigger-t') {
            return triggerTemplate as never;
          }
          if (id === 'simple-agent-t') {
            return simpleAgentTemplate as never;
          }
          if (id === 'claude-agent-t') {
            return claudeAgentTemplate as never;
          }
          return undefined as never;
        },
      );
    };

    const expectMissingRequired = (schema: GraphSchemaType) => {
      try {
        compiler.validateSchema(schema);
        expect.fail('expected MISSING_REQUIRED_CONNECTION');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as { errorCode?: string }).errorCode).toBe(
          'MISSING_REQUIRED_CONNECTION',
        );
      }
    };

    it('rejects a trigger with no agent connection at all', () => {
      registerTemplates();
      expectMissingRequired({
        nodes: [{ id: 'tr', template: 'trigger-t', config: {} }],
        edges: [],
      });
    });

    it('accepts the group satisfied by the FIRST member kind (simpleAgent only)', () => {
      registerTemplates();
      expect(() =>
        compiler.validateSchema({
          nodes: [
            { id: 'tr', template: 'trigger-t', config: {} },
            { id: 'ag', template: 'simple-agent-t', config: {} },
          ],
          edges: [{ from: 'tr', to: 'ag' }],
        }),
      ).not.toThrow();
    });

    it('accepts the group satisfied by the SECOND member kind only (claudeAgent — the discriminating case)', () => {
      registerTemplates();
      expect(() =>
        compiler.validateSchema({
          nodes: [
            { id: 'tr', template: 'trigger-t', config: {} },
            { id: 'ag', template: 'claude-agent-t', config: {} },
          ],
          edges: [{ from: 'tr', to: 'ag' }],
        }),
      ).not.toThrow();
    });

    it('names every group option in the rejection message', () => {
      registerTemplates();
      try {
        compiler.validateSchema({
          nodes: [{ id: 'tr', template: 'trigger-t', config: {} }],
          edges: [],
        });
        expect.fail('expected MISSING_REQUIRED_CONNECTION');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("kind 'simpleAgent'");
        expect(message).toContain("kind 'claudeAgent'");
      }
    });

    it('still enforces per-rule required:true alongside a satisfied group', () => {
      const triggerWithRequired = {
        ...triggerTemplate,
        outputs: [
          ...triggerTemplate.outputs,
          {
            type: 'kind',
            value: NodeKind.Runtime,
            required: true,
            multiple: false,
          },
        ] as NodeConnection[],
      };
      vi.mocked(templateRegistry.getTemplate).mockImplementation(
        (id: string) => {
          if (id === 'trigger-t') {
            return triggerWithRequired as never;
          }
          if (id === 'claude-agent-t') {
            return claudeAgentTemplate as never;
          }
          return undefined as never;
        },
      );

      // Agent group satisfied, but the required Runtime edge is missing.
      expectMissingRequired({
        nodes: [
          { id: 'tr', template: 'trigger-t', config: {} },
          { id: 'ag', template: 'claude-agent-t', config: {} },
        ],
        edges: [{ from: 'tr', to: 'ag' }],
      });
    });
  });
});
