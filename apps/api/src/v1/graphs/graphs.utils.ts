import { isObject } from 'lodash';
import { parse as parseYaml } from 'yaml';

import { TemplateRegistry } from '../graph-templates/services/template-registry';
import type { TriggerNodeInfoType } from './dto/graphs.dto';
import {
  AGENT_NODE_KINDS,
  type GraphAgentInfo,
  type GraphSchemaType,
  NodeKind,
} from './graphs.types';

export const parseStructuredContent = (input: unknown): unknown => {
  if (typeof input === 'string') {
    const jsonParsed = parseJsonContent(input);
    if (jsonParsed !== undefined) {
      return jsonParsed;
    }
    const yamlParsed = parseYamlContent(input);
    if (yamlParsed !== undefined) {
      return yamlParsed;
    }
    return input;
  }
  if (Array.isArray(input)) {
    return input;
  }
  if (isObject(input)) {
    return input as Record<string, unknown>;
  }
  return input;
};

const parseJsonContent = (input: string): unknown | undefined => {
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed;
  } catch {
    return undefined;
  }
};

const parseYamlContent = (input: string): unknown | undefined => {
  try {
    const parsed = parseYaml(input) as unknown;
    return parsed;
  } catch {
    return undefined;
  }
};

export function extractAgentsFromSchema(
  schema: GraphSchemaType,
  templateRegistry: TemplateRegistry,
): GraphAgentInfo[] {
  const agents: GraphAgentInfo[] = [];
  for (const node of schema.nodes) {
    const template = templateRegistry.getTemplate(node.template);
    if (template && AGENT_NODE_KINDS.has(template.kind)) {
      const name =
        typeof node.config.name === 'string' ? node.config.name : undefined;
      const description =
        typeof node.config.description === 'string'
          ? node.config.description
          : undefined;
      agents.push({
        nodeId: node.id,
        name: name ?? node.template,
        description: description || undefined,
      });
    }
  }
  return agents;
}

export function extractTriggerNodesFromSchema(
  schema: GraphSchemaType,
  metadata: Record<string, unknown> | null | undefined,
  templateRegistry: TemplateRegistry,
): TriggerNodeInfoType[] {
  const triggerTemplates = templateRegistry.getTemplatesByKind(
    NodeKind.Trigger,
  );
  const triggerTemplateIds = new Set(triggerTemplates.map((t) => t.id));

  const metadataNodes = extractMetadataNodes(metadata);

  const triggerNodes: TriggerNodeInfoType[] = [];
  for (const node of schema.nodes) {
    if (!triggerTemplateIds.has(node.template)) {
      continue;
    }

    const metaNode = metadataNodes.get(node.id);
    const template = templateRegistry.getTemplate(node.template);
    const displayName = metaNode?.name || template?.name || node.template;

    triggerNodes.push({
      id: node.id,
      name: displayName,
      template: node.template,
    });
  }
  return triggerNodes;
}

export function extractNodeDisplayNamesFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  const metadataNodes = extractMetadataNodes(metadata);
  for (const [nodeId, node] of metadataNodes) {
    if (node.name) {
      result[nodeId] = node.name;
    }
  }
  return result;
}

function extractMetadataNodes(
  metadata: Record<string, unknown> | null | undefined,
): Map<string, { name?: string }> {
  const result = new Map<string, { name?: string }>();
  if (!metadata || !Array.isArray(metadata.nodes)) {
    return result;
  }

  for (const node of metadata.nodes) {
    if (
      !isObject(node) ||
      typeof (node as Record<string, unknown>).id !== 'string'
    ) {
      continue;
    }
    const nodeObj = node as Record<string, unknown>;
    const id = nodeObj.id as string;
    const rawName =
      typeof nodeObj.name === 'string' ? nodeObj.name.trim() : undefined;
    result.set(id, { name: rawName || undefined });
  }
  return result;
}
