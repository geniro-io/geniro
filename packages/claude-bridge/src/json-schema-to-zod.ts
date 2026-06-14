/**
 * Minimal JSON Schema (draft-07 subset) → Zod conversion for forwarded Geniro
 * tool schemas. The SDK's in-process MCP server accepts only Zod raw shapes —
 * a non-Zod `inputSchema` is silently advertised to the model as an empty
 * object schema, destroying argument fidelity. Host-side schemas arrive as
 * JSON (they cross the stdio protocol), so the bridge rebuilds Zod here.
 *
 * Fidelity is best-effort by design: any construct outside the supported
 * subset degrades to `z.unknown()` for that field — never a throw — because
 * the authoritative validation happens host-side when the real tool runs.
 */
import { z } from 'zod';

type JsonSchemaNode = Record<string, unknown>;

function isObject(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withDescription(type: z.ZodType, node: JsonSchemaNode): z.ZodType {
  return typeof node.description === 'string'
    ? type.describe(node.description)
    : type;
}

function enumToZod(values: unknown[]): z.ZodType {
  const strings = values.filter((value) => typeof value === 'string');
  if (strings.length === values.length && strings.length > 0) {
    return z.enum(strings as [string, ...string[]]);
  }
  const isLiteral = (
    value: unknown,
  ): value is string | number | boolean | null =>
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean';
  // A non-literal member (object/array enum value) cannot be expressed as a
  // Zod literal. Dropping it would NARROW the schema and reject legal calls
  // before they reach the host — degrade the whole enum instead.
  if (!values.every(isLiteral)) {
    return z.unknown();
  }
  const literals: z.ZodType[] = values.map((value) => z.literal(value));
  if (literals.length === 0) {
    return z.unknown();
  }
  if (literals.length === 1) {
    return literals[0]!;
  }
  return z.union(literals);
}

function typeNameToZod(typeName: string, node: JsonSchemaNode): z.ZodType {
  switch (typeName) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array':
      return z.array(jsonSchemaNodeToZod(node.items));
    case 'object': {
      // Loose: a field the converter did not understand must never cause the
      // MCP layer to strip caller-provided keys before they reach the host.
      return z.looseObject(jsonSchemaToZodShape(node));
    }
    default:
      return z.unknown();
  }
}

export function jsonSchemaNodeToZod(node: unknown): z.ZodType {
  if (!isObject(node)) {
    return z.unknown();
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return withDescription(enumToZod(node.enum), node);
  }
  if (node.const !== undefined) {
    return withDescription(enumToZod([node.const]), node);
  }
  const variants = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : null;
  if (variants && variants.length > 0) {
    const members: z.ZodType[] = variants.map(jsonSchemaNodeToZod);
    const union = members.length === 1 ? members[0]! : z.union(members);
    return withDescription(union, node);
  }
  if (Array.isArray(node.type)) {
    const names = node.type.filter(
      (name): name is string => typeof name === 'string',
    );
    const members: z.ZodType[] = names.map((name) => typeNameToZod(name, node));
    if (members.length === 0) {
      return withDescription(z.unknown(), node);
    }
    const union = members.length === 1 ? members[0]! : z.union(members);
    return withDescription(union, node);
  }
  if (typeof node.type === 'string') {
    return withDescription(typeNameToZod(node.type, node), node);
  }
  return withDescription(z.unknown(), node);
}

/**
 * Convert a JSON Schema object node into the Zod RAW SHAPE the SDK's `tool()`
 * helper expects (`Record<field, ZodType>`), honoring `required`. A non-object
 * or property-less schema yields an empty shape.
 */
export function jsonSchemaToZodShape(
  schema: unknown,
): Record<string, z.ZodType> {
  if (!isObject(schema) || !isObject(schema.properties)) {
    return {};
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : [],
  );
  const shape: Record<string, z.ZodType> = {};
  for (const [key, propertyNode] of Object.entries(schema.properties)) {
    const fieldType = jsonSchemaNodeToZod(propertyNode);
    shape[key] = required.has(key) ? fieldType : fieldType.optional();
  }
  return shape;
}
