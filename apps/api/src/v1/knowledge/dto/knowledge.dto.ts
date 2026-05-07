import { PartialType } from '@nestjs/swagger';
import { zodQueryArray } from '@packages/http-server';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const KnowledgeDocSchema = z.object({
  id: z.uuid(),
  publicId: z.number().int(),
  content: z.string(),
  title: z.string(),
  summary: z.string().nullable().optional(),
  politic: z.string().nullable().optional(),
  embeddingModel: z.string().nullable().optional(),
  tags: z.array(z.string()),
  projectId: z
    .uuid()
    .nullable()
    .describe('Project this knowledge doc belongs to'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** Maximum content length in characters (~500k tokens at 4 chars/token). */
const MAX_CONTENT_LENGTH = 2_000_000;

export const KnowledgeDocInputSchema = z.object({
  title: z.string().min(1).max(500).describe('Knowledge document title'),
  content: z
    .string()
    .min(1)
    .max(MAX_CONTENT_LENGTH)
    .describe('Raw knowledge document content'),
  politic: z
    .string()
    .min(1)
    .optional()
    .nullable()
    .describe(
      'Optional LLM usage guidance for this document. If the politic instructs to fetch full content (e.g. "always fetch the full content instead of fetching only specific chunks"), full document retrieval is permitted.',
    ),
  tags: z
    .array(z.string().min(1))
    .optional()
    .nullable()
    .describe('Optional tags to apply to the document'),
});

export const KnowledgeDocListQuerySchema = z.object({
  tags: zodQueryArray(z.string().min(1))
    .optional()
    .describe('Filter by tags (match any)'),
  search: z.string().optional().describe('Search in title/summary/content'),
  limit: z.coerce.number().int().positive().max(100).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

export class KnowledgeDocDto extends createZodDto(KnowledgeDocSchema) {}
export class KnowledgeDocCreateDto extends createZodDto(
  KnowledgeDocInputSchema,
) {}
export class KnowledgeDocUpdateDto extends PartialType(
  createZodDto(KnowledgeDocInputSchema),
) {}
export class KnowledgeDocListQueryDto extends createZodDto(
  KnowledgeDocListQuerySchema,
) {}

export const KnowledgeDocListResultSchema = z.object({
  items: z.array(KnowledgeDocSchema),
  total: z.number().int().nonnegative(),
});

export class KnowledgeDocListResultDto extends createZodDto(
  KnowledgeDocListResultSchema,
) {}

export type KnowledgeDocInput = z.infer<typeof KnowledgeDocInputSchema>;
export type KnowledgeDocListQuery = z.infer<typeof KnowledgeDocListQuerySchema>;
