import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { GraphNodeSchemaType } from '../graphs.types';
import { collectOAuthNodes } from './oauth-node.utils';

// Mirror linear-mcp.template.ts: the token field carries BOTH x-ui:secret-select
// and x-ui:oauth-authenticate on the SAME field.
const oauthSchema = z.object({
  token: z
    .string()
    .min(1)
    .meta({
      'x-ui:label': 'Linear authentication',
      'x-ui:secret-select': true,
      'x-ui:oauth-authenticate': { provider: 'linear' },
    }),
});

// A secret-select field WITHOUT the oauth marker (mirrors a plain custom-MCP).
const secretOnlySchema = z.object({
  apiKey: z.string().meta({ 'x-ui:secret-select': true }),
});

const noMetaSchema = z.object({
  name: z.string(),
});

const node = (id: string, template: string): GraphNodeSchemaType => ({
  id,
  template,
  config: {},
});

const resolver =
  (map: Record<string, z.ZodTypeAny>) =>
  (templateId: string): z.ZodTypeAny | undefined =>
    map[templateId];

describe('collectOAuthNodes', () => {
  it('returns the node + provider for a node carrying the oauth-authenticate marker', () => {
    const result = collectOAuthNodes(
      [node('n1', 'linear-mcp')],
      resolver({ 'linear-mcp': oauthSchema }),
    );

    expect(result).toEqual([{ nodeId: 'n1', provider: 'linear' }]);
  });

  it('ignores a node whose field has secret-select but NOT oauth-authenticate', () => {
    const result = collectOAuthNodes(
      [node('n1', 'custom-mcp')],
      resolver({ 'custom-mcp': secretOnlySchema }),
    );

    expect(result).toEqual([]);
  });

  it('ignores a node with no field metadata', () => {
    const result = collectOAuthNodes(
      [node('n1', 'plain')],
      resolver({ plain: noMetaSchema }),
    );

    expect(result).toEqual([]);
  });

  it('skips a node whose template cannot be resolved', () => {
    const result = collectOAuthNodes(
      [node('n1', 'unknown-template')],
      resolver({}),
    );

    expect(result).toEqual([]);
  });

  it('skips a node whose template schema is not a ZodObject', () => {
    const result = collectOAuthNodes(
      [node('n1', 'weird')],
      resolver({ weird: z.string() as unknown as z.ZodTypeAny }),
    );

    expect(result).toEqual([]);
  });

  it('collects every OAuth node across a mixed graph', () => {
    const result = collectOAuthNodes(
      [
        node('agent', 'simple-agent'),
        node('linear', 'linear-mcp'),
        node('custom', 'custom-mcp'),
        node('linear2', 'linear-mcp'),
      ],
      resolver({
        'simple-agent': noMetaSchema,
        'linear-mcp': oauthSchema,
        'custom-mcp': secretOnlySchema,
      }),
    );

    expect(result).toEqual([
      { nodeId: 'linear', provider: 'linear' },
      { nodeId: 'linear2', provider: 'linear' },
    ]);
  });

  it('rejects a malformed marker (provider not a non-empty string)', () => {
    const badMarkers = [
      z.object({ token: z.string().meta({ 'x-ui:oauth-authenticate': true }) }),
      z.object({
        token: z.string().meta({ 'x-ui:oauth-authenticate': { provider: '' } }),
      }),
      z.object({
        token: z.string().meta({ 'x-ui:oauth-authenticate': { provider: 42 } }),
      }),
      z.object({
        token: z.string().meta({ 'x-ui:oauth-authenticate': null }),
      }),
    ];

    for (const schema of badMarkers) {
      expect(
        collectOAuthNodes([node('n1', 'bad')], resolver({ bad: schema })),
      ).toEqual([]);
    }
  });

  it('dedupes by provider when the same provider marker appears on two fields', () => {
    const dualField = z.object({
      token: z
        .string()
        .meta({ 'x-ui:oauth-authenticate': { provider: 'linear' } }),
      altToken: z
        .string()
        .meta({ 'x-ui:oauth-authenticate': { provider: 'linear' } }),
    });

    const result = collectOAuthNodes(
      [node('n1', 'dual')],
      resolver({ dual: dualField }),
    );

    expect(result).toEqual([{ nodeId: 'n1', provider: 'linear' }]);
  });
});
