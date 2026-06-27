import { createHash } from 'node:crypto';

import { Injectable, OnModuleInit } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import { z } from 'zod';

import { environment } from '../../../environments';
import { GitProvider } from '../../git-auth/git-auth.types';
import { GitTokenResolverService } from '../../git-auth/services/git-token-resolver.service';
import { LlmModelsService } from '../../litellm/services/llm-models.service';
import { OpenaiService } from '../../openai/openai.service';
import { QdrantService } from '../../qdrant/services/qdrant.service';
import { RuntimeInstanceDao } from '../../runtime/dao/runtime-instance.dao';
import { RuntimeProvider } from '../../runtime/services/runtime-provider';
import { shQuote } from '../../utils/shell.utils';
import { GitRepositoriesDao } from '../dao/git-repositories.dao';
import { RepoIndexDao } from '../dao/repo-index.dao';
import { GitRepositoryEntity } from '../entity/git-repository.entity';
import { RepoIndexEntity } from '../entity/repo-index.entity';
import { RepoIndexStatus } from '../git-repositories.types';
import {
  GetOrInitIndexParams,
  GetOrInitIndexResult,
  SearchCodebaseParams,
  SearchCodebaseResult,
} from './repo-index.types';
import {
  RepoIndexJobData,
  RepoIndexQueueService,
} from './repo-index-queue.service';
import {
  CODEBASE_COLLECTION_PREFIX,
  JobCancelledException,
  RepoExecFn,
  RepoIndexerService,
} from './repo-indexer.service';

const REPO_CLONE_DIR = '/workspace/repo';

const SYSTEM_RUNTIME_NODE_ID = 'repo-indexer';

/** Timeout for git commands inside the ephemeral container. */
const CONTAINER_EXEC_TIMEOUT_MS = 120_000;
/** Tail timeout for ephemeral container exec. */
const CONTAINER_TAIL_TIMEOUT_MS = 30_000;

const EMBEDDING_CACHE_MAX_SIZE = 200;
const EMBEDDING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const QUERY_EXPANSION_CACHE_MAX_SIZE = 100;
const QUERY_EXPANSION_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Minimum topK to trigger query expansion — focused searches (small topK)
// don't benefit enough from LLM-based expansion to justify the latency.
const QUERY_EXPANSION_MIN_TOP_K = 10;

/** Shallow clone depth to avoid OOM for very large repositories. */
const GIT_CLONE_DEPTH = 100;

const CodeSearchQueryExpansionSchema = z.object({
  queries: z.array(z.string().min(1)).min(1).max(5),
});

type CachedEmbedding = { embedding: number[]; timestamp: number };
type CachedQueryExpansion = { queries: string[]; timestamp: number };

@Injectable()
export class RepoIndexService implements OnModuleInit {
  private readonly embeddingCache = new Map<string, CachedEmbedding>();
  private readonly queryExpansionCache = new Map<
    string,
    CachedQueryExpansion
  >();

  constructor(
    private readonly repoIndexDao: RepoIndexDao,
    private readonly gitRepositoriesDao: GitRepositoriesDao,
    private readonly gitTokenResolverService: GitTokenResolverService,
    private readonly repoIndexerService: RepoIndexerService,
    private readonly repoIndexQueueService: RepoIndexQueueService,
    private readonly llmModelsService: LlmModelsService,
    private readonly openaiService: OpenaiService,
    private readonly qdrantService: QdrantService,
    private readonly runtimeProvider: RuntimeProvider,
    private readonly runtimeInstanceDao: RuntimeInstanceDao,
    private readonly logger: DefaultLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    this.repoIndexQueueService.setCallbacks({
      onProcess: async (data, signal) => {
        await this.processIndexJob(data, signal);
      },
      onStalled: this.handleStalledJob.bind(this),
      onRetry: this.handleRetryJob.bind(this),
      onFailed: this.handleFailedJob.bind(this),
    });
    await this.recoverStuckJobs();
    // Run cleanup asynchronously to avoid blocking module initialization.
    // Errors are caught internally — fire-and-forget is safe here.
    void this.cleanupOrphanedIndexes();
  }

  /**
   * Called when a job is detected as stalled (server died mid-processing).
   * Resets the database status so the job can be reprocessed.
   */
  private async handleStalledJob(repoIndexId: string): Promise<void> {
    this.logger.warn('Repo index job stalled, resetting status', {
      repoIndexId,
    });

    await this.repoIndexDao.updateById(repoIndexId, {
      status: RepoIndexStatus.Pending,
    });
  }

  /**
   * Called when a job fails but will be retried by BullMQ.
   * Resets entity to Pending so it doesn't appear stuck as InProgress
   * while waiting for the retry.
   */
  private async handleRetryJob(
    repoIndexId: string,
    error: Error,
  ): Promise<void> {
    this.logger.warn('Repo index job failed, will be retried', {
      repoIndexId,
      error: error.message,
    });

    await this.repoIndexDao.updateById(repoIndexId, {
      status: RepoIndexStatus.Pending,
    });
  }

  /**
   * Called when a job fails after all retries are exhausted.
   */
  private async handleFailedJob(
    repoIndexId: string,
    error: Error,
  ): Promise<void> {
    this.logger.error(error, 'Repo index job failed permanently', {
      repoIndexId,
    });

    await this.repoIndexDao.updateById(repoIndexId, {
      status: RepoIndexStatus.Failed,
      errorMessage: error.message,
    });
  }

  /**
   * On server restart, re-enqueue any incomplete indexing jobs.
   * The database is the source of truth - if status is Pending/InProgress,
   * the job needs to be in the queue.
   */
  private async recoverStuckJobs(): Promise<void> {
    try {
      const incompleteJobs = await this.repoIndexDao.getAll({
        status: [RepoIndexStatus.InProgress, RepoIndexStatus.Pending],
      });

      if (incompleteJobs.length === 0) {
        return;
      }

      this.logger.warn('Recovering incomplete repo index jobs on startup', {
        count: incompleteJobs.length,
      });

      // Clean stale active jobs from the previous worker before re-adding,
      // otherwise BullMQ's stalled detection races with the new jobs.
      await this.repoIndexQueueService.cleanStaleActiveJobs();

      for (const index of incompleteJobs) {
        // Reset to Pending (in case it was InProgress when server died)
        await this.repoIndexDao.updateById(index.id, {
          status: RepoIndexStatus.Pending,
        });

        await this.repoIndexQueueService.addIndexJob({
          repoIndexId: index.id,
          repoUrl: index.repoUrl,
          branch: index.branch,
        });

        this.logger.debug('Re-enqueued incomplete repo index job', {
          repoIndexId: index.id,
          previousStatus: index.status,
        });
      }
    } catch (err) {
      this.logger.error(
        err instanceof Error ? err : new Error(String(err)),
        'Failed to recover incomplete repo index jobs',
      );
    }
  }

  /**
   * On server startup, remove orphaned Qdrant collections, orphaned DB rows,
   * and stale indexes that haven't been updated within the configured threshold.
   */
  private async cleanupOrphanedIndexes(): Promise<void> {
    try {
      const maxAgeDays = environment.codebaseIndexMaxAgeDays;
      const staleThreshold = new Date(
        Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
      );

      // 1. Fetch all codebase_* Qdrant collections and all DB rows
      const qdrantResult = await this.qdrantService.getCollections();
      const codebaseCollections = qdrantResult.collections
        .map((c) => c.name)
        .filter((name) => name.startsWith(CODEBASE_COLLECTION_PREFIX));

      const allIndexes = await this.repoIndexDao.getAll({});

      const dbCollectionNames = new Set(
        allIndexes
          .map((i) => i.qdrantCollection)
          .filter((name): name is string => Boolean(name)),
      );
      const qdrantCollectionNames = new Set(codebaseCollections);

      // 2. Delete orphaned Qdrant collections (no matching DB row)
      for (const collection of codebaseCollections) {
        if (!dbCollectionNames.has(collection)) {
          try {
            await this.qdrantService.deleteCollection(collection);
            this.logger.warn('Deleted orphaned Qdrant collection', {
              collection,
            });
          } catch (err) {
            this.logger.warn('Failed to delete orphaned Qdrant collection', {
              collection,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // 3. Identify indexes to delete (orphaned or stale)
      const indexesToDelete: { index: RepoIndexEntity; reason: string }[] = [];
      for (const index of allIndexes) {
        // Skip in-progress/pending — collection may not be created yet
        if (
          index.status === RepoIndexStatus.InProgress ||
          index.status === RepoIndexStatus.Pending
        ) {
          continue;
        }

        const isOrphaned =
          index.qdrantCollection &&
          !qdrantCollectionNames.has(index.qdrantCollection);
        const isStale = index.updatedAt < staleThreshold;

        if (isOrphaned) {
          indexesToDelete.push({ index, reason: 'orphaned' });
        } else if (isStale) {
          indexesToDelete.push({ index, reason: 'stale' });
        }
      }

      // Build set of collections still referenced by surviving (non-deleted) rows
      const deletedIds = new Set(indexesToDelete.map((e) => e.index.id));
      const survivingCollections = new Set(
        allIndexes
          .filter((i) => !deletedIds.has(i.id) && i.qdrantCollection)
          .map((i) => i.qdrantCollection),
      );

      // 4. Execute deletions
      const deletedCollections = new Set<string>();
      for (const { index, reason } of indexesToDelete) {
        // Delete the Qdrant collection only if no surviving row still references it
        // and we haven't already deleted it in a previous iteration
        if (
          index.qdrantCollection &&
          qdrantCollectionNames.has(index.qdrantCollection) &&
          !survivingCollections.has(index.qdrantCollection) &&
          !deletedCollections.has(index.qdrantCollection)
        ) {
          try {
            await this.qdrantService.deleteCollection(index.qdrantCollection);
            deletedCollections.add(index.qdrantCollection);
          } catch (err) {
            this.logger.warn(
              'Failed to delete Qdrant collection for stale index',
              {
                collection: index.qdrantCollection,
                repoIndexId: index.id,
                error: err instanceof Error ? err.message : String(err),
              },
            );
          }
        }

        // Cancel any pending BullMQ job
        await this.repoIndexQueueService.removeJob(index.id);

        // Delete the DB row
        await this.repoIndexDao.deleteById(index.id);
        this.logger.warn(`Deleted ${reason} repo index`, {
          repoIndexId: index.id,
          qdrantCollection: index.qdrantCollection,
          updatedAt: index.updatedAt,
        });
      }

      if (indexesToDelete.length > 0 || deletedCollections.size > 0) {
        this.logger.warn('Orphaned index cleanup summary', {
          deletedDbRows: indexesToDelete.length,
          deletedQdrantCollections: deletedCollections.size,
        });
      }
    } catch (err) {
      this.logger.error(
        err instanceof Error ? err : new Error(String(err)),
        'Failed to cleanup orphaned indexes',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Public: main entry points called by tools
  // ---------------------------------------------------------------------------

  async getOrInitIndexForRepo(
    params: GetOrInitIndexParams,
  ): Promise<GetOrInitIndexResult> {
    let { repositoryId } = params;
    const { repoRoot, execFn, branch, userId } = params;

    // Resolve the real git_repositories record so we use its actual ID
    // instead of the caller-computed UUID. This ensures we find the existing
    // repo_indexes row and reuse it for incremental reindexing.
    const resolvedRepo = await this.resolveGitRepository(
      params.repoUrl,
      userId,
    );
    if (resolvedRepo) {
      repositoryId = resolvedRepo.id;
    }

    // Acquire an advisory lock on (repositoryId, branch) to prevent two
    // concurrent agents from both deciding "no existing index → create one".
    // The lock covers only the check + claim phase; actual indexing runs after
    // the lock is released.
    const claim = await this.repoIndexDao.withIndexLock(
      repositoryId,
      branch,
      () =>
        this.claimIndexSlot(
          repositoryId,
          params.repoUrl,
          branch,
          execFn,
          repoRoot,
        ),
    );

    if (claim.earlyReturn) {
      return claim.earlyReturn;
    }

    // Destructure the claimed slot — we now own the entity with InProgress/Pending status
    const { entity, repoUrl, needsFullReindex, indexParams, estimatedTokens } =
      claim;

    if (estimatedTokens <= environment.codebaseIndexTokenThreshold) {
      // Inline indexing — small repo, do it now
      this.logger.debug('Using inline indexing strategy');

      try {
        // Create a callback to update indexed token progress using atomic increment
        const onProgressUpdate = this.createProgressCallback(entity.id);

        if (needsFullReindex) {
          await this.repoIndexerService.runFullIndex(
            indexParams,
            execFn,
            undefined,
            onProgressUpdate,
          );
        } else {
          await this.repoIndexerService.runIncrementalIndex(
            indexParams,
            execFn,
            undefined,
            onProgressUpdate,
          );
        }

        // After indexing, count the actual total tokens in Qdrant to get an
        // accurate number that reflects the real state of the collection.
        const totalIndexedTokens =
          await this.repoIndexerService.countIndexedTokens(
            indexParams.collection,
            indexParams.repoId,
          );

        await this.repoIndexDao.updateById(entity.id, {
          status: RepoIndexStatus.Completed,
          lastIndexedCommit: indexParams.currentCommit,
          errorMessage: null,
          estimatedTokens: totalIndexedTokens,
          indexedTokens: totalIndexedTokens,
        });

        return {
          status: 'ready',
          repoIndex: {
            ...entity,
            status: RepoIndexStatus.Completed,
            lastIndexedCommit: indexParams.currentCommit,
            indexedTokens: totalIndexedTokens,
            estimatedTokens: totalIndexedTokens,
          },
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await this.repoIndexDao.updateById(entity.id, {
          status: RepoIndexStatus.Failed,
          errorMessage,
        });
        throw err;
      }
    }

    // Background indexing — large repo
    this.logger.debug('Using background indexing strategy');

    // Switch entity to Pending since we claimed it as InProgress in the lock
    await this.repoIndexDao.updateById(entity.id, {
      status: RepoIndexStatus.Pending,
    });

    const jobData: RepoIndexJobData = {
      repoIndexId: entity.id,
      repoUrl,
      branch,
    };

    await this.repoIndexQueueService.addIndexJob(jobData);

    this.logger.debug('Repo index job enqueued', {
      repoIndexId: entity.id,
      repoUrl,
      estimatedTokens,
    });

    return {
      status: 'pending',
      repoIndex: { ...entity, status: RepoIndexStatus.Pending },
    };
  }

  /**
   * Runs inside the advisory lock. Checks existing state, calculates metadata,
   * and creates/updates the entity to "claim" the indexing slot.
   * Returns either an early result (already done / in progress) or the claimed
   * entity + indexing parameters for the caller to execute outside the lock.
   */
  private async claimIndexSlot(
    repositoryId: string,
    originalRepoUrl: string,
    branch: string,
    execFn: RepoExecFn,
    repoRoot: string,
  ): Promise<
    | { earlyReturn: GetOrInitIndexResult }
    | {
        earlyReturn?: undefined;
        entity: RepoIndexEntity;
        repoUrl: string;
        needsFullReindex: boolean;
        indexParams: {
          repoId: string;
          repoRoot: string;
          currentCommit: string;
          collection: string;
          vectorSize: number;
          embeddingModel: string;
          lastIndexedCommit?: string;
        };
        estimatedTokens: number;
      }
  > {
    // Normalize the URL so the Qdrant repo_id is always consistent
    // (strips .git suffix, converts SSH to HTTPS, etc.)
    let repoUrl = this.repoIndexerService.deriveRepoId(originalRepoUrl);

    const existing = await this.repoIndexDao.getOne({
      repositoryId,
      branch,
    });

    // Use the existing index's repoUrl to keep the Qdrant repo_id filter
    // consistent between old and new points (e.g. URL with/without .git suffix).
    if (existing) {
      repoUrl = existing.repoUrl;
    }

    // If indexing is actively running, return immediately.
    // Repair-on-read: if the row has been sitting in Pending/InProgress beyond
    // the staleness window, the BullMQ job may be lost (Redis flush, worker
    // eviction, or crash between updateById and queue.add). Reset and re-enqueue
    // so the next user interaction unblocks the zombie row. `recoverStuckJobs`
    // only runs on module init, so long-lived pods need this in-path recovery.
    //
    // Two-layer defense: `updatedAt` is the first filter (age > window), but a
    // slow embedding batch (many large files × slow LiteLLM) can stall
    // `incrementIndexedTokens` for >2 min while the worker is still alive.
    // The BullMQ `getJobState` check is the second layer — it confirms the job
    // is not actively being processed before force-failing and re-enqueueing.
    // Both conditions must hold before the repair fires.
    if (
      existing &&
      (existing.status === RepoIndexStatus.InProgress ||
        existing.status === RepoIndexStatus.Pending)
    ) {
      const ageMs = Date.now() - new Date(existing.updatedAt).getTime();
      if (ageMs > environment.codebaseIndexStaleMs) {
        const jobState = await this.repoIndexQueueService.getJobState(
          existing.id,
        );
        if (jobState === 'active') {
          this.logger.debug(
            'Stale repo index row but BullMQ job is active, skipping repair',
            { repoIndexId: existing.id, ageMs, jobState },
          );
        } else {
          this.logger.warn(
            'Stale repo index detected, re-enqueueing background job',
            {
              repoIndexId: existing.id,
              previousStatus: existing.status,
              ageMs,
              jobState,
              indexedTokens: existing.indexedTokens,
              estimatedTokens: existing.estimatedTokens,
            },
          );
          // Repair is best-effort — enqueue the job FIRST so that if Redis
          // is flaky and `addIndexJob` throws, `updatedAt` is NOT refreshed
          // by `updateById`. A stale `updatedAt` means the next
          // `codebase_search` call will see the row as still-stale and retry
          // the repair once Redis recovers. If `addIndexJob` succeeds, we
          // mark the row Pending so the staleness window restarts accurately.
          try {
            await this.repoIndexQueueService.addIndexJob({
              repoIndexId: existing.id,
              repoUrl: existing.repoUrl,
              branch: existing.branch,
            });
            await this.repoIndexDao.updateById(existing.id, {
              status: RepoIndexStatus.Pending,
              errorMessage: null,
            });
          } catch (repairErr) {
            this.logger.warn('Failed to re-enqueue stale repo index job', {
              repoIndexId: existing.id,
              error:
                repairErr instanceof Error
                  ? repairErr.message
                  : String(repairErr),
            });
          }
        }
      }
      return { earlyReturn: { status: 'in_progress', repoIndex: existing } };
    }

    // Determine current state
    const { embeddingModel, vectorSize, chunkingSignatureHash, collection } =
      await this.repoIndexerService.calculateIndexMetadata(
        repositoryId,
        branch,
      );
    const currentCommit = await this.repoIndexerService.resolveCurrentCommit(
      repoRoot,
      execFn,
    );

    // If completed and up-to-date, return ready
    if (existing && existing.status === RepoIndexStatus.Completed) {
      if (
        existing.lastIndexedCommit === currentCommit &&
        existing.embeddingModel === embeddingModel &&
        existing.vectorSize === vectorSize &&
        existing.chunkingSignatureHash === chunkingSignatureHash
      ) {
        return { earlyReturn: { status: 'ready', repoIndex: existing } };
      }
    }

    const strategy = await this.resolveIndexStrategy(
      existing,
      repositoryId,
      repoRoot,
      execFn,
      collection,
      currentCommit,
      { embeddingModel, vectorSize, chunkingSignatureHash },
      repoUrl,
    );

    const {
      needsFullReindex,
      lastIndexedCommit,
      estimatedTokens,
      seededTokens,
    } = strategy;

    this.logger.debug(
      'Estimated tokens calculated, deciding indexing strategy',
      {
        repoIndexId: existing?.id,
        estimatedTokens,
        seededTokens,
        threshold: environment.codebaseIndexTokenThreshold,
        willIndexInline:
          estimatedTokens <= environment.codebaseIndexTokenThreshold,
      },
    );

    // For incremental reindex, carry previous total so the progress bar stays meaningful.
    // When seeded from a donor branch, use the donor's token count as the baseline.
    const previousTotalTokens =
      !needsFullReindex && existing && existing.estimatedTokens > 0
        ? existing.estimatedTokens
        : !needsFullReindex && seededTokens && seededTokens > 0
          ? seededTokens
          : undefined;

    // Claim the slot by upserting the entity with InProgress status.
    // Any concurrent caller that arrives here will see InProgress and bail out.
    const entity = await this.upsertIndexEntity({
      existing,
      repositoryId,
      repoUrl,
      branch,
      status: RepoIndexStatus.InProgress,
      qdrantCollection: collection,
      embeddingModel,
      vectorSize,
      chunkingSignatureHash,
      estimatedTokens,
      previousTotalTokens,
    });

    return {
      entity,
      repoUrl,
      needsFullReindex,
      indexParams: {
        repoId: repoUrl,
        repoRoot,
        currentCommit,
        collection,
        vectorSize,
        embeddingModel,
        lastIndexedCommit,
      },
      estimatedTokens,
    };
  }

  async searchCodebase(
    params: SearchCodebaseParams,
  ): Promise<SearchCodebaseResult[]> {
    const {
      collection,
      query,
      repoId,
      topK,
      directoryFilter,
      languageFilter,
      minScore,
    } = params;

    const embeddingModel = this.llmModelsService.getKnowledgeEmbeddingModel();

    // For focused queries (low topK) use a single embedding; for broader
    // searches, expand the query into variants for better recall.
    const useExpansion = topK >= QUERY_EXPANSION_MIN_TOP_K;

    let embeddings: number[][];
    if (useExpansion) {
      // Run query expansion and primary embedding in parallel to reduce latency.
      // The primary embedding is always needed; expansion variants are additive.
      const [primaryEmbedding, variants] = await Promise.all([
        this.getOrComputeEmbedding(embeddingModel, query),
        this.generateCodeSearchVariants(query),
      ]);

      // Embed the expansion variants (excluding the original, which is already embedded).
      // Use case-insensitive comparison to avoid duplicating near-identical queries.
      const queryLower = query.toLowerCase().trim();
      const additionalVariants = variants.filter(
        (v) => v.toLowerCase().trim() !== queryLower,
      );
      if (additionalVariants.length > 0) {
        const additionalEmbeddings = await this.batchGetOrComputeEmbeddings(
          embeddingModel,
          additionalVariants,
        );
        embeddings = [primaryEmbedding, ...additionalEmbeddings];
      } else {
        embeddings = [primaryEmbedding];
      }
    } else {
      embeddings = [await this.getOrComputeEmbedding(embeddingModel, query)];
    }

    // Expand search limit to allow post-filtering without losing relevant results.
    // When multiple query variants are used, each variant already broadens coverage
    // so a smaller per-variant factor avoids scanning excessive points.
    const factor =
      embeddings.length > 1
        ? environment.codebaseSearchOverfetchFactorWithVariants
        : environment.codebaseSearchOverfetchFactor;
    const searchLimit = topK * factor;
    const repoFilter = this.repoIndexerService.buildRepoFilter(repoId);

    // Search Qdrant. searchPoints/searchMany guard collection existence, so a
    // collection that was deleted (or never created) between indexing and search
    // yields no matches rather than throwing — no special-casing needed here. A
    // genuine search failure (a degraded backend, or a missing payload index on an
    // existing collection — both of which a broad "not found" string-match would
    // misread as cold-start) propagates fail-loud instead of looking like
    // "no results".
    type SearchResultItem = Awaited<
      ReturnType<QdrantService['searchPoints']>
    >[number];
    let allMatches: SearchResultItem[];
    if (embeddings.length === 1) {
      allMatches = await this.qdrantService.searchPoints(
        collection,
        embeddings[0]!,
        searchLimit,
        { filter: repoFilter, with_payload: true },
      );
    } else {
      const batchResults = await this.qdrantService.searchMany(
        collection,
        embeddings.map((vector) => ({
          vector,
          limit: searchLimit,
          filter: repoFilter,
          with_payload: true,
          with_vector: false,
        })),
      );
      // Deduplicate by point ID, keeping the highest score
      const bestByPointId = new Map<string | number, SearchResultItem>();
      for (const results of batchResults) {
        for (const match of results) {
          const existing = bestByPointId.get(match.id);
          if (!existing || match.score > existing.score) {
            bestByPointId.set(match.id, match);
          }
        }
      }
      allMatches = Array.from(bestByPointId.values()).sort(
        (a, b) => b.score - a.score,
      );
    }

    // Parse and filter results
    const results = allMatches
      .map((match) => this.parseSearchResult(match))
      .filter((match): match is SearchCodebaseResult => Boolean(match))
      .filter((match) => (minScore != null ? match.score >= minScore : true))
      .filter((match) => this.matchesPathPrefix(match, directoryFilter))
      .filter((match) => this.matchesLanguage(match, languageFilter))
      .slice(0, topK);

    return results;
  }

  // ---------------------------------------------------------------------------
  // Private: BullMQ processor
  // ---------------------------------------------------------------------------

  private async processIndexJob(
    data: RepoIndexJobData,
    signal?: AbortSignal,
  ): Promise<void> {
    const { repoIndexId, branch } = data;
    // Normalize so the Qdrant repo_id is consistent regardless of source
    const repoUrl = this.repoIndexerService.deriveRepoId(data.repoUrl);

    this.logger.debug('Processing repo index job', {
      repoIndexId,
      repoUrl,
    });

    const entity = await this.repoIndexDao.getOne({ id: repoIndexId });
    if (!entity) {
      this.logger.warn('Repo index entity not found, skipping job', {
        repoIndexId,
      });
      return;
    }
    if (entity.status === RepoIndexStatus.Completed) {
      this.logger.debug('Repo index already completed, skipping job', {
        repoIndexId,
      });
      return;
    }

    if (signal?.aborted) {
      this.logger.debug('Repo index job cancelled before start', {
        repoIndexId,
      });
      return;
    }

    await this.repoIndexDao.updateById(repoIndexId, {
      status: RepoIndexStatus.InProgress,
      errorMessage: null,
      // Preserve indexedTokens from pending state (for incremental reindex this
      // already accounts for the untouched portion set by upsertIndexEntity)
      indexedTokens: entity.indexedTokens,
      // Preserve estimatedTokens from pending state (will be recalculated in container)
      estimatedTokens: entity.estimatedTokens,
    });

    const runtimeNodeId = SYSTEM_RUNTIME_NODE_ID;
    const threadId = repoIndexId;

    let runtimeInstance: Awaited<
      ReturnType<typeof this.runtimeProvider.provide>
    > | null = null;

    try {
      this.logger.debug('Spinning up ephemeral container for repo indexing', {
        repoIndexId,
      });

      // Spin up ephemeral container (no graphId — repo indexing is a system operation)
      try {
        runtimeInstance = await this.runtimeProvider.provide({
          runtimeNodeId,
          threadId,
          type: this.runtimeProvider.getDefaultRuntimeType(),
          temporary: true,
          runtimeStartParams: {},
        });
      } catch (err) {
        if (err instanceof JobCancelledException) {
          throw err;
        }
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to start sandbox for repository indexing. ` +
            `This may be a transient infrastructure issue — try re-indexing. ` +
            `Detail: ${detail}`,
          { cause: err },
        );
      }

      this.logger.debug('Container started, beginning clone', {
        repoIndexId,
        repoUrl,
      });

      const runtime = runtimeInstance.runtime;

      const execFn: RepoExecFn = async (params) => {
        const res = await runtime.exec({
          cmd: params.cmd,
          sessionId: threadId,
          timeoutMs: CONTAINER_EXEC_TIMEOUT_MS,
          tailTimeoutMs: CONTAINER_TAIL_TIMEOUT_MS,
        });
        return {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
        };
      };

      // Build authenticated clone URL using GitHub App token resolution
      const gitRepo = await this.gitRepositoriesDao.getOne({
        id: entity.repositoryId,
      });
      const cloneUrl = await this.buildCloneUrlFromEntity(repoUrl, gitRepo);

      // Clean up any existing repo directory from previous runs
      await execFn({
        cmd: `rm -rf ${shQuote(REPO_CLONE_DIR)}`,
      });

      // Clone repo with depth limit to avoid OOM for very large repos
      const branchFlag = branch ? `--branch ${shQuote(branch)} ` : '';
      const cloneRes = await execFn({
        cmd: `git clone --depth ${GIT_CLONE_DEPTH} ${branchFlag}${shQuote(cloneUrl)} ${shQuote(REPO_CLONE_DIR)}`,
      });

      if (cloneRes.exitCode !== 0) {
        const sanitizedErr = RepoIndexService.sanitizeUrl(cloneRes.stderr);
        // Provide a clear message when the branch doesn't exist on the remote
        if (branch && sanitizedErr.includes('not found in upstream')) {
          throw new Error(
            `Branch '${branch}' not found on remote. If this is a local branch, push it first (git push origin ${branch}) before using codebase search.`,
          );
        }
        throw new Error(`git clone failed: ${sanitizedErr}`);
      }

      if (signal?.aborted) {
        this.logger.debug('Repo index job cancelled after clone', {
          repoIndexId,
        });
        return;
      }

      // If this is a reindex (entity has a lastIndexedCommit), deepen the
      // shallow clone so the commit is reachable for estimateChangedTokenCount.
      // runIncrementalIndex also calls ensureCommitReachable internally, but
      // that second call is a no-op (single git cat-file check) since the
      // commit is already reachable after this first pass.
      if (entity.lastIndexedCommit) {
        const reachable = await this.repoIndexerService.ensureCommitReachable(
          REPO_CLONE_DIR,
          entity.lastIndexedCommit,
          RepoIndexerService.withTimeout(execFn),
        );
        if (!reachable) {
          this.logger.warn(
            'lastIndexedCommit unreachable after deepening, incremental estimate may be inaccurate',
            { repoIndexId, commit: entity.lastIndexedCommit },
          );
        }
      }

      // Resolve current state in the fresh clone
      const { embeddingModel, vectorSize, chunkingSignatureHash, collection } =
        await this.repoIndexerService.calculateIndexMetadata(
          entity.repositoryId,
          branch,
        );
      // Read-only discovery (commit resolution + strategy estimate) runs on the
      // raw orchestrator execFn, which under heavy parallel load can resolve a
      // git read as a transient exit-124 timeout. Wrap those reads with the same
      // retry+timeout the index passes use, so a transient neither aborts the job
      // (resolveCurrentCommit throws on a failed read) nor mis-sizes the
      // inline-vs-background routing (estimate maps a failed read to 0). The
      // clone/rm-rf above stay on the raw execFn — they are not safe to retry.
      const readExecFn = RepoIndexerService.withRetry(
        RepoIndexerService.withTimeout(execFn),
      );
      const currentCommit = await this.repoIndexerService.resolveCurrentCommit(
        REPO_CLONE_DIR,
        readExecFn,
      );

      const strategy = await this.resolveIndexStrategy(
        entity,
        entity.repositoryId,
        REPO_CLONE_DIR,
        readExecFn,
        collection,
        currentCommit,
        { embeddingModel, vectorSize, chunkingSignatureHash },
        repoUrl,
      );

      const { needsFullReindex, lastIndexedCommit } = strategy;

      // For incremental reindex, keep the previous total as the estimate
      // so the progress bar stays meaningful (previous total ≈ final total).
      const effectiveEstimated =
        !needsFullReindex && entity.estimatedTokens > 0
          ? entity.estimatedTokens
          : strategy.estimatedTokens;

      this.logger.debug('Estimated tokens calculated for indexing', {
        repoIndexId,
        estimatedTokens: effectiveEstimated,
        needsFullReindex,
      });

      // Update metadata fields now so they're visible during indexing
      await this.repoIndexDao.updateById(repoIndexId, {
        embeddingModel,
        vectorSize,
        chunkingSignatureHash,
        qdrantCollection: collection,
        estimatedTokens: effectiveEstimated,
      });

      const indexParams = {
        repoId: repoUrl,
        repoRoot: REPO_CLONE_DIR,
        currentCommit,
        collection,
        vectorSize,
        embeddingModel,
        lastIndexedCommit,
      };

      // Create a callback to update runtime activity (keeps container alive during indexing)
      const updateRuntimeActivity = async () => {
        await this.updateRuntimeLastUsedAt(runtimeNodeId, threadId);
      };

      // Create a callback to update indexed token progress using atomic increment
      const onProgressUpdate = this.createProgressCallback(repoIndexId);

      if (needsFullReindex) {
        await this.repoIndexerService.runFullIndex(
          indexParams,
          execFn,
          updateRuntimeActivity,
          onProgressUpdate,
          signal,
        );
      } else {
        await this.repoIndexerService.runIncrementalIndex(
          indexParams,
          execFn,
          updateRuntimeActivity,
          onProgressUpdate,
          signal,
        );
      }

      // After indexing, count the actual total tokens in Qdrant to get an
      // accurate number that reflects the real state of the collection.
      const totalIndexedTokens =
        await this.repoIndexerService.countIndexedTokens(collection, repoUrl);

      await this.repoIndexDao.updateById(repoIndexId, {
        status: RepoIndexStatus.Completed,
        lastIndexedCommit: currentCommit,
        embeddingModel,
        vectorSize,
        chunkingSignatureHash,
        qdrantCollection: collection,
        errorMessage: null,
        estimatedTokens: totalIndexedTokens,
        indexedTokens: totalIndexedTokens,
      });

      this.logger.debug('Repo index job completed', {
        repoIndexId,
        currentCommit,
        indexedTokens: totalIndexedTokens,
      });
    } catch (err) {
      if (err instanceof JobCancelledException) {
        this.logger.debug('Repo index job cancelled, exiting cleanly', {
          repoIndexId,
        });
        return;
      }
      // If the abort signal fired (repo was deleted), treat any error as
      // cancellation — the Qdrant collection may have been deleted mid-flight,
      // causing 404s or fetch failures that are not JobCancelledException.
      if (signal?.aborted) {
        this.logger.debug(
          'Repo index job failed after cancellation signal, treating as cancelled',
          {
            repoIndexId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        return;
      }
      throw err;
    } finally {
      // Cleanup ephemeral container
      if (runtimeInstance) {
        await this.runtimeProvider
          .cleanupRuntimeInstance({
            runtimeNodeId,
            threadId,
            type: this.runtimeProvider.getDefaultRuntimeType(),
          })
          .catch((err: unknown) => {
            this.logger.warn(
              'Failed to cleanup runtime instance after indexing',
              {
                runtimeNodeId,
                threadId,
                error: err instanceof Error ? err.message : String(err),
              },
            );
          });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: helpers
  // ---------------------------------------------------------------------------

  private static readonly LOG_TOKEN_INTERVAL = 50_000;

  /**
   * Creates a progress callback for indexing operations.
   * Uses atomic increment to avoid race conditions when batches complete concurrently.
   * Logs progress at intervals to reduce noise.
   */
  private createProgressCallback(
    repoIndexId: string,
  ): (tokenCount: number) => Promise<void> {
    let totalTokensProcessed = 0;
    let lastLoggedThreshold = 0;

    return async (tokenCount: number) => {
      // Atomically increment the token counter in DB
      await this.repoIndexDao.incrementIndexedTokens(repoIndexId, tokenCount);

      // Track locally for logging decisions (approximate is fine for logging)
      totalTokensProcessed += tokenCount;

      // Log when we cross a new threshold
      const currentThreshold =
        Math.floor(totalTokensProcessed / RepoIndexService.LOG_TOKEN_INTERVAL) *
        RepoIndexService.LOG_TOKEN_INTERVAL;

      if (currentThreshold > lastLoggedThreshold) {
        this.logger.debug('Indexing progress updated', {
          repoIndexId,
          approximateTokens: totalTokensProcessed,
        });
        lastLoggedThreshold = currentThreshold;
      }
    };
  }

  /**
   * Updates the runtime instance's lastUsedAt timestamp to prevent cleanup
   * during long-running indexing operations
   */
  private async updateRuntimeLastUsedAt(
    nodeId: string,
    threadId: string,
  ): Promise<void> {
    try {
      const instance = await this.runtimeInstanceDao.getOne({
        nodeId,
        threadId,
      });

      if (instance) {
        await this.runtimeInstanceDao.updateById(instance.id, {
          lastUsedAt: new Date(),
        });
      }
    } catch (error) {
      // Don't fail indexing if we can't update lastUsedAt
      this.logger.warn('Failed to update runtime lastUsedAt', {
        nodeId,
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Shared logic to determine full vs incremental indexing, attempt cross-branch
   * seeding, and estimate token counts. Used by both claimIndexSlot (inline) and
   * processIndexJob (background) to avoid duplicating this decision tree.
   */
  private async resolveIndexStrategy(
    existing: RepoIndexEntity | null,
    repositoryId: string,
    repoRoot: string,
    execFn: RepoExecFn,
    collection: string,
    currentCommit: string,
    config: {
      embeddingModel: string;
      vectorSize: number;
      chunkingSignatureHash: string;
    },
    repoUrl?: string,
  ): Promise<{
    needsFullReindex: boolean;
    lastIndexedCommit?: string;
    estimatedTokens: number;
    /** Token count inherited from a donor branch via cross-branch seeding. */
    seededTokens?: number;
  }> {
    const noExisting = !existing;
    const previousFailed = existing?.status === RepoIndexStatus.Failed;
    const configChanged =
      existing != null &&
      this.needsFullReindexDueToConfigChange(existing, config);
    let needsFullReindex = noExisting || previousFailed || configChanged;

    this.logger.debug('Index strategy resolved', {
      repositoryId,
      needsFullReindex,
      reason: noExisting
        ? 'no_existing_index'
        : previousFailed
          ? 'previous_failed'
          : configChanged
            ? 'config_changed'
            : 'incremental',
      lastIndexedCommit: existing?.lastIndexedCommit,
      currentCommit,
      existingEmbeddingModel: existing?.embeddingModel,
      currentEmbeddingModel: config.embeddingModel,
    });

    // Cross-branch seeding: when no index exists (or no last commit),
    // copy points from a sibling branch
    let donorCommit: string | undefined;
    let seededTokens: number | undefined;
    if (needsFullReindex && !existing?.lastIndexedCommit) {
      const seeding = await this.attemptCrossBranchSeeding(
        repositoryId,
        collection,
        repoUrl,
      );
      if (seeding.seeded) {
        donorCommit = seeding.donorCommit;
        seededTokens = seeding.donorTokens;
        needsFullReindex = false;
      }
    }

    const lastIndexedCommit = needsFullReindex
      ? undefined
      : (existing?.lastIndexedCommit ?? donorCommit ?? undefined);

    let estimatedTokens: number;
    if (needsFullReindex || !lastIndexedCommit) {
      estimatedTokens = await this.repoIndexerService.estimateTokenCount(
        repoRoot,
        execFn,
      );
    } else {
      estimatedTokens = await this.repoIndexerService.estimateChangedTokenCount(
        repoRoot,
        lastIndexedCommit,
        currentCommit,
        execFn,
      );
    }

    return {
      needsFullReindex,
      lastIndexedCommit,
      estimatedTokens,
      seededTokens,
    };
  }

  /**
   * Determines if a full reindex is needed due to config changes.
   * Does NOT check for entity existence or status - caller handles those.
   */
  private needsFullReindexDueToConfigChange(
    entity: {
      lastIndexedCommit: string | null;
      embeddingModel: string | null;
      vectorSize: number | null;
      chunkingSignatureHash: string | null;
    },
    currentConfig: {
      embeddingModel: string;
      vectorSize: number;
      chunkingSignatureHash: string;
    },
  ): boolean {
    return (
      !entity.lastIndexedCommit ||
      entity.embeddingModel !== currentConfig.embeddingModel ||
      entity.vectorSize !== currentConfig.vectorSize ||
      entity.chunkingSignatureHash !== currentConfig.chunkingSignatureHash
    );
  }

  /**
   * Strip embedded credentials (e.g. `token@` or `user:pass@`) from URLs
   * so they don't leak into log entries or error messages.
   */
  private static sanitizeUrl(text: string): string {
    return text.replace(/\/\/[^@/]+@/g, '//');
  }

  /**
   * Parse owner/repo from a git URL. Returns null for non-URL strings
   * (e.g. `local:…` paths) or URLs with fewer than two path segments.
   */
  private static parseOwnerRepo(
    repoUrl: string,
  ): { url: URL; owner: string; repo: string } | null {
    try {
      const url = new URL(repoUrl);
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (pathParts.length < 2) {
        return null;
      }
      const owner = pathParts[0];
      const repo = pathParts[1]?.replace(/\.git$/, '');
      if (!owner || !repo) {
        return null;
      }
      return { url, owner, repo };
    } catch {
      return null;
    }
  }

  /**
   * Try to find the real GitRepositoryEntity by parsing owner/repo from a URL.
   * Scopes the lookup to a specific user when `createdBy` is provided to avoid
   * cross-user data leakage.
   * Returns null if the URL can't be parsed or no matching record exists.
   */
  private async resolveGitRepository(
    repoUrl: string,
    createdBy?: string,
  ): Promise<GitRepositoryEntity | null> {
    const parsed = RepoIndexService.parseOwnerRepo(repoUrl);
    if (!parsed) {
      return null;
    }

    const searchParams: { owner: string; repo: string; createdBy?: string } = {
      owner: parsed.owner,
      repo: parsed.repo,
    };
    if (createdBy) {
      searchParams.createdBy = createdBy;
    }
    return this.gitRepositoriesDao.getOne(searchParams);
  }

  /**
   * Build an authenticated clone URL using GitHub App token resolution.
   * Falls back to the unauthenticated URL for public repos when no token is available.
   */
  private async buildCloneUrlFromEntity(
    repoUrl: string,
    gitRepo: GitRepositoryEntity | null,
  ): Promise<string> {
    const parsed = RepoIndexService.parseOwnerRepo(repoUrl);
    if (!parsed) {
      return repoUrl;
    }

    // gitRepo.createdBy is trusted — it originates from a DB record, not user input.
    const resolved = gitRepo
      ? await this.gitTokenResolverService.resolveToken(
          GitProvider.GitHub,
          gitRepo.owner,
          gitRepo.createdBy,
        )
      : null;

    if (!resolved) {
      return `https://github.com/${parsed.owner}/${parsed.repo}.git`;
    }

    return `https://x-access-token:${resolved.token}@github.com/${parsed.owner}/${parsed.repo}.git`;
  }

  /**
   * Try to seed a new branch index by copying points from an existing
   * completed index on a sibling branch. Extracted to avoid duplicating
   * the donor-finding logic between inline and background indexing paths.
   */
  private async attemptCrossBranchSeeding(
    repositoryId: string,
    targetCollection: string,
    repoUrl?: string,
  ): Promise<{ seeded: boolean; donorCommit?: string; donorTokens?: number }> {
    // First try finding a donor by repositoryId (same user's repo entity)
    let donors = await this.repoIndexDao.getAll(
      { repositoryId, status: RepoIndexStatus.Completed },
      { limit: 1, orderBy: { updatedAt: 'DESC' } },
    );

    // Fallback: find a donor by repoUrl (covers cross-user scenarios where
    // different users have different repositoryId values for the same repo)
    if (donors.length === 0 && repoUrl) {
      donors = await this.repoIndexDao.getAll(
        { repoUrl, status: RepoIndexStatus.Completed },
        { limit: 1, orderBy: { updatedAt: 'DESC' } },
      );
    }

    const donor = donors[0];

    if (!donor?.lastIndexedCommit || !donor.qdrantCollection) {
      return { seeded: false };
    }

    this.logger.debug('Seeding new branch index from donor', {
      repositoryId,
      donorCollection: donor.qdrantCollection,
      donorCommit: donor.lastIndexedCommit,
      donorTokens: donor.indexedTokens,
    });

    await this.repoIndexerService.copyCollectionPoints(
      donor.qdrantCollection,
      targetCollection,
    );

    return {
      seeded: true,
      donorCommit: donor.lastIndexedCommit,
      donorTokens: donor.indexedTokens,
    };
  }

  private async upsertIndexEntity(params: {
    existing: RepoIndexEntity | null;
    repositoryId: string;
    repoUrl: string;
    branch: string;
    status: RepoIndexStatus;
    qdrantCollection: string;
    embeddingModel: string;
    vectorSize: number;
    chunkingSignatureHash: string;
    estimatedTokens: number;
    /** For incremental reindex: carry over the previous total as estimatedTokens
     *  and set indexedTokens to (previousTotal - changedEstimate) instead of 0. */
    previousTotalTokens?: number;
  }): Promise<RepoIndexEntity> {
    // For incremental reindex keep the previous total as the estimate
    // and set indexedTokens to the untouched portion so progress starts close to max.
    const effectiveEstimated =
      params.previousTotalTokens ?? params.estimatedTokens;
    const effectiveIndexed = params.previousTotalTokens
      ? Math.max(0, params.previousTotalTokens - params.estimatedTokens)
      : 0;

    const payload = {
      status: params.status,
      qdrantCollection: params.qdrantCollection,
      embeddingModel: params.embeddingModel,
      vectorSize: params.vectorSize,
      chunkingSignatureHash: params.chunkingSignatureHash,
      estimatedTokens: effectiveEstimated,
      indexedTokens: effectiveIndexed,
      errorMessage: null,
    };

    if (params.existing) {
      await this.repoIndexDao.updateById(params.existing.id, payload);
      // updateById returns affected row count — refetch the entity
      const refreshed = await this.repoIndexDao.getById(params.existing.id);
      return (
        refreshed ?? ({ ...params.existing, ...payload } as RepoIndexEntity)
      );
    }

    // Check for a soft-deleted row with the same (repositoryId, branch).
    // The unique constraint still covers soft-deleted rows, so we must
    // restore + update instead of creating a new row.
    const softDeleted = await this.repoIndexDao.getOne(
      { repositoryId: params.repositoryId, branch: params.branch },
      { filters: { softDelete: false } },
    );

    if (softDeleted) {
      await this.repoIndexDao.restoreById(softDeleted.id);
      await this.repoIndexDao.updateById(softDeleted.id, {
        repoUrl: params.repoUrl,
        lastIndexedCommit: null,
        ...payload,
      });
      const refreshed = await this.repoIndexDao.getById(softDeleted.id);
      return refreshed ?? ({ ...softDeleted, ...payload } as RepoIndexEntity);
    }

    return this.repoIndexDao.create({
      repositoryId: params.repositoryId,
      repoUrl: params.repoUrl,
      branch: params.branch,
      lastIndexedCommit: null,
      ...payload,
    });
  }

  /**
   * Generate alternative search queries for code search to improve recall.
   * Uses an LLM to rephrase the original query into code-oriented variants
   * (function names, class names, file paths, etc.).
   */
  private async generateCodeSearchVariants(query: string): Promise<string[]> {
    const cacheKey = query.trim().toLowerCase();
    const cached = this.queryExpansionCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < QUERY_EXPANSION_CACHE_TTL_MS) {
      // Touch entry for LRU: delete + re-insert moves it to the end
      this.queryExpansionCache.delete(cacheKey);
      this.queryExpansionCache.set(cacheKey, cached);
      return cached.queries;
    }

    try {
      const prompt = [
        'Generate 3-5 short search queries or keyword phrases for finding relevant code in a repository.',
        'Return ONLY JSON with key "queries": string[].',
        'Rules:',
        '- Include the original query verbatim.',
        '- Include variants that use likely function/class/variable names.',
        '- Include variants that describe the code pattern or file type.',
        '- Keep each query under 12 words.',
        '- Deduplicate queries.',
        '',
        `QUERY: ${query}`,
      ].join('\n');

      const modelName = this.llmModelsService.getKnowledgeSearchModel();
      const response = await this.openaiService.jsonRequest<{
        queries: string[];
      }>({
        model: modelName,
        message: prompt,
        jsonSchema: CodeSearchQueryExpansionSchema,
      });

      const validation = CodeSearchQueryExpansionSchema.safeParse(
        response.content,
      );
      if (!validation.success) {
        return [query];
      }

      const unique = new Set<string>();
      unique.add(query);
      for (const item of validation.data.queries) {
        const normalized = item.trim();
        if (normalized) {
          unique.add(normalized);
        }
      }

      const result = Array.from(unique).slice(0, 5);

      // Cache the expansion result
      if (this.queryExpansionCache.size >= QUERY_EXPANSION_CACHE_MAX_SIZE) {
        const oldest = this.queryExpansionCache.keys().next().value;
        if (oldest !== undefined) {
          this.queryExpansionCache.delete(oldest);
        }
      }
      this.queryExpansionCache.set(cacheKey, {
        queries: result,
        timestamp: Date.now(),
      });

      return result;
    } catch (error) {
      this.logger.warn('Failed to expand code search query, using original', {
        query,
        error: error instanceof Error ? error.message : String(error),
      });
      return [query];
    }
  }

  /**
   * Embed multiple texts in a single batch API call for uncached queries.
   * Returns embeddings in the same order as the input texts.
   * Cached entries are served from the cache; only uncached texts hit the API.
   */
  private async batchGetOrComputeEmbeddings(
    model: string,
    texts: string[],
  ): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    if (texts.length === 1) {
      return [await this.getOrComputeEmbedding(model, texts[0]!)];
    }

    const now = Date.now();
    const results: (number[] | null)[] = new Array<number[] | null>(
      texts.length,
    ).fill(null);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    // Collect cached results and identify uncached texts
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      const cacheKey = RepoIndexService.embeddingCacheKey(model, text);
      const cached = this.embeddingCache.get(cacheKey);
      if (cached && now - cached.timestamp < EMBEDDING_CACHE_TTL_MS) {
        // LRU touch
        this.embeddingCache.delete(cacheKey);
        this.embeddingCache.set(cacheKey, cached);
        results[i] = cached.embedding;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(text);
      }
    }

    // Batch-embed all uncached texts in a single API call
    if (uncachedTexts.length > 0) {
      const apiResult = await this.openaiService.embeddings({
        model,
        input: uncachedTexts,
        dimensions: environment.llmEmbeddingDimensions,
      });

      // Evict enough entries upfront to make room for all new embeddings
      const overflow =
        this.embeddingCache.size +
        uncachedTexts.length -
        EMBEDDING_CACHE_MAX_SIZE;
      if (overflow > 0) {
        const keys = this.embeddingCache.keys();
        for (let e = 0; e < overflow; e++) {
          const key = keys.next().value;
          if (key !== undefined) {
            this.embeddingCache.delete(key);
          }
        }
      }

      for (let j = 0; j < uncachedTexts.length; j++) {
        const embedding = apiResult.embeddings[j];
        if (!embedding) {
          continue;
        }

        const idx = uncachedIndices[j]!;
        results[idx] = embedding;

        const cacheKey = RepoIndexService.embeddingCacheKey(
          model,
          uncachedTexts[j]!,
        );
        this.embeddingCache.set(cacheKey, { embedding, timestamp: now });
      }
    }

    // Verify all slots are filled
    const final = results.filter((r): r is number[] => r !== null);
    if (final.length !== texts.length) {
      throw new Error('Failed to generate embeddings for all query variants');
    }
    return final;
  }

  private async getOrComputeEmbedding(
    model: string,
    text: string,
  ): Promise<number[]> {
    const cacheKey = RepoIndexService.embeddingCacheKey(model, text);
    const cached = this.embeddingCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.timestamp < EMBEDDING_CACHE_TTL_MS) {
      // Touch entry for LRU: delete + re-insert moves it to the end
      this.embeddingCache.delete(cacheKey);
      this.embeddingCache.set(cacheKey, cached);
      return cached.embedding;
    }

    const result = await this.openaiService.embeddings({
      model,
      input: [text],
      dimensions: environment.llmEmbeddingDimensions,
    });

    if (result.embeddings.length === 0 || !result.embeddings[0]) {
      throw new Error('Failed to generate embedding for query');
    }

    const embedding = result.embeddings[0];

    // Evict oldest entries when cache is full
    if (this.embeddingCache.size >= EMBEDDING_CACHE_MAX_SIZE) {
      const firstKey = this.embeddingCache.keys().next().value;
      if (firstKey !== undefined) {
        this.embeddingCache.delete(firstKey);
      }
    }

    this.embeddingCache.set(cacheKey, { embedding, timestamp: now });
    return embedding;
  }

  private parseSearchResult(
    match: Awaited<ReturnType<QdrantService['searchPoints']>>[number],
  ): SearchCodebaseResult | null {
    const payload = (match.payload ?? {}) as Partial<{
      repo_id: string;
      path: string;
      start_line: number;
      end_line: number;
      total_lines: number;
      text: string;
    }>;

    if (!payload.path || !payload.text) {
      return null;
    }

    const startLine = Number(payload.start_line ?? 1);
    const endLine = Number(payload.end_line ?? startLine);
    const totalLines =
      payload.total_lines != null ? Number(payload.total_lines) : undefined;

    return {
      path: String(payload.path),
      start_line: Number.isFinite(startLine) ? startLine : 1,
      end_line: Number.isFinite(endLine) ? endLine : startLine,
      ...(totalLines != null && Number.isFinite(totalLines)
        ? { total_lines: totalLines }
        : {}),
      text: String(payload.text),
      score: match.score ?? 0,
    };
  }

  private matchesPathPrefix(
    match: SearchCodebaseResult,
    directory?: string,
  ): boolean {
    if (!directory) {
      return true;
    }

    const normalized = directory.replace(/\\/g, '/').replace(/^\/+/, '');
    const withoutSlash = normalized.replace(/\/+$/, '');

    if (!withoutSlash) {
      return true;
    }

    return (
      match.path === withoutSlash || match.path.startsWith(`${withoutSlash}/`)
    );
  }

  /** Build a short, fixed-length cache key for embedding lookups.
   *  Uses SHA-256 instead of the raw text to keep Map memory bounded. */
  private static embeddingCacheKey(model: string, text: string): string {
    return `${model}:${createHash('sha256').update(text).digest('hex')}`;
  }

  /** Maps common language names to file extensions for flexible filtering. */
  private static readonly LANGUAGE_TO_EXTENSIONS: Record<string, string[]> = {
    typescript: ['ts', 'tsx'],
    javascript: ['js', 'jsx', 'mjs', 'cjs'],
    python: ['py', 'pyw'],
    rust: ['rs'],
    golang: ['go'],
    go: ['go'],
    java: ['java'],
    kotlin: ['kt', 'kts'],
    swift: ['swift'],
    ruby: ['rb'],
    csharp: ['cs'],
    'c#': ['cs'],
    'c++': ['cpp', 'cc', 'cxx', 'hpp', 'hxx', 'h'],
    cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hxx', 'h'],
    c: ['c', 'h'],
    php: ['php'],
    scala: ['scala'],
    shell: ['sh', 'bash', 'zsh'],
    bash: ['sh', 'bash'],
    html: ['html', 'htm'],
    css: ['css', 'scss', 'sass', 'less'],
    sql: ['sql'],
    yaml: ['yaml', 'yml'],
    json: ['json'],
    markdown: ['md', 'mdx'],
    vue: ['vue'],
    svelte: ['svelte'],
    dart: ['dart'],
    elixir: ['ex', 'exs'],
    haskell: ['hs'],
    lua: ['lua'],
    zig: ['zig'],
  };

  private matchesLanguage(
    match: SearchCodebaseResult,
    language?: string,
  ): boolean {
    if (!language) {
      return true;
    }

    const normalized = language.trim().toLowerCase();
    if (!normalized) {
      return true;
    }

    const extension = match.path.split('.').pop()?.toLowerCase();
    if (!extension) {
      return false;
    }

    // First try direct extension match (e.g. "ts", "py")
    if (extension === normalized) {
      return true;
    }

    // Then try language name → extensions mapping (e.g. "typescript" → ["ts", "tsx"])
    const mappedExtensions =
      RepoIndexService.LANGUAGE_TO_EXTENSIONS[normalized];
    if (mappedExtensions) {
      return mappedExtensions.includes(extension);
    }

    return false;
  }
}
