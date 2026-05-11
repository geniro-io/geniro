import { EntityManager, FilterQuery, FindOptions } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { KnowledgeDocEntity } from '../entity/knowledge-doc.entity';
import { escapeIlike } from '../knowledge.utils';

@Injectable()
export class KnowledgeDocDao extends BaseDao<KnowledgeDocEntity> {
  constructor(em: EntityManager) {
    super(em, KnowledgeDocEntity);
  }

  /**
   * Search knowledge docs with ILIKE across title, summary, and content.
   * Also supports filtering by tags using the PostgreSQL ?| operator.
   */
  async search(
    where: FilterQuery<KnowledgeDocEntity>,
    search?: string,
    tags?: string[],
    options?: FindOptions<KnowledgeDocEntity>,
  ): Promise<KnowledgeDocEntity[]> {
    const filters: FilterQuery<KnowledgeDocEntity>[] = [where];

    if (search && search.trim().length > 0) {
      const query = `%${escapeIlike(search.trim())}%`;
      filters.push({
        $or: [
          { title: { $ilike: query } },
          { summary: { $ilike: query } },
          { content: { $ilike: query } },
        ],
      });
    }

    if (tags && tags.length > 0) {
      // Use `EXISTS (... t.elem IN (?, ?, ...))` instead of the `?|` operator:
      // the driver eats `?` characters as parameter slots, so the operator-form
      // would require fragile escape sequences. The array shape `ANY(?)` was
      // also rejected as a "malformed array literal" by the underlying driver.
      const placeholders = tags.map(() => '?').join(',');
      const taggedIds = await this.em.getConnection().execute<{ id: string }[]>(
        `SELECT id FROM knowledge_docs WHERE EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(tags) AS t(elem)
             WHERE t.elem IN (${placeholders})
           ) AND "deleted_at" IS NULL`,
        tags,
      );
      const ids = taggedIds.map((r) => r.id);
      if (ids.length === 0) {
        return [];
      }
      filters.push({ id: { $in: ids } });
    }

    const combinedWhere: FilterQuery<KnowledgeDocEntity> =
      filters.length === 1 ? filters[0]! : { $and: filters };

    return await this.getRepo().find(combinedWhere, options);
  }

  async getEmbeddingModelMismatches(
    currentModel: string,
  ): Promise<KnowledgeDocEntity[]> {
    return await this.getRepo().find(
      {
        $or: [
          { embeddingModel: null },
          { embeddingModel: { $ne: currentModel } },
        ],
      },
      { filters: { softDelete: false } },
    );
  }
}
