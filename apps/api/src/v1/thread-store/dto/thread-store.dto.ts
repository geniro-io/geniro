import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  THREAD_STORE_MAX_KEY_LENGTH,
  THREAD_STORE_MAX_NAMESPACE_LENGTH,
  ThreadStoreEntryMode,
} from '../thread-store.types';

export const namespaceSchema = z
  .string()
  .min(1)
  .max(THREAD_STORE_MAX_NAMESPACE_LENGTH)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
    'namespace must start with an alphanumeric character and contain only letters, digits, underscores, dashes, or dots',
  );

export const keySchema = z
  .string()
  .min(1)
  .max(THREAD_STORE_MAX_KEY_LENGTH)
  .regex(
    /^[^\s/\\]{1,256}$/,
    'key must not contain whitespace, forward slashes, or backslashes and must be 1-256 characters',
  );

export const ThreadStoreEntryDtoSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  namespace: z.string(),
  key: z.string(),
  value: z.unknown(),
  mode: z.nativeEnum(ThreadStoreEntryMode),
  authorAgentId: z.string().nullable(),
  tags: z.array(z.string()).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export class ThreadStoreEntryDto extends createZodDto(
  ThreadStoreEntryDtoSchema,
) {}
export type ThreadStoreEntry = z.infer<typeof ThreadStoreEntryDtoSchema>;

export const NamespaceSummaryDtoSchema = z.object({
  namespace: z.string(),
  mode: z.nativeEnum(ThreadStoreEntryMode),
  entryCount: z.number().int().nonnegative(),
  lastUpdatedAt: z.string().datetime(),
});

export class NamespaceSummaryDto extends createZodDto(
  NamespaceSummaryDtoSchema,
) {}
export type NamespaceSummary = z.infer<typeof NamespaceSummaryDtoSchema>;

export const ListEntriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export class ListEntriesQueryDto extends createZodDto(ListEntriesQuerySchema) {}
export type ListEntriesQuery = z.infer<typeof ListEntriesQuerySchema>;
