import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CompiledGraph,
  CompiledGraphNode,
  GraphNodeStatus,
  GraphStatus,
  NodeKind,
} from '../graphs.types';
import { GraphRegistry } from './graph-registry';

describe('GraphRegistry', () => {
  let registry: GraphRegistry;

  const createMockCompiledGraph = (
    nodeCount = 2,
    status: GraphStatus = GraphStatus.Running,
  ): CompiledGraph => {
    const nodes = new Map<string, CompiledGraphNode>();

    for (let i = 1; i <= nodeCount; i++) {
      const instance = { mockInstance: `instance-${i}` };
      nodes.set(`node-${i}`, {
        id: `node-${i}`,
        type: i % 2 === 0 ? NodeKind.Runtime : NodeKind.Tool,
        template: i % 2 === 0 ? 'runtime' : 'web-search-tool',
        instance,
        config: {},
        handle: {
          provide: async () => instance,
          configure: async () => {},
          destroy: async () => {},
        },
      });
    }

    const state = {
      getSnapshots: vi.fn().mockImplementation(() =>
        Array.from(nodes.values()).map((node) => ({
          id: node.id,
          name: node.id,
          template: node.template,
          type: node.type,
          status: GraphNodeStatus.Idle,
          config: node.config,
          error: null,
        })),
      ),
      handleGraphDestroyed: vi.fn(),
    } as unknown as CompiledGraph['state'];

    return {
      metadata: {
        graphId: 'mock-graph',
        version: '1.0.0',
        graph_created_by: 'test-user',
        graph_project_id: 'test-project',
      },
      nodes,
      edges: [{ from: 'node-1', to: 'node-2' }],
      state,
      status,
      destroy: vi.fn().mockResolvedValue(undefined),
    };
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GraphRegistry],
    }).compile();

    registry = module.get<GraphRegistry>(GraphRegistry);
  });

  describe('register', () => {
    it('should register a new graph successfully', () => {
      const graphId = 'test-graph-1';
      const compiledGraph = createMockCompiledGraph();

      expect(() => registry.register(graphId, compiledGraph)).not.toThrow();
    });

    it('should throw error when registering duplicate graph ID', () => {
      const graphId = 'test-graph-1';
      const compiledGraph1 = createMockCompiledGraph();
      const compiledGraph2 = createMockCompiledGraph();

      registry.register(graphId, compiledGraph1);

      expect(() => registry.register(graphId, compiledGraph2)).toThrow(
        BadRequestException,
      );
    });

    it('should allow registering different graphs with different IDs', () => {
      const graphId1 = 'test-graph-1';
      const graphId2 = 'test-graph-2';
      const compiledGraph1 = createMockCompiledGraph();
      const compiledGraph2 = createMockCompiledGraph();

      expect(() => {
        registry.register(graphId1, compiledGraph1);
        registry.register(graphId2, compiledGraph2);
      }).not.toThrow();
    });
  });

  describe('getOrCompile', () => {
    it('should de-duplicate concurrent compiles for same graphId', async () => {
      const graphId = 'compile-graph';
      const compiledGraph = createMockCompiledGraph(2, GraphStatus.Compiling);

      const factory = vi.fn(async () => {
        // simulate some async work before registration happens
        await Promise.resolve();
        registry.register(graphId, compiledGraph);
        registry.setStatus(graphId, GraphStatus.Running);
        return compiledGraph;
      });

      const [a, b] = await Promise.all([
        registry.getOrCompile(graphId, factory),
        registry.getOrCompile(graphId, factory),
      ]);

      expect(factory).toHaveBeenCalledTimes(1);
      expect(a).toBe(compiledGraph);
      expect(b).toBe(compiledGraph);
    });

    it('should return already registered graph when status is Running', async () => {
      const graphId = 'already-running-graph';
      const compiledGraph = createMockCompiledGraph(2, GraphStatus.Running);

      registry.register(graphId, compiledGraph);

      const factory = vi.fn(async () => createMockCompiledGraph(1));
      const result = await registry.getOrCompile(graphId, factory);

      expect(factory).not.toHaveBeenCalled();
      expect(result).toBe(compiledGraph);
    });

    it('should throw when graph exists in Compiling status but no in-flight compile is tracked', async () => {
      const graphId = 'stuck-compiling-graph';
      const compiledGraph = createMockCompiledGraph(1, GraphStatus.Compiling);

      registry.register(graphId, compiledGraph);

      const factory = vi.fn(async () => compiledGraph);
      await expect(registry.getOrCompile(graphId, factory)).rejects.toThrow(
        BadRequestException,
      );
      expect(factory).not.toHaveBeenCalled();
    });
  });

  describe('unregister', () => {
    it('should unregister an existing graph', () => {
      const graphId = 'test-graph-1';
      const compiledGraph = createMockCompiledGraph();

      registry.register(graphId, compiledGraph);
      expect(registry.get(graphId)).toBeDefined();

      registry.unregister(graphId);
      expect(registry.get(graphId)).toBeUndefined();
    });

    it('should handle unregistering non-existent graph gracefully', () => {
      const graphId = 'non-existent-graph';

      expect(() => registry.unregister(graphId)).not.toThrow();
    });
  });

  describe('get', () => {
    it('should return registered graph', () => {
      const graphId = 'test-graph-1';
      const compiledGraph = createMockCompiledGraph();

      registry.register(graphId, compiledGraph);

      const result = registry.get(graphId);
      expect(result).toBe(compiledGraph);
    });

    it('should return undefined for non-existent graph', () => {
      const graphId = 'non-existent-graph';

      const result = registry.get(graphId);
      expect(result).toBeUndefined();
    });
  });

  describe('getStatus', () => {
    it('should return undefined for non-existent graph', () => {
      expect(registry.getStatus('missing')).toBeUndefined();
    });

    it('should return current status for registered graph', () => {
      const graphId = 'status-graph';
      const compiledGraph = createMockCompiledGraph(2, GraphStatus.Created);

      registry.register(graphId, compiledGraph);
      expect(registry.getStatus(graphId)).toBe(GraphStatus.Created);

      registry.setStatus(graphId, GraphStatus.Running);
      expect(registry.getStatus(graphId)).toBe(GraphStatus.Running);
    });
  });

  describe('getNode', () => {
    it('should return specific node from registered graph', () => {
      const graphId = 'test-graph-1';
      const compiledGraph = createMockCompiledGraph(3);

      registry.register(graphId, compiledGraph);

      const result = registry.getNode(graphId, 'node-2');
      expect(result).toEqual({
        id: 'node-2',
        type: NodeKind.Runtime,
        template: 'runtime',
        config: {},
        instance: { mockInstance: 'instance-2' },
        handle: expect.any(Object),
      });
    });

    it('should return undefined for non-existent graph', () => {
      const graphId = 'non-existent-graph';

      const result = registry.getNode(graphId, 'node-1');
      expect(result).toBeUndefined();
    });

    it('should return undefined for non-existent node in existing graph', () => {
      const graphId = 'test-graph-1';
      const compiledGraph = createMockCompiledGraph(2);

      registry.register(graphId, compiledGraph);

      const result = registry.getNode(graphId, 'non-existent-node');
      expect(result).toBeUndefined();
    });
  });

  describe('destroy', () => {
    it('should destroy registered graph and remove from registry', async () => {
      const graphId = 'test-graph-1';
      const compiledGraph = createMockCompiledGraph();
      const destroySpy = vi.spyOn(compiledGraph, 'destroy');

      registry.register(graphId, compiledGraph);

      await registry.destroy(graphId);

      expect(destroySpy).toHaveBeenCalledOnce();
      expect(registry.get(graphId)).toBeUndefined();
    });

    it('should handle destroying non-existent graph gracefully', async () => {
      const graphId = 'non-existent-graph';

      await expect(registry.destroy(graphId)).resolves.not.toThrow();
    });

    it('should remove graph from registry even if destroy fails', async () => {
      const graphId = 'test-graph-1';
      const compiledGraph = createMockCompiledGraph();
      const _destroySpy = vi
        .spyOn(compiledGraph, 'destroy')
        .mockRejectedValue(new Error('Destroy failed'));

      registry.register(graphId, compiledGraph);

      await expect(registry.destroy(graphId)).rejects.toThrow('Destroy failed');
      expect(registry.get(graphId)).toBeUndefined();
    });

    it('should handle multiple destroy calls on same graph', async () => {
      const graphId = 'test-graph-1';
      const compiledGraph = createMockCompiledGraph();
      const destroySpy = vi.spyOn(compiledGraph, 'destroy');

      registry.register(graphId, compiledGraph);

      await registry.destroy(graphId);
      await registry.destroy(graphId); // Second call should be no-op

      expect(destroySpy).toHaveBeenCalledOnce();
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle empty registry', () => {
      expect(registry.get('any-id')).toBeUndefined();
      expect(registry.getNode('any-id', 'any-node')).toBeUndefined();
    });

    it('should handle graph with no nodes', () => {
      const graphId = 'empty-graph';
      const emptyGraph: CompiledGraph = {
        metadata: {
          graphId: graphId,
          version: '1.0.0',
          graph_created_by: 'test-user',
          graph_project_id: 'test-project',
        },
        nodes: new Map(),
        edges: [],
        state: {
          getSnapshots: vi.fn().mockReturnValue([]),
          handleGraphDestroyed: vi.fn(),
        } as unknown as CompiledGraph['state'],
        status: GraphStatus.Created,
        destroy: vi.fn().mockResolvedValue(undefined),
      };

      registry.register(graphId, emptyGraph);

      expect(registry.getNode(graphId, 'any-node')).toBeUndefined();
    });

    it('should handle graph with single node', () => {
      const graphId = 'single-node-graph';
      const onlyInstance = { agent: 'test-agent' };
      const singleNodeGraph: CompiledGraph = {
        metadata: {
          graphId: graphId,
          version: '1.0.0',
          graph_created_by: 'test-user',
          graph_project_id: 'test-project',
        },
        nodes: new Map([
          [
            'only-node',
            {
              id: 'only-node',
              type: NodeKind.SimpleAgent,
              template: 'simple-agent',
              instance: onlyInstance,
              config: {},
              handle: {
                provide: async () => onlyInstance,
                configure: async () => {},
                destroy: async () => {},
              },
            },
          ],
        ]),
        edges: [],
        state: {
          getSnapshots: vi.fn().mockReturnValue([]),
          handleGraphDestroyed: vi.fn(),
        } as unknown as CompiledGraph['state'],
        status: GraphStatus.Running,
        destroy: vi.fn().mockResolvedValue(undefined),
      };

      registry.register(graphId, singleNodeGraph);

      const result = registry.getNode(graphId, 'only-node');
      expect(result).toEqual({
        id: 'only-node',
        type: NodeKind.SimpleAgent,
        template: 'simple-agent',
        config: {},
        instance: onlyInstance,
        handle: expect.any(Object),
      });
    });

    it('should handle concurrent operations', async () => {
      const graphId = 'concurrent-graph';
      const compiledGraph = createMockCompiledGraph();

      registry.register(graphId, compiledGraph);

      const operations = [
        registry.get(graphId),
        registry.getNode(graphId, 'node-1'),
        registry.getNode(graphId, 'node-2'),
      ];

      const results = await Promise.all(operations);

      expect(results[0]).toBe(compiledGraph);
      expect(results[1]).toBeDefined();
      expect(results[2]).toBeDefined();
    });
  });

  describe('integration scenarios', () => {
    it('should handle complete graph lifecycle', async () => {
      const graphId = 'lifecycle-graph';
      const compiledGraph = createMockCompiledGraph(3);
      const destroySpy = vi.spyOn(compiledGraph, 'destroy');

      registry.register(graphId, compiledGraph);
      expect(registry.get(graphId)).toBe(compiledGraph);

      // Access nodes
      const node1 = registry.getNode(graphId, 'node-1');
      const node2 = registry.getNode(graphId, 'node-2');
      const node3 = registry.getNode(graphId, 'node-3');

      expect(node1).toBeDefined();
      expect(node2).toBeDefined();
      expect(node3).toBeDefined();

      // Destroy
      await registry.destroy(graphId);
      expect(destroySpy).toHaveBeenCalledOnce();
      expect(registry.get(graphId)).toBeUndefined();
    });

    it('should handle multiple graphs independently', async () => {
      const graphId1 = 'graph-1';
      const graphId2 = 'graph-2';
      const compiledGraph1 = createMockCompiledGraph(2);
      const compiledGraph2 = createMockCompiledGraph(3);

      registry.register(graphId1, compiledGraph1);
      registry.register(graphId2, compiledGraph2);

      // Verify both exist
      expect(registry.get(graphId1)).toBe(compiledGraph1);
      expect(registry.get(graphId2)).toBe(compiledGraph2);

      // Destroy one
      await registry.destroy(graphId1);

      // Verify one is gone, other remains
      expect(registry.get(graphId1)).toBeUndefined();
      expect(registry.get(graphId2)).toBe(compiledGraph2);

      // Destroy the other
      await registry.destroy(graphId2);
      expect(registry.get(graphId2)).toBeUndefined();
    });

    it('should handle rapid register/unregister cycles', () => {
      const graphId = 'rapid-cycle-graph';
      const compiledGraph = createMockCompiledGraph();

      // Rapid cycles
      for (let i = 0; i < 10; i++) {
        registry.register(graphId, compiledGraph);
        expect(registry.get(graphId)).toBe(compiledGraph);
        registry.unregister(graphId);
        expect(registry.get(graphId)).toBeUndefined();
      }
    });
  });

  describe('type safety and node types', () => {
    it('should handle different node types correctly', () => {
      const graphId = 'mixed-types-graph';
      const runtimeInstance = { container: 'docker-container' };
      const toolInstance = { toolName: 'shell-tool' };
      const agentInstance = { agentName: 'test-agent' };
      const triggerInstance = { triggerType: 'manual' };
      const mixedGraph: CompiledGraph = {
        metadata: {
          graphId: 'mixed-types',
          version: '1.0.0',
          graph_created_by: 'test-user',
          graph_project_id: 'test-project',
        },
        nodes: new Map([
          [
            'runtime-node',
            {
              id: 'runtime-node',
              type: NodeKind.Runtime,
              template: 'runtime',
              instance: runtimeInstance,
              config: {},
              handle: {
                provide: async () => runtimeInstance,
                configure: async () => {},
                destroy: async () => {},
              },
            },
          ],
          [
            'tool-node',
            {
              id: 'tool-node',
              type: NodeKind.Tool,
              template: 'shell-tool',
              instance: toolInstance,
              config: {},
              handle: {
                provide: async () => toolInstance,
                configure: async () => {},
                destroy: async () => {},
              },
            },
          ],
          [
            'agent-node',
            {
              id: 'agent-node',
              type: NodeKind.SimpleAgent,
              template: 'simple-agent',
              instance: agentInstance,
              config: {},
              handle: {
                provide: async () => agentInstance,
                configure: async () => {},
                destroy: async () => {},
              },
            },
          ],
          [
            'trigger-node',
            {
              id: 'trigger-node',
              type: NodeKind.Trigger,
              template: 'manual-trigger',
              instance: triggerInstance,
              config: {},
              handle: {
                provide: async () => triggerInstance,
                configure: async () => {},
                destroy: async () => {},
              },
            },
          ],
        ]),
        edges: [],
        state: {
          getSnapshots: vi.fn().mockReturnValue([]),
          handleGraphDestroyed: vi.fn(),
        } as unknown as CompiledGraph['state'],
        status: GraphStatus.Running,
        destroy: vi.fn().mockResolvedValue(undefined),
      };

      registry.register(graphId, mixedGraph);

      // Verify each node type is accessible
      expect(registry.getNode(graphId, 'runtime-node')?.type).toBe(
        NodeKind.Runtime,
      );
      expect(registry.getNode(graphId, 'tool-node')?.type).toBe(NodeKind.Tool);
      expect(registry.getNode(graphId, 'agent-node')?.type).toBe(
        NodeKind.SimpleAgent,
      );
      expect(registry.getNode(graphId, 'trigger-node')?.type).toBe(
        NodeKind.Trigger,
      );
    });
  });

  describe('getNodes', () => {
    it('should return multiple nodes by their IDs using Set', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(5);

      registry.register(graphId, compiledGraph);

      const nodeIds = new Set(['node-1', 'node-3', 'node-5']);
      const result = registry.getNodes(graphId, nodeIds);

      expect(result.size).toBe(3);
      expect(result.has('node-1')).toBe(true);
      expect(result.has('node-3')).toBe(true);
      expect(result.has('node-5')).toBe(true);
      expect(result.get('node-1')?.id).toBe('node-1');
    });

    it('should return multiple nodes by their IDs using Array', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(5);

      registry.register(graphId, compiledGraph);

      const nodeIds = ['node-2', 'node-4'];
      const result = registry.getNodes(graphId, nodeIds);

      expect(result.size).toBe(2);
      expect(result.has('node-2')).toBe(true);
      expect(result.has('node-4')).toBe(true);
    });

    it('should return empty map for non-existent graph', () => {
      const result = registry.getNodes('non-existent-graph', ['node-1']);
      expect(result.size).toBe(0);
    });

    it('should skip non-existent nodes', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(3);

      registry.register(graphId, compiledGraph);

      const nodeIds = new Set(['node-1', 'non-existent', 'node-3']);
      const result = registry.getNodes(graphId, nodeIds);

      expect(result.size).toBe(2);
      expect(result.has('node-1')).toBe(true);
      expect(result.has('node-3')).toBe(true);
      expect(result.has('non-existent')).toBe(false);
    });

    it('should handle empty node IDs list', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(3);

      registry.register(graphId, compiledGraph);

      const result = registry.getNodes(graphId, []);
      expect(result.size).toBe(0);
    });
  });

  describe('filterNodesByType', () => {
    it('should filter nodes by type from Set of IDs', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(6);

      registry.register(graphId, compiledGraph);

      const nodeIds = new Set([
        'node-1',
        'node-2',
        'node-3',
        'node-4',
        'node-5',
      ]);
      const result = registry.filterNodesByType(
        graphId,
        nodeIds,
        NodeKind.Runtime,
      );

      // Even-numbered nodes are Runtime (see createMockCompiledGraph)
      expect(result).toEqual(['node-2', 'node-4']);
    });

    it('should filter nodes by type from Array of IDs', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(6);

      registry.register(graphId, compiledGraph);

      const nodeIds = ['node-1', 'node-2', 'node-3', 'node-4', 'node-5'];
      const result = registry.filterNodesByType(
        graphId,
        nodeIds,
        NodeKind.Tool,
      );

      // Odd-numbered nodes are Tool (see createMockCompiledGraph)
      expect(result).toEqual(['node-1', 'node-3', 'node-5']);
    });

    it('should return empty array for non-existent graph', () => {
      const result = registry.filterNodesByType(
        'non-existent-graph',
        ['node-1'],
        NodeKind.Tool,
      );
      expect(result).toEqual([]);
    });

    it('should return empty array when no nodes match type', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(3);

      registry.register(graphId, compiledGraph);

      const nodeIds = ['node-1', 'node-3']; // Both are Tool
      const result = registry.filterNodesByType(
        graphId,
        nodeIds,
        NodeKind.SimpleAgent,
      );

      expect(result).toEqual([]);
    });

    it('should skip non-existent nodes during filtering', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(4);

      registry.register(graphId, compiledGraph);

      const nodeIds = ['node-1', 'non-existent', 'node-2', 'node-4'];
      const result = registry.filterNodesByType(
        graphId,
        nodeIds,
        NodeKind.Runtime,
      );

      expect(result).toEqual(['node-2', 'node-4']);
    });
  });

  describe('filterNodesByTemplate', () => {
    it('should filter nodes by template from Set of IDs', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(6);

      registry.register(graphId, compiledGraph);

      const nodeIds = new Set([
        'node-1',
        'node-2',
        'node-3',
        'node-4',
        'node-5',
      ]);
      const result = registry.filterNodesByTemplate(
        graphId,
        nodeIds,
        'runtime',
      );

      expect(result).toEqual(['node-2', 'node-4']);
    });

    it('should filter nodes by template from Array of IDs', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(6);

      registry.register(graphId, compiledGraph);

      const nodeIds = ['node-1', 'node-2', 'node-3', 'node-4', 'node-5'];
      const result = registry.filterNodesByTemplate(
        graphId,
        nodeIds,
        'web-search-tool',
      );

      expect(result).toEqual(['node-1', 'node-3', 'node-5']);
    });

    it('should return empty array for non-existent graph', () => {
      const result = registry.filterNodesByTemplate(
        'non-existent-graph',
        ['node-1'],
        'web-search-tool',
      );
      expect(result).toEqual([]);
    });

    it('should return empty array when no nodes match template', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(3);

      registry.register(graphId, compiledGraph);

      const nodeIds = ['node-1', 'node-2', 'node-3'];
      const result = registry.filterNodesByTemplate(
        graphId,
        nodeIds,
        'non-existent-template',
      );

      expect(result).toEqual([]);
    });
  });

  describe('getNodesByType', () => {
    it('should return all nodes of a specific type', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(6);

      registry.register(graphId, compiledGraph);

      const result = registry.getNodesByType(graphId, NodeKind.Runtime);

      expect(result.length).toBe(3); // node-2, node-4, node-6
      expect(result.every((node) => node.type === NodeKind.Runtime)).toBe(true);
      expect(result.map((n) => n.id).sort()).toEqual([
        'node-2',
        'node-4',
        'node-6',
      ]);
    });

    it('should return all Tool nodes', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(5);

      registry.register(graphId, compiledGraph);

      const result = registry.getNodesByType(graphId, NodeKind.Tool);

      expect(result.length).toBe(3); // node-1, node-3, node-5
      expect(result.every((node) => node.type === NodeKind.Tool)).toBe(true);
    });

    it('should return empty array for non-existent graph', () => {
      const result = registry.getNodesByType(
        'non-existent-graph',
        NodeKind.Tool,
      );
      expect(result).toEqual([]);
    });

    it('should return empty array when no nodes match type', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(3);

      registry.register(graphId, compiledGraph);

      const result = registry.getNodesByType(graphId, NodeKind.Trigger);

      expect(result).toEqual([]);
    });

    it('should work with complex node types', () => {
      const graphId = 'complex-graph';
      const agent1Instance = { agent: 'agent-1' };
      const agent2Instance = { agent: 'agent-2' };
      const tool1Instance = { tool: 'tool-1' };
      const complexGraph: CompiledGraph = {
        metadata: {
          graphId: graphId,
          version: '1.0.0',
          graph_created_by: 'test-user',
          graph_project_id: 'test-project',
        },
        nodes: new Map([
          [
            'agent-1',
            {
              id: 'agent-1',
              type: NodeKind.SimpleAgent,
              template: 'simple-agent',
              instance: agent1Instance,
              config: {},
              handle: {
                provide: async () => agent1Instance,
                configure: async () => {},
                destroy: async () => {},
              },
            },
          ],
          [
            'agent-2',
            {
              id: 'agent-2',
              type: NodeKind.SimpleAgent,
              template: 'simple-agent',
              instance: agent2Instance,
              config: {},
              handle: {
                provide: async () => agent2Instance,
                configure: async () => {},
                destroy: async () => {},
              },
            },
          ],
          [
            'tool-1',
            {
              id: 'tool-1',
              type: NodeKind.Tool,
              template: 'shell-tool',
              instance: tool1Instance,
              config: {},
              handle: {
                provide: async () => tool1Instance,
                configure: async () => {},
                destroy: async () => {},
              },
            },
          ],
        ]),
        edges: [],
        state: {
          getSnapshots: vi.fn().mockReturnValue([]),
          handleGraphDestroyed: vi.fn(),
        } as unknown as CompiledGraph['state'],
        status: GraphStatus.Running,
        destroy: vi.fn().mockResolvedValue(undefined),
      };

      registry.register(graphId, complexGraph);

      const agents = registry.getNodesByType(graphId, NodeKind.SimpleAgent);
      expect(agents.length).toBe(2);
      expect(agents.map((n) => n.id).sort()).toEqual(['agent-1', 'agent-2']);
    });
  });

  describe('getAgentNodes / filterAgentNodeIds', () => {
    const buildAgentGraph = (): CompiledGraph => {
      const makeNode = (
        id: string,
        type: NodeKind,
        template: string,
      ): CompiledGraphNode => {
        const instance = { id };
        return {
          id,
          type,
          template,
          instance,
          config: {},
          handle: {
            provide: async () => instance,
            configure: async () => {},
            destroy: async () => {},
          },
        };
      };

      return {
        metadata: {
          graphId: 'agent-graph',
          version: '1.0.0',
          graph_created_by: 'test-user',
          graph_project_id: 'test-project',
        },
        nodes: new Map([
          [
            'agent-1',
            makeNode('agent-1', NodeKind.SimpleAgent, 'simple-agent'),
          ],
          [
            'agent-2',
            makeNode('agent-2', NodeKind.SimpleAgent, 'simple-agent'),
          ],
          // The discriminating member: helpers regressing to SimpleAgent-only
          // dispatch must fail on this node.
          [
            'claude-1',
            makeNode('claude-1', NodeKind.ClaudeAgent, 'claude-agent'),
          ],
          ['tool-1', makeNode('tool-1', NodeKind.Tool, 'shell-tool')],
          ['runtime-1', makeNode('runtime-1', NodeKind.Runtime, 'runtime')],
        ]),
        edges: [],
        state: {
          getSnapshots: vi.fn().mockReturnValue([]),
          handleGraphDestroyed: vi.fn(),
        } as unknown as CompiledGraph['state'],
        status: GraphStatus.Running,
        destroy: vi.fn().mockResolvedValue(undefined),
      };
    };

    it('getAgentNodes returns every node whose kind is in AGENT_NODE_KINDS', () => {
      registry.register('agent-graph', buildAgentGraph());

      const result = registry.getAgentNodes('agent-graph');

      expect(result.map((n) => n.id).sort()).toEqual([
        'agent-1',
        'agent-2',
        'claude-1',
      ]);
    });

    it('getAgentNodes returns empty array for non-existent graph', () => {
      expect(registry.getAgentNodes('missing')).toEqual([]);
    });

    it('filterAgentNodeIds keeps only agent node ids', () => {
      registry.register('agent-graph', buildAgentGraph());

      const result = registry.filterAgentNodeIds('agent-graph', [
        'agent-1',
        'tool-1',
        'claude-1',
        'runtime-1',
        'unknown-id',
        'agent-2',
      ]);

      expect(result).toEqual(['agent-1', 'claude-1', 'agent-2']);
    });

    it('filterAgentNodeIds accepts a Set and returns empty for missing graph', () => {
      registry.register('agent-graph', buildAgentGraph());

      expect(
        registry.filterAgentNodeIds('agent-graph', new Set(['agent-2'])),
      ).toEqual(['agent-2']);
      expect(registry.filterAgentNodeIds('missing', ['agent-1'])).toEqual([]);
    });
  });

  describe('getNodesByTemplate', () => {
    it('should return all nodes matching a template', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(6);

      registry.register(graphId, compiledGraph);

      const result = registry.getNodesByTemplate(graphId, 'runtime');

      expect(result.length).toBe(3); // node-2, node-4, node-6
      expect(result.every((node) => node.template === 'runtime')).toBe(true);
    });

    it('should return all web-search-tool nodes', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(5);

      registry.register(graphId, compiledGraph);

      const result = registry.getNodesByTemplate(graphId, 'web-search-tool');

      expect(result.length).toBe(3); // node-1, node-3, node-5
      expect(result.every((node) => node.template === 'web-search-tool')).toBe(
        true,
      );
    });

    it('should return empty array for non-existent graph', () => {
      const result = registry.getNodesByTemplate(
        'non-existent-graph',
        'web-search-tool',
      );
      expect(result).toEqual([]);
    });

    it('should return empty array when no nodes match template', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(3);

      registry.register(graphId, compiledGraph);

      const result = registry.getNodesByTemplate(
        graphId,
        'non-existent-template',
      );

      expect(result).toEqual([]);
    });

    it('should work with mixed templates', () => {
      const graphId = 'mixed-graph';
      const shell1Instance = { tool: 'shell-1' };
      const shell2Instance = { tool: 'shell-2' };
      const webSearchInstance = { tool: 'web-search-1' };
      const mixedGraph: CompiledGraph = {
        metadata: {
          graphId: graphId,
          version: '1.0.0',
          graph_created_by: 'test-user',
          graph_project_id: 'test-project',
        },
        nodes: new Map([
          [
            'shell-1',
            {
              id: 'shell-1',
              type: NodeKind.Tool,
              template: 'shell-tool',
              instance: shell1Instance,
              config: {},
              handle: {
                provide: async () => shell1Instance,
                configure: async () => {},
                destroy: async () => {},
              },
            },
          ],
          [
            'shell-2',
            {
              id: 'shell-2',
              type: NodeKind.Tool,
              template: 'shell-tool',
              instance: shell2Instance,
              config: {},
              handle: {
                provide: async () => shell2Instance,
                configure: async () => {},
                destroy: async () => {},
              },
            },
          ],
          [
            'web-search-1',
            {
              id: 'web-search-1',
              type: NodeKind.Tool,
              template: 'web-search-tool',
              instance: webSearchInstance,
              config: {},
              handle: {
                provide: async () => webSearchInstance,
                configure: async () => {},
                destroy: async () => {},
              },
            },
          ],
        ]),
        edges: [],
        state: {
          getSnapshots: vi.fn().mockReturnValue([]),
          handleGraphDestroyed: vi.fn(),
        } as unknown as CompiledGraph['state'],
        status: GraphStatus.Running,
        destroy: vi.fn().mockResolvedValue(undefined),
      };

      registry.register(graphId, mixedGraph);

      const shellTools = registry.getNodesByTemplate(graphId, 'shell-tool');
      expect(shellTools.length).toBe(2);
      expect(shellTools.map((n) => n.id).sort()).toEqual([
        'shell-1',
        'shell-2',
      ]);

      const webSearchTools = registry.getNodesByTemplate(
        graphId,
        'web-search-tool',
      );
      expect(webSearchTools.length).toBe(1);
      expect(webSearchTools[0]?.id).toBe('web-search-1');
    });
  });

  describe('addNode', () => {
    it('should add a node to an existing graph', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(2);

      registry.register(graphId, compiledGraph);

      const newNode = {
        id: 'new-node',
        type: NodeKind.Tool,
        template: 'test-tool',
        instance: {},
        handle: {
          provide: async () => ({}),
          configure: async () => {},
          destroy: async () => {},
        },
        config: {},
      } as CompiledGraphNode;

      registry.addNode(graphId, 'new-node', newNode);

      const retrievedNode = registry.getNode(graphId, 'new-node');
      expect(retrievedNode).toBe(newNode);
      expect(compiledGraph.nodes.size).toBe(3); // 2 original + 1 new
    });

    it('should throw error when adding node to non-existent graph', () => {
      const newNode = {
        id: 'new-node',
        type: NodeKind.Tool,
        template: 'test-tool',
        instance: {},
        handle: {
          provide: async () => ({}),
          configure: async () => {},
          destroy: async () => {},
        },
        config: {},
      } as CompiledGraphNode;

      expect(() =>
        registry.addNode('non-existent', 'new-node', newNode),
      ).toThrow(BadRequestException);
    });

    it('should overwrite existing node with same ID', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(2);

      registry.register(graphId, compiledGraph);

      const originalNode = registry.getNode(graphId, 'node-1');
      expect(originalNode).toBeDefined();

      const replacementNode = {
        id: 'node-1',
        type: NodeKind.Runtime,
        template: 'different-template',
        instance: {},
        handle: {
          provide: async () => ({}),
          configure: async () => {},
          destroy: async () => {},
        },
        config: {},
      } as CompiledGraphNode;

      registry.addNode(graphId, 'node-1', replacementNode);

      const retrievedNode = registry.getNode(graphId, 'node-1');
      expect(retrievedNode).toBe(replacementNode);
      expect(retrievedNode?.template).toBe('different-template');
      expect(compiledGraph.nodes.size).toBe(2); // Still 2 nodes
    });
  });

  describe('deleteNode', () => {
    it('should delete a node from an existing graph', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(3);

      registry.register(graphId, compiledGraph);

      expect(registry.getNode(graphId, 'node-2')).toBeDefined();

      registry.deleteNode(graphId, 'node-2');

      expect(registry.getNode(graphId, 'node-2')).toBeUndefined();
      expect(compiledGraph.nodes.size).toBe(2); // 3 - 1 = 2
    });

    it('should throw error when deleting node from non-existent graph', () => {
      expect(() => registry.deleteNode('non-existent', 'node-1')).toThrow(
        BadRequestException,
      );
    });

    it('should handle deleting non-existent node gracefully', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(3);

      registry.register(graphId, compiledGraph);

      // Deleting non-existent node should not throw
      expect(() =>
        registry.deleteNode(graphId, 'non-existent-node'),
      ).not.toThrow();
      expect(compiledGraph.nodes.size).toBe(3); // Still 3 nodes
    });

    it('should be able to delete all nodes from a graph', () => {
      const graphId = 'test-graph';
      const compiledGraph = createMockCompiledGraph(3);

      registry.register(graphId, compiledGraph);

      registry.deleteNode(graphId, 'node-1');
      registry.deleteNode(graphId, 'node-2');
      registry.deleteNode(graphId, 'node-3');

      expect(compiledGraph.nodes.size).toBe(0);
      expect(registry.getNode(graphId, 'node-1')).toBeUndefined();
      expect(registry.getNode(graphId, 'node-2')).toBeUndefined();
      expect(registry.getNode(graphId, 'node-3')).toBeUndefined();
    });
  });
});
