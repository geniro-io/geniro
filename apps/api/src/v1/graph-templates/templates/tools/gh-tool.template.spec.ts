import { DynamicStructuredTool } from '@langchain/core/tools';
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GhToolGroup } from '../../../agent-tools/tools/common/github/gh-tool-group';
import { ResourceKind } from '../../../graph-resources/graph-resources.types';
import { IGithubResourceOutput } from '../../../graph-resources/services/github-resource';
import {
  CompiledGraphNode,
  GraphNode,
  GraphNodeInstanceHandle,
  GraphNodeStatus,
  NodeKind,
} from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import { RuntimeType } from '../../../runtime/runtime.types';
import { GhToolTemplate, GhToolTemplateSchema } from './gh-tool.template';

const makeHandle = <TInstance>(
  instance: TInstance,
): GraphNodeInstanceHandle<TInstance, unknown> => ({
  provide: async () => instance,
  configure: async () => {},
  destroy: async () => {},
});

const buildMockNode = <TInstance = unknown>(options: {
  id: string;
  type: NodeKind;
  template: string;
  instance: TInstance;
  config?: unknown;
  getStatus?: () => GraphNodeStatus;
}): CompiledGraphNode<TInstance> =>
  ({
    ...options,
    handle: makeHandle(options.instance),
    config: options.config ?? {},
    getStatus: options.getStatus || (() => GraphNodeStatus.Idle),
  }) as unknown as CompiledGraphNode<TInstance>;

describe('GhToolTemplate', () => {
  let template: GhToolTemplate;
  let mockGhToolGroup: GhToolGroup;
  let mockGraphRegistry: GraphRegistry;

  beforeEach(async () => {
    mockGhToolGroup = {
      buildTools: vi
        .fn()
        .mockReturnValue({ tools: [], instructions: undefined }),
    } as unknown as GhToolGroup;

    mockGraphRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn(),
      getNode: vi.fn(),
      getNodeInstance: vi.fn(),
      filterNodesByType: vi.fn(),
      filterNodesByTemplate: vi.fn(),
      destroy: vi.fn(),
    } as unknown as GraphRegistry;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GhToolTemplate,
        {
          provide: GhToolGroup,
          useValue: mockGhToolGroup,
        },
        {
          provide: GraphRegistry,
          useValue: mockGraphRegistry,
        },
      ],
    }).compile();

    template = module.get<GhToolTemplate>(GhToolTemplate);
  });

  describe('properties', () => {
    it('should have correct name', () => {
      expect(template.name).toBe('GitHub Tools');
    });

    it('should have correct description', () => {
      expect(template.description).toBe('GitHub tools');
    });

    it('should have correct kind', () => {
      expect(template.kind).toBe(NodeKind.Tool);
    });

    it('should have correct schema', () => {
      expect(template.schema).toBe(GhToolTemplateSchema);
    });

    it('should have correct inputs', () => {
      expect(template.inputs).toEqual([
        {
          type: 'kind',
          value: NodeKind.SimpleAgent,
          multiple: true,
        },
      ]);
    });

    it('should have correct outputs', () => {
      expect(template.outputs).toEqual([
        {
          type: 'template',
          value: 'github-resource',
          multiple: false,
          required: true,
        },
        {
          type: 'kind',
          value: NodeKind.Runtime,
          required: true,
          multiple: false,
        },
      ]);
    });
  });

  describe('schema validation', () => {
    it('should accept empty config (uses defaults)', () => {
      const config = {};
      const parsed = GhToolTemplateSchema.parse(config);
      expect(parsed).toEqual({ readOnly: false });
    });

    it('should accept readOnly flag', () => {
      const config = { readOnly: true };
      const parsed = GhToolTemplateSchema.parse(config);
      expect(parsed.readOnly).toBe(true);
    });

    it('should ignore legacy flags from older configs', () => {
      const config = {
        oldFlag: true,
        anotherExtra: 'value',
      };
      const parsed = GhToolTemplateSchema.parse(config);
      expect(parsed).toEqual({ readOnly: false });
    });
  });

  describe('create', () => {
    const mockRuntimeId = 'runtime-1';
    const mockResourceId = 'resource-1';
    const mockGraphId = 'graph-1';
    const mockMetadata = {
      graphId: mockGraphId,
      nodeId: 'tool-1',
      version: '1',
      graph_created_by: 'user-1',
      graph_project_id: '11111111-1111-1111-1111-111111111111',
    };

    let mockRuntime: { exec: ReturnType<typeof vi.fn> };
    let mockRuntimeThreadProvider: {
      provide: ReturnType<typeof vi.fn>;
      getParams: ReturnType<typeof vi.fn>;
      addEnvVariables: ReturnType<typeof vi.fn>;
      registerJob: ReturnType<typeof vi.fn>;
      removeExecutor: ReturnType<typeof vi.fn>;
    };
    let mockResource: IGithubResourceOutput;

    beforeEach(() => {
      mockRuntime = {
        exec: vi.fn().mockResolvedValue({
          stdout: '',
          stderr: '',
          exitCode: 0,
          fail: false,
          execPath: '/bin/sh',
        }),
      };
      mockRuntimeThreadProvider = {
        provide: vi.fn().mockResolvedValue(mockRuntime),
        getParams: vi.fn().mockReturnValue({
          graphId: mockGraphId,
          runtimeNodeId: mockRuntimeId,
          type: RuntimeType.Docker,
          runtimeStartParams: { initScriptTimeoutMs: 0 },
          temporary: false,
        }),
        addEnvVariables: vi.fn(),
        registerJob: vi.fn(),
        removeExecutor: vi.fn(),
      };

      mockResource = {
        information: 'Resource info',
        kind: ResourceKind.Shell,
        resolveToken: vi.fn().mockResolvedValue(null),
        data: {
          resolveEnv: vi.fn().mockResolvedValue({}),
          initScript: 'echo init',
        },
      } satisfies IGithubResourceOutput;

      vi.mocked(mockGraphRegistry.filterNodesByType).mockImplementation(
        (_gid, _nodes, kind) =>
          kind === NodeKind.Runtime ? [mockRuntimeId] : [],
      );

      vi.mocked(mockGraphRegistry.filterNodesByTemplate).mockImplementation(
        (_gid, _nodes, templateId) =>
          templateId === 'github-resource' ? [mockResourceId] : [],
      );

      vi.mocked(mockGraphRegistry.getNode).mockImplementation((gid, nid) => {
        if (gid === mockGraphId && nid === mockRuntimeId) {
          return buildMockNode({
            id: mockRuntimeId,
            type: NodeKind.Runtime,
            template: 'runtime',
            instance: mockRuntimeThreadProvider,
            config: {},
          });
        }

        if (nid === mockResourceId) {
          return buildMockNode({
            id: mockResourceId,
            type: NodeKind.Resource,
            template: 'github-resource',
            instance: mockResource,
          });
        }

        return undefined;
      });
    });

    it('should create GitHub tools with valid runtime and resource nodes', async () => {
      const mockTools = [{ name: 'gh-tool' }] as DynamicStructuredTool[];
      vi.mocked(mockGhToolGroup.buildTools).mockReturnValue({
        tools: mockTools,
        instructions: undefined,
      });

      const outputNodeIds = new Set([mockRuntimeId, mockResourceId]);
      const config = { readOnly: false };
      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockGhToolGroup.buildTools).toHaveBeenCalledWith(
        expect.objectContaining({
          readOnly: false,
        }),
      );
      expect(mockGhToolGroup.buildTools).toHaveBeenCalledWith(
        expect.not.objectContaining({
          patToken: expect.anything(),
        }),
      );
      expect(instance.tools).toEqual(mockTools);
      expect(mockRuntimeThreadProvider.registerJob).toHaveBeenCalledWith(
        mockMetadata.nodeId,
        `gh-init:${mockMetadata.nodeId}`,
        expect.any(Function),
      );
      const buildArgs = vi.mocked(mockGhToolGroup.buildTools).mock.calls[0]![0];
      expect(buildArgs.runtimeProvider).toBe(mockRuntimeThreadProvider);
    });

    it('should use readOnly flag to limit tools', async () => {
      const outputNodeIds = new Set([mockRuntimeId, mockResourceId]);
      const config = { readOnly: true };
      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockGhToolGroup.buildTools).toHaveBeenCalledWith(
        expect.objectContaining({
          readOnly: true,
        }),
      );
    });

    it('should throw NotFoundException when runtime node not found', async () => {
      vi.mocked(mockGraphRegistry.filterNodesByType).mockReturnValue([]);

      const config = { readOnly: false };
      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);

      await expect(handle.configure(init, instance)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when runtime node is null', async () => {
      vi.mocked(mockGraphRegistry.getNode).mockReturnValue(undefined);

      const outputNodeIds = new Set([mockRuntimeId]);
      const config = { readOnly: false };
      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);

      await expect(handle.configure(init, instance)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when GitHub resource node not found', async () => {
      vi.mocked(mockGraphRegistry.filterNodesByTemplate).mockReturnValue([]);

      const outputNodeIds = new Set([mockRuntimeId]);
      const config = { readOnly: false };
      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);

      await expect(handle.configure(init, instance)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should include init script from GitHub resource in runtime resolver', async () => {
      const outputNodeIds = new Set([mockRuntimeId, mockResourceId]);
      const config = { readOnly: false };
      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);
      expect(mockRuntimeThreadProvider.registerJob).toHaveBeenCalledWith(
        mockMetadata.nodeId,
        `gh-init:${mockMetadata.nodeId}`,
        expect.any(Function),
      );
    });

    it('should surface runtime resolver errors when invoked', async () => {
      mockRuntimeThreadProvider.provide.mockRejectedValue(
        new Error('INIT_SCRIPT_EXECUTION_FAILED'),
      );

      const outputNodeIds = new Set([mockRuntimeId, mockResourceId]);
      const config = { readOnly: false };
      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      const buildArgs = vi.mocked(mockGhToolGroup.buildTools).mock.calls[0]![0];
      await expect(
        buildArgs.runtimeProvider?.provide({
          configurable: { thread_id: 'thread-1' },
        } as any),
      ).rejects.toThrow('INIT_SCRIPT_EXECUTION_FAILED');
    });

    it('should skip init script when initScript is undefined', async () => {
      mockResource.data.initScript = undefined;

      const outputNodeIds = new Set([mockRuntimeId, mockResourceId]);
      const config = { readOnly: false };
      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);
      expect(mockRuntimeThreadProvider.registerJob).not.toHaveBeenCalled();
    });
  });
});
