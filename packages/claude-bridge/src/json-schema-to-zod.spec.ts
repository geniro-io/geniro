import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  jsonSchemaNodeToZod,
  jsonSchemaToZodShape,
} from './json-schema-to-zod';

describe('jsonSchemaToZodShape', () => {
  it('converts a flat object schema honoring required vs optional', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'integer' },
      },
      required: ['query'],
    });

    const parsed = z.object(shape).safeParse({ query: 'threads' });
    expect(parsed.success).toBe(true);

    const missingRequired = z.object(shape).safeParse({ limit: 3 });
    expect(missingRequired.success).toBe(false);

    const wrongType = z.object(shape).safeParse({ query: 'x', limit: 1.5 });
    expect(wrongType.success).toBe(false);

    const intOk = z.object(shape).safeParse({ query: 'x', limit: 3 });
    expect(intOk.success).toBe(true);
  });

  it('preserves field descriptions for the advertised schema', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query' },
      },
      required: ['query'],
    });

    expect(shape.query?.description).toBe('Natural-language query');
  });

  it('returns an empty shape for non-object or property-less schemas', () => {
    expect(jsonSchemaToZodShape(undefined)).toEqual({});
    expect(jsonSchemaToZodShape('garbage')).toEqual({});
    expect(jsonSchemaToZodShape({ type: 'object' })).toEqual({});
    expect(jsonSchemaToZodShape({ type: 'string' })).toEqual({});
  });
});

describe('jsonSchemaNodeToZod', () => {
  it('maps primitive types', () => {
    expect(jsonSchemaNodeToZod({ type: 'string' }).safeParse('a').success).toBe(
      true,
    );
    expect(jsonSchemaNodeToZod({ type: 'number' }).safeParse(1.5).success).toBe(
      true,
    );
    expect(
      jsonSchemaNodeToZod({ type: 'boolean' }).safeParse(true).success,
    ).toBe(true);
    expect(jsonSchemaNodeToZod({ type: 'null' }).safeParse(null).success).toBe(
      true,
    );
    expect(jsonSchemaNodeToZod({ type: 'string' }).safeParse(7).success).toBe(
      false,
    );
  });

  it('maps string enums to z.enum', () => {
    const schema = jsonSchemaNodeToZod({ enum: ['a', 'b'] });
    expect(schema.safeParse('a').success).toBe(true);
    expect(schema.safeParse('c').success).toBe(false);
  });

  it('maps mixed-literal enums and const values', () => {
    const mixed = jsonSchemaNodeToZod({ enum: ['a', 1, null] });
    expect(mixed.safeParse(1).success).toBe(true);
    expect(mixed.safeParse(null).success).toBe(true);
    expect(mixed.safeParse('b').success).toBe(false);

    const constant = jsonSchemaNodeToZod({ const: 'fixed' });
    expect(constant.safeParse('fixed').success).toBe(true);
    expect(constant.safeParse('other').success).toBe(false);
  });

  it('maps arrays with typed items', () => {
    const schema = jsonSchemaNodeToZod({
      type: 'array',
      items: { type: 'string' },
    });
    expect(schema.safeParse(['a', 'b']).success).toBe(true);
    expect(schema.safeParse([1]).success).toBe(false);
  });

  it('keeps unknown keys on nested objects (loose objects, never strip)', () => {
    const schema = jsonSchemaNodeToZod({
      type: 'object',
      properties: { known: { type: 'string' } },
      required: ['known'],
    });
    const parsed = schema.safeParse({ known: 'x', extra: 42 });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ known: 'x', extra: 42 });
  });

  it('maps anyOf/oneOf to unions', () => {
    const schema = jsonSchemaNodeToZod({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(schema.safeParse('a').success).toBe(true);
    expect(schema.safeParse(2).success).toBe(true);
    expect(schema.safeParse(true).success).toBe(false);
  });

  it('maps nullable type arrays to unions', () => {
    const schema = jsonSchemaNodeToZod({ type: ['string', 'null'] });
    expect(schema.safeParse('a').success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(3).success).toBe(false);
  });

  it('degrades unsupported constructs to accept-anything instead of throwing', () => {
    const unsupported = jsonSchemaNodeToZod({ type: 'frobnicate' });
    expect(unsupported.safeParse({ any: 'thing' }).success).toBe(true);
    expect(jsonSchemaNodeToZod(null).safeParse(123).success).toBe(true);
    expect(jsonSchemaNodeToZod([1, 2]).safeParse('x').success).toBe(true);
  });

  it('accepts a non-primitive enum member instead of narrowing the enum to its primitive subset', () => {
    // A tool schema may legally enumerate object-valued presets next to
    // string shorthands. Dropping the object member while keeping the string
    // literals NARROWS the advertised schema: the bridge-side validation then
    // rejects an argument the real (host-side, authoritative) schema accepts,
    // and the model can never invoke the tool with that value. Fidelity must
    // degrade WIDE (accept-anything), never narrow.
    const schema = jsonSchemaNodeToZod({
      enum: ['fast', { mode: 'custom', depth: 2 }],
    });

    expect(schema.safeParse('fast').success).toBe(true);
    expect(schema.safeParse({ mode: 'custom', depth: 2 }).success).toBe(true);
  });
});
