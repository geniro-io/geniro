import { createHash } from 'node:crypto';
import { posix as posixPath } from 'node:path';

import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import ignore from 'ignore';
import { v5 as uuidv5 } from 'uuid';

import { environment } from '../../../environments';
import { LitellmService } from '../../litellm/services/litellm.service';
import { LlmModelsService } from '../../litellm/services/llm-models.service';
import { OpenaiService } from '../../openai/openai.service';
import { QdrantService } from '../../qdrant/services/qdrant.service';
import { shQuote } from '../../utils/shell.utils';
// Batch size for upserting points (copy, seed, etc.) to avoid overwhelming Qdrant
const POINT_COPY_BATCH_SIZE = 500;

// Page size for Qdrant scroll requests. scrollAll/scrollAllWithVectors
// paginate automatically, so this only controls memory per page.
const QDRANT_SCROLL_PAGE_SIZE = 1000;

// Number of files to flush per batch during full indexing
const FULL_INDEX_BATCH_FILE_COUNT = 15;

// Number of files to flush per batch during incremental indexing
const INCREMENTAL_BATCH_FILE_COUNT = 50;

// Number of files to read concurrently from the runtime container.
// Higher values overlap I/O latency but increase memory pressure.
const FILE_READ_CONCURRENCY = 20;

// Maximum number of Qdrant points to scroll during prefetch before aborting.
// Guards against pathological repos with an extreme number of indexed chunks.
const PREFETCH_MAX_POINTS = 500_000;

// Conventional exit code the runtime returns when an exec is killed by a
// timeout or session restart (vs a genuine git error). The Docker session-exec
// path resolves a tail-timeout / session-restart with this code WITHOUT
// throwing, so it is the signal used to distinguish a transient, retryable
// failure from a legitimate non-zero exit (e.g. `[ -f missing ]` → 1).
const GIT_EXEC_TIMEOUT_EXIT_CODE = 124;

// Bounded retry for idempotent git reads that hit a transient exec timeout
// under heavy parallel load. Total attempts including the first; linear backoff.
const GIT_READ_RETRY_ATTEMPTS = 3;
const GIT_READ_RETRY_DELAY_MS = 500;

/** Shared prefix for all codebase index Qdrant collections. */
export const CODEBASE_COLLECTION_PREFIX = 'codebase_';

export type RepoExecFn = (params: {
  cmd: string;
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

type ChunkDescriptor = {
  text: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  chunkHash: string;
  tokenCount: number;
};

type ChunkBatchItem = {
  repoId: string;
  commit: string;
  filePath: string;
  fileHash: string;
  totalLines: number;
  chunk: ChunkDescriptor;
};

type FileIndexInput = {
  relativePath: string;
  content: string;
  fileHash: string;
};

type QdrantPointPayload = {
  repo_id: string;
  path: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  text: string;
  chunk_hash: string;
  file_hash: string;
  commit: string;
  indexed_at: string;
  token_count: number;
};

type PrefetchedChunkInfo = {
  fileHash: string;
  tokenCount: number;
  commit: string;
};

export interface RepoIndexParams {
  repoId: string;
  repoRoot: string;
  currentCommit: string;
  collection: string;
  vectorSize: number;
  embeddingModel: string;
  lastIndexedCommit?: string;
}

/** Thrown when a job detects it has been cancelled (e.g., repository deleted). */
export class JobCancelledException extends Error {
  constructor(message = 'Job cancelled') {
    super(message);
    this.name = 'JobCancelledException';
  }
}

@Injectable()
export class RepoIndexerService {
  private static readonly IGNORE_CACHE_MAX_SIZE = 50;

  /**
   * Built-in file patterns excluded from indexing by default.
   * Covers binary assets, compiled artifacts, lock files, minified bundles, and
   * dependency / build / cache / tooling DIRECTORIES that are semantically
   * useless for vector search and waste tokens.
   *
   * Directory patterns matter most for COMMITTED tooling metadata (`.github`,
   * `.husky`, `.cursor`, …) that a repo's `.gitignore` does NOT cover — the
   * dependency/build/cache dirs are usually already `.gitignore`'d (the indexer
   * loads `.gitignore` too, see {@link buildIgnoreMatcher}), so listing them
   * here is belt-and-braces for repos with an incomplete `.gitignore`.
   *
   * Patterns are gitignore-syntax: a bare name (e.g. `node_modules`, `.github`)
   * matches that file/dir at ANY depth and ignores everything under it. A repo
   * can re-include anything via a negation in `.codebaseindexignore` (e.g.
   * `!*.svg`, `!.github/workflows/deploy.yml`).
   */
  private static readonly BUILTIN_EXCLUDE_PATTERNS: string[] = [
    // Images
    '*.png',
    '*.jpg',
    '*.jpeg',
    '*.gif',
    '*.bmp',
    '*.tiff',
    '*.tif',
    '*.ico',
    '*.webp',
    '*.avif',
    '*.heic',
    '*.heif',
    '*.raw',
    '*.svg',
    // Fonts
    '*.ttf',
    '*.otf',
    '*.woff',
    '*.woff2',
    '*.eot',
    // Audio / video
    '*.mp3',
    '*.mp4',
    '*.wav',
    '*.ogg',
    '*.flac',
    '*.aac',
    '*.avi',
    '*.mov',
    '*.mkv',
    '*.webm',
    // Archives
    '*.zip',
    '*.tar',
    '*.gz',
    '*.bz2',
    '*.xz',
    '*.7z',
    '*.rar',
    // Compiled / binary
    '*.exe',
    '*.dll',
    '*.so',
    '*.dylib',
    '*.bin',
    '*.obj',
    '*.o',
    '*.a',
    '*.class',
    '*.pyc',
    '*.pyo',
    '*.pyd',
    '*.wasm',
    // PDF / office documents
    '*.pdf',
    '*.doc',
    '*.docx',
    '*.xls',
    '*.xlsx',
    '*.ppt',
    '*.pptx',
    // Lock files
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'composer.lock',
    'Gemfile.lock',
    'Cargo.lock',
    'go.sum',
    'poetry.lock',
    'packages.lock.json',
    // Minified bundles
    '*.min.js',
    '*.min.css',
    // Source maps
    '*.map',
    // Database files
    '*.sqlite',
    '*.sqlite3',
    '*.db',
    // Dependency directories (usually .gitignore'd, but not every repo has a
    // complete one — and these are pure noise for code search regardless)
    'node_modules',
    'bower_components',
    'jspm_packages',
    // Build / compile output
    'dist',
    'build',
    'out',
    'target',
    '.next',
    '.nuxt',
    '.output',
    '.svelte-kit',
    '.gradle',
    // Caches
    '.turbo',
    '.cache',
    '.parcel-cache',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    '.tox',
    '.venv',
    'venv',
    // Coverage / test reports
    'coverage',
    '.nyc_output',
    // VCS / CI / IDE / agent-tooling metadata. Committed (so NOT covered by a
    // repo's .gitignore) yet noise for code search — the main gap built-ins fill.
    '.github',
    '.gitlab',
    '.circleci',
    '.husky',
    '.vscode',
    '.idea',
    '.cursor',
    '.claude',
    '.docker',
    // OS cruft
    '.DS_Store',
    'Thumbs.db',
    // Logs
    '*.log',
  ];

  /**
   * Approximate bytes-per-token ratio for code. English prose averages ~4,
   * but code with short identifiers, operators, and whitespace averages ~3.
   * Using 3 intentionally overestimates slightly, which is preferable for
   * budget/limit checks vs underestimating.
   */
  private static readonly BYTES_PER_TOKEN_ESTIMATE = 3;

  private readonly ignoreCache = new Map<string, ReturnType<typeof ignore>>();

  constructor(
    private readonly qdrantService: QdrantService,
    private readonly openaiService: OpenaiService,
    private readonly litellmService: LitellmService,
    private readonly llmModelsService: LlmModelsService,
    private readonly logger: DefaultLogger,
  ) {}

  /**
   * Wrap an `execFn` so every call races against a configurable timeout.
   * Prevents hung git processes from blocking indexing indefinitely.
   */
  static withTimeout(execFn: RepoExecFn, timeoutMs?: number): RepoExecFn {
    const ms = timeoutMs ?? environment.codebaseGitExecTimeoutMs;
    if (ms <= 0) {
      return execFn;
    }
    return (params) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Git exec timed out after ${ms}ms: ${params.cmd.slice(0, 120)}`,
              ),
            ),
          ms,
        );
      });
      return Promise.race([execFn(params), timeoutPromise]).finally(() => {
        clearTimeout(timer);
      });
    };
  }

  /**
   * Wrap an `execFn` so transient exec failures on idempotent git commands
   * (reads, plus idempotent fetch --deepen/--unshallow) are retried. The Docker
   * session-exec path resolves a tail-timeout or
   * session-restart with `exitCode: 124` (it does NOT throw), and `withTimeout`
   * above rejects on its own deadline. Under heavy parallel load a slow `git`
   * read can hit either path; without a retry the caller sees a failed read and
   * — for callers that map a failed read to "no data" (listTrackedFiles,
   * batchFileExists, prepareFileIndexInput, the incremental diff) — silently
   * indexes zero files. A bounded retry with linear backoff absorbs the
   * transient. Only the timeout exit code and thrown rejections are retried; a
   * legitimate non-zero exit (e.g. `[ -f missing ]` → 1, `head -c` on a missing
   * file) is returned as-is so callers that depend on it keep working.
   *
   * Compose OUTSIDE withTimeout (`withRetry(withTimeout(fn))`) so each attempt
   * gets its own deadline and the retry spans attempts.
   */
  static withRetry(
    execFn: RepoExecFn,
    attempts = GIT_READ_RETRY_ATTEMPTS,
    delayMs = GIT_READ_RETRY_DELAY_MS,
  ): RepoExecFn {
    if (attempts <= 1) {
      return execFn;
    }
    return async (params) => {
      let lastResult: {
        exitCode: number;
        stdout: string;
        stderr: string;
      } | null = null;
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const res = await execFn(params);
          if (res.exitCode !== GIT_EXEC_TIMEOUT_EXIT_CODE) {
            return res;
          }
          lastResult = res;
          lastError = undefined;
        } catch (error) {
          lastError = error;
          lastResult = null;
        }
        if (attempt < attempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, delayMs * attempt),
          );
        }
      }
      if (lastResult) {
        return lastResult;
      }
      throw lastError;
    };
  }

  // ---------------------------------------------------------------------------
  // Public: discovery helpers
  // ---------------------------------------------------------------------------

  async estimateTokenCount(
    repoRoot: string,
    execFn: RepoExecFn,
  ): Promise<number> {
    const res = await execFn({
      cmd: `git -C ${shQuote(repoRoot)} ls-tree -r --long HEAD`,
    });
    if (res.exitCode !== 0) {
      return 0;
    }

    const matcher = await this.preloadIgnoreMatcher(repoRoot, execFn);

    let totalBytes = 0;
    for (const line of res.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      // Format: <mode> <type> <hash> <size>\t<path>
      const tabIndex = trimmed.indexOf('\t');
      if (tabIndex === -1) {
        continue;
      }
      const path = trimmed.slice(tabIndex + 1);
      if (!this.shouldIndexPathSync(path, matcher)) {
        continue;
      }
      const meta = trimmed.slice(0, tabIndex).trim();
      const parts = meta.split(/\s+/);
      const size = Number.parseInt(parts[3] ?? '0', 10);
      if (Number.isFinite(size)) {
        totalBytes += size;
      }
    }

    return Math.floor(
      (totalBytes / RepoIndexerService.BYTES_PER_TOKEN_ESTIMATE) *
        this.getChunkOverlapFactor(),
    );
  }

  /**
   * Estimate token count for only the changed files between two commits,
   * including working tree changes that haven't been committed yet.
   * Used to decide if incremental indexing can run inline vs background.
   */
  async estimateChangedTokenCount(
    repoRoot: string,
    fromCommit: string,
    toCommit: string,
    execFn: RepoExecFn,
  ): Promise<number> {
    // Get list of changed files between commits
    const diffRes = await execFn({
      cmd: `git -C ${shQuote(repoRoot)} diff --name-only ${shQuote(fromCommit)}..${shQuote(toCommit)}`,
    });
    if (diffRes.exitCode !== 0) {
      // If diff fails, fall back to full estimate
      return this.estimateTokenCount(repoRoot, execFn);
    }

    const diffFiles = diffRes.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    // Also include working tree changes that runIncrementalIndex will process
    const workingTreeFiles = await this.listWorkingTreeChanges(
      repoRoot,
      execFn,
    );
    const allChangedFiles = [...new Set([...diffFiles, ...workingTreeFiles])];

    if (allChangedFiles.length === 0) {
      return 0;
    }

    // Filter out ignored files so the estimate matches what actually gets indexed
    const matcher = await this.preloadIgnoreMatcher(repoRoot, execFn);
    const filteredFiles = allChangedFiles.filter((f) =>
      this.shouldIndexPathSync(f, matcher),
    );

    if (filteredFiles.length === 0) {
      return 0;
    }

    return this.estimateFileSizes(repoRoot, filteredFiles, execFn);
  }

  /**
   * Estimate token count from a list of file paths by summing their sizes
   * from `git ls-tree` and dividing by 4.
   *
   * Files not yet committed (untracked / newly added) are not in `ls-tree HEAD`,
   * so we fall back to `stat` for any files not found in the first pass.
   */
  private async estimateFileSizes(
    repoRoot: string,
    files: string[],
    execFn: RepoExecFn,
  ): Promise<number> {
    const BATCH_SIZE = 200;
    let totalBytes = 0;
    const resolvedPaths = new Set<string>();

    // First pass: resolve sizes from git ls-tree (committed files)
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const quotedPaths = batch.map((f) => shQuote(f)).join(' ');
      const sizeRes = await execFn({
        cmd: `git -C ${shQuote(repoRoot)} ls-tree -l HEAD -- ${quotedPaths}`,
      });
      if (sizeRes.exitCode === 0 && sizeRes.stdout.trim()) {
        for (const line of sizeRes.stdout.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          // Format: <mode> <type> <hash> <size>\t<path>
          const tabIndex = trimmed.indexOf('\t');
          if (tabIndex === -1) {
            continue;
          }
          const filePath = trimmed.slice(tabIndex + 1);
          const meta = trimmed.slice(0, tabIndex).trim();
          const parts = meta.split(/\s+/);
          const size = Number.parseInt(parts[3] ?? '0', 10);
          if (Number.isFinite(size)) {
            totalBytes += size;
            resolvedPaths.add(filePath);
          }
        }
      }
    }

    // Second pass: fall back to `stat` for files not found in ls-tree
    // (untracked or newly staged files not yet committed)
    const unresolvedFiles = files.filter((f) => !resolvedPaths.has(f));
    for (let i = 0; i < unresolvedFiles.length; i += BATCH_SIZE) {
      const batch = unresolvedFiles.slice(i, i + BATCH_SIZE);
      const statCmd = batch
        .map(
          (f) =>
            `stat -c '%s' ${shQuote(`${repoRoot}/${f}`)} 2>/dev/null || true`,
        )
        .join('; ');
      const statRes = await execFn({ cmd: statCmd });
      if (statRes.exitCode === 0 && statRes.stdout.trim()) {
        for (const line of statRes.stdout.split('\n')) {
          const size = Number.parseInt(line.trim(), 10);
          if (Number.isFinite(size) && size > 0) {
            totalBytes += size;
          }
        }
      }
    }

    return Math.floor(
      (totalBytes / RepoIndexerService.BYTES_PER_TOKEN_ESTIMATE) *
        this.getChunkOverlapFactor(),
    );
  }

  async resolveCurrentCommit(
    repoRoot: string,
    execFn: RepoExecFn,
    attempts = GIT_READ_RETRY_ATTEMPTS,
    delayMs = GIT_READ_RETRY_DELAY_MS,
  ): Promise<string> {
    // `git rev-parse HEAD` in a valid repo deterministically prints a 40-char
    // SHA (exit 0, non-empty). An exit-0 result with an EMPTY stdout is
    // therefore physically impossible from git itself — under heavy parallel
    // load it is a runtime-exec transport artifact (the stdout stream closing
    // before the exec captures it). The caller's `withRetry` already absorbs the
    // exit-124 timeout case but deliberately does NOT retry an empty stdout — an
    // empty stdout is a valid result for many git reads (e.g. a clean `diff`).
    // For THIS command an empty stdout cannot be valid, so it is retried here
    // with the same bounded linear backoff. A non-zero exit is a genuine,
    // deterministic git error (e.g. not a repository) — surfaced immediately,
    // never retried.
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const res = await execFn({
        cmd: `git -C ${shQuote(repoRoot)} rev-parse HEAD`,
      });
      if (res.exitCode !== 0) {
        throw new Error(
          `Failed to resolve current commit: ${res.stderr || 'unknown error'}`,
        );
      }
      const commit = res.stdout.trim();
      if (commit) {
        return commit;
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
    throw new Error('Failed to resolve current commit: empty result');
  }

  async getCurrentBranch(
    repoRoot: string,
    execFn: RepoExecFn,
  ): Promise<string> {
    const res = await execFn({
      cmd: `git -C ${shQuote(repoRoot)} rev-parse --abbrev-ref HEAD`,
    });
    return res.stdout.trim();
  }

  // ---------------------------------------------------------------------------
  // Public: naming & signature helpers
  // ---------------------------------------------------------------------------

  /**
   * Normalize a git remote URL into a canonical identifier used as the
   * `repo_id` payload field in Qdrant and as `repo_url` in the DB.
   * Converts SSH URLs to HTTPS, strips credentials/ports, and removes `.git`.
   *
   * Handles: `git@host:path`, `ssh://[user@]host[:port]/path`, `https://…`.
   */
  deriveRepoId(url: string): string {
    let normalized = url.trim();

    // SCP-style: git@host:owner/repo.git
    if (normalized.startsWith('git@') && normalized.includes(':')) {
      const [host, pathPart] = normalized.replace('git@', '').split(':', 2);
      normalized = `https://${host}/${pathPart}`;
    }

    // ssh://[user@]host[:port]/path  →  https://host/path
    if (normalized.startsWith('ssh://')) {
      try {
        const parsed = new URL(normalized);
        normalized = `https://${parsed.hostname}${parsed.pathname}`;
      } catch {
        // Fallback: simple prefix replacement if URL parsing fails
        normalized = normalized.replace(/^ssh:\/\//, 'https://');
      }
    }

    // Strip embedded credentials (e.g. https://token@github.com/…)
    normalized = normalized.replace(/\/\/[^@/]+@/, '//');
    normalized = normalized.replace(/\.git$/i, '');
    return normalized.replace(/\/+$/, '');
  }

  deriveRepoSlug(repoId: string): string {
    const base = repoId.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const trimmed = base.replace(/^_+|_+$/g, '');
    if (trimmed.length <= 80) {
      return trimmed || 'repo';
    }
    const hash = this.hash(repoId).slice(0, 8);
    return `${trimmed.slice(0, 60)}_${hash}`;
  }

  deriveBranchSlug(branch: string): string {
    const sanitized = branch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (sanitized.length <= 30) {
      return sanitized || 'default';
    }
    const hash = this.hash(branch).slice(0, 8);
    return `${sanitized.slice(0, 20)}_${hash}`;
  }

  buildCollectionName(
    repoSlug: string,
    vectorSize: number,
    branchSlug?: string,
  ): string {
    const baseName = branchSlug
      ? `${CODEBASE_COLLECTION_PREFIX}${repoSlug}_${branchSlug}`
      : `${CODEBASE_COLLECTION_PREFIX}${repoSlug}`;
    return this.qdrantService.buildSizedCollectionName(baseName, vectorSize);
  }

  getChunkingSignatureHash(): string {
    return this.hash(this.stableStringify(this.buildChunkingSignature()));
  }

  /**
   * Ensure Qdrant payload indexes exist on key fields for efficient filtering.
   * Called once per indexing run after the collection is created.
   */
  async ensureCodebasePayloadIndexes(collection: string): Promise<void> {
    await Promise.all([
      this.qdrantService.ensurePayloadIndex(collection, 'repo_id', 'keyword'),
      this.qdrantService.ensurePayloadIndex(collection, 'path', 'keyword'),
      this.qdrantService.ensurePayloadIndex(collection, 'file_hash', 'keyword'),
    ]);
  }

  /**
   * Count the total number of indexed tokens for a repo in a Qdrant collection
   * by scrolling all points and summing their `token_count` payload field.
   * Only fetches the `token_count` field (no vectors, no text) to minimise memory.
   * Returns 0 if the collection does not exist or contains no matching points.
   *
   * Note: On the full-index path this results in a second Qdrant scroll (the
   * first being `prefetchExistingChunks`). The two cannot be merged because
   * prefetch reads the *pre-index* state while this reads the *post-index*
   * state. The scroll is lightweight (no vectors, single field) so the
   * trade-off favours correctness over saving one round-trip.
   */
  async countIndexedTokens(
    collection: string,
    repoId: string,
  ): Promise<number> {
    try {
      let total = 0;
      let offset: string | number | Record<string, unknown> | undefined;

      while (true) {
        const page = await this.qdrantService.raw.scroll(collection, {
          filter: this.buildRepoFilter(repoId),
          limit: QDRANT_SCROLL_PAGE_SIZE,
          with_payload: { include: ['token_count'] },
          with_vector: false,
          offset,
        });

        for (const point of page.points) {
          const payload = point.payload as Partial<{ token_count: number }>;
          total += payload.token_count ?? 0;
        }

        if (!page.next_page_offset) {
          break;
        }
        offset = page.next_page_offset;
      }

      return total;
    } catch (error) {
      if (QdrantService.isCollectionNotFoundError(error)) {
        return 0;
      }
      throw error;
    }
  }

  /**
   * Calculates all metadata fields needed for repository indexing.
   * This centralizes the logic that was duplicated across multiple services.
   */
  async calculateIndexMetadata(
    repositoryId: string,
    branch: string,
  ): Promise<{
    embeddingModel: string;
    vectorSize: number;
    chunkingSignatureHash: string;
    repoSlug: string;
    collection: string;
  }> {
    const embeddingModel = this.llmModelsService.getKnowledgeEmbeddingModel();
    const vectorSize = environment.llmEmbeddingDimensions;
    const chunkingSignatureHash = this.getChunkingSignatureHash();
    const repoSlug = this.deriveRepoSlug(repositoryId);
    const branchSlug = this.deriveBranchSlug(branch);
    const collection = this.buildCollectionName(
      repoSlug,
      vectorSize,
      branchSlug,
    );

    return {
      embeddingModel,
      vectorSize,
      chunkingSignatureHash,
      repoSlug,
      collection,
    };
  }

  // ---------------------------------------------------------------------------
  // Public: cross-branch seeding
  // ---------------------------------------------------------------------------

  /**
   * Copy all Qdrant points from one collection to another.
   * Used to seed a new branch's index from an existing branch.
   * The target collection is auto-created by `upsertPoints` if it does not exist.
   */
  async copyCollectionPoints(
    sourceCollection: string,
    targetCollection: string,
  ): Promise<number> {
    // Check existence via the raw client (collectionExists is private on the service)
    const collections = await this.qdrantService.raw.getCollections();
    const exists = collections.collections.some(
      (c) => c.name === sourceCollection,
    );
    if (!exists) {
      return 0;
    }

    // Process pages one at a time instead of loading all points into memory.
    // Each scroll page is upserted to the target before fetching the next.
    let totalCopied = 0;
    let offset: string | number | Record<string, unknown> | undefined;

    while (true) {
      const page = await this.qdrantService.raw.scroll(sourceCollection, {
        limit: QDRANT_SCROLL_PAGE_SIZE,
        with_payload: true,
        with_vector: true,
        offset,
      });

      const points = page.points
        .filter((p) => p.id && p.vector && p.payload)
        .map((p) => ({
          id: p.id as string,
          vector: p.vector as number[],
          payload: p.payload as Record<string, unknown>,
        }));

      // Upsert current page in batches
      for (let i = 0; i < points.length; i += POINT_COPY_BATCH_SIZE) {
        const batch = points.slice(i, i + POINT_COPY_BATCH_SIZE);
        if (batch.length > 0) {
          await this.qdrantService.upsertPoints(targetCollection, batch);
        }
      }

      totalCopied += points.length;

      if (!page.next_page_offset) {
        break;
      }
      offset = page.next_page_offset;
    }

    return totalCopied;
  }

  // ---------------------------------------------------------------------------
  // Public: indexing entry points
  // ---------------------------------------------------------------------------

  async runFullIndex(
    params: RepoIndexParams,
    rawExecFn: RepoExecFn,
    updateRuntimeActivity?: () => Promise<void>,
    onProgressUpdate?: (tokenCount: number) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const execFn = RepoIndexerService.withRetry(
      RepoIndexerService.withTimeout(rawExecFn),
    );
    await this.runFullIndexInternal(
      params,
      execFn,
      updateRuntimeActivity,
      onProgressUpdate,
      signal,
    );
  }

  /**
   * Internal full-index implementation that accepts an already timeout-wrapped
   * execFn. Used directly by runIncrementalIndex fallback to avoid
   * double-wrapping the timeout.
   */
  private async runFullIndexInternal(
    params: RepoIndexParams,
    execFn: RepoExecFn,
    updateRuntimeActivity?: () => Promise<void>,
    onProgressUpdate?: (tokenCount: number) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const files = await this.listTrackedFiles(params.repoRoot, execFn);
    const matcher = await this.preloadIgnoreMatcher(params.repoRoot, execFn);
    const filtered: string[] = [];
    for (const path of files) {
      if (this.shouldIndexPathSync(path, matcher)) {
        filtered.push(path);
      }
    }

    // Ensure payload indexes exist for efficient filtering
    await this.ensureCodebasePayloadIndexes(params.collection);

    this.logger.debug('Codebase index: starting full index', {
      repoId: params.repoId,
      repoRoot: params.repoRoot,
      totalFiles: filtered.length,
    });

    if (signal?.aborted) {
      throw new JobCancelledException('Indexing cancelled: repository deleted');
    }

    // Pre-fetch existing chunk metadata from Qdrant to avoid per-file roundtrips
    const prefetchedChunks = await this.prefetchExistingChunks(
      params.collection,
      params.repoId,
    );

    const processedPaths = await this.processFiles(filtered, params, execFn, {
      batchFileCount: FULL_INDEX_BATCH_FILE_COUNT,
      updateRuntimeActivity,
      onProgressUpdate,
      prefetchedChunks,
      checkFileExists: false,
      signal,
    });

    // Clean up orphaned chunks (files that no longer exist in the repo).
    // Pass the prefetched map's keys so we don't need a second full scroll.
    await this.cleanupOrphanedChunks(
      params.collection,
      params.repoId,
      processedPaths,
      prefetchedChunks,
    );
  }

  async runIncrementalIndex(
    params: RepoIndexParams,
    rawExecFn: RepoExecFn,
    updateRuntimeActivity?: () => Promise<void>,
    onProgressUpdate?: (tokenCount: number) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const execFn = RepoIndexerService.withRetry(
      RepoIndexerService.withTimeout(rawExecFn),
    );

    // Ensure lastIndexedCommit is reachable (shallow clones may not include it).
    // If deepening fails the diff below will also fail, triggering full-reindex
    // fallback, so we only log a warning here.
    if (params.lastIndexedCommit) {
      const reachable = await this.ensureCommitReachable(
        params.repoRoot,
        params.lastIndexedCommit,
        execFn,
      );
      if (!reachable) {
        this.logger.warn(
          'lastIndexedCommit unreachable, incremental diff will likely fail',
          {
            repoId: params.repoId,
            commit: params.lastIndexedCommit,
          },
        );
      }
    }

    const diffPaths = params.lastIndexedCommit
      ? await this.listChangedFiles(
          params.repoRoot,
          params.lastIndexedCommit,
          params.currentCommit,
          execFn,
        )
      : null;

    if (!diffPaths) {
      this.logger.warn(
        'Incremental diff failed, falling back to full reindex',
        {
          repoId: params.repoId,
          lastIndexedCommit: params.lastIndexedCommit,
          currentCommit: params.currentCommit,
          reason: !params.lastIndexedCommit
            ? 'no_last_commit'
            : 'diff_command_failed',
        },
      );
      // Pass the already-wrapped execFn to the internal helper to avoid
      // double-wrapping the timeout (runFullIndex would wrap it again).
      await this.runFullIndexInternal(
        params,
        execFn,
        updateRuntimeActivity,
        onProgressUpdate,
        signal,
      );
      return;
    }

    const statusPaths = await this.listWorkingTreeChanges(
      params.repoRoot,
      execFn,
    );
    const allPaths = [...new Set([...diffPaths, ...statusPaths])];

    // Ensure payload indexes exist for efficient filtering
    await this.ensureCodebasePayloadIndexes(params.collection);

    this.logger.debug('Codebase index: starting incremental index', {
      repoId: params.repoId,
      repoRoot: params.repoRoot,
      totalFiles: allPaths.length,
    });

    const matcher = await this.preloadIgnoreMatcher(params.repoRoot, execFn);

    // Filter by ignore rules first, then batch-check existence
    const candidates = allPaths.filter((p) =>
      this.shouldIndexPathSync(p, matcher),
    );

    const existenceMap = await this.batchFileExists(
      params.repoRoot,
      candidates,
      execFn,
    );

    // Separate existing files from deleted ones
    const filesToProcess: string[] = [];
    const deletedPaths: string[] = [];
    for (const relativePath of candidates) {
      if (existenceMap.get(relativePath)) {
        filesToProcess.push(relativePath);
      } else {
        deletedPaths.push(relativePath);
      }
    }

    // Batch-delete old chunks for all deleted files in one Qdrant call
    if (deletedPaths.length > 0) {
      for (let i = 0; i < deletedPaths.length; i += POINT_COPY_BATCH_SIZE) {
        const batch = deletedPaths.slice(i, i + POINT_COPY_BATCH_SIZE);
        await this.qdrantService.deleteByFilter(params.collection, {
          must: [{ key: 'repo_id', match: { value: params.repoId } }],
          should: batch.map((path) => ({
            key: 'path',
            match: { value: path },
          })),
        });
      }
    }

    await this.processFiles(filesToProcess, params, execFn, {
      batchFileCount: INCREMENTAL_BATCH_FILE_COUNT,
      updateRuntimeActivity,
      onProgressUpdate,
      prefetchedChunks: null,
      checkFileExists: false,
      signal,
    });
  }

  // ---------------------------------------------------------------------------
  // Private: shared file processing loop
  // ---------------------------------------------------------------------------

  /**
   * Process a list of files: read, check for reuse, chunk, embed, and upsert.
   * Shared between runFullIndex and runIncrementalIndex to avoid duplication.
   * Returns the set of paths that were processed (for orphan cleanup).
   */
  private async processFiles(
    files: string[],
    params: RepoIndexParams,
    execFn: RepoExecFn,
    options: {
      batchFileCount: number;
      updateRuntimeActivity?: () => Promise<void>;
      onProgressUpdate?: (tokenCount: number) => Promise<void>;
      prefetchedChunks: Map<string, PrefetchedChunkInfo> | null;
      checkFileExists: boolean;
      signal?: AbortSignal;
    },
  ): Promise<Set<string>> {
    const processedPaths = new Set<string>();
    const batch: ChunkBatchItem[] = [];
    let batchTokenCount = 0;
    const maxTokens = environment.codebaseEmbeddingMaxTokens;
    let filesInCurrentBatch = 0;

    // Read files in parallel batches to overlap I/O
    for (let i = 0; i < files.length; i += FILE_READ_CONCURRENCY) {
      if (options.signal?.aborted) {
        throw new JobCancelledException(
          'Indexing cancelled: repository deleted',
        );
      }

      const fileSlice = files.slice(i, i + FILE_READ_CONCURRENCY);
      const fileInputs = await Promise.all(
        fileSlice.map(async (relativePath) => {
          const input = await this.prepareFileIndexInput(
            params.repoRoot,
            relativePath,
            execFn,
          );
          return { relativePath, input };
        }),
      );

      for (const { relativePath, input: fileInput } of fileInputs) {
        processedPaths.add(relativePath);

        if (!fileInput) {
          continue;
        }

        // Check for content reuse: try prefetched map first, fall back to Qdrant
        const reuseResult = await this.checkFileReuse(
          params,
          fileInput,
          options.prefetchedChunks,
        );

        if (reuseResult.reused) {
          if (options.onProgressUpdate && reuseResult.tokenCount > 0) {
            try {
              await options.onProgressUpdate(reuseResult.tokenCount);
            } catch (err) {
              this.logger.error(
                err instanceof Error ? err : new Error(String(err)),
                'Failed to update progress for reused chunks',
                { tokenCount: reuseResult.tokenCount },
              );
            }
          }
          continue;
        }

        // Delete old chunks for this file before re-indexing with new content
        await this.qdrantService.deleteByFilter(
          params.collection,
          this.buildFileFilter(params.repoId, fileInput.relativePath),
        );

        // New content - chunk and embed
        const chunks = await this.chunkText(
          fileInput.content,
          params.embeddingModel,
        );
        const totalLines = fileInput.content.split('\n').length;

        for (const chunk of chunks) {
          if (
            batchTokenCount + chunk.tokenCount > maxTokens &&
            batch.length > 0
          ) {
            if (options.signal?.aborted) {
              throw new JobCancelledException(
                'Indexing cancelled: repository deleted',
              );
            }
            await this.flushChunkBatch(
              params.collection,
              batch,
              params.vectorSize,
              params.embeddingModel,
              maxTokens,
              options.onProgressUpdate,
            );
            batchTokenCount = 0;
            filesInCurrentBatch = 0;
          }
          batch.push({
            repoId: params.repoId,
            commit: params.currentCommit,
            filePath: fileInput.relativePath,
            fileHash: fileInput.fileHash,
            totalLines,
            chunk,
          });
          batchTokenCount += chunk.tokenCount;
        }

        filesInCurrentBatch += 1;

        // Flush every N files to save progress
        if (filesInCurrentBatch >= options.batchFileCount && batch.length > 0) {
          if (options.signal?.aborted) {
            throw new JobCancelledException(
              'Indexing cancelled: repository deleted',
            );
          }
          await this.flushChunkBatch(
            params.collection,
            batch,
            params.vectorSize,
            params.embeddingModel,
            maxTokens,
            options.onProgressUpdate,
          );
          batchTokenCount = 0;
          filesInCurrentBatch = 0;

          if (options.updateRuntimeActivity) {
            await options.updateRuntimeActivity().catch(() => undefined);
          }
        }
      }
    }

    await this.flushChunkBatch(
      params.collection,
      batch,
      params.vectorSize,
      params.embeddingModel,
      maxTokens,
      options.onProgressUpdate,
    );

    return processedPaths;
  }

  /**
   * Check if a file's content can be reused from existing indexed chunks.
   * Uses the prefetched map for O(1) lookups when available, falls back to
   * the Qdrant-based checkAndCopyExistingChunks for metadata updates.
   */
  private async checkFileReuse(
    params: RepoIndexParams,
    fileInput: FileIndexInput,
    prefetchedChunks: Map<string, PrefetchedChunkInfo> | null,
  ): Promise<{ reused: boolean; tokenCount: number }> {
    if (prefetchedChunks) {
      const existing = prefetchedChunks.get(fileInput.relativePath);
      if (existing && existing.fileHash === fileInput.fileHash) {
        // Content matches — check if metadata needs updating
        if (existing.commit === params.currentCommit) {
          return { reused: true, tokenCount: existing.tokenCount };
        }
        // Same content but stale commit — need Qdrant call to update metadata
      } else if (!existing) {
        // Path not in Qdrant at all — new file, skip Qdrant check entirely
        return { reused: false, tokenCount: 0 };
      }
      // Different hash or stale commit — fall through to full Qdrant check
    }

    const { exists, tokenCount } = await this.checkAndCopyExistingChunks(
      params.collection,
      params.repoId,
      fileInput.fileHash,
      fileInput.relativePath,
      params.currentCommit,
      params.embeddingModel,
    );
    return { reused: exists, tokenCount };
  }

  /**
   * Pre-fetch all existing chunk metadata from Qdrant for a collection+repo.
   * Returns a map of path → { fileHash, tokenCount, commit } for O(1) lookups.
   * This replaces per-file Qdrant roundtrips during full indexing.
   *
   * Memory: The map is keyed by file path (not by chunk), so a repo with 100k
   * chunks but 5k unique files produces only ~5k entries (~500 KB). A safety
   * limit aborts the scroll if the total number of scrolled points exceeds
   * {@link PREFETCH_MAX_POINTS} to guard against pathological cases.
   */
  private async prefetchExistingChunks(
    collection: string,
    repoId: string,
  ): Promise<Map<string, PrefetchedChunkInfo>> {
    const map = new Map<string, PrefetchedChunkInfo>();
    try {
      let offset: string | number | Record<string, unknown> | undefined;
      let scrolledPoints = 0;

      while (true) {
        const page = await this.qdrantService.raw.scroll(collection, {
          filter: this.buildRepoFilter(repoId),
          limit: QDRANT_SCROLL_PAGE_SIZE,
          with_payload: {
            include: ['path', 'file_hash', 'token_count', 'commit'],
          },
          with_vector: false,
          offset,
        });

        for (const point of page.points) {
          const payload = point.payload as Partial<{
            path: string;
            file_hash: string;
            token_count: number;
            commit: string;
          }>;
          if (!payload.path || !payload.file_hash) {
            continue;
          }

          const tokenCount = payload.token_count ?? 0;
          const chunkCommit = payload.commit ?? '';
          const existing = map.get(payload.path);

          if (!existing) {
            map.set(payload.path, {
              fileHash: payload.file_hash,
              tokenCount,
              commit: chunkCommit,
            });
            continue;
          }

          // If a chunk has a different file_hash (e.g. partial re-index failure
          // left stale chunks alongside new ones), reset to the newest hash.
          // The stale chunks will be cleaned up by deleteByFilter + re-embed.
          if (existing.fileHash !== payload.file_hash) {
            existing.fileHash = payload.file_hash;
            existing.tokenCount = tokenCount;
            existing.commit = chunkCommit;
          } else {
            // Accumulate token counts across chunks of the same file/hash.
            existing.tokenCount += tokenCount;
            existing.commit = existing.commit || chunkCommit;
          }
        }

        scrolledPoints += page.points.length;
        if (scrolledPoints >= PREFETCH_MAX_POINTS) {
          this.logger.warn(
            'Prefetch safety limit reached, returning partial map',
            {
              collection,
              repoId,
              scrolledPoints,
              mapSize: map.size,
            },
          );
          break;
        }

        if (!page.next_page_offset) {
          break;
        }
        offset = page.next_page_offset;
      }

      this.logger.debug('Prefetched existing chunk metadata', {
        collection,
        repoId,
        scrolledPoints,
        uniquePaths: map.size,
      });
    } catch (error) {
      if (!QdrantService.isCollectionNotFoundError(error)) {
        this.logger.warn('Failed to prefetch existing chunks', {
          collection,
          repoId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Return empty map on failure — will fall back to per-file checks
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Public: git helpers
  // ---------------------------------------------------------------------------

  /**
   * Ensure a specific commit is reachable in a (possibly shallow) clone.
   * Checks with `git cat-file -t` first; if missing, progressively deepens
   * the clone history with `git fetch --deepen=N` until the commit appears
   * or max attempts are exhausted.
   *
   * Returns `true` if the commit is reachable after all attempts.
   */
  async ensureCommitReachable(
    repoRoot: string,
    commit: string,
    execFn: RepoExecFn,
  ): Promise<boolean> {
    // Quick check: is the commit already reachable?
    const checkRes = await execFn({
      cmd: `git -C ${shQuote(repoRoot)} cat-file -t ${shQuote(commit)}`,
    });
    if (checkRes.exitCode === 0) {
      return true;
    }

    // Progressive deepening: --deepen=N adds N commits to the current shallow
    // boundary (additive, not absolute). Starting from GIT_CLONE_DEPTH (100),
    // the cumulative depths become ~300, ~800, ~2800.
    const deepenSteps = [200, 500, 2000];
    for (const depth of deepenSteps) {
      this.logger.debug('Deepening shallow clone to reach commit', {
        repoRoot,
        commit,
        depth,
      });
      await execFn({
        cmd: `git -C ${shQuote(repoRoot)} fetch --deepen=${depth}`,
      });

      const recheck = await execFn({
        cmd: `git -C ${shQuote(repoRoot)} cat-file -t ${shQuote(commit)}`,
      });
      if (recheck.exitCode === 0) {
        this.logger.debug('Commit now reachable after deepening', {
          repoRoot,
          commit,
          depth,
        });
        return true;
      }
    }

    // Last resort: try to unshallow entirely
    this.logger.debug('Unshallowing clone to reach commit', {
      repoRoot,
      commit,
    });
    await execFn({
      cmd: `git -C ${shQuote(repoRoot)} fetch --unshallow`,
    });

    const finalCheck = await execFn({
      cmd: `git -C ${shQuote(repoRoot)} cat-file -t ${shQuote(commit)}`,
    });
    if (finalCheck.exitCode === 0) {
      this.logger.debug('Commit reachable after unshallow', {
        repoRoot,
        commit,
      });
      return true;
    }

    this.logger.warn(
      'Failed to make commit reachable after all deepening attempts',
      {
        repoRoot,
        commit,
      },
    );
    return false;
  }

  // ---------------------------------------------------------------------------
  // Private: git helpers
  // ---------------------------------------------------------------------------

  private async listTrackedFiles(
    repoRoot: string,
    execFn: RepoExecFn,
  ): Promise<string[]> {
    const res = await execFn({
      cmd: `git -C ${shQuote(repoRoot)} ls-files`,
    });
    if (res.exitCode !== 0) {
      // A failed read (e.g. a load-induced exec timeout that exhausted retries)
      // is NOT an empty repository. Returning [] here would silently index zero
      // files; fail loud instead, mirroring resolveCurrentCommit's empty guard.
      // A genuinely empty repo exits 0 with empty stdout and still returns [].
      throw new Error(
        `Failed to list tracked files: ${
          res.stderr || `git ls-files exited ${res.exitCode}`
        }`,
      );
    }
    return res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  private async listChangedFiles(
    repoRoot: string,
    fromCommit: string,
    toCommit: string,
    execFn: RepoExecFn,
  ): Promise<string[] | null> {
    const res = await execFn({
      cmd: `git -C ${shQuote(repoRoot)} diff --name-only ${shQuote(fromCommit)}..${shQuote(toCommit)}`,
    });
    if (res.exitCode !== 0) {
      return null;
    }
    return res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  private async listWorkingTreeChanges(
    repoRoot: string,
    execFn: RepoExecFn,
  ): Promise<string[]> {
    const res = await execFn({
      cmd: `git -C ${shQuote(repoRoot)} status --porcelain`,
    });
    if (res.exitCode === GIT_EXEC_TIMEOUT_EXIT_CODE) {
      // A timed-out read (after retries) is not "no working-tree changes";
      // swallowing it would skip indexing genuinely-modified files. Fail loud,
      // consistent with listTrackedFiles. `git status` exits 0 with empty stdout
      // for a genuinely clean tree, so the no-changes case still returns [].
      throw new Error(
        `Failed to list working-tree changes: ${res.stderr || 'exec timeout'}`,
      );
    }
    if (res.exitCode !== 0) {
      return [];
    }

    const paths = new Set<string>();
    for (const line of res.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const payload = trimmed.slice(3).trim();
      if (!payload) {
        continue;
      }
      if (payload.includes(' -> ')) {
        const [from, to] = payload.split(' -> ', 2).map((p) => p.trim());
        if (from) {
          paths.add(from);
        }
        if (to) {
          paths.add(to);
        }
      } else {
        paths.add(payload);
      }
    }
    return Array.from(paths);
  }

  // ---------------------------------------------------------------------------
  // Private: file filtering
  // ---------------------------------------------------------------------------

  /**
   * Pre-load the ignore matcher for a repo root. Call once at the start of
   * an indexing run and pass the result to `shouldIndexPathSync` to avoid
   * re-reading the ignore file for every single file.
   */
  async preloadIgnoreMatcher(
    repoRoot: string,
    execFn: RepoExecFn,
  ): Promise<ReturnType<typeof ignore>> {
    return this.loadIgnoreMatcher(repoRoot, execFn);
  }

  shouldIndexPathSync(
    path: string,
    matcher: ReturnType<typeof ignore>,
  ): boolean {
    if (!path) {
      return false;
    }
    const normalized = posixPath
      .normalize(path.replace(/\\/g, '/'))
      .replace(/^\/+/, '');
    return !matcher.ignores(normalized);
  }

  private async loadIgnoreMatcher(
    repoRoot: string,
    execFn: RepoExecFn,
  ): Promise<ReturnType<typeof ignore>> {
    // Read both .gitignore and .codebaseindexignore. .gitignore rules are
    // loaded first (base rules), then .codebaseindexignore can add overrides.
    const readFile = async (name: string): Promise<string> => {
      const filePath = `${repoRoot}/${name}`;
      const res = await execFn({
        cmd: `if [ -f ${shQuote(filePath)} ]; then cat ${shQuote(filePath)}; fi`,
      });
      return res.exitCode === 0 ? res.stdout.trim() : '';
    };

    const [gitignoreContent, codebaseIgnoreContent] = await Promise.all([
      readFile('.gitignore'),
      readFile('.codebaseindexignore'),
    ]);

    // Cache key = repoRoot + hash of combined content so stale rules are never served
    const combinedContent = `${gitignoreContent}\n---\n${codebaseIgnoreContent}`;
    const cacheKey = `${repoRoot}:${this.hash(combinedContent)}`;
    const cached = this.ignoreCache.get(cacheKey);
    if (cached) {
      // Touch entry for LRU: delete + re-insert moves it to the end
      this.ignoreCache.delete(cacheKey);
      this.ignoreCache.set(cacheKey, cached);
      return cached;
    }

    const parseLines = (content: string): string[] =>
      content
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.trim() && !line.trimStart().startsWith('#'));

    const matcher = ignore();
    // Built-in exclusions first — user patterns can override with negations
    matcher.add(RepoIndexerService.BUILTIN_EXCLUDE_PATTERNS);
    if (gitignoreContent) {
      matcher.add(parseLines(gitignoreContent));
    }
    if (codebaseIgnoreContent) {
      matcher.add(parseLines(codebaseIgnoreContent));
    }

    // Evict oldest entries when the cache exceeds the max size
    if (this.ignoreCache.size >= RepoIndexerService.IGNORE_CACHE_MAX_SIZE) {
      const oldest = this.ignoreCache.keys().next().value;
      if (oldest !== undefined) {
        this.ignoreCache.delete(oldest);
      }
    }
    this.ignoreCache.set(cacheKey, matcher);
    return matcher;
  }

  /**
   * Batch-check file existence using a single shell command instead of
   * one `test -f` roundtrip per file. Returns a map of path → exists.
   */
  private async batchFileExists(
    repoRoot: string,
    paths: string[],
    execFn: RepoExecFn,
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (paths.length === 0) {
      return result;
    }

    // Split into shell-safe batches and run them concurrently
    const BATCH = 200;
    const batches: string[][] = [];
    for (let i = 0; i < paths.length; i += BATCH) {
      batches.push(paths.slice(i, i + BATCH));
    }

    const CONCURRENCY = FILE_READ_CONCURRENCY;
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const slice = batches.slice(i, i + CONCURRENCY);
      const responses = await Promise.all(
        slice.map((batch) => {
          const checks = batch
            .map(
              (p) =>
                `[ -f ${shQuote(`${repoRoot}/${p}`)} ] && echo ${shQuote(p)}`,
            )
            .join('; ');
          return execFn({ cmd: checks });
        }),
      );
      for (let j = 0; j < slice.length; j++) {
        const response = responses[j]!;
        if (response.exitCode === GIT_EXEC_TIMEOUT_EXIT_CODE) {
          // A timed-out / session-restarted existence check (exit 124, empty
          // stdout) is NOT "every file in this batch is absent" — treating it
          // so would mark live files deleted and drop their indexed chunks.
          // Fail loud, mirroring listTrackedFiles. A genuine `[ -f ] && echo`
          // chain exits 0 or 1, never 124, so real absences keep working.
          throw new Error(
            `File-existence check failed (exec timeout): ${
              response.stderr || `exit ${response.exitCode}`
            }`,
          );
        }
        const existingPaths = new Set(
          response.stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean),
        );
        for (const p of slice[j]!) {
          result.set(p, existingPaths.has(p));
        }
      }
    }

    return result;
  }

  private async prepareFileIndexInput(
    repoRoot: string,
    relativePath: string,
    execFn: RepoExecFn,
  ): Promise<FileIndexInput | null> {
    const absolutePath = `${repoRoot}/${relativePath}`;
    const maxBytes = environment.codebaseMaxFileBytes;

    // Read up to maxBytes+1 in a single command — if output exceeds maxBytes
    // the file is too large. This avoids a separate `wc -c` roundtrip.
    const contentRes = await execFn({
      cmd: `head -c ${maxBytes + 1} ${shQuote(absolutePath)}`,
    });
    if (contentRes.exitCode !== 0) {
      this.logger.debug('Failed to read file content', {
        relativePath,
        stderr: contentRes.stderr,
      });
      return null;
    }

    const content = contentRes.stdout;

    // head -c reads bytes, but stdout is a string — use Buffer to check byte size
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      this.logger.debug('File too large to index', {
        relativePath,
        maxSize: maxBytes,
      });
      return null;
    }

    if (!content.trim()) {
      this.logger.debug('File is empty, skipping', { relativePath });
      return null;
    }
    if (content.includes('\u0000')) {
      this.logger.debug('File contains binary content, skipping', {
        relativePath,
      });
      return null;
    }

    // Replace lone surrogates (U+D800–U+DFFF) with the replacement character.
    // They can appear when head -c cuts a file mid-multibyte-sequence, or from
    // certain non-UTF-8 encodings. JSON.stringify / Qdrant rejects them outright.
    const sanitizedContent = content.toWellFormed();

    return {
      relativePath,
      content: sanitizedContent,
      fileHash: this.hash(sanitizedContent),
    };
  }

  // ---------------------------------------------------------------------------
  // Private: chunking
  // ---------------------------------------------------------------------------

  private async chunkText(
    content: string,
    embeddingModel: string,
  ): Promise<ChunkDescriptor[]> {
    if (!content) {
      return [];
    }

    const encoding = await this.litellmService.getTokenizer(embeddingModel);
    const tokens = encoding.encode(content);
    if (tokens.length === 0) {
      return [];
    }

    const lineStarts = this.buildLineStartOffsets(content);
    const targetTokens = Math.min(
      environment.codebaseChunkTargetTokens,
      environment.codebaseEmbeddingMaxTokens,
    );
    const overlapTokens = Math.min(
      environment.codebaseChunkOverlapTokens,
      Math.max(0, targetTokens - 1),
    );

    // Compute character offsets incrementally at chunk boundaries.
    // Instead of decoding tokens[0..N] from scratch each time (O(N) per call),
    // we track the last computed position and decode only the delta slice.
    const offsetCache = new Map<number, number>();
    offsetCache.set(0, 0);
    offsetCache.set(tokens.length, content.length);
    let lastTokenIdx = 0;
    let lastCharOffset = 0;
    const charOffset = (tokenIdx: number): number => {
      const cached = offsetCache.get(tokenIdx);
      if (cached !== undefined) {
        return cached;
      }

      // Decode only the token slice between the nearest known position and target
      let baseIdx: number;
      let baseOffset: number;
      if (tokenIdx > lastTokenIdx) {
        baseIdx = lastTokenIdx;
        baseOffset = lastCharOffset;
      } else {
        // Rare: overlap caused a backward jump — find nearest cached predecessor
        baseIdx = 0;
        baseOffset = 0;
        for (const [idx, off] of offsetCache) {
          if (idx <= tokenIdx && idx > baseIdx) {
            baseIdx = idx;
            baseOffset = off;
          }
        }
      }

      const delta = tokens.slice(baseIdx, tokenIdx);
      const len = baseOffset + String(encoding.decode(delta)).length;
      offsetCache.set(tokenIdx, len);
      lastTokenIdx = tokenIdx;
      lastCharOffset = len;
      return len;
    };

    const chunks: ChunkDescriptor[] = [];
    let startToken = 0;
    let guard = 0;

    while (startToken < tokens.length && guard < 10_000) {
      guard += 1;
      const endToken = Math.min(startToken + targetTokens, tokens.length);
      if (endToken <= startToken) {
        break;
      }

      const startOffset = charOffset(startToken);
      const endOffset = charOffset(endToken);
      // toWellFormed() replaces lone surrogates that can appear when the
      // token-boundary offset splits a multi-code-unit character (e.g. emoji).
      const text = content.slice(startOffset, endOffset).toWellFormed();
      const startLine = this.lineForOffset(lineStarts, startOffset);
      const endLine = this.lineForOffset(
        lineStarts,
        Math.max(endOffset - 1, startOffset),
      );
      const chunkHash = this.hash(text);
      // Token count is already known from the token-window slicing — no need
      // to re-tokenize the text.
      const tokenCount = endToken - startToken;

      chunks.push({
        text,
        startOffset,
        endOffset,
        startLine,
        endLine,
        chunkHash,
        tokenCount,
      });

      if (endToken >= tokens.length) {
        break;
      }
      startToken = Math.max(0, endToken - overlapTokens);
    }

    return chunks;
  }

  private buildLineStartOffsets(content: string): number[] {
    const offsets = [0];
    for (let i = 0; i < content.length; i += 1) {
      if (content[i] === '\n') {
        offsets.push(i + 1);
      }
    }
    return offsets;
  }

  private lineForOffset(offsets: number[], offset: number): number {
    let left = 0;
    let right = offsets.length - 1;
    let best = 0;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const value = offsets[mid];
      if (value === undefined) {
        break;
      }
      if (value <= offset) {
        best = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    return best + 1;
  }

  // ---------------------------------------------------------------------------
  // Private: embedding & upsert
  // ---------------------------------------------------------------------------

  private async flushChunkBatch(
    collection: string,
    batch: ChunkBatchItem[],
    vectorSize: number,
    embeddingModel: string,
    maxTokens: number,
    onProgressUpdate?: (tokenCount: number) => Promise<void>,
  ): Promise<void> {
    if (batch.length === 0) {
      return;
    }

    const texts = batch.map((item) => item.chunk.text);
    const tokenCounts = batch.map((item) => item.chunk.tokenCount);
    let embeddings: number[][];
    try {
      embeddings = await this.embedTextsWithUsageConcurrent(
        texts,
        tokenCounts,
        embeddingModel,
        maxTokens,
      );
    } catch (err) {
      this.logger.error(
        err instanceof Error ? err : new Error(String(err)),
        'Embedding API call failed — batch will not be indexed',
        {
          collection,
          chunkCount: batch.length,
          totalTokens: tokenCounts.reduce((sum, c) => sum + c, 0),
        },
      );
      throw err;
    }

    const actualVectorSize =
      this.qdrantService.getVectorSizeFromEmbeddings(embeddings);
    if (actualVectorSize !== vectorSize) {
      this.logger.warn(
        'Embedding vector size mismatch — dropping batch to prevent corrupt index',
        {
          collection,
          expected: vectorSize,
          actual: actualVectorSize,
          droppedChunks: batch.length,
        },
      );
      batch.length = 0;
      return;
    }

    const indexedAt = new Date().toISOString();
    const points = batch.map((item, index) => {
      const vector = embeddings[index];
      if (!vector) {
        return null;
      }

      const chunk = item.chunk;
      const id = this.buildPointId(item.repoId, item.filePath, chunk.chunkHash);
      const payload: QdrantPointPayload = {
        repo_id: item.repoId,
        path: item.filePath,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        total_lines: item.totalLines,
        text: chunk.text,
        chunk_hash: chunk.chunkHash,
        file_hash: item.fileHash,
        commit: item.commit,
        indexed_at: indexedAt,
        token_count: chunk.tokenCount,
      };
      return { id, vector, payload };
    });

    const filteredPoints = points.filter(
      (point): point is NonNullable<typeof point> => Boolean(point),
    );

    await this.qdrantService.upsertPoints(collection, filteredPoints);

    // Calculate total tokens indexed in this batch
    const batchTokenCount = tokenCounts.reduce((sum, count) => sum + count, 0);

    this.logger.debug('Chunk batch saved to Qdrant', {
      collection,
      pointCount: filteredPoints.length,
      tokenCount: batchTokenCount,
    });

    // Update progress
    if (onProgressUpdate) {
      try {
        await onProgressUpdate(batchTokenCount);
      } catch (err) {
        this.logger.error(
          err instanceof Error ? err : new Error(String(err)),
          'Failed to update indexing progress',
          {
            tokenCount: batchTokenCount,
          },
        );
      }
    }

    batch.length = 0;
  }

  private async embedTextsWithUsageConcurrent(
    texts: string[],
    tokenCounts: number[],
    model: string,
    maxTokens: number,
    concurrency = environment.codebaseEmbeddingConcurrency,
  ): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const batches = this.buildEmbeddingBatches(texts, tokenCounts, maxTokens);
    const results: number[][] = [];

    for (let i = 0; i < batches.length; i += concurrency) {
      const slice = batches.slice(i, i + concurrency);
      const sliceResults = await Promise.all(
        slice.map(async (batch) => {
          const result = await this.embedWithRetry(model, batch.items);
          return result;
        }),
      );
      for (const embeddingSet of sliceResults) {
        results.push(...embeddingSet);
      }
    }

    return results;
  }

  /**
   * Embed a batch of texts with retry logic for transient API failures.
   * Retries up to 2 times with exponential backoff (1s, 2s).
   */
  private async embedWithRetry(
    model: string,
    input: string[],
    maxRetries = 3,
  ): Promise<number[][]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.openaiService.embeddings({
          model,
          input,
          dimensions: environment.llmEmbeddingDimensions,
        });
        return result.embeddings;
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          const delayMs = 2000 * 2 ** attempt;
          this.logger.warn('Embedding API call failed, retrying', {
            attempt: attempt + 1,
            maxRetries,
            delayMs,
            error: err instanceof Error ? err.message : String(err),
          });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError;
  }

  private buildEmbeddingBatches(
    texts: string[],
    tokenCounts: number[],
    maxTokens: number,
  ): { items: string[]; tokenCounts: number[] }[] {
    const batches: { items: string[]; tokenCounts: number[] }[] = [];
    let currentItems: string[] = [];
    let currentTokenCounts: number[] = [];
    let currentTokens = 0;

    for (let i = 0; i < texts.length; i += 1) {
      const text = texts[i];
      const tokens = tokenCounts[i] ?? 0;
      if (currentTokens + tokens > maxTokens && currentItems.length > 0) {
        batches.push({ items: currentItems, tokenCounts: currentTokenCounts });
        currentItems = [];
        currentTokenCounts = [];
        currentTokens = 0;
      }
      currentItems.push(text ?? '');
      currentTokenCounts.push(tokens);
      currentTokens += tokens;
    }

    if (currentItems.length > 0) {
      batches.push({ items: currentItems, tokenCounts: currentTokenCounts });
    }

    return batches;
  }

  // ---------------------------------------------------------------------------
  // Qdrant filters & point IDs
  // ---------------------------------------------------------------------------

  buildRepoFilter(repoId: string) {
    return {
      must: [{ key: 'repo_id', match: { value: repoId } }],
    };
  }

  private buildFileFilter(repoId: string, path: string) {
    return {
      must: [
        { key: 'repo_id', match: { value: repoId } },
        { key: 'path', match: { value: path } },
      ],
    };
  }

  private buildFileHashPathFilter(
    repoId: string,
    fileHash: string,
    path: string,
  ) {
    return {
      must: [
        { key: 'repo_id', match: { value: repoId } },
        { key: 'file_hash', match: { value: fileHash } },
        { key: 'path', match: { value: path } },
      ],
    };
  }

  /**
   * Clean up orphaned chunks (files that no longer exist in the repo).
   * This is called after full index to remove chunks for deleted files.
   *
   * When a prefetched map is provided, derives orphaned paths from it
   * directly (O(1) per path) to avoid a redundant full-collection scroll.
   * Falls back to paginated scroll when no prefetched map is available.
   */
  private async cleanupOrphanedChunks(
    collection: string,
    repoId: string,
    validPaths: Set<string>,
    prefetchedChunks?: Map<string, PrefetchedChunkInfo> | null,
  ): Promise<void> {
    try {
      let orphanedPaths: Set<string>;

      if (prefetchedChunks && prefetchedChunks.size > 0) {
        // Derive orphans from the prefetch map — no extra Qdrant scroll needed
        orphanedPaths = new Set<string>();
        for (const path of prefetchedChunks.keys()) {
          if (!validPaths.has(path)) {
            orphanedPaths.add(path);
          }
        }
      } else {
        // No prefetch map — fall back to paginated scroll
        orphanedPaths = new Set<string>();
        let offset: string | number | Record<string, unknown> | undefined;

        while (true) {
          const page = await this.qdrantService.raw.scroll(collection, {
            filter: this.buildRepoFilter(repoId),
            limit: QDRANT_SCROLL_PAGE_SIZE,
            with_payload: { include: ['path'] },
            with_vector: false,
            offset,
          });

          for (const point of page.points) {
            const payload = point.payload as { path?: string } | undefined;
            const path = payload?.path;
            if (path && !validPaths.has(path)) {
              orphanedPaths.add(path);
            }
          }

          if (!page.next_page_offset) {
            break;
          }
          offset = page.next_page_offset;
        }
      }

      if (orphanedPaths.size === 0) {
        return;
      }

      // Batch delete orphaned paths using a `should` (OR) filter.
      // Qdrant semantics: `must` AND (at least one `should`).
      // Fire all batch deletes concurrently to minimize the window where
      // partial cleanup is visible to concurrent searches.
      const orphanedArray = Array.from(orphanedPaths);
      const deletePromises: Promise<void>[] = [];

      for (let i = 0; i < orphanedArray.length; i += POINT_COPY_BATCH_SIZE) {
        const batch = orphanedArray.slice(i, i + POINT_COPY_BATCH_SIZE);
        deletePromises.push(
          this.qdrantService.deleteByFilter(collection, {
            must: [{ key: 'repo_id', match: { value: repoId } }],
            should: batch.map((path) => ({
              key: 'path',
              match: { value: path },
            })),
          }),
        );
      }
      await Promise.all(deletePromises);

      this.logger.debug('Cleaned up orphaned chunks', {
        collection,
        repoId,
        orphanedPathCount: orphanedPaths.size,
      });
    } catch (error) {
      // Log but don't fail if cleanup fails
      this.logger.warn('Failed to clean up orphaned chunks', {
        collection,
        repoId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check if chunks for this file_hash already exist at the same path in the
   * collection. If found and both path and commit match, no work is needed.
   * If found but the commit differs, update commit metadata without re-embedding.
   * Returns { exists: boolean, tokenCount: number }
   */
  private async checkAndCopyExistingChunks(
    collection: string,
    repoId: string,
    fileHash: string,
    newPath: string,
    currentCommit: string,
    embeddingModel: string,
  ): Promise<{ exists: boolean; tokenCount: number }> {
    try {
      const filter = this.buildFileHashPathFilter(repoId, fileHash, newPath);

      // First check existence WITHOUT vectors — much cheaper than fetching vectors.
      const lightPoints = await this.qdrantService.scrollAll(collection, {
        filter,
        limit: QDRANT_SCROLL_PAGE_SIZE,
        with_payload: true,
      });

      if (lightPoints.length === 0) {
        return { exists: false, tokenCount: 0 };
      }

      // Calculate total tokens and identify which point IDs need updating.
      let totalTokens = 0;
      const pointIdsToUpdate: (string | number)[] = [];
      const tokenCountByChunkHash = new Map<string, number>();

      for (const point of lightPoints) {
        const payload = point.payload as QdrantPointPayload;
        const chunkTokenCount =
          payload.token_count ??
          (await this.litellmService.countTokens(embeddingModel, payload.text));
        totalTokens += chunkTokenCount;
        tokenCountByChunkHash.set(payload.chunk_hash, chunkTokenCount);

        if (payload.commit !== currentCommit || !payload.token_count) {
          pointIdsToUpdate.push(point.id);
        }
      }

      // If nothing needs updating, skip the expensive vector fetch
      if (pointIdsToUpdate.length === 0) {
        return { exists: true, tokenCount: totalTokens };
      }

      // Fetch vectors ONLY for the points that need metadata updates
      // (not the entire collection, just the specific IDs).
      const pointsWithVectors = await this.qdrantService.raw.retrieve(
        collection,
        { ids: pointIdsToUpdate, with_payload: true, with_vector: true },
      );

      const pointsToUpsert: {
        id: string;
        vector: number[];
        payload: Record<string, unknown>;
      }[] = [];

      for (const point of pointsWithVectors) {
        const payload = point.payload as QdrantPointPayload;
        const chunkTokenCount =
          tokenCountByChunkHash.get(payload.chunk_hash) ??
          payload.token_count ??
          (await this.litellmService.countTokens(embeddingModel, payload.text));
        const newId = this.buildPointId(repoId, newPath, payload.chunk_hash);
        pointsToUpsert.push({
          id: newId,
          vector: point.vector as number[],
          payload: {
            ...payload,
            commit: currentCommit,
            indexed_at: new Date().toISOString(),
            token_count: chunkTokenCount,
          },
        });
      }

      if (pointsToUpsert.length > 0) {
        for (let i = 0; i < pointsToUpsert.length; i += POINT_COPY_BATCH_SIZE) {
          const batch = pointsToUpsert.slice(i, i + POINT_COPY_BATCH_SIZE);
          await this.qdrantService.upsertPoints(collection, batch);
        }
      }

      return { exists: true, tokenCount: totalTokens };
    } catch (error) {
      if (QdrantService.isCollectionNotFoundError(error)) {
        this.logger.debug('Collection or points not found during chunk copy', {
          repoId,
          fileHash,
          collection,
        });
        return { exists: false, tokenCount: 0 };
      }
      throw error;
    }
  }

  private buildPointId(
    repoId: string,
    filePath: string,
    chunkHash: string,
  ): string {
    return uuidv5(
      `${repoId}|${filePath}|${chunkHash}`,
      environment.codebaseUuidNamespace,
    );
  }

  // ---------------------------------------------------------------------------
  // Private: chunking helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the overlap inflation factor: ratio of tokens actually indexed
   * (including overlapping regions) to raw tokens in source text.
   * Mirrors the guarded logic in chunkText().
   */
  private getChunkOverlapFactor(): number {
    const targetTokens = Math.min(
      environment.codebaseChunkTargetTokens,
      environment.codebaseEmbeddingMaxTokens,
    );
    const effectiveOverlap = Math.min(
      environment.codebaseChunkOverlapTokens,
      Math.max(0, targetTokens - 1),
    );
    const stride = targetTokens - effectiveOverlap;
    if (stride <= 0) {
      return 1;
    }
    return targetTokens / stride;
  }

  private buildChunkingSignature(): Record<string, unknown> {
    return {
      chunk_target_tokens: environment.codebaseChunkTargetTokens,
      chunk_overlap_tokens: environment.codebaseChunkOverlapTokens,
      embedding_max_tokens: environment.codebaseEmbeddingMaxTokens,
      break_strategy: 'token-window',
      line_counting: 'line-start-offsets',
      max_file_bytes: environment.codebaseMaxFileBytes,
      builtin_exclude_patterns: RepoIndexerService.BUILTIN_EXCLUDE_PATTERNS,
      ignore_rules: { sources: ['.gitignore', '.codebaseindexignore'] },
      embedding_input: { format: 'raw' },
      point_id_scheme: {
        version: 'uuidv5',
        namespace: environment.codebaseUuidNamespace,
      },
    };
  }

  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    const body = entries
      .map(
        ([key, val]) => `${JSON.stringify(key)}:${this.stableStringify(val)}`,
      )
      .join(',');
    return `{${body}}`;
  }

  // ---------------------------------------------------------------------------
  // Private: utility
  // ---------------------------------------------------------------------------

  private hash(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }
}
