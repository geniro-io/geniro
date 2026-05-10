import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';
import { isUndefined, pickBy } from 'lodash';
import { z } from 'zod';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { LlmModelsService } from '../../litellm/services/llm-models.service';
import { OpenaiService } from '../../openai/openai.service';
import { ProjectsDao } from '../../projects/dao/projects.dao';
import { KnowledgeDocDao } from '../dao/knowledge-doc.dao';
import {
  KnowledgeDocCreateDto,
  KnowledgeDocDto,
  KnowledgeDocListQuery,
  KnowledgeDocListResultDto,
  KnowledgeDocUpdateDto,
} from '../dto/knowledge.dto';
import { KnowledgeDocEntity } from '../entity/knowledge-doc.entity';
import { KnowledgeSummary } from '../knowledge.types';
import {
  MAX_TAGS,
  normalizeFilterTags,
  normalizeTags,
} from '../knowledge.utils';
import {
  ChunkMaterial,
  KnowledgeChunksService,
} from './knowledge-chunks.service';

const FALLBACK_SUMMARY_LENGTH = 500;

const KnowledgeSummarySchema = z.object({
  summary: z.string().min(1),
});

export type KnowledgeDocListResult = KnowledgeDocListResultDto;

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly docDao: KnowledgeDocDao,
    private readonly em: EntityManager,
    private readonly openaiService: OpenaiService,
    private readonly llmModelsService: LlmModelsService,
    private readonly knowledgeChunksService: KnowledgeChunksService,
    private readonly projectsDao: ProjectsDao,
  ) {}

  async createDoc(
    ctx: AppContextStorage,
    dto: KnowledgeDocCreateDto,
  ): Promise<KnowledgeDocDto> {
    const userId = ctx.checkSub();
    const projectId = ctx.checkProjectId();

    const content = dto.content.trim();
    if (!content) {
      throw new BadRequestException('CONTENT_REQUIRED');
    }

    const project = await this.projectsDao.getOne({
      id: projectId,
      createdBy: userId,
    });
    if (!project) {
      throw new NotFoundException('PROJECT_NOT_FOUND');
    }

    const modelCtx = await this.llmModelsService.buildLLMRequestContext(
      userId,
      project.settings,
    );
    const embeddingModel = this.llmModelsService.getKnowledgeEmbeddingModel(
      modelCtx?.models?.llmEmbeddingModel,
    );
    const [summary, plan] = await Promise.all([
      this.generateSummary(content, modelCtx?.models?.llmMiniModel),
      this.knowledgeChunksService.generateChunkPlan(content),
    ]);
    const tags = normalizeTags(dto.tags ?? [], MAX_TAGS);
    const chunks = this.knowledgeChunksService.materializeChunks(content, plan);
    const embeddings = await this.knowledgeChunksService.embedTexts(
      chunks.map((c) => c.text),
      embeddingModel,
    );

    const doc = await this.em.transactional(async (em: EntityManager) => {
      const doc = await this.docDao.create(
        {
          content,
          title: dto.title,
          summary,
          politic: dto.politic,
          embeddingModel,
          tags,
          createdBy: userId,
          projectId,
        },
        em,
      );
      return doc;
    });

    await this.knowledgeChunksService.upsertDocChunks(
      doc.id,
      doc.publicId,
      chunks,
      embeddings,
    );

    return this.prepareDocResponse(doc);
  }

  async updateDoc(
    ctx: AppContextStorage,
    id: string,
    dto: KnowledgeDocUpdateDto,
  ): Promise<KnowledgeDocDto> {
    const userId = ctx.checkSub();

    const existing = await this.docDao.getOne({ id, createdBy: userId });
    if (!existing) {
      throw new NotFoundException('KNOWLEDGE_DOC_NOT_FOUND');
    }

    const updateData: Partial<KnowledgeDocEntity> = pickBy(
      { ...dto, tags: dto.tags ?? undefined },
      (v) => !isUndefined(v),
    );

    let chunks: ChunkMaterial[] = [];
    let embeddings: number[][] = [];

    if (dto.content) {
      const project = await this.projectsDao.getOne({
        id: existing.projectId,
        createdBy: userId,
      });
      const modelCtx = await this.llmModelsService.buildLLMRequestContext(
        userId,
        project?.settings,
      );
      const embeddingModel = this.llmModelsService.getKnowledgeEmbeddingModel(
        modelCtx?.models?.llmEmbeddingModel,
      );
      const [summary, plan] = await Promise.all([
        this.generateSummary(dto.content, modelCtx?.models?.llmMiniModel),
        this.knowledgeChunksService.generateChunkPlan(dto.content),
      ]);
      updateData.summary = summary;
      updateData.embeddingModel = embeddingModel;
      chunks = this.knowledgeChunksService.materializeChunks(dto.content, plan);
      embeddings = await this.knowledgeChunksService.embedTexts(
        chunks.map((c) => c.text),
        embeddingModel,
      );
    }

    if (dto.tags) {
      updateData.tags = normalizeTags(dto.tags, MAX_TAGS);
    }

    await this.em.transactional(async (em: EntityManager) => {
      await this.docDao.updateById(id, updateData, em);
    });

    const updated = await this.docDao.getOne({ id, createdBy: userId });
    if (!updated) {
      throw new NotFoundException('KNOWLEDGE_DOC_NOT_FOUND');
    }

    if (dto.content) {
      await this.knowledgeChunksService.upsertDocChunks(
        id,
        updated.publicId,
        chunks,
        embeddings,
      );
    }

    return this.prepareDocResponse(updated);
  }

  async deleteDoc(ctx: AppContextStorage, id: string): Promise<void> {
    const userId = ctx.checkSub();

    const existing = await this.docDao.getOne({ id, createdBy: userId });
    if (!existing) {
      throw new NotFoundException('KNOWLEDGE_DOC_NOT_FOUND');
    }

    // Delete from Qdrant first — if this fails, the DB record still exists
    // and the operation can be retried. The reverse order would leave
    // orphan vectors in Qdrant with no DB record to reference.
    await this.knowledgeChunksService.deleteDocChunks(id);

    await this.docDao.deleteById(id);
  }

  async listDocs(
    ctx: AppContextStorage,
    query: KnowledgeDocListQuery,
  ): Promise<KnowledgeDocListResult> {
    const userId = ctx.checkSub();

    const tags = normalizeFilterTags(query.tags);

    const baseWhere = {
      createdBy: userId,
      projectId: ctx.checkProjectId(),
    };

    const [rows, total] = await Promise.all([
      this.docDao.search(baseWhere, query.search, tags, {
        orderBy: { updatedAt: 'DESC' },
        limit: query.limit,
        offset: query.offset,
      }),
      this.docDao.count(baseWhere),
    ]);

    return {
      items: rows.map((row) => this.prepareDocResponse(row)),
      total,
    };
  }

  async getDoc(ctx: AppContextStorage, id: string): Promise<KnowledgeDocDto> {
    const userId = ctx.checkSub();

    const doc = await this.docDao.getOne({ id, createdBy: userId });
    if (!doc) {
      throw new NotFoundException('KNOWLEDGE_DOC_NOT_FOUND');
    }
    return this.prepareDocResponse(doc);
  }

  private prepareDocResponse(entity: KnowledgeDocEntity): KnowledgeDocDto {
    return {
      ...entity,
      createdAt: new Date(entity.createdAt).toISOString(),
      updatedAt: new Date(entity.updatedAt).toISOString(),
      tags: entity.tags ?? [],
      summary: entity.summary ?? null,
      politic: entity.politic ?? null,
      embeddingModel: entity.embeddingModel ?? null,
      projectId: entity.projectId,
    };
  }

  private async generateSummary(
    content: string,
    model?: string,
  ): Promise<string> {
    const prompt = [
      'You generate summaries for internal knowledge base documents.',
      'Return ONLY JSON with key: summary.',
      'Rules:',
      '- summary: 2-5 lines, concise.',
      '',
      'DOCUMENT:',
      content,
    ].join('\n');

    const modelParams =
      await this.llmModelsService.getKnowledgeMetadataParams(model);
    const modelName =
      typeof modelParams.model === 'string'
        ? modelParams.model
        : String(modelParams.model);

    const response = await this.openaiService.jsonRequest<KnowledgeSummary>({
      model: modelName,
      message: prompt,
      jsonSchema: KnowledgeSummarySchema,
      ...(modelParams.reasoning ? { reasoning: modelParams.reasoning } : {}),
    });

    const validation = KnowledgeSummarySchema.safeParse(response.content);
    if (!validation.success) {
      return this.buildFallbackSummary(content);
    }

    return validation.data.summary;
  }

  private buildFallbackSummary(content: string): string {
    const summary = content.trim().slice(0, FALLBACK_SUMMARY_LENGTH);
    return summary.length ? summary : 'No summary available.';
  }
}
