import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { environment } from '../../../environments';
import { AgentMemoryEntryMode } from '../agent-memory.types';

export const namespaceSchema = z
  .string()
  .min(1)
  .max(environment.agentMemoryMaxNamespaceLength)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
    'namespace must start with an alphanumeric character and contain only letters, digits, underscores, dashes, or dots',
  );

export const keySchema = z
  .string()
  .min(1)
  .max(environment.agentMemoryMaxKeyLength)
  .regex(
    /^[^\s/\\]+$/,
    'key must not contain whitespace, forward slashes, or backslashes',
  );

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
  title: z.string().max(environment.agentMemoryMaxTitleLength).nullish(),
  value: z.unknown(),
  tags: z.array(z.string().min(1).max(64)).max(16).nullish(),
});

export class SaveEntryBodyDto extends createZodDto(SaveEntryBodySchema) {}
export type SaveEntryBody = z.infer<typeof SaveEntryBodySchema>;
