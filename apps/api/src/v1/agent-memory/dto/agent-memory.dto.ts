import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { environment } from '../../../environments';
import type { RequestTokenUsage } from '../../litellm/litellm.types';
import {
  AGENT_MEMORY_MAX_KEY_LENGTH,
  AGENT_MEMORY_MAX_NAMESPACE_LENGTH,
  AGENT_MEMORY_MAX_TAG_LENGTH,
  AGENT_MEMORY_MAX_TAGS_COUNT,
  AGENT_MEMORY_MAX_TITLE_LENGTH,
  AgentMemoryEntryMode,
} from '../agent-memory.types';

/**
 * Static GET segments under `/memory` that would shadow a same-named namespace:
 * `GET /memory/search` always routes to semantic search, so a namespace literally
 * named `search` would be unreachable via `GET /memory/:namespace`. Reserved here
 * (at the shared namespace schema, so save/append and the agent tools all enforce
 * it) so such an unreachable namespace can never be created. Compared
 * case-insensitively to stay correct regardless of the router's case-sensitivity.
 */
const RESERVED_NAMESPACES = new Set(['search']);

export const namespaceSchema = z
  .string()
  .min(1)
  .max(AGENT_MEMORY_MAX_NAMESPACE_LENGTH)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
    'namespace must start with an alphanumeric character and contain only letters, digits, underscores, dashes, or dots',
  )
  .refine((ns) => !RESERVED_NAMESPACES.has(ns.toLowerCase()), {
    message:
      'namespace "search" is reserved (it would be shadowed by the GET /memory/search route)',
  });

export const keySchema = z
  .string()
  .min(1)
  .max(AGENT_MEMORY_MAX_KEY_LENGTH)
  .regex(
    /^[^\s/\\]+$/,
    'key must not contain whitespace, forward slashes, or backslashes',
  );

/** Optional short label. Shared by the DTO and the agent memory tool schemas. */
export const titleSchema = z.string().max(AGENT_MEMORY_MAX_TITLE_LENGTH);

/** Optional freeform labels. Shared by the DTO and the agent memory tool schemas. */
export const tagsSchema = z
  .array(z.string().min(1).max(AGENT_MEMORY_MAX_TAG_LENGTH))
  .max(AGENT_MEMORY_MAX_TAGS_COUNT);

export const AgentMemoryEntryDtoSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  namespace: z.string(),
  key: z.string(),
  title: z.string().nullable(),
  value: z.unknown(),
  mode: z.nativeEnum(AgentMemoryEntryMode),
  authorAgentId: z.string().nullable(),
  tags: z.array(z.string()).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export class AgentMemoryEntryDto extends createZodDto(
  AgentMemoryEntryDtoSchema,
) {}
export type AgentMemoryEntry = z.infer<typeof AgentMemoryEntryDtoSchema>;

/**
 * Result of a project-scoped write (`putForProject` / `appendForProject`). The
 * entry is the persisted row; `embedUsage` is the token usage of the best-effort
 * embed-on-write call (M2), which the calling agent tool attaches to its
 * `ToolInvokeResult.toolRequestUsage` so the embedding spend is attributed. It is
 * `undefined` when the embeddings call failed (nothing billed) or produced no
 * usage — never coerce a missing usage to a zeroed object, or an unpriced embed
 * reads as a priced $0.
 */
export interface AgentMemoryWriteResult {
  entry: AgentMemoryEntry;
  embedUsage?: RequestTokenUsage;
}

export const NamespaceSummaryDtoSchema = z.object({
  namespace: z.string(),
  mode: z.nativeEnum(AgentMemoryEntryMode),
  entryCount: z.number().int().nonnegative(),
  lastUpdatedAt: z.string().datetime(),
});

export class NamespaceSummaryDto extends createZodDto(
  NamespaceSummaryDtoSchema,
) {}
export type NamespaceSummary = z.infer<typeof NamespaceSummaryDtoSchema>;

/** One row of the live project memory index returned by `memory_list` (no bodies). */
export const ProjectMemoryIndexEntryDtoSchema = z.object({
  namespace: z.string(),
  key: z.string(),
  title: z.string().nullable(),
  mode: z.nativeEnum(AgentMemoryEntryMode),
  tags: z.array(z.string()).nullable(),
  updatedAt: z.string().datetime(),
});

export class ProjectMemoryIndexEntryDto extends createZodDto(
  ProjectMemoryIndexEntryDtoSchema,
) {}
export type ProjectMemoryIndexEntry = z.infer<
  typeof ProjectMemoryIndexEntryDtoSchema
>;

export const ListEntriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export class ListEntriesQueryDto extends createZodDto(ListEntriesQuerySchema) {}
export type ListEntriesQuery = z.infer<typeof ListEntriesQuerySchema>;

/** PUT body for a human upsert from the Project Memory UI. */
export const SaveEntryBodySchema = z.object({
  namespace: namespaceSchema,
  key: keySchema,
  title: titleSchema.nullish(),
  value: z.unknown(),
  tags: tagsSchema.nullish(),
});

export class SaveEntryBodyDto extends createZodDto(SaveEntryBodySchema) {}
export type SaveEntryBody = z.infer<typeof SaveEntryBodySchema>;

/** Query params for the semantic memory search endpoint (M2). */
export const SearchMemoryQuerySchema = z.object({
  query: z.string().min(1).max(2048),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(environment.agentMemorySearchMaxLimit)
    .optional(),
});

export class SearchMemoryQueryDto extends createZodDto(
  SearchMemoryQuerySchema,
) {}
export type SearchMemoryQuery = z.infer<typeof SearchMemoryQuerySchema>;
