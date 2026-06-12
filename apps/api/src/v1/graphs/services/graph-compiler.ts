import { Injectable } from '@nestjs/common';
import { BadRequestException, DefaultLogger } from '@packages/common';
import { z } from 'zod';

import { TemplateRegistry } from '../../graph-templates/services/template-registry';
import { NodeConnection } from '../../graph-templates/templates/base-node.template';
import { LlmModelsService } from '../../litellm/services/llm-models.service';
import { ProjectsDao } from '../../projects/dao/projects.dao';
import { RuntimeThreadProvider } from '../../runtime/services/runtime-thread-provider';
import { SecretsService } from '../../secrets/services/secrets.service';
import { GraphEntity } from '../entity/graph.entity';
import {
  AGENT_NODE_KINDS,
  CompiledGraph,
  CompiledGraphNode,
  GraphEdgeSchemaType,
  GraphMetadataSchemaType,
  GraphNode,
  GraphNodeSchemaType,
  GraphSchemaType,
  GraphStatus,
  NodeKind,
} from '../graphs.types';
import { GraphRegistry } from './graph-registry';
import { GraphStateFactory } from './graph-state.factory';
import { GraphStateManager } from './graph-state.manager';

@Injectable()
export class GraphCompiler {
  constructor(
    private readonly templateRegistry: TemplateRegistry,
    private readonly logger: DefaultLogger,
    private readonly graphStateFactory: GraphStateFactory,
    private readonly graphRegistry: GraphRegistry,
    private readonly llmModelsService: LlmModelsService,
    private readonly projectsDao: ProjectsDao,
    private readonly secretsService: SecretsService,
  ) {}

  validateSchema(schema: GraphSchemaType): void {
    const ids = schema.nodes.map((n) => n.id);
    const uniqueIds = new Set(ids);
    if (ids.length !== uniqueIds.size) {
      throw new BadRequestException('GRAPH_DUPLICATE_NODE');
    }

    const nodeMap = new Map(schema.nodes.map((n) => [n.id, n]));
    const edges = schema.edges || [];

    for (const edge of edges) {
      const from = nodeMap.get(edge.from);
      const to = nodeMap.get(edge.to);
      if (!from) {
        throw new BadRequestException(
          'GRAPH_EDGE_NOT_FOUND',
          `Edge references non-existent source node: ${edge.from}`,
        );
      }
      if (!to) {
        throw new BadRequestException(
          'GRAPH_EDGE_NOT_FOUND',
          `Edge references non-existent target node: ${edge.to}`,
        );
      }

      this.validateTemplateConnection(from.template, to.template);
    }

    for (const node of schema.nodes) {
      if (!this.templateRegistry.hasTemplate(node.template)) {
        throw new BadRequestException(
          'TEMPLATE_NOT_REGISTERED',
          `Template '${node.template}' is not registered`,
        );
      }
      this.templateRegistry.validateTemplateConfig(node.template, node.config);
    }

    this.validateRequiredConnections(schema.nodes, edges);
  }

  private validateTemplateConnection(
    sourceTemplateName: string,
    targetTemplateName: string,
  ): void {
    const sourceTemplate =
      this.templateRegistry.getTemplate(sourceTemplateName);
    const targetTemplate =
      this.templateRegistry.getTemplate(targetTemplateName);

    if (!sourceTemplate || !targetTemplate) {
      return;
    }

    if (sourceTemplate.outputs) {
      if (sourceTemplate.outputs.length === 0) {
        throw new BadRequestException(
          'WRONG_EDGE_CONNECTION',
          `Template '${sourceTemplateName}' does not provide any connections (outputs is empty), but trying to connect to '${targetTemplateName}' (kind: ${targetTemplate.kind})`,
        );
      }

      const isAllowed = sourceTemplate.outputs.some((rule: NodeConnection) => {
        if (rule.type === 'template') {
          return rule.value === targetTemplateName;
        }
        if (rule.type === 'kind') {
          return rule.value === targetTemplate.kind;
        }
        return false;
      });

      if (!isAllowed) {
        const rulesHuman = sourceTemplate.outputs
          .map((r: NodeConnection) => `${r.type}:${r.value}`)
          .join(', ');
        throw new BadRequestException(
          'WRONG_EDGE_CONNECTION',
          `Template '${sourceTemplateName}' only provides to [${rulesHuman}], but trying to connect to '${targetTemplateName}' (kind: ${targetTemplate.kind})`,
        );
      }
    }

    if (targetTemplate.inputs) {
      if (targetTemplate.inputs.length === 0) {
        throw new BadRequestException(
          'WRONG_EDGE_CONNECTION',
          `Template '${targetTemplateName}' does not accept any connections (inputs is empty), but got '${sourceTemplateName}' (kind: ${sourceTemplate.kind})`,
        );
      }

      const isAllowed = targetTemplate.inputs.some((rule: NodeConnection) => {
        if (rule.type === 'template') {
          return rule.value === sourceTemplateName;
        }
        if (rule.type === 'kind') {
          return rule.value === sourceTemplate.kind;
        }
        return false;
      });

      if (!isAllowed) {
        const rulesHuman = targetTemplate.inputs
          .map((r: NodeConnection) => `${r.type}:${r.value}`)
          .join(', ');
        throw new BadRequestException(
          'WRONG_EDGE_CONNECTION',
          `Template '${targetTemplateName}' only accepts from [${rulesHuman}], but got '${sourceTemplateName}' (kind: ${sourceTemplate.kind})`,
        );
      }
    }
  }

  private validateRequiredConnections(
    nodes: GraphNodeSchemaType[],
    edges: GraphEdgeSchemaType[],
  ): void {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    const describeRule = (rule: NodeConnection): string =>
      rule.type === 'template'
        ? `template '${rule.value}'`
        : `kind '${rule.value}'`;

    const ruleSatisfied = (nodeId: string, rule: NodeConnection): boolean =>
      edges.some((edge) => {
        if (edge.from !== nodeId) {
          return false;
        }

        const targetNode = nodeMap.get(edge.to);
        if (!targetNode) {
          return false;
        }

        const targetTemplate = this.templateRegistry.getTemplate(
          targetNode.template,
        );
        if (!targetTemplate) {
          return false;
        }

        if (rule.type === 'template') {
          return rule.value === targetNode.template;
        }
        if (rule.type === 'kind') {
          return rule.value === targetTemplate.kind;
        }
        return false;
      });

    for (const node of nodes) {
      const template = this.templateRegistry.getTemplate(node.template);
      if (!template?.outputs) {
        continue;
      }

      const requiredRules = template.outputs.filter(
        (rule: NodeConnection) => rule.required === true,
      );

      for (const rule of requiredRules) {
        if (!ruleSatisfied(node.id, rule)) {
          throw new BadRequestException(
            'MISSING_REQUIRED_CONNECTION',
            `Template '${node.template}' requires at least one connection to ${describeRule(rule)}, but none found`,
          );
        }
      }

      // `requiredGroup` rules are OR-validated: at least one rule per group
      // must be satisfied (e.g. a trigger must connect to an agent of EITHER
      // kind), which per-rule `required` cannot express.
      const ruleGroups = new Map<string, NodeConnection[]>();
      for (const rule of template.outputs as readonly NodeConnection[]) {
        if (rule.requiredGroup) {
          const group = ruleGroups.get(rule.requiredGroup) ?? [];
          group.push(rule);
          ruleGroups.set(rule.requiredGroup, group);
        }
      }

      for (const [groupName, groupRules] of ruleGroups) {
        if (!groupRules.some((rule) => ruleSatisfied(node.id, rule))) {
          const options = groupRules.map(describeRule).join(' or ');
          throw new BadRequestException(
            'MISSING_REQUIRED_CONNECTION',
            `Template '${node.template}' requires at least one connection to ${options} ('${groupName}' group), but none found`,
          );
        }
      }
    }
  }

  async compile(
    entity: GraphEntity,
    additionalMetadata?: Partial<GraphMetadataSchemaType>,
  ): Promise<CompiledGraph> {
    const schema = entity.schema;

    // Build LLMRequestContext once at compile time so all nodes/tools share it
    const project = await this.projectsDao.getOne({
      id: entity.projectId,
      createdBy: entity.createdBy,
    });
    const llmRequestContext =
      await this.llmModelsService.buildLLMRequestContext(
        entity.createdBy,
        project?.settings,
      );

    const metadata: GraphMetadataSchemaType = {
      name: entity.name,
      version: entity.version,
      graphId: entity.id,
      temporary: entity.temporary,
      graph_created_by: entity.createdBy,
      graph_project_id: entity.projectId,
      llmRequestContext,
      ...(additionalMetadata || {}),
    };

    const graphId = metadata.graphId || 'unknown';

    return this.graphRegistry.getOrCompile(graphId, async () => {
      this.validateSchema(schema);

      const compiledNodes = new Map<string, CompiledGraphNode>();
      const stateManager = await this.graphStateFactory.create(graphId);
      const edges = schema.edges || [];

      const compiledGraph: CompiledGraph = {
        metadata,
        nodes: compiledNodes,
        edges,
        state: stateManager,
        destroy: async () => {
          await this.destroyGraph(compiledNodes);
          stateManager.destroy();
        },
        status: GraphStatus.Compiling,
      };

      this.graphRegistry.register(graphId, compiledGraph);

      try {
        const buildOrder = this.getBuildOrder(schema);

        for (const node of buildOrder) {
          const compiledNode = await this.compileNode(
            node,
            compiledNodes,
            metadata,
            edges,
            stateManager,
          );
          compiledNodes.set(node.id, compiledNode);
          stateManager.attachGraphNode(node.id, compiledNode);
        }

        // Resolve secrets and inject into runtime env vars as a post-compile step.
        // This runs after all nodes are compiled so tool configure() calls have already
        // registered their jobs on RuntimeThreadProvider instances.
        // Collect all secret names across all nodes in a single pre-pass, then
        // batch-fetch from DB + vault to avoid N+1 sequential HTTP calls.
        const secretNamesByNode = new Map<string, string[]>();
        const allSecretNames = new Set<string>();
        for (const node of buildOrder) {
          const names = this.collectSecretNames(node);
          if (names.length > 0) {
            secretNamesByNode.set(node.id, names);
            for (const name of names) {
              allSecretNames.add(name);
            }
          }
        }

        const resolvedSecrets =
          allSecretNames.size > 0
            ? await this.secretsService.batchResolveSecretValues(
                metadata.graph_project_id,
                Array.from(allSecretNames),
              )
            : new Map<string, string>();

        for (const node of buildOrder) {
          const names = secretNamesByNode.get(node.id);
          if (!names || names.length === 0) {
            continue;
          }

          const secretEnv: Record<string, string> = {};
          for (const name of names) {
            const value = resolvedSecrets.get(name);
            if (value !== undefined) {
              secretEnv[name] = value;
            }
          }

          if (Object.keys(secretEnv).length === 0) {
            continue;
          }

          // If the node itself is a runtime, inject directly without looking at edges.
          const compiledNode = compiledNodes.get(node.id);
          if (
            compiledNode?.type === NodeKind.Runtime &&
            compiledNode.instance instanceof RuntimeThreadProvider
          ) {
            compiledNode.instance.addEnvVariables(secretEnv);
            continue;
          }

          // Otherwise, find the connected runtime via outgoing edges.
          const runtimeNodeId = this.findConnectedRuntimeNode(
            node.id,
            edges,
            compiledNodes,
          );
          if (runtimeNodeId) {
            const runtimeNode = compiledNodes.get(runtimeNodeId);
            if (runtimeNode?.instance instanceof RuntimeThreadProvider) {
              runtimeNode.instance.addEnvVariables(secretEnv);
            }
          }
        }

        this.graphRegistry.setStatus(graphId, GraphStatus.Running);

        return compiledGraph;
      } catch (error) {
        this.graphRegistry.unregister(graphId);
        throw error;
      }
    });
  }

  /** Collect all secret names referenced by a node's config fields. */
  private collectSecretNames(node: GraphNodeSchemaType): string[] {
    const template = this.templateRegistry.getTemplate(node.template);
    if (!template?.schema) {
      return [];
    }

    const names: string[] = [];
    const schema = template.schema;

    if (schema instanceof z.ZodObject) {
      const shape = schema.shape as Record<string, z.ZodTypeAny>;
      for (const [key, fieldSchema] of Object.entries(shape)) {
        const meta = fieldSchema.meta?.() as
          | Record<string, unknown>
          | undefined;
        if (meta && meta['x-ui:secret-select'] === true) {
          const secretName = node.config?.[key as keyof typeof node.config];
          if (secretName && typeof secretName === 'string') {
            names.push(secretName);
          }
        }
        if (meta && meta['x-ui:secret-multi-select'] === true) {
          const secretNames = node.config?.[key as keyof typeof node.config];
          if (Array.isArray(secretNames)) {
            names.push(
              ...secretNames.filter(
                (n): n is string => typeof n === 'string' && n.length > 0,
              ),
            );
          }
        }
      }
    }

    return names;
  }

  private findConnectedRuntimeNode(
    nodeId: string,
    edges: GraphEdgeSchemaType[],
    compiledNodes: Map<string, CompiledGraphNode>,
  ): string | undefined {
    for (const edge of edges) {
      if (edge.from === nodeId) {
        const target = compiledNodes.get(edge.to);
        if (target?.type === NodeKind.Runtime) {
          return edge.to;
        }
      }
    }
    return undefined;
  }

  async destroyNode(node: CompiledGraphNode): Promise<void> {
    try {
      await node.handle.destroy(node.instance);
    } catch (error) {
      this.logger.error(error as Error, `Failed to destroy node ${node.id}`);
      throw error;
    }
  }

  private async destroyGraph(
    nodes: Map<string, CompiledGraphNode>,
  ): Promise<void> {
    // Group nodes by type for ordered destruction
    const triggerNodes: CompiledGraphNode[] = [];
    const agentNodes: CompiledGraphNode[] = [];
    const mcpNodes: CompiledGraphNode[] = [];
    const runtimeNodes: CompiledGraphNode[] = [];

    for (const node of nodes.values()) {
      if (node.type === NodeKind.Trigger) {
        triggerNodes.push(node);
      } else if (AGENT_NODE_KINDS.has(node.type)) {
        agentNodes.push(node);
      } else if (node.type === NodeKind.Mcp) {
        mcpNodes.push(node);
      } else if (node.type === NodeKind.Runtime) {
        runtimeNodes.push(node);
      }
    }

    // Destroy triggers first (they might be actively processing)
    await Promise.all(triggerNodes.map((node) => this.destroyNode(node)));

    // Then destroy agents (they might have active streams)
    await Promise.all(agentNodes.map((node) => this.destroyNode(node)));

    // Then destroy MCP services (agents might be using them)
    await Promise.all(mcpNodes.map((node) => this.destroyNode(node)));

    // Finally destroy runtimes (they might have containers running)
    await Promise.all(runtimeNodes.map((node) => this.destroyNode(node)));
  }

  private async compileNode(
    node: GraphNodeSchemaType,
    compiledNodes: Map<string, CompiledGraphNode>,
    metadata: GraphMetadataSchemaType,
    edges: GraphEdgeSchemaType[],
    stateManager: GraphStateManager,
  ): Promise<CompiledGraphNode> {
    const { template, validatedConfig, init } = this.prepareNode(
      node,
      compiledNodes,
      metadata,
      edges,
    );

    stateManager.registerNode(node.id);

    const { handle, instance } = await this.createAndConfigureHandle(
      template,
      validatedConfig,
      init,
    );

    return {
      id: node.id,
      type: template.kind,
      template: node.template,
      handle,
      instance,
      config: validatedConfig,
    } satisfies CompiledGraphNode;
  }

  public prepareNode(
    node: GraphNodeSchemaType,
    compiledNodes: Map<string, CompiledGraphNode>,
    metadata: GraphMetadataSchemaType,
    edges: GraphEdgeSchemaType[],
  ): {
    template: NonNullable<ReturnType<TemplateRegistry['getTemplate']>>;
    validatedConfig: unknown;
    init: GraphNode<unknown>;
  } {
    const validatedConfig = this.templateRegistry.validateTemplateConfig(
      node.template,
      node.config,
    );

    const template = this.templateRegistry.getTemplate(node.template);
    if (!template) {
      throw new BadRequestException(
        'GRAPH_TEMPLATE_NOT_FOUND',
        `Template '${node.template}' not found`,
      );
    }

    const { inputNodeIds, outputNodeIds } = this.computeNodeConnections(
      node.id,
      compiledNodes,
      edges,
    );

    const init: GraphNode<unknown> = {
      config: validatedConfig,
      inputNodeIds,
      outputNodeIds,
      metadata: {
        ...metadata,
        nodeId: node.id,
      },
    };

    return { template, validatedConfig, init };
  }

  public async createAndConfigureHandle(
    template: NonNullable<ReturnType<TemplateRegistry['getTemplate']>>,
    validatedConfig: unknown,
    init: GraphNode<unknown>,
  ): Promise<{
    handle: Awaited<ReturnType<typeof template.create>>;
    instance: unknown;
  }> {
    const handle = await template.create();
    const instance = await handle.provide(init);
    await handle.configure(init, instance);
    return { handle, instance };
  }

  private computeNodeConnections(
    nodeId: string,
    compiledNodes: Map<string, CompiledGraphNode>,
    edges: GraphEdgeSchemaType[],
  ): { inputNodeIds: Set<string>; outputNodeIds: Set<string> } {
    const inputNodeIds = new Set<string>();
    const outputNodeIds = new Set<string>();

    for (const edge of edges) {
      if (edge.to === nodeId && compiledNodes.has(edge.from)) {
        inputNodeIds.add(edge.from);
      } else if (edge.from === nodeId && compiledNodes.has(edge.to)) {
        outputNodeIds.add(edge.to);
      }
    }

    return { inputNodeIds, outputNodeIds };
  }

  public getBuildOrder(schema: GraphSchemaType): GraphNodeSchemaType[] {
    const edges = schema.edges || [];

    const nodeMap = new Map(schema.nodes.map((n) => [n.id, n]));
    const outgoingEdgeCount = new Map<string, number>();
    const incomingEdges = new Map<string, Set<string>>();

    for (const node of schema.nodes) {
      outgoingEdgeCount.set(node.id, 0);
      incomingEdges.set(node.id, new Set());
    }

    // Edge semantics: edge.from depends on edge.to
    // So we count outgoing edges (dependencies) and track incoming edges (dependents)
    for (const edge of edges) {
      outgoingEdgeCount.set(
        edge.from,
        (outgoingEdgeCount.get(edge.from) || 0) + 1,
      );
      incomingEdges.get(edge.to)!.add(edge.from);
    }

    const queue: GraphNodeSchemaType[] = [];
    for (const node of schema.nodes) {
      if (outgoingEdgeCount.get(node.id) === 0) {
        queue.push(node);
      }
    }

    const buildOrder: GraphNodeSchemaType[] = [];
    let queueHead = 0;

    while (queueHead < queue.length) {
      const currentNode = queue[queueHead++]!;
      buildOrder.push(currentNode);

      const dependents = incomingEdges.get(currentNode.id)!;
      for (const dependentId of dependents) {
        const newCount = outgoingEdgeCount.get(dependentId)! - 1;
        outgoingEdgeCount.set(dependentId, newCount);

        if (newCount === 0) {
          const dependentNode = nodeMap.get(dependentId);
          if (dependentNode) {
            queue.push(dependentNode);
          }
        }
      }
    }

    if (buildOrder.length !== schema.nodes.length) {
      const processedIds = new Set(buildOrder.map((n) => n.id));
      const cycleNodes = schema.nodes
        .filter((n) => !processedIds.has(n.id))
        .map((n) => n.id);

      throw new BadRequestException(
        'GRAPH_CIRCULAR_DEPENDENCY',
        `Graph contains circular dependencies involving nodes: ${cycleNodes.join(', ')}`,
      );
    }

    return buildOrder;
  }
}
