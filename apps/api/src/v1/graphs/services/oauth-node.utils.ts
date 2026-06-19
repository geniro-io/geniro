import { z } from 'zod';

import { GraphNodeSchemaType } from '../graphs.types';

/** An OAuth-MCP node and the provider it authenticates against. */
export interface OAuthNodeRef {
  nodeId: string;
  provider: string;
}

interface OAuthAuthenticateMarker {
  provider: string;
}

/**
 * Read a provider string from an `x-ui:oauth-authenticate` marker value.
 * The marker is untrusted template metadata, so validate object-ness + a
 * non-empty string `provider` before trusting it; anything else yields null.
 */
function readMarkerProvider(marker: unknown): string | null {
  if (
    typeof marker === 'object' &&
    marker !== null &&
    'provider' in marker &&
    typeof (marker as OAuthAuthenticateMarker).provider === 'string' &&
    (marker as OAuthAuthenticateMarker).provider.length > 0
  ) {
    return (marker as OAuthAuthenticateMarker).provider;
  }
  return null;
}

/**
 * Identify the OAuth-MCP nodes in a graph by reading the
 * `x-ui:oauth-authenticate { provider }` marker off each node's template fields.
 *
 * Mirrors the field-meta walk of `GraphCompiler.collectSecretNames`
 * (`graph-compiler.ts` — iterate the template's `ZodObject` shape, read
 * `fieldSchema.meta()`) but targets the UI-only `x-ui:oauth-authenticate`
 * marker. The two markers co-exist on the same token field (e.g.
 * `linear-mcp.template.ts`) yet are orthogonal: `oauth-authenticate` NEVER
 * routes a credential — it only flags which nodes need a valid OAuth credential
 * so a pre-flight can check it (see `.claude/rules/sandbox-boundary.md`). Keep
 * this walk in lockstep with `collectSecretNames` to avoid drift.
 *
 * `resolveTemplateSchema` is injected rather than the `TemplateRegistry` so the
 * helper stays pure and unit-testable. Deduped per node by provider.
 */
export function collectOAuthNodes(
  nodes: GraphNodeSchemaType[],
  resolveTemplateSchema: (templateId: string) => z.ZodTypeAny | undefined,
): OAuthNodeRef[] {
  const refs: OAuthNodeRef[] = [];

  for (const node of nodes) {
    const schema = resolveTemplateSchema(node.template);
    if (!(schema instanceof z.ZodObject)) {
      continue;
    }

    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const seenProviders = new Set<string>();
    for (const fieldSchema of Object.values(shape)) {
      const meta = fieldSchema.meta?.() as Record<string, unknown> | undefined;
      const provider = readMarkerProvider(meta?.['x-ui:oauth-authenticate']);
      if (provider && !seenProviders.has(provider)) {
        seenProviders.add(provider);
        refs.push({ nodeId: node.id, provider });
      }
    }
  }

  return refs;
}
