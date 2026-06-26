import { Injectable, Logger } from '@nestjs/common';
import { v5 as uuidv5 } from 'uuid';

import { environment } from '../../../environments';
import type { RequestTokenUsage } from '../../litellm/litellm.types';
import { LlmModelsService } from '../../litellm/services/llm-models.service';
import { OpenaiService } from '../../openai/openai.service';
import { QdrantService } from '../../qdrant/services/qdrant.service';
import { AgentMemorySearchMatch } from '../agent-memory.types';

/** Stable namespace for deterministic agent-memory point IDs (UUID v5). */
const AGENT_MEMORY_POINT_UUID_NS = '8f2a1c64-3d7e-4b9a-9c1d-2e6f0a5b7c83';

/** Coordinates of one memory entry — the key a deterministic point ID is built from. */
export interface AgentMemoryVectorRef {
  projectId: string;
  namespace: string;
  key: string;
}

interface AgentMemoryEmbedInput extends AgentMemoryVectorRef {
  title: string | null;
  value: unknown;
}

// A plain object `type` (not an interface) so it satisfies Qdrant's
// `Record<string, unknown>` payload type — interfaces carry no implicit index
// signature and would be rejected at upsert.
type AgentMemoryPayload = {
  projectId: string;
  namespace: string;
  key: string;
  title: string | null;
};

/**
 * The semantic (vector) layer for agent memory (M2). Owns the single shared
 * Qdrant collection, embed-on-write, project-filtered search, and vector
 * deletion. Every write is best-effort and never throws into the caller's
 * transaction: the Postgres row is the source of truth, the vector is a derived
 * index. All vectors share one collection and are isolated purely by the
 * `projectId` payload filter — the validated `projectId` is the trust boundary
 * (mirrors AgentMemoryService).
 *
 * Derived-index coverage caveats (search-invisible rows, all reachable by key via
 * memory_get / memory_list):
 * - A KV entry whose embed failed is re-embedded on its next overwrite.
 * - An append entry (immutable, unique key) is never re-embedded, so a failed
 *   embed leaves it permanently unsearchable.
 * - Rows written before M2 deployed have no vector at all (no backfill — see
 *   milestone-2 §3; out of scope this milestone).
 */
@Injectable()
export class AgentMemoryVectorService {
  private readonly logger = new Logger(AgentMemoryVectorService.name);
  /** Collections whose `projectId` payload index has been ensured this process. */
  private readonly indexedCollections = new Set<string>();

  constructor(
    private readonly qdrantService: QdrantService,
    private readonly openaiService: OpenaiService,
    private readonly llmModelsService: LlmModelsService,
  ) {}

  private get collection(): string {
    return this.qdrantService.buildSizedCollectionName(
      'agent_memory',
      environment.llmEmbeddingDimensions,
    );
  }

  private pointId(ref: AgentMemoryVectorRef): string {
    return uuidv5(
      `${ref.projectId}|${ref.namespace}|${ref.key}`,
      AGENT_MEMORY_POINT_UUID_NS,
    );
  }

  private buildEmbedInput(title: string | null, value: unknown): string {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    const text = [title, body].filter(Boolean).join('\n\n');
    return text.slice(0, environment.agentMemoryEmbedMaxChars);
  }

  /**
   * Embed an entry and upsert its vector under a deterministic point ID so a KV
   * overwrite replaces the vector in place. Best-effort: never throws — the row
   * is already persisted. Returns the embed token usage for cost attribution
   * whenever the (billed) embeddings call succeeded, EVEN IF the subsequent
   * Qdrant upsert failed — LiteLLM has already charged for that call, and
   * discarding the usage would hide an incurred cost from the per-thread rollup
   * (`.claude/rules/cost-accounting.md`). Returns `undefined` only when the
   * embeddings call itself failed (nothing billed) or produced no usage.
   *
   * The vector is a derived index: when the upsert fails the row stays searchable
   * by key (memory_get) but not by meaning until the next KV overwrite re-embeds
   * it. An append row (immutable, unique key) is never re-embedded, so a failed
   * embed leaves it permanently search-invisible — acceptable under M2 scope (no
   * backfill; see milestone-2 §3).
   */
  async embedEntry(
    input: AgentMemoryEmbedInput,
  ): Promise<RequestTokenUsage | undefined> {
    // Captured the instant the embeddings call resolves, before the upsert can
    // throw, so a downstream Qdrant failure still attributes the billed cost.
    let billedUsage: RequestTokenUsage | undefined;
    try {
      const text = this.buildEmbedInput(input.title, input.value);
      const result = await this.openaiService.embeddings({
        model: this.llmModelsService.getKnowledgeEmbeddingModel(),
        input: text,
        dimensions: environment.llmEmbeddingDimensions,
      });
      billedUsage = result.usage;
      const vector = result.embeddings[0];
      if (!vector) {
        this.logger.warn('Embed produced no vector; skipping memory upsert', {
          projectId: input.projectId,
          namespace: input.namespace,
          key: input.key,
        });
        return billedUsage;
      }

      const payload: AgentMemoryPayload = {
        projectId: input.projectId,
        namespace: input.namespace,
        key: input.key,
        title: input.title,
      };
      await this.qdrantService.upsertPoints(this.collection, [
        { id: this.pointId(input), vector, payload },
      ]);
      await this.ensureProjectIndex();
      return billedUsage;
    } catch (error) {
      // Embed/upsert failure must not fail the already-committed write. Log the
      // coordinates and a short message only — never the value (user content).
      // Return whatever was billed: undefined if the embeddings call threw (no
      // charge), or the captured usage if only the upsert/index step failed.
      this.logger.warn('Best-effort memory embed failed; row persisted', {
        projectId: input.projectId,
        namespace: input.namespace,
        key: input.key,
        error: error instanceof Error ? error.message : String(error),
      });
      return billedUsage;
    }
  }

  /**
   * Semantic search within a single project. Embeds the query and returns the
   * closest entries' coordinates (no bodies) plus the query-embed usage for cost
   * attribution. Results are constrained to `projectId` by a payload filter, so
   * one project can never see another's memory.
   *
   * Unlike {@link embedEntry} (a best-effort write that never throws), this read
   * is fail-loud: an embeddings or Qdrant failure propagates to the caller. A
   * degraded vector backend surfaces as an explicit tool/HTTP error the agent can
   * reason about, rather than a silent empty result that looks like "nothing
   * matched" — the write must not block the user's save, but a failed recall
   * should not masquerade as no-matches.
   */
  async search(
    projectId: string,
    query: string,
    limit: number,
  ): Promise<{ matches: AgentMemorySearchMatch[]; usage?: RequestTokenUsage }> {
    const normalized = query.trim();
    if (!normalized) {
      return { matches: [] };
    }

    const result = await this.openaiService.embeddings({
      model: this.llmModelsService.getKnowledgeEmbeddingModel(),
      input: normalized,
      dimensions: environment.llmEmbeddingDimensions,
    });
    const vector = result.embeddings[0];
    if (!vector) {
      return { matches: [], usage: result.usage };
    }

    const hits = await this.qdrantService.searchPoints(
      this.collection,
      vector,
      limit,
      {
        filter: { must: [{ key: 'projectId', match: { value: projectId } }] },
        with_payload: true,
      },
    );

    const matches = hits
      .map((hit) => this.parsePayload(hit.payload))
      .filter((match): match is AgentMemorySearchMatch => match !== null);

    return { matches, usage: result.usage };
  }

  /** Delete the vector for one entry by its deterministic point ID. Best-effort. */
  async deleteEntry(ref: AgentMemoryVectorRef): Promise<void> {
    await this.deleteByIds([this.pointId(ref)], ref.projectId);
  }

  /** Delete the vectors for several entries (e.g. prune victims). Best-effort. */
  async deleteEntries(refs: AgentMemoryVectorRef[]): Promise<void> {
    const [first] = refs;
    if (!first) {
      return;
    }
    await this.deleteByIds(
      refs.map((ref) => this.pointId(ref)),
      first.projectId,
    );
  }

  private async deleteByIds(ids: string[], projectId: string): Promise<void> {
    try {
      await this.qdrantService.deleteByFilter(this.collection, {
        must: [{ has_id: ids }],
      });
    } catch (error) {
      this.logger.warn('Best-effort memory vector delete failed', {
        projectId,
        count: ids.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureProjectIndex(): Promise<void> {
    const collection = this.collection;
    if (this.indexedCollections.has(collection)) {
      return;
    }
    // Must run after the first upsert: ensurePayloadIndex no-ops on a collection
    // that does not exist yet, and the collection is created lazily inside
    // upsertPoints. Idempotent, so a missed cache (e.g. dropped collection) just
    // re-ensures on the next write.
    await this.qdrantService.ensurePayloadIndex(
      collection,
      'projectId',
      'keyword',
    );
    this.indexedCollections.add(collection);
  }

  private parsePayload(payload: unknown): AgentMemorySearchMatch | null {
    if (typeof payload !== 'object' || payload === null) {
      return null;
    }
    const record = payload as Record<string, unknown>;
    const { namespace, key, title } = record;
    if (typeof namespace !== 'string' || typeof key !== 'string') {
      return null;
    }
    return {
      namespace,
      key,
      title: typeof title === 'string' ? title : null,
    };
  }
}
