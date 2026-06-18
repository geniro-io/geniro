import { ModuleRef } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaywrightMcp } from '../../../agent-mcp/services/mcp/playwright-mcp';
import type { GraphNode } from '../../../graphs/graphs.types';
import { NodeKind } from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import { RuntimeType } from '../../../runtime/runtime.types';
import { BaseRuntime } from '../../../runtime/services/base-runtime';
import { RuntimeProvider } from '../../../runtime/services/runtime-provider';
import type { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
import {
  PlaywrightMcpTemplate,
  PlaywrightMcpTemplateSchema,
} from './playwright-mcp.template';

describe('PlaywrightMcpTemplate', () => {
  let template: PlaywrightMcpTemplate;
  let graphRegistry: GraphRegistry;
  let mockModuleRef: ModuleRef;
  let mockRuntime: BaseRuntime;
  let mockMcpInstance: PlaywrightMcp;
  let mockRuntimeProvider: {
    provide: ReturnType<typeof vi.fn>;
    cleanupRuntimeInstance: ReturnType<typeof vi.fn>;
    getDefaultRuntimeType: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    // Create mock runtime
    mockRuntime = {
      start: vi.fn(),
      stop: vi.fn(),
      exec: vi.fn(),
      execStream: vi.fn(),
    } as unknown as BaseRuntime;

    // Create mock MCP instance
    mockMcpInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
      discoverTools: vi.fn().mockResolvedValue([]),
      provideTemporaryRuntime: vi.fn().mockResolvedValue(mockRuntime),
    } as unknown as PlaywrightMcp;

    // Create mock GraphRegistry
    const mockRuntimeThreadProvider: Partial<RuntimeThreadProvider> = {
      getParams: vi.fn().mockReturnValue({
        graphId: 'test-graph-id',
        runtimeNodeId: 'runtime-1',
        type: RuntimeType.Docker,
        runtimeStartParams: {},
        temporary: false,
      }),
    };
    const mockGraphRegistry = {
      getNode: vi.fn().mockReturnValue({
        type: NodeKind.Runtime,
        id: 'runtime-1',
        config: {},
        instance: mockRuntimeThreadProvider,
      }),
      getNodeInstance: vi.fn().mockReturnValue(mockRuntime),
    };

    // Create mock ModuleRef with resolve method
    mockModuleRef = {
      get: vi.fn().mockReturnValue(mockMcpInstance),
      create: vi.fn().mockResolvedValue(mockMcpInstance),
      resolve: vi.fn().mockResolvedValue(mockMcpInstance),
    } as unknown as ModuleRef;

    mockRuntimeProvider = {
      provide: vi.fn().mockResolvedValue({
        runtime: mockRuntime,
        cached: false,
      }),
      cleanupRuntimeInstance: vi.fn().mockResolvedValue(undefined),
      getDefaultRuntimeType: vi.fn().mockReturnValue(RuntimeType.Docker),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlaywrightMcpTemplate,
        {
          provide: GraphRegistry,
          useValue: mockGraphRegistry,
        },
        {
          provide: ModuleRef,
          useValue: mockModuleRef,
        },
        {
          provide: RuntimeProvider,
          useValue: mockRuntimeProvider,
        },
      ],
    }).compile();

    template = module.get<PlaywrightMcpTemplate>(PlaywrightMcpTemplate);
    graphRegistry = module.get<GraphRegistry>(GraphRegistry);
  });

  describe('template metadata', () => {
    it('should have correct id and name', () => {
      expect(template.id).toBe('playwright-mcp');
      expect(template.name).toBe('Playwright MCP');
      expect(template.description).toContain('Playwright');
      expect(template.description).toContain('Browser automation');
    });

    it('should accept SimpleAgent and ClaudeAgent as inputs', () => {
      expect(template.inputs).toEqual([
        { type: 'kind', value: NodeKind.SimpleAgent, multiple: true },
        { type: 'kind', value: NodeKind.ClaudeAgent, multiple: true },
      ]);
    });

    it('should require Runtime as output', () => {
      expect(template.outputs).toEqual([
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
    it('should parse empty config', () => {
      const parsed = PlaywrightMcpTemplateSchema.parse({});
      expect(parsed).toEqual({});
    });

    it('should strip unknown fields', () => {
      const config = {
        unexpected: 'value',
      };

      const parsed = PlaywrightMcpTemplateSchema.parse(config);
      expect(parsed).not.toHaveProperty('unexpected');
    });
  });

  describe('create', () => {
    it('should create MCP instance and setup with runtime', async () => {
      const config = {} as Record<string, never>;

      const metadata = {
        graphId: 'test-graph-id',
        nodeId: 'test-node-id',
        name: 'test-node',
        version: '1.0.0',
        graph_created_by: 'user-1',
        graph_project_id: '11111111-1111-1111-1111-111111111111',
      };

      const outputNodeIds = new Set(['runtime-1']);

      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata,
      };

      const instance = await handle.provide(init);
      expect(instance).toBeDefined();

      await handle.configure(init, instance as PlaywrightMcp);

      expect(mockMcpInstance.provideTemporaryRuntime).toHaveBeenCalledWith({
        runtimeProvider: mockRuntimeProvider,
        graphId: metadata.graphId,
        runtimeNodeId: 'runtime-1',
        runtimeConfig: {},
      });
      expect(mockMcpInstance.initialize).toHaveBeenCalledWith(
        config,
        expect.any(Object),
        mockRuntime,
        metadata.nodeId,
      );
      expect(mockRuntimeProvider.cleanupRuntimeInstance).toHaveBeenCalledWith({
        graphId: metadata.graphId,
        runtimeNodeId: 'runtime-1',
        threadId: `mcp-init-${metadata.graphId}-runtime-1`,
        type: RuntimeType.Docker,
      });
    });

    it('should cleanup before setup during reconfiguration', async () => {
      const config = {} as Record<string, never>;

      const metadata = {
        graphId: 'test-graph-id',
        nodeId: 'test-node-id',
        name: 'test-node',
        version: '1.0.0',
        graph_created_by: 'user-1',
        graph_project_id: '11111111-1111-1111-1111-111111111111',
      };

      const outputNodeIds = new Set(['runtime-1']);

      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata,
      };

      const instance = await handle.provide(init);
      await handle.configure(init, instance as PlaywrightMcp);

      expect(mockMcpInstance.cleanup).toHaveBeenCalled();
      expect(mockMcpInstance.initialize).toHaveBeenCalled();
    });

    it('should throw error when runtime is not connected', async () => {
      const config = {} as Record<string, never>;

      const metadata = {
        graphId: 'test-graph-id',
        nodeId: 'test-node-id',
        name: 'test-node',
        version: '1.0.0',
        graph_created_by: 'user-1',
        graph_project_id: '11111111-1111-1111-1111-111111111111',
      };

      const outputNodeIds = new Set<string>();

      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata,
      };

      const instance = await handle.provide(init);

      await expect(
        handle.configure(init, instance as PlaywrightMcp),
      ).rejects.toThrow(
        'Playwright MCP requires a Runtime node with Docker type',
      );
    });

    it('should throw error when runtime instance is not found', async () => {
      const config = {} as Record<string, never>;

      const metadata = {
        graphId: 'test-graph-id',
        nodeId: 'test-node-id',
        name: 'test-node',
        version: '1.0.0',
        graph_created_by: 'user-1',
        graph_project_id: '11111111-1111-1111-1111-111111111111',
      };

      const outputNodeIds = new Set(['runtime-1']);

      // Runtime node is discovered, but missing when fetched for configuration
      vi.mocked(graphRegistry.getNode)
        .mockReturnValueOnce({
          type: NodeKind.Runtime,
          id: 'runtime-1',
          config: {},
        } as any)
        .mockReturnValueOnce(undefined as any);

      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata,
      };

      const instance = await handle.provide(init);

      await expect(
        handle.configure(init, instance as PlaywrightMcp),
      ).rejects.toThrow(/Runtime node .* not found/);
    });

    it('should cleanup on destroy', async () => {
      const handle = await template.create();

      await handle.destroy(mockMcpInstance);

      expect(mockMcpInstance.cleanup).toHaveBeenCalled();
    });

    it('should handle cleanup errors gracefully on destroy', async () => {
      vi.mocked(mockMcpInstance.cleanup).mockRejectedValue(
        new Error('Cleanup failed'),
      );

      const handle = await template.create();

      // Should not throw
      await expect(handle.destroy(mockMcpInstance)).resolves.not.toThrow();
    });
  });
});
