import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable, Scope } from '@nestjs/common';
import { BadRequestException } from '@packages/common';
import dedent from 'dedent';
import { z } from 'zod';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { KnowledgeDocDao } from '../../../../knowledge/dao/knowledge-doc.dao';
import { normalizeFilterTags } from '../../../../knowledge/knowledge.utils';
import { KnowledgeChunksService } from '../../../../knowledge/services/knowledge-chunks.service';
import {
  BaseTool,
  ExtendedLangGraphRunnableConfig,
  ToolInvokeResult,
} from '../../base-tool';
import { KnowledgeToolGroupConfig } from './knowledge-tools.types';

export const KnowledgeSearchChunksSchema = z.object({
  docIds: z
    .array(z.number().int().positive())
    .min(1)
    .describe(
      'Document public IDs to search within (obtained from knowledge_search_docs results). Keep this focused — searching fewer documents yields more relevant results.',
    ),
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language query describing what information you need (e.g., "rate limit configuration", "database migration process"). Semantic search — phrasing matters.',
    ),
  topK: z
    .number()
    .int()
    .min(1)
    .max(20)
    .nullable()
    .optional()
    .describe(
      'Maximum number of chunk snippets to return (default: 5, max: 20). Start with 3-7 for focused queries.',
    ),
});

export type KnowledgeSearchChunksSchemaType = z.infer<
  typeof KnowledgeSearchChunksSchema
>;

export type KnowledgeSearchChunksResult = {
  chunkPublicId: number;
  docPublicId: number | null;
  score: number;
  snippet: string;
};

@Injectable({ scope: Scope.TRANSIENT })
export class KnowledgeSearchChunksTool extends BaseTool<
  KnowledgeSearchChunksSchemaType,
  KnowledgeToolGroupConfig
> {
  public name = 'knowledge_search_chunks';
  public description =
    'Perform semantic search within specific knowledge documents and return the most relevant content snippets ranked by similarity to your query. Requires document public IDs obtained from knowledge_search_docs. Returns up to 20 chunk snippets with chunk IDs and relevance scores — use knowledge_get_chunks to retrieve full text for the most relevant chunks. Start with topK 3-7 for focused queries and increase if needed.';

  constructor(
    private readonly docDao: KnowledgeDocDao,
    private readonly knowledgeChunksService: KnowledgeChunksService,
  ) {
    super();
  }

  public getDetailedInstructions(
    _config: KnowledgeToolGroupConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### Overview
      Semantic search within specific knowledge documents. Returns the most relevant content snippets ranked by similarity to your query.

      ### When to Use
      - After \`knowledge_search_docs\` has identified relevant document IDs
      - When you need specific information from known documents (not the full content)
      - When the document policy does NOT allow full content retrieval (\`knowledge_get_doc\` would fail)

      ### When NOT to Use
      - You don't have document IDs yet → use \`knowledge_search_docs\` first
      - The document policy says to fetch full content → use \`knowledge_get_doc\` instead
      - You already have the full document content → no need to search chunks

      ### Workflow
      1. \`knowledge_search_docs\` → get relevant document public IDs
      2. **\`knowledge_search_chunks\`** → search within those documents for specific information
      3. \`knowledge_get_chunks\` → retrieve full text for the most relevant chunks (search returns snippets only)

      ### Best Practices
      - Keep \`docIds\` focused — searching fewer documents yields more relevant results
      - Use natural-language queries (semantic search — phrasing matters)
      - Start with topK 3-7 for focused queries; increase if needed
      - Review snippet scores to gauge relevance before fetching full chunks

      ### Examples
      **1. Search one document:**
      \`\`\`json
      {"docIds": [101], "query": "rate limit configuration", "topK": 5}
      \`\`\`

      **2. Search across multiple documents:**
      \`\`\`json
      {"docIds": [101, 102, 103], "query": "database migration process", "topK": 7}
      \`\`\`

      **3. Narrow search:**
      \`\`\`json
      {"docIds": [201], "query": "authentication middleware setup", "topK": 3}
      \`\`\`
    `;
  }

  public get schema() {
    return KnowledgeSearchChunksSchema;
  }

  public async invoke(
    args: KnowledgeSearchChunksSchemaType,
    config: KnowledgeToolGroupConfig,
    runnableConfig: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<KnowledgeSearchChunksResult[]>> {
    const graphCreatedBy = runnableConfig.configurable?.graph_created_by;
    if (!graphCreatedBy) {
      throw new BadRequestException(undefined, 'graph_created_by is required');
    }

    const normalizedQuery = args.query.trim();
    if (!normalizedQuery) {
      throw new BadRequestException('QUERY_REQUIRED');
    }

    const tagsFilter = normalizeFilterTags(config.tags);
    const docs = await this.docDao.getAll(
      { createdBy: graphCreatedBy, publicId: { $in: args.docIds } },
      { fields: ['id', 'publicId', 'tags'], orderBy: { updatedAt: 'DESC' } },
    );

    const allowedDocs = tagsFilter?.length
      ? docs.filter((doc) => this.hasMatchingTag(doc.tags ?? [], tagsFilter))
      : docs;

    if (allowedDocs.length === 0) {
      return { output: [] };
    }

    const resolvedDocIds = allowedDocs.map((doc) => doc.id);
    const docPublicIdById = new Map(
      allowedDocs.map((doc) => [doc.id, doc.publicId] as const),
    );

    const topK = args.topK ?? 5;
    const chunks = await this.knowledgeChunksService.searchChunks({
      docIds: resolvedDocIds,
      query: normalizedQuery,
      topK,
    });

    const output = chunks.map((chunk) => ({
      chunkPublicId: chunk.publicId,
      docPublicId: docPublicIdById.get(chunk.docId) ?? null,
      score: chunk.score,
      snippet: chunk.snippet,
    }));

    const title = this.generateTitle?.(args, config);

    return {
      output,
      messageMetadata: {
        __title: title,
      },
    };
  }

  protected override generateTitle(
    args: KnowledgeSearchChunksSchemaType,
    _config: KnowledgeToolGroupConfig,
  ): string {
    return `Knowledge chunk search: ${args.query}`;
  }

  private hasMatchingTag(tags: string[], filter: string[]): boolean {
    const normalized = new Set(tags.map((tag) => tag.trim().toLowerCase()));
    return filter.some((tag) => normalized.has(tag.trim().toLowerCase()));
  }
}
