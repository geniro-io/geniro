import { beforeEach, describe, expect, it, Mock, vi } from 'vitest';

import type { RequestTokenUsage } from '../../litellm/litellm.types';
import { LlmModelsService } from '../../litellm/services/llm-models.service';
import { OpenaiService } from '../../openai/openai.service';
import { QdrantService } from '../../qdrant/services/qdrant.service';
import { AgentMemoryVectorService } from './agent-memory-vector.service';

// A non-zero price so "the embed billed but its cost vanished" is distinguishable
// from a genuine $0 embed. LiteLLM has already charged this once the embeddings()
// call resolves; nothing downstream can un-bill it.
const BILLED_EMBED_USAGE: RequestTokenUsage = {
  inputTokens: 10,
  outputTokens: 0,
  totalTokens: 10,
  totalPrice: 0.00042,
};

describe('AgentMemoryVectorService embed-on-write cost attribution', () => {
  let qdrant: {
    upsertPoints: Mock;
    ensurePayloadIndex: Mock;
    buildSizedCollectionName: Mock;
    deleteByFilter: Mock;
    searchPoints: Mock;
  };
  let openai: { embeddings: Mock };
  let models: { getKnowledgeEmbeddingModel: Mock };
  let service: AgentMemoryVectorService;

  beforeEach(() => {
    qdrant = {
      upsertPoints: vi.fn().mockResolvedValue(undefined),
      ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
      buildSizedCollectionName: vi.fn().mockReturnValue('agent_memory_1536'),
      deleteByFilter: vi.fn().mockResolvedValue(undefined),
      searchPoints: vi.fn().mockResolvedValue([]),
    };
    openai = {
      embeddings: vi.fn().mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
        usage: BILLED_EMBED_USAGE,
      }),
    };
    models = { getKnowledgeEmbeddingModel: vi.fn().mockReturnValue('embed') };
    service = new AgentMemoryVectorService(
      qdrant as unknown as QdrantService,
      openai as unknown as OpenaiService,
      models as unknown as LlmModelsService,
    );
  });

  it('still attributes the billed embed cost when the Qdrant upsert fails after the embed call succeeded', async () => {
    // The embed call resolves successfully (LiteLLM has billed BILLED_EMBED_USAGE);
    // only the subsequent vector upsert fails. The row is already persisted, so the
    // write must not roll back — but the cost the LLM proxy already charged must
    // still be attributed, or the thread's totalPrice under-reports real spend.
    qdrant.upsertPoints.mockRejectedValue(new Error('qdrant unavailable'));

    const usage = await service.embedEntry({
      projectId: 'project-1',
      namespace: 'facts',
      key: 'k',
      title: null,
      value: 'we run Postgres for the database',
    });

    expect(openai.embeddings).toHaveBeenCalledTimes(1);
    expect(usage?.totalPrice).toBe(0.00042);
  });

  it('attributes the full billed usage when both embed and upsert succeed', async () => {
    const usage = await service.embedEntry({
      projectId: 'project-1',
      namespace: 'facts',
      key: 'k',
      title: 'DB',
      value: 'Postgres',
    });

    expect(usage).toEqual(BILLED_EMBED_USAGE);
  });

  it('attributes the billed cost but skips the upsert when the embed returns no vector', async () => {
    // A 200 with an empty embeddings array (a real LiteLLM degradation) still
    // billed; the row must not get a vector, but the cost is still attributed.
    openai.embeddings.mockResolvedValue({
      embeddings: [],
      usage: BILLED_EMBED_USAGE,
    });

    const usage = await service.embedEntry({
      projectId: 'project-1',
      namespace: 'facts',
      key: 'k',
      title: null,
      value: 'no vector came back',
    });

    expect(usage?.totalPrice).toBe(0.00042);
    expect(qdrant.upsertPoints).not.toHaveBeenCalled();
  });
});
