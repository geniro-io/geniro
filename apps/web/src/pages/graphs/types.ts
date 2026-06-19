import type { Edge, Node } from '@xyflow/react';
import type {
  JSONSchema7,
  JSONSchema7Definition,
  JSONSchema7TypeName,
} from 'json-schema';

export interface GraphNodeData {
  label: string;
  template: string;
  templateKind?: string;
  templateSchema?: TemplateSchema;
  config: Record<string, unknown>;
}

export type GraphNode = Node;
export type GraphEdge = Edge;

export interface GraphState {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface NodeMetadata {
  id: string;
  x: number;
  y: number;
  name?: string;
}

export interface GraphMetadata {
  nodes?: NodeMetadata[];
  zoom?: number;
  x?: number;
  y?: number;
}

type UiSchemaExtensions = {
  'x-ui:show-on-node'?: boolean;
  'x-ui:label'?: string;
  'x-ui:textarea'?: boolean;
  'x-ui:ai-suggestions'?: boolean;
  'x-ui:litellm-models-list-select'?: boolean;
  'x-ui:github-repos-select'?: boolean;
  'x-ui:secret-select'?: boolean;
  // Host-only secret marker (e.g. Claude Agent BYO key): rendered with the same
  // secret picker, but never collected into the generic sandbox secretEnv path
  // by the backend graph compiler.
  'x-ui:secret-select-host'?: boolean;
  'x-ui:secret-multi-select'?: boolean;
  // Per-MCP-node OAuth "Authenticate" widget marker (UI-only — the backend
  // graph compiler's collectSecretNames ignores it). Carries the provider.
  'x-ui:oauth-authenticate'?: { provider: string };
  'x-ui:readonly'?: boolean;
};

type NonBooleanSchema = Exclude<JSONSchema7Definition, boolean>;

export type SchemaTypeName = JSONSchema7TypeName;
export type SchemaProperty = NonBooleanSchema & UiSchemaExtensions;

export type TemplateSchema = JSONSchema7 & {
  properties: Record<string, SchemaProperty>;
  definitions?: Record<string, NonBooleanSchema>;
};
