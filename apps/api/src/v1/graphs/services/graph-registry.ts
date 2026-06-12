import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import {
  AGENT_NODE_KINDS,
  CompiledGraph,
  CompiledGraphNode,
  GraphStatus,
} from '../graphs.types';

/**
 * GraphRegistry maintains a registry of all compiled and running graphs.
 * This allows us to:
 * - Track active graphs
 * - Access compiled graphs for management operations
 * - Stop specific nodes within a graph
 * - Destroy graphs and their resources
 */
@Injectable()
export class GraphRegistry {
  private readonly graphs = new Map<string, CompiledGraph>();
  private readonly compiling = new Map<string, Promise<CompiledGraph>>();

  async getOrCompile(
    graphId: string,
    factory: () => Promise<CompiledGraph>,
  ): Promise<CompiledGraph> {
    const inFlight = this.compiling.get(graphId);
    if (inFlight) {
      return inFlight;
    }

    const existing = this.graphs.get(graphId);
    if (existing) {
      if (existing.status === GraphStatus.Compiling) {
        throw new BadRequestException(
          'GRAPH_COMPILING',
          `Graph ${graphId} is currently compiling`,
        );
      }
      return existing;
    }

    const p = factory().finally(() => {
      this.compiling.delete(graphId);
    });

    this.compiling.set(graphId, p);

    return p;
  }

  /**
   * Registers a compiled graph in the registry
   */
  register(graphId: string, compiledGraph: CompiledGraph): void {
    if (this.graphs.has(graphId)) {
      throw new BadRequestException('GRAPH_ALREADY_REGISTERED');
    }

    this.graphs.set(graphId, compiledGraph);
  }

  /**
   * Unregisters a graph from the registry without destroying it
   */
  unregister(graphId: string): void {
    this.graphs.delete(graphId);
  }

  /**
   * Adds a node to an existing registered graph.
   * Useful during compilation to make nodes available incrementally.
   */
  addNode(graphId: string, nodeId: string, node: CompiledGraphNode): void {
    const graph = this.graphs.get(graphId);
    if (!graph) {
      throw new BadRequestException(
        'GRAPH_NOT_FOUND',
        `Cannot add node to graph ${graphId}: graph not registered.`,
      );
    }
    graph.nodes.set(nodeId, node);
  }

  /**
   * Removes a node from a registered graph.
   */
  deleteNode(graphId: string, nodeId: string): void {
    const graph = this.graphs.get(graphId);
    if (!graph) {
      throw new BadRequestException(
        'GRAPH_NOT_FOUND',
        `Cannot delete node from graph ${graphId}: graph not registered.`,
      );
    }
    graph.nodes.delete(nodeId);
  }

  /**
   * Retrieves a compiled graph by ID
   */
  get(graphId: string): CompiledGraph | undefined {
    return this.graphs.get(graphId);
  }

  setStatus(graphId: string, status: GraphStatus) {
    const g = this.graphs.get(graphId);

    if (g) {
      g.status = status;
    }
  }

  getStatus(graphId: string): GraphStatus | undefined {
    return this.graphs.get(graphId)?.status;
  }

  /**
   * Gets a specific node from a graph
   */
  getNode<TInstance>(
    graphId: string,
    nodeId: string,
  ): CompiledGraphNode<TInstance> | undefined {
    const graph = this.graphs.get(graphId);
    if (!graph) {
      return undefined;
    }

    return graph.nodes.get(nodeId) as CompiledGraphNode<TInstance> | undefined;
  }

  /**
   * Convenience helper: returns the runtime instance for a node (via NodeHandle).
   */
  getNodeInstance<TInstance>(
    graphId: string,
    nodeId: string,
  ): TInstance | undefined {
    const node = this.getNode<TInstance>(graphId, nodeId);
    return node?.instance;
  }

  /**
   * Gets multiple nodes from a graph by their IDs
   */
  getNodes<TInstance>(
    graphId: string,
    nodeIds: Set<string> | string[],
  ): Map<string, CompiledGraphNode<TInstance>> {
    const graph = this.graphs.get(graphId);
    const result = new Map<string, CompiledGraphNode<TInstance>>();

    if (!graph) {
      return result;
    }

    const nodeIdsArray = Array.isArray(nodeIds) ? nodeIds : Array.from(nodeIds);
    for (const nodeId of nodeIdsArray) {
      const node = graph.nodes.get(nodeId);
      if (node) {
        result.set(nodeId, node as CompiledGraphNode<TInstance>);
      }
    }

    return result;
  }

  /**
   * Filters node IDs by their type
   */
  filterNodesByType(
    graphId: string,
    nodeIds: Set<string> | string[],
    type: CompiledGraphNode['type'],
  ): string[] {
    const graph = this.graphs.get(graphId);
    if (!graph) {
      return [];
    }

    const nodeIdsArray = Array.isArray(nodeIds) ? nodeIds : Array.from(nodeIds);
    return nodeIdsArray.filter((nodeId) => {
      const node = graph.nodes.get(nodeId);
      return node?.type === type;
    });
  }

  /**
   * Filters node IDs by their template id
   */
  filterNodesByTemplate(
    graphId: string,
    nodeIds: Set<string> | string[],
    template: string,
  ): string[] {
    const graph = this.graphs.get(graphId);
    if (!graph) {
      return [];
    }

    const nodeIdsArray = Array.isArray(nodeIds) ? nodeIds : Array.from(nodeIds);
    return nodeIdsArray.filter((nodeId) => {
      const node = graph.nodes.get(nodeId);
      return node?.template === template;
    });
  }

  /**
   * Gets all nodes of a specific type from a graph
   */
  getNodesByType<TInstance>(
    graphId: string,
    type: CompiledGraphNode['type'],
  ): CompiledGraphNode<TInstance>[] {
    const graph = this.graphs.get(graphId);
    if (!graph) {
      return [];
    }

    return Array.from(graph.nodes.values()).filter(
      (node) => node.type === type,
    ) as CompiledGraphNode<TInstance>[];
  }

  /**
   * Gets all agent nodes (any kind in AGENT_NODE_KINDS) from a graph.
   * Instances implement the RunnableAgent surface.
   */
  getAgentNodes<TInstance>(graphId: string): CompiledGraphNode<TInstance>[] {
    const graph = this.graphs.get(graphId);
    if (!graph) {
      return [];
    }

    return Array.from(graph.nodes.values()).filter((node) =>
      AGENT_NODE_KINDS.has(node.type),
    ) as CompiledGraphNode<TInstance>[];
  }

  /**
   * Filters node IDs down to agent nodes (any kind in AGENT_NODE_KINDS).
   */
  filterAgentNodeIds(
    graphId: string,
    nodeIds: Set<string> | string[],
  ): string[] {
    const graph = this.graphs.get(graphId);
    if (!graph) {
      return [];
    }

    const nodeIdsArray = Array.isArray(nodeIds) ? nodeIds : Array.from(nodeIds);
    return nodeIdsArray.filter((nodeId) => {
      const node = graph.nodes.get(nodeId);
      return node !== undefined && AGENT_NODE_KINDS.has(node.type);
    });
  }

  /**
   * Gets all nodes matching a specific template from a graph
   */
  getNodesByTemplate<TInstance>(
    graphId: string,
    template: string,
  ): CompiledGraphNode<TInstance>[] {
    const graph = this.graphs.get(graphId);
    if (!graph) {
      return [];
    }

    return Array.from(graph.nodes.values()).filter(
      (node) => node.template === template,
    ) as CompiledGraphNode<TInstance>[];
  }

  /**
   * Destroys a graph and removes it from the registry
   */
  async destroy(graphId: string): Promise<void> {
    const graph = this.graphs.get(graphId);
    if (!graph) {
      return;
    }

    try {
      await graph.destroy();
    } finally {
      // Always remove from registry even if destroy fails
      this.graphs.delete(graphId);
    }
  }
}
