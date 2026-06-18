import { ModuleRef } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomMcp } from '../../../agent-mcp/services/mcp/custom-mcp';
import type { GraphNode } from '../../../graphs/graphs.types';
import { NodeKind } from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import { RuntimeType } from '../../../runtime/runtime.types';
import { BaseRuntime } from '../../../runtime/services/base-runtime';
import { RuntimeProvider } from '../../../runtime/services/runtime-provider';
import type { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
import {
  CustomMcpTemplate,
  CustomMcpTemplateSchema,
  CustomMcpTemplateSchemaType,
} from './custom-mcp.template';

describe('CustomMcpTemplate', () => {
  let template: CustomMcpTemplate;
  let graphRegistry: GraphRegistry;
  let mockModuleRef: ModuleRef;
  let mockRuntime: BaseRuntime;
  let mockMcpInstance: CustomMcp;
  let mockRuntimeProvider: {
    provide: ReturnType<typeof vi.fn>;
    cleanupRuntimeInstance: ReturnType<typeof vi.fn>;
    getDefaultRuntimeType: ReturnType<typeof vi.fn>;
  };

  const metadata = {
    graphId: 'test-graph-id',
    nodeId: 'test-node-id',
    name: 'test-node',
    version: '1.0.0',
    graph_created_by: 'user-1',
    graph_project_id: '11111111-1111-1111-1111-111111111111',
  };

  beforeEach(async () => {
    mockRuntime = {
      start: vi.fn(),
      stop: vi.fn(),
      exec: vi.fn(),
      execStream: vi.fn(),
    } as unknown as BaseRuntime;

    mockMcpInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
      discoverTools: vi.fn().mockResolvedValue([]),
      provideTemporaryRuntime: vi.fn().mockResolvedValue(mockRuntime),
      getMcpConfig: vi.fn(),
      getDetailedInstructions: vi.fn(),
    } as unknown as CustomMcp;

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
        CustomMcpTemplate,
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

    template = module.get<CustomMcpTemplate>(CustomMcpTemplate);
    graphRegistry = module.get<GraphRegistry>(GraphRegistry);
  });

  describe('template metadata', () => {
    it('should have correct id, name, and description', () => {
      expect(template.id).toBe('custom-mcp');
      expect(template.name).toBe('Custom MCP');
      expect(template.description).toContain('command mode');
      expect(template.description).toContain('URL mode');
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
    it('should parse command-only config', () => {
      const parsed = CustomMcpTemplateSchema.parse({
        command: 'my-server',
      });
      expect(parsed).toEqual({
        command: 'my-server',
        headers: {},
        env: {},
      });
    });

    it('should parse serverUrl-only config', () => {
      const parsed = CustomMcpTemplateSchema.parse({
        serverUrl: 'https://mcp.example.com',
      });
      expect(parsed).toEqual({
        serverUrl: 'https://mcp.example.com',
        headers: {},
        env: {},
      });
    });

    it('should reject empty config when neither command nor serverUrl is provided', () => {
      expect(() => CustomMcpTemplateSchema.parse({})).toThrow(
        'Either command or serverUrl must be provided',
      );
    });

    it('should parse config with both command and serverUrl', () => {
      const parsed = CustomMcpTemplateSchema.parse({
        command: 'my-server',
        serverUrl: 'https://mcp.example.com',
      });
      expect(parsed.command).toBe('my-server');
      expect(parsed.serverUrl).toBe('https://mcp.example.com');
    });

    it('should reject header names with invalid characters', () => {
      expect(() =>
        CustomMcpTemplateSchema.parse({
          serverUrl: 'https://mcp.example.com',
          headers: { 'Bad Header': 'value' },
        }),
      ).toThrow();
    });

    it('should reject header values containing newlines (CRLF)', () => {
      expect(() =>
        CustomMcpTemplateSchema.parse({
          serverUrl: 'https://mcp.example.com',
          headers: { 'X-Custom': 'value\r\nInjected: true' },
        }),
      ).toThrow();
    });

    it('should reject header values containing bare LF', () => {
      expect(() =>
        CustomMcpTemplateSchema.parse({
          serverUrl: 'https://mcp.example.com',
          headers: { 'X-Custom': 'line1\nline2' },
        }),
      ).toThrow();
    });

    it('should reject header names with colons', () => {
      expect(() =>
        CustomMcpTemplateSchema.parse({
          serverUrl: 'https://mcp.example.com',
          headers: { 'Host:Inject': 'value' },
        }),
      ).toThrow();
    });

    it('should strip args field if provided (no longer part of schema)', () => {
      const parsed = CustomMcpTemplateSchema.parse({
        command: 'my-server --port 3000',
        args: ['--port', '3000'],
      });
      expect(parsed).not.toHaveProperty('args');
      expect(parsed.command).toBe('my-server --port 3000');
    });

    it('should parse config with env variables', () => {
      const parsed = CustomMcpTemplateSchema.parse({
        command: 'my-server',
        env: { NODE_ENV: 'production', DEBUG: '*' },
      });
      expect(parsed.env).toEqual({ NODE_ENV: 'production', DEBUG: '*' });
    });

    it('should strip unknown fields', () => {
      const parsed = CustomMcpTemplateSchema.parse({
        command: 'my-server',
        transportType: 'command',
        unknownField: 'value',
      });
      expect(parsed).not.toHaveProperty('transportType');
      expect(parsed).not.toHaveProperty('unknownField');
    });
  });

  describe('roundtrip: schema parse → getMcpConfig', () => {
    let customMcpInstance: CustomMcp;

    beforeEach(() => {
      customMcpInstance = new CustomMcp({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        setContext: vi.fn(),
      } as any);
    });

    it('should roundtrip command config through schema and getMcpConfig', () => {
      const parsed = CustomMcpTemplateSchema.parse({
        command: 'my-server --flag',
        env: { KEY: 'val' },
        transportType: 'command', // stripped by schema
      });

      const mcpConfig = customMcpInstance.getMcpConfig(parsed);

      expect(mcpConfig.command).toBe('my-server');
      expect(mcpConfig.args).toEqual(['--flag']);
      expect(mcpConfig.env).toEqual({ KEY: 'val' });
    });

    it('should roundtrip URL config through schema and getMcpConfig with mcp-remote', () => {
      const parsed = CustomMcpTemplateSchema.parse({
        serverUrl: 'http://localhost:9090',
        headers: { Authorization: 'Bearer tok' },
      });

      const mcpConfig = customMcpInstance.getMcpConfig(parsed);

      expect(mcpConfig.command).toBe('npx');
      expect(mcpConfig.args).toContain('mcp-remote');
      expect(mcpConfig.args).toContain('http://localhost:9090');
      expect(mcpConfig.args).toContain('--allow-http');
      expect(mcpConfig.args).toContain('Authorization:Bearer tok');
    });
  });

  describe('create', () => {
    it('should configure with command mode config and runtime', async () => {
      const config: CustomMcpTemplateSchemaType = {
        command: 'my-mcp-server --port 3000',
        headers: {},
        env: {},
      };
      const outputNodeIds = new Set(['runtime-1']);

      const handle = await template.create();
      const init: GraphNode<CustomMcpTemplateSchemaType> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata,
      };

      const instance = await handle.provide(init);
      expect(instance).toBeDefined();

      await handle.configure(init, instance as CustomMcp);

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

    it('should configure with URL mode config and runtime', async () => {
      const config: CustomMcpTemplateSchemaType = {
        serverUrl: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer token' },
        env: {},
      };
      const outputNodeIds = new Set(['runtime-1']);

      const handle = await template.create();
      const init: GraphNode<CustomMcpTemplateSchemaType> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata,
      };

      const instance = await handle.provide(init);
      await handle.configure(init, instance as CustomMcp);

      expect(mockMcpInstance.initialize).toHaveBeenCalledWith(
        config,
        expect.any(Object),
        mockRuntime,
        metadata.nodeId,
      );
    });

    it('should throw error when runtime is not connected', async () => {
      const config: CustomMcpTemplateSchemaType = {
        command: 'my-server',
        headers: {},
        env: {},
      };
      const outputNodeIds = new Set<string>();

      const handle = await template.create();
      const init: GraphNode<CustomMcpTemplateSchemaType> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata,
      };

      const instance = await handle.provide(init);

      await expect(
        handle.configure(init, instance as CustomMcp),
      ).rejects.toThrow('Custom MCP requires a Runtime node connection');
    });

    it('should throw NotFoundException when runtime instance is not found in registry', async () => {
      const config: CustomMcpTemplateSchemaType = {
        command: 'my-server',
        headers: {},
        env: {},
      };
      const outputNodeIds = new Set(['runtime-1']);

      vi.mocked(graphRegistry.getNode)
        .mockReturnValueOnce({
          type: NodeKind.Runtime,
          id: 'runtime-1',
          config: {},
        } as any)
        .mockReturnValueOnce(undefined as any);

      const handle = await template.create();
      const init: GraphNode<CustomMcpTemplateSchemaType> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata,
      };

      const instance = await handle.provide(init);

      await expect(
        handle.configure(init, instance as CustomMcp),
      ).rejects.toThrow(/Runtime node .* not found/);
    });

    it('should cleanup on destroy without throwing', async () => {
      const handle = await template.create();

      await handle.destroy(mockMcpInstance);

      expect(mockMcpInstance.cleanup).toHaveBeenCalled();
    });

    it('should swallow cleanup errors on destroy', async () => {
      vi.mocked(mockMcpInstance.cleanup).mockRejectedValue(
        new Error('Cleanup failed'),
      );

      const handle = await template.create();

      await expect(handle.destroy(mockMcpInstance)).resolves.not.toThrow();
    });
  });

  describe('getMcpConfig via CustomMcp', () => {
    let customMcpInstance: CustomMcp;

    beforeEach(() => {
      customMcpInstance = new CustomMcp({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        setContext: vi.fn(),
      } as any);
    });

    it('should split command string into command and args', () => {
      const result = customMcpInstance.getMcpConfig({
        command: 'npx -y @my-org/mcp-server --port 3000',
        env: { NODE_ENV: 'production' },
      });

      expect(result).toEqual({
        name: 'custom-mcp',
        command: 'npx',
        args: ['-y', '@my-org/mcp-server', '--port', '3000'],
        env: { NODE_ENV: 'production' },
      });
    });

    it('should handle single-word command with no args', () => {
      const result = customMcpInstance.getMcpConfig({
        command: 'my-server',
      });

      expect(result).toEqual({
        name: 'custom-mcp',
        command: 'my-server',
        args: [],
        env: {},
      });
    });

    it('should auto-detect URL mode when only serverUrl is provided', () => {
      const result = customMcpInstance.getMcpConfig({
        serverUrl: 'https://mcp.example.com',
      });

      expect(result).toEqual({
        name: 'custom-mcp',
        command: 'npx',
        args: [
          '-y',
          'mcp-remote',
          'https://mcp.example.com',
          '--transport',
          'http-first',
        ],
        env: {},
      });
    });

    it('should prefer command mode when both command and serverUrl are provided', () => {
      const result = customMcpInstance.getMcpConfig({
        command: 'my-server --verbose',
        serverUrl: 'https://mcp.example.com',
        env: {},
      });

      expect(result).toEqual({
        name: 'custom-mcp',
        command: 'my-server',
        args: ['--verbose'],
        env: {},
      });
    });

    it('should throw when neither command nor serverUrl is provided', () => {
      expect(() => customMcpInstance.getMcpConfig({})).toThrow(
        'Custom MCP requires either a command or a serverUrl',
      );
    });

    it('should add --allow-http flag for http:// URLs', () => {
      const result = customMcpInstance.getMcpConfig({
        serverUrl: 'http://localhost:3000',
      });

      expect(result.args).toContain('--allow-http');
    });

    it('should add --header flags for custom headers', () => {
      const result = customMcpInstance.getMcpConfig({
        serverUrl: 'https://mcp.example.com',
        headers: {
          Authorization: 'Bearer token',
          'X-Custom': 'value',
        },
      });

      expect(result.args).toContain('--header');
      expect(result.args).toContain('Authorization:Bearer token');
      expect(result.args).toContain('X-Custom:value');
    });
  });

  describe('getDetailedInstructions via CustomMcp', () => {
    let customMcpInstance: CustomMcp;

    beforeEach(() => {
      customMcpInstance = new CustomMcp({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        setContext: vi.fn(),
      } as any);
    });

    it('should auto-detect command mode instructions when command is provided', () => {
      const instructions = customMcpInstance.getDetailedInstructions({
        command: 'my-mcp-server --verbose',
        env: {},
      });

      expect(instructions).toContain('Custom MCP Server');
      expect(instructions).toContain('Command mode');
      expect(instructions).toContain('my-mcp-server --verbose');
    });

    it('should auto-detect URL mode instructions when only serverUrl is provided', () => {
      const instructions = customMcpInstance.getDetailedInstructions({
        serverUrl: 'https://mcp.example.com',
        headers: {},
        env: {},
      });

      expect(instructions).toContain('Custom MCP Server');
      expect(instructions).toContain('URL mode');
      expect(instructions).toContain('https://mcp.example.com');
    });

    it('should prefer command mode in instructions when both are provided', () => {
      const instructions = customMcpInstance.getDetailedInstructions({
        command: 'my-server',
        serverUrl: 'https://mcp.example.com',
      });

      expect(instructions).toContain('Command mode');
      expect(instructions).toContain('my-server');
    });

    it('should show URL mode with "(not set)" when neither is provided', () => {
      const instructions = customMcpInstance.getDetailedInstructions({});

      expect(instructions).toContain('URL mode');
      expect(instructions).toContain('(not set)');
    });
  });
});
