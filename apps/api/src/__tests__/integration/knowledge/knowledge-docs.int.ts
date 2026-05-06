import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { environment } from '../../../environments';
import { KnowledgeDocDao } from '../../../v1/knowledge/dao/knowledge-doc.dao';
import { KnowledgeService } from '../../../v1/knowledge/services/knowledge.service';
import { KnowledgeChunksService } from '../../../v1/knowledge/services/knowledge-chunks.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { QdrantService } from '../../../v1/qdrant/services/qdrant.service';
import { createTestProject } from '../helpers/test-context';
import { createTestModule } from '../setup';

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('KnowledgeService (integration)', () => {
  let app: INestApplication;
  let knowledgeService: KnowledgeService;
  let knowledgeChunksService: KnowledgeChunksService;
  let docDao: KnowledgeDocDao;
  let qdrantService: QdrantService;
  const createdDocIds: string[] = [];
  let testProjectId: string;

  beforeAll(async () => {
    app = await createTestModule();
    knowledgeService = app.get(KnowledgeService);
    knowledgeChunksService = app.get(KnowledgeChunksService);
    docDao = app.get(KnowledgeDocDao);
    qdrantService = app.get(QdrantService);
    // MikroORM v7 exposes the schema generator via `orm.schema` and the update
    // method is `orm.schema.update()` — `getSchemaGenerator()` was removed.
    const orm = app.get(MikroORM);
    await orm.schema.update();

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;
  }, 120_000);

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

  const expectIsoDate = (value: string) => {
    const parsed = new Date(value);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(parsed.toISOString()).toBe(value);
  };

  const expectNormalizedTags = (tags: string[]) => {
    const normalized = tags.map((tag) => tag.trim().toLowerCase());
    expect(tags).toEqual(normalized);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags.length).toBeLessThanOrEqual(12);
  };

  const expectChunksCoverContent = (
    chunks: {
      docId: string;
      chunkIndex: number;
      text: string;
      startOffset: number;
      endOffset: number;
    }[],
    docId: string,
    content: string,
  ) => {
    expect(chunks.length).toBeGreaterThan(0);
    const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
    expect(ordered[0]?.chunkIndex).toBe(0);
    expect(ordered[0]?.startOffset).toBe(0);
    let previousEnd = 0;

    ordered.forEach((chunk, index) => {
      expect(chunk.docId).toBe(docId);
      expect(chunk.chunkIndex).toBe(index);
      expect(chunk.startOffset).toBe(previousEnd);
      expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
      expect(chunk.text).toBe(
        content.slice(chunk.startOffset, chunk.endOffset),
      );
      previousEnd = chunk.endOffset;
    });

    expect(previousEnd).toBe(content.length);
  };

  it(
    'creates a knowledge doc with metadata and chunks',
    { timeout: 30000 },
    async () => {
      const title = 'Alpha doc';
      const content = 'Alpha document content';
      const tags = [' Alpha ', 'BETA'];

      const doc = await knowledgeService.createDoc(contextDataStorage, {
        title,
        content,
        tags,
      });
      createdDocIds.push(doc.id);

      expect(doc.content).toBe(content);
      expect(doc.title).toBe(title);
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.summary?.length ?? 0).toBeGreaterThan(0);
      expect(doc.tags.length).toBeGreaterThan(0);
      expectNormalizedTags(doc.tags);
      expectIsoDate(doc.createdAt);
      expectIsoDate(doc.updatedAt);

      const chunks = await knowledgeChunksService.getDocChunks(doc.id);
      expectChunksCoverContent(chunks, doc.id, content);
    },
  );

  it('rejects empty content', async () => {
    await expect(
      knowledgeService.createDoc(contextDataStorage, {
        title: 'Alpha doc',
        content: '   ',
      }),
    ).rejects.toThrow('CONTENT_REQUIRED');
  });

  it(
    'lists docs with tag filtering and supports updates',
    { timeout: 30000 },
    async () => {
      const title = 'Alpha doc';
      const content = 'Alpha document content';
      const tags = ['alpha-tag', 'beta-tag'];

      const doc = await knowledgeService.createDoc(contextDataStorage, {
        title,
        content,
        tags,
      });
      createdDocIds.push(doc.id);

      const tagsFilter = doc.tags.slice(0, 1);
      expect(tagsFilter.length).toBe(1);

      const results = await knowledgeService.listDocs(contextDataStorage, {
        tags: tagsFilter,
        limit: 10,
        offset: 0,
      });
      expect(results.items.some((entry) => entry.id === doc.id)).toBe(true);
      expect(results.total).toBeGreaterThanOrEqual(results.items.length);
      results.items.forEach((entry) => {
        expect(entry.tags).toEqual(
          expect.arrayContaining([tagsFilter[0] as string]),
        );
      });

      const updatedTitle = 'Beta doc';
      const updatedContent = 'Beta document content with new details';

      const updated = await knowledgeService.updateDoc(
        contextDataStorage,
        doc.id,
        {
          title: updatedTitle,
          content: updatedContent,
        },
      );
      expect(updated.content).toBe(updatedContent);
      expect(updated.title).toBe(updatedTitle);
      expect(updated.title.length).toBeGreaterThan(0);
      expect(updated.summary?.length ?? 0).toBeGreaterThan(0);
      expect(updated.tags).toEqual(doc.tags);
      expectNormalizedTags(updated.tags);
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(updated.createdAt).getTime(),
      );

      const chunks = await knowledgeChunksService.getDocChunks(doc.id);
      expectChunksCoverContent(chunks, doc.id, updatedContent);
    },
  );

  it('deletes docs and rejects missing ids', { timeout: 30000 }, async () => {
    const title = 'Alpha doc';
    const content = 'Alpha document content';
    const tags = ['alpha-tag'];

    const doc = await knowledgeService.createDoc(contextDataStorage, {
      title,
      content,
      tags,
    });
    createdDocIds.push(doc.id);

    await knowledgeService.deleteDoc(contextDataStorage, doc.id);
    const remaining = await knowledgeService.listDocs(contextDataStorage, {
      limit: 10,
      offset: 0,
    });
    expect(remaining.items.some((entry) => entry.id === doc.id)).toBe(false);

    await expect(
      knowledgeService.getDoc(contextDataStorage, doc.id),
    ).rejects.toThrow();
  });
});
