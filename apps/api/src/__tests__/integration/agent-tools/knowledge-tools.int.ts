import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { environment } from '../../../environments';
import {
  KnowledgeGetChunksOutput,
  KnowledgeGetChunksTool,
} from '../../../v1/agent-tools/tools/common/knowledge/knowledge-get-chunks.tool';
import { KnowledgeGetDocTool } from '../../../v1/agent-tools/tools/common/knowledge/knowledge-get-doc.tool';
import { KnowledgeSearchChunksTool } from '../../../v1/agent-tools/tools/common/knowledge/knowledge-search-chunks.tool';
import { KnowledgeSearchDocsTool } from '../../../v1/agent-tools/tools/common/knowledge/knowledge-search-docs.tool';
import { KnowledgeDocDao } from '../../../v1/knowledge/dao/knowledge-doc.dao';
import { KnowledgeService } from '../../../v1/knowledge/services/knowledge.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { QdrantService } from '../../../v1/qdrant/services/qdrant.service';
import { createTestProject } from '../helpers/test-context';
import { applyDefaults, getMockLlm } from '../mocks/mock-llm';
import { createTestModule, TEST_USER_ID } from '../setup';

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Knowledge tools (integration)', () => {
  let app: INestApplication;
  let knowledgeService: KnowledgeService;
  let searchDocsTool: KnowledgeSearchDocsTool;
  let searchChunksTool: KnowledgeSearchChunksTool;
  let getChunksTool: KnowledgeGetChunksTool;
  let getDocTool: KnowledgeGetDocTool;
  let docDao: KnowledgeDocDao;
  let qdrantService: QdrantService;
  const createdDocIds: string[] = [];
  let testProjectId: string;

  beforeAll(async () => {
    app = await createTestModule();
    knowledgeService = app.get(KnowledgeService);
    searchDocsTool = await app.resolve(KnowledgeSearchDocsTool);
    searchChunksTool = await app.resolve(KnowledgeSearchChunksTool);
    getChunksTool = await app.resolve(KnowledgeGetChunksTool);
    getDocTool = await app.resolve(KnowledgeGetDocTool);
    docDao = app.get(KnowledgeDocDao);
    qdrantService = app.get(QdrantService);
    // MikroORM v7 exposes the schema generator via orm.schema (not getSchemaGenerator()).
    // The update method is orm.schema.update() in v7, not updateSchema().
    const orm = app.get(MikroORM);
    await orm.schema.update();

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;
  }, 120_000);

  beforeEach(() => {
    const mockLlm = getMockLlm(app);
    mockLlm.reset();

    // Fixture for query variant expansion (higher specificity — registered first).
    // KnowledgeChunksService.generateQueryVariants sends a prompt starting with
    // "Generate 3-5 short search queries or keyword phrases relevant to the user query."
    mockLlm.onJsonRequest(
      { lastUserMessage: /Generate 3-5 short search queries/i },
      { kind: 'json', content: { queries: ['test query'] } },
    );

    // Fixture for document summary generation with content-aware reply.
    // KnowledgeService.generateSummary includes the full document content in the
    // prompt, so we match on unique doc-level keywords that appear in tests.
    // "orionflux" is the original doc keyword in the "updates summaries" test.
    mockLlm.onJsonRequest(
      { lastUserMessage: /orionflux/i },
      {
        kind: 'json',
        content: { summary: 'Original document summary — orionflux.' },
      },
    );
    // "novaquill" is the updated doc keyword in the "updates summaries" test.
    mockLlm.onJsonRequest(
      { lastUserMessage: /novaquill/i },
      {
        kind: 'json',
        content: { summary: 'Updated document summary — novaquill.' },
      },
    );

    // Catch-all summary fixture for all other createDoc/updateDoc calls.
    // KnowledgeService.generateSummary prompt always begins with the sentinel phrase.
    mockLlm.onJsonRequest(
      {
        lastUserMessage:
          /You generate summaries for internal knowledge base documents/i,
      },
      { kind: 'json', content: { summary: 'Test document summary.' } },
    );

    // Register deterministic embeddings and chat catch-alls.
    // Must be called AFTER per-test specific fixtures.
    applyDefaults(mockLlm);
  });

  afterEach(async () => {
    for (const id of createdDocIds) {
      await docDao.deleteById(id);
    }
    createdDocIds.length = 0;
  });

  afterAll(async () => {
    const collectionName =
      environment.knowledgeChunksCollection ?? 'knowledge_chunks';
    try {
      const collections = await qdrantService.raw.getCollections();
      const exists = collections.collections.some(
        (collection) => collection.name === collectionName,
      );
      if (exists) {
        await qdrantService.raw.deleteCollection(collectionName);
      }
    } catch {
      // Qdrant may not be available
    }

    if (testProjectId) {
      try {
        await app.get(ProjectsDao).deleteById(testProjectId);
      } catch {
        // best effort cleanup
      }
    }

    await app?.close();
  });

  it(
    'returns matching docs and summaries with strict tag filters',
    { timeout: 60000 },
    async () => {
      const alphaKeyword = 'zephyrox';
      const betaKeyword = 'umbracore';
      const alphaContent = `Alpha document content ${alphaKeyword}`;
      const betaContent = `Beta document content ${betaKeyword}`;
      const alphaTag = `alpha-tag-${randomUUID()}`;
      const betaTag = `beta-tag-${randomUUID()}`;
      const alphaDoc = await knowledgeService.createDoc(contextDataStorage, {
        title: 'Alpha doc',
        content: alphaContent,
        tags: [alphaTag],
      });
      const betaDoc = await knowledgeService.createDoc(contextDataStorage, {
        title: 'Beta doc',
        content: betaContent,
        tags: [betaTag],
      });
      createdDocIds.push(alphaDoc.id, betaDoc.id);

      // Register the doc-selection fixture now that we know alphaDoc.publicId.
      // KnowledgeSearchDocsTool.selectRelevantDocs sends a jsonRequest whose prompt
      // starts with "You select relevant knowledge documents for a query."
      // We return only the alpha doc's publicId so the assertion holds.
      getMockLlm(app).onJsonRequest(
        {
          lastUserMessage:
            /You select relevant knowledge documents for a query/i,
        },
        { kind: 'json', content: { ids: [alphaDoc.publicId], comment: null } },
      );

      expect(alphaDoc.summary).toBeTruthy();
      expect(betaDoc.summary).toBeTruthy();

      const refreshedAlpha = await knowledgeService.getDoc(
        contextDataStorage,
        alphaDoc.id,
      );
      expect(refreshedAlpha.tags).toEqual([alphaTag]);

      const searchResult = await searchDocsTool.invoke(
        {
          task: `Find alpha-tag doc. Stack: NestJS + TypeScript. Keyword: ${alphaKeyword}`,
        },
        { tags: [alphaTag] },
        {
          configurable: {
            thread_id: 'thread-1',
            graph_created_by: TEST_USER_ID,
          },
        },
      );

      const output = searchResult.output as {
        documents: {
          documentPublicId: number;
          title: string;
          summary: string | null;
          tags: string[];
        }[];
        comment?: string;
      };
      expect(output.documents).toHaveLength(1);
      expect(output.documents[0]?.documentPublicId).toBe(alphaDoc.publicId);
      expect(output.documents[0]?.summary).toBe(refreshedAlpha.summary);
      expect(output.documents[0]?.tags).toEqual([alphaTag]);
    },
  );

  it(
    'searches chunks and returns exact content slices',
    { timeout: 60000 },
    async () => {
      const keyword = 'zephyrox';
      const content = `Alpha document content ${keyword} and more text.`;
      const alphaTag = `alpha-tag-${randomUUID()}`;
      const doc = await knowledgeService.createDoc(contextDataStorage, {
        title: 'Alpha doc',
        content,
        tags: [alphaTag],
      });
      createdDocIds.push(doc.id);

      const chunksResult = await searchChunksTool.invoke(
        { docIds: [doc.publicId], query: keyword, topK: 3 },
        { tags: [alphaTag] },
        {
          configurable: {
            thread_id: 'thread-1',
            graph_created_by: TEST_USER_ID,
          },
        },
      );

      const chunkSnippets = chunksResult.output;
      expect(chunkSnippets.length).toBeGreaterThan(0);
      expect(chunkSnippets[0]?.docPublicId).toBe(doc.publicId);
      expect(chunkSnippets[0]?.snippet.toLowerCase()).toContain(keyword);

      const chunkResult = await getChunksTool.invoke(
        { chunkIds: [chunkSnippets[0]!.chunkPublicId] },
        { tags: [alphaTag] },
        {
          configurable: {
            thread_id: 'thread-1',
            graph_created_by: TEST_USER_ID,
          },
        },
      );

      const chunks: KnowledgeGetChunksOutput = chunkResult.output;
      expect(chunks).toHaveLength(1);
      const chunk = chunks[0];
      expect(chunk?.docPublicId).toBe(doc.publicId);

      const refreshed = await knowledgeService.getDoc(
        contextDataStorage,
        doc.id,
      );
      expect(chunk?.text).toBe(
        refreshed.content.slice(chunk?.startOffset ?? 0, chunk?.endOffset ?? 0),
      );
    },
  );

  it('updates summaries when content changes', { timeout: 60000 }, async () => {
    const originalKeyword = 'orionflux';
    const updatedKeyword = 'novaquill';
    const original = await knowledgeService.createDoc(contextDataStorage, {
      title: 'Original doc',
      content: `Original content ${originalKeyword}.`,
    });
    createdDocIds.push(original.id);
    expect(original.summary).toBeTruthy();

    // Ensure the update happens in a different millisecond so updatedAt changes.
    // With the mock LLM (no network latency), createDoc and updateDoc can finish
    // within the same millisecond, making updatedAt identical. 25ms gives enough
    // headroom on slow CI hosts and clocks with coarse millisecond resolution.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    const updated = await knowledgeService.updateDoc(
      contextDataStorage,
      original.id,
      {
        title: 'Updated doc',
        content: `Updated content ${updatedKeyword}.`,
      },
    );

    expect(updated.summary).toBeTruthy();
    expect(updated.summary).not.toBe(original.summary);
    expect(updated.updatedAt).not.toBe(original.updatedAt);
  });

  it(
    'filters chunk search and retrieval by tags',
    { timeout: 60000 },
    async () => {
      const alphaKeyword = 'solaris';
      const betaKeyword = 'umbria';
      // Per-run unique tags so leftover Qdrant chunks from prior tests in this
      // file (afterEach only deletes Postgres rows; Qdrant is wiped in afterAll)
      // cannot match this test's tag filter.
      const alphaTag = `alpha-tag-${randomUUID()}`;
      const betaTag = `beta-tag-${randomUUID()}`;
      const alphaDoc = await knowledgeService.createDoc(contextDataStorage, {
        title: 'Alpha doc',
        content: `Alpha content ${alphaKeyword}.`,
        tags: [alphaTag],
      });
      const betaDoc = await knowledgeService.createDoc(contextDataStorage, {
        title: 'Beta doc',
        content: `Beta content ${betaKeyword}.`,
        tags: [betaTag],
      });
      createdDocIds.push(alphaDoc.id, betaDoc.id);

      // Override the query-variant fixture with specificity 2 (callIndex + lastUserMessage)
      // so it beats the beforeEach catch-all (specificity 1).
      // We return the exact alpha chunk text so the query embedding is identical to
      // the stored alpha chunk embedding — guaranteeing cosine similarity = 1.0 for
      // alpha and < 1.0 for beta with deterministic (non-semantic) vectors.
      // callIndex 4 = 5th overall LLM call: after 2x summary (0,2) + 2x embeddings (1,3).
      getMockLlm(app).onJsonRequest(
        { callIndex: 4, lastUserMessage: /Generate 3-5 short search queries/i },
        {
          kind: 'json',
          content: { queries: [`Alpha content ${alphaKeyword}.`] },
        },
      );

      const chunksResult = await searchChunksTool.invoke(
        {
          docIds: [alphaDoc.publicId, betaDoc.publicId],
          query: alphaKeyword,
          topK: 5,
        },
        { tags: [alphaTag] },
        {
          configurable: {
            thread_id: 'thread-1',
            graph_created_by: TEST_USER_ID,
          },
        },
      );

      const chunkSnippets = chunksResult.output as {
        chunkPublicId: number;
        docPublicId: number | null;
        score: number;
        snippet: string;
      }[];
      expect(chunkSnippets.length).toBeGreaterThan(0);
      expect(
        chunkSnippets.every((chunk) => chunk.docPublicId === alphaDoc.publicId),
      ).toBe(true);

      const allowedChunks = await getChunksTool.invoke(
        { chunkIds: [chunkSnippets[0]!.chunkPublicId] },
        { tags: [alphaTag] },
        {
          configurable: {
            thread_id: 'thread-1',
            graph_created_by: TEST_USER_ID,
          },
        },
      );
      const allowedOutput: KnowledgeGetChunksOutput = allowedChunks.output;
      expect(allowedOutput).toHaveLength(1);
      expect(allowedOutput[0]?.docPublicId).toBe(alphaDoc.publicId);

      const blockedChunks = await getChunksTool.invoke(
        { chunkIds: [chunkSnippets[0]!.chunkPublicId] },
        { tags: [betaTag] },
        {
          configurable: {
            thread_id: 'thread-1',
            graph_created_by: TEST_USER_ID,
          },
        },
      );
      const blockedOutput: KnowledgeGetChunksOutput = blockedChunks.output;
      expect(blockedOutput).toHaveLength(0);
    },
  );

  it(
    'returns full doc content only when politic allows it',
    { timeout: 60000 },
    async () => {
      const allowedDoc = await knowledgeService.createDoc(contextDataStorage, {
        title: 'Allowed doc',
        content: 'Full content is allowed here.',
        politic:
          'If this document is relevant to the current task - always fetch the full content instead of fetching only specific chunks.',
      });
      const blockedDoc = await knowledgeService.createDoc(contextDataStorage, {
        title: 'Blocked doc',
        content: 'This should not be returned.',
        politic: 'Summarize only; do not share full content.',
      });
      createdDocIds.push(allowedDoc.id, blockedDoc.id);

      const allowedResult = await getDocTool.invoke(
        { docId: allowedDoc.publicId },
        {},
        {
          configurable: {
            thread_id: 'thread-1',
            graph_created_by: TEST_USER_ID,
          },
        },
      );

      expect(allowedResult.output).toBeTruthy();
      expect(allowedResult.output?.documentPublicId).toBe(allowedDoc.publicId);
      expect(allowedResult.output?.content).toBe(allowedDoc.content);

      await expect(
        getDocTool.invoke(
          { docId: blockedDoc.publicId },
          {},
          {
            configurable: {
              thread_id: 'thread-1',
              graph_created_by: TEST_USER_ID,
            },
          },
        ),
      ).rejects.toThrowError('FULL_CONTENT_NOT_ALLOWED');
    },
  );
});
