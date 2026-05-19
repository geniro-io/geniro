import {
  isAbsolute,
  join as joinPath,
  posix as posixPath,
  relative,
  resolve,
} from 'node:path';

import { ToolRunnableConfig } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import dedent from 'dedent';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';

import { environment } from '../../../../../environments';
import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { RepoIndexService } from '../../../../git-repositories/services/repo-index.service';
import {
  RepoExecFn,
  RepoIndexerService,
} from '../../../../git-repositories/services/repo-indexer.service';
import { BASE_RUNTIME_WORKDIR } from '../../../../runtime/services/base-runtime';
import { shQuote } from '../../../../utils/shell.utils';
import {
  ExtendedLangGraphRunnableConfig,
  ToolInvokeResult,
} from '../../base-tool';
import { FilesBaseTool, FilesBaseToolConfig } from './files-base.tool';

const DEFAULT_TOP_K = 15;
const MAX_TOP_K = 30;
const DEFAULT_MIN_SCORE = 0.3;
/**
 * Cap top_k for partial searches during indexing. Keeps it below the
 * query-expansion threshold (10) inside `searchCodebase()`, which avoids
 * an extra LLM call + multiple embedding requests for incomplete data.
 */
const PARTIAL_SEARCH_TOP_K = 5;

const CodebaseSearchSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'A natural-language phrase or question describing what you are looking for (e.g., "where is the authentication middleware defined?"). Do not use single keywords — multi-word semantic queries produce much better results.',
    ),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(MAX_TOP_K)
    .nullable()
    .optional()
    .describe(
      'Maximum number of code chunk results to return (default: 15, max: 30). Start with 5-10 for focused queries.',
    ),
  gitRepoDirectory: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      `Absolute path to the git repository root (the directory containing the .git folder). ` +
        `Use the exact path returned by gh_clone. If omitted, the tool will auto-detect ` +
        `the repository under ${BASE_RUNTIME_WORKDIR}.`,
    ),
  language: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      'Filter results to a specific programming language by file extension (e.g., "ts", "py", "go", "rs"). Omit to search all languages.',
    ),
});

type CodebaseSearchSchemaType = z.infer<typeof CodebaseSearchSchema>;

type CodebaseSearchResult = {
  path: string;
  start_line: number;
  end_line: number;
  total_lines?: number;
  text: string;
  score: number;
};

type CodebaseSearchOutput = {
  error?: string;
  message?: string;
  results?: CodebaseSearchResult[];
  /** True when indexing is still in progress and results may be incomplete. */
  partialResults?: boolean;
};

@Injectable()
export class FilesCodebaseSearchTool extends FilesBaseTool<CodebaseSearchSchemaType> {
  public name = 'codebase_search';
  public description =
    'Preferred first step for codebase exploration. Perform semantic search across a git repository to find relevant code by meaning. Use natural-language queries (not single keywords) for best results. Returns file paths, line ranges, total_lines (file size), and code snippets ranked by relevance. Use this tool first after gh_clone — it is faster and more precise than files_directory_tree or files_find_paths. If indexing is in progress, partial results may be returned — supplement with other file tools for complete coverage. Check total_lines in results: read small files (≤300 lines) entirely, but for large files (>300 lines) ALWAYS use fromLineNumber/toLineNumber in files_read. The repository must be cloned first with gh_clone.';

  constructor(
    private readonly repoIndexService: RepoIndexService,
    private readonly repoIndexerService: RepoIndexerService,
  ) {
    super();
  }

  public getDetailedInstructions(
    _config: FilesBaseToolConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ): string {
    return dedent`
      ### ⚠️ PREFERRED FIRST STEP
      This tool SHOULD be your first action after cloning a repository. Prefer it over \`files_directory_tree\` or \`files_find_paths\` — those tools produce noisier output. \`codebase_search\` returns exactly the code you need with precise file paths and line numbers.
      If indexing is in progress, the tool may return partial results. Supplement with other file tools for complete coverage.

      ### Overview
      Semantic codebase search that indexes a git repository on demand.
      Indexing is triggered automatically on the first call. For large repositories
      indexing runs in the background — when indexing is in progress, the tool will
      attempt to search already-indexed data and return partial results if available.
      Treat partial results as useful but incomplete — also use \`files_directory_tree\`,
      \`files_find_paths\`, and \`files_search_text\` for broader coverage.
      Do NOT repeatedly retry \`codebase_search\` hoping for more results.

      ### Prerequisites
      - Repository MUST be cloned first. Use \`gh_clone\` if not already done.
      - \`gitRepoDirectory\` is optional — if omitted, the tool auto-detects the first git repo under ${BASE_RUNTIME_WORKDIR}.
      - When provided, use the exact path returned by gh_clone. It must point to the repository root (containing .git folder).

      ### When to Use
      - Your preferred first action after \`gh_clone\`
      - Any codebase discovery or "where is X?" question
      - Understanding architecture, finding implementations, locating definitions
      - Use multiple queries to explore different aspects (e.g., "authentication middleware", "database models", "API routes")

      ### When NOT to Use
      - You already have the file paths and line numbers you need from a previous search
      - Indexing is in progress and you already received partial results from a prior call — use other tools for additional exploration

      ### Requirements
      - Must be inside a git repository
      - Query must be a human-readable phrase or question (not a single word)

      ### Output Fields
      Each result contains:
      - \`path\` — absolute file path (use directly with \`files_read\`, no need to verify)
      - \`start_line\` / \`end_line\` — line range of the matched chunk
      - \`total_lines\` — total number of lines in the file (**ALWAYS check this before reading**)
      - \`text\` — code snippet
      - \`score\` — relevance score (0-1)

      ### ⚠️ CRITICAL — Reading Strategy Based on total_lines
      You MUST check \`total_lines\` before calling \`files_read\`:
      - **Small files (≤300 lines)**: read the entire file with \`files_read\`
      - **Large files (>300 lines)**: you MUST use \`fromLineNumber\`/\`toLineNumber\` in \`files_read\`. Set the range to \`start_line - 30\` through \`end_line + 30\` from the search result. NEVER fetch the full content of files with more than 300 lines.

      ### ⚠️ CRITICAL — Indexing In Progress
      When \`codebase_search\` returns results marked as partial:
      - **Use the partial results** — they are valid and relevant, just incomplete.
      - **Supplement** with \`files_directory_tree\`, \`files_find_paths\`, and \`files_search_text\` for areas not yet indexed.
      - **Do NOT retry** \`codebase_search\` expecting more results — the index builds in the background and retrying won't speed it up.

      When \`codebase_search\` returns empty results with an "indexing in progress" message:
      - The index has just started and no data is searchable yet.
      - **Stop using \`codebase_search\` entirely for the rest of this task.** The index will not complete fast enough to help you.
      - Switch to \`files_directory_tree\`, \`files_find_paths\`, and \`files_search_text\` for all remaining discovery.

      ### Search Convergence
      If two consecutive \`codebase_search\` calls with different queries return the same top results,
      the search has converged — stop refining the query and read those files directly with \`files_read\`.
      When you already know a file path from a previous search or from context, read it directly instead of searching for it again.

      ### Recommended Flow
      1) Clone repo with \`gh_clone\` (if not already cloned).
      2) Run \`codebase_search\` with semantic queries — this is your preferred first exploration step.
      3) If indexing is in progress, use any partial results returned. Supplement with \`files_directory_tree\`, \`files_find_paths\`, and \`files_search_text\` for broader coverage.
      4) Check \`total_lines\` in results. For small files (≤300), read entirely. For large files (>300), use line ranges from \`start_line\`/\`end_line\`.
      5) Use additional \`codebase_search\` queries to explore other aspects of the codebase.
      6) Use \`files_search_text\` for exact pattern matching (function names, variable references).

      ### Examples
      \`\`\`json
      {"query":"where is auth middleware created?","top_k":5,"gitRepoDirectory":"${BASE_RUNTIME_WORKDIR}/project","language":"ts"}
      \`\`\`
      When there is only one repo in the workspace, gitRepoDirectory can be omitted:
      \`\`\`json
      {"query":"where is auth middleware created?","top_k":5}
      \`\`\`
    `;
  }

  public get schema() {
    return CodebaseSearchSchema;
  }

  protected override generateTitle(
    args: CodebaseSearchSchemaType,
    _config: FilesBaseToolConfig,
  ): string {
    return `Codebase search: ${args.query}`;
  }

  public async invoke(
    args: CodebaseSearchSchemaType,
    config: FilesBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<CodebaseSearchOutput>> {
    const title = this.generateTitle(args, config);
    const messageMetadata = { __title: title };

    const normalizedQuery = args.query.trim();
    if (!normalizedQuery) {
      return {
        output: { error: 'query must not be blank' },
        messageMetadata,
      };
    }

    // Auto-discover git repo when gitRepoDirectory is not provided.
    const gitRepoDirectory =
      args.gitRepoDirectory ?? (await this.autoDiscoverRepo(config, cfg));

    if (!gitRepoDirectory) {
      return {
        output: {
          error: dedent`
            codebase_search requires a cloned git repository but none was found under ${BASE_RUNTIME_WORKDIR}.

            REQUIRED ACTION: Clone the repository first using gh_clone, then retry with the returned path.

            Example workflow:
            1. gh_clone({"owner": "owner", "repo": "repo-name"}) -> returns {"path": "${BASE_RUNTIME_WORKDIR}/repo-name"}
            2. codebase_search({"query": "your query", "gitRepoDirectory": "${BASE_RUNTIME_WORKDIR}/repo-name"})
          `,
        },
        messageMetadata,
      };
    }

    const repoRoot = await this.resolveRepoRoot(config, cfg, gitRepoDirectory);
    if (!repoRoot) {
      return {
        output: {
          error: dedent`
            codebase_search requires a cloned git repository.

            No git repository found at: ${gitRepoDirectory}

            REQUIRED ACTION: Clone the repository first using gh_clone, then retry with the returned path.

            Example workflow:
            1. gh_clone({"owner": "owner", "repo": "repo-name"}) -> returns {"path": "${BASE_RUNTIME_WORKDIR}/repo-name"}
            2. codebase_search({"query": "your query", "gitRepoDirectory": "${BASE_RUNTIME_WORKDIR}/repo-name"})
          `,
        },
        messageMetadata,
      };
    }

    const repoInfo = await this.resolveRepoInfo(repoRoot, config, cfg);
    if ('error' in repoInfo) {
      return { output: { error: repoInfo.error }, messageMetadata };
    }

    const repositoryId = uuidv5(
      repoInfo.repoId,
      environment.codebaseUuidNamespace,
    );

    const execFn: RepoExecFn = async (params) => {
      const res = await this.execCommand({ cmd: params.cmd }, config, cfg);
      return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
    };

    // Resolve the checked-out branch (or fall back to remote default for detached HEAD)
    const branch = await this.resolveCurrentBranch(repoRoot, execFn);

    const userId = cfg.configurable?.thread_created_by as string | undefined;

    let indexResult;
    try {
      indexResult = await this.repoIndexService.getOrInitIndexForRepo({
        repositoryId,
        repoUrl: repoInfo.repoId,
        repoRoot,
        execFn,
        branch,
        userId,
      });
    } catch (initError) {
      const errMsg =
        initError instanceof Error ? initError.message : String(initError);
      if (/auth|api.key|unauthorized|forbidden|user not found/i.test(errMsg)) {
        return {
          output: {
            error: `Embedding service authentication failed during index initialization: ${errMsg}\n\nSTOP: Do not retry codebase_search — the embedding service is unavailable.\nSwitch immediately to these tools for all remaining codebase exploration:\n- files_directory_tree — to understand project structure\n- files_find_paths — to find files by name or pattern\n- files_search_text — to search file contents with regex`,
          },
          messageMetadata,
        };
      }
      throw initError;
    }

    if (indexResult.status !== 'ready') {
      const { repoIndex } = indexResult;
      const progressParts: string[] = [];
      if (repoIndex.estimatedTokens > 0) {
        const pct = Math.min(
          100,
          Math.round(
            (repoIndex.indexedTokens / repoIndex.estimatedTokens) * 100,
          ),
        );
        progressParts.push(
          `Progress: ${pct}% (${repoIndex.indexedTokens}/${repoIndex.estimatedTokens} tokens)`,
        );
      }

      // Attempt partial search if some tokens have already been indexed.
      // TODO(.geniro/knowledge/gotchas/typescript-runtime-gotchas.jsonl#G7):
      // also allow the partial path when `qdrantCollection && lastIndexedCommit`
      // are set — a prior Completed index may have populated Qdrant before the
      // row was reset to Pending/indexedTokens=0.
      if (repoIndex.indexedTokens > 0 && repoIndex.qdrantCollection) {
        try {
          const collection = repoIndex.qdrantCollection;
          const directoryFilter = this.normalizeDirectoryFilter(
            gitRepoDirectory,
            repoRoot,
          );

          const partialTopK = Math.min(
            args.top_k ?? DEFAULT_TOP_K,
            PARTIAL_SEARCH_TOP_K,
          );
          const results = await this.repoIndexService.searchCodebase({
            collection,
            query: normalizedQuery,
            repoId: repoIndex.repoUrl,
            topK: partialTopK,
            directoryFilter,
            languageFilter: args.language ?? undefined,
            minScore: DEFAULT_MIN_SCORE,
          });

          if (results.length > 0) {
            return {
              output: {
                results,
                partialResults: true,
                message: [
                  'NOTE: These are PARTIAL results — repository indexing is still in progress.',
                  ...progressParts,
                  'Results may be incomplete. You can also use files_directory_tree, files_find_paths, and files_search_text for additional exploration.',
                ].join('\n'),
              },
              messageMetadata,
            };
          }
        } catch (partialSearchError) {
          // Auth errors should be surfaced immediately with fallback guidance.
          const partialErrMsg =
            partialSearchError instanceof Error
              ? partialSearchError.message
              : String(partialSearchError);
          if (/auth|api.key|unauthorized|forbidden/i.test(partialErrMsg)) {
            return {
              output: {
                error: dedent`
                  Embedding service authentication failed: ${partialErrMsg}

                  STOP: Do not retry codebase_search — the embedding service is unavailable.
                  Switch immediately to these tools for all remaining codebase exploration:
                  - files_directory_tree — to understand project structure
                  - files_find_paths — to locate files by name/pattern
                  - files_search_text — to search file contents with regex patterns
                `,
              },
              messageMetadata,
            };
          }
          // Non-auth error (e.g. transient Qdrant error) — fall through
          // to the standard "indexing in progress" response.
        }
      }

      return {
        output: {
          results: [],
          error: [
            'Repository indexing is currently in progress. This is normal for the first search in a repository.',
            ...progressParts,
            'STOP: Do not call codebase_search again for this task — the index will not complete fast enough.',
            'Switch immediately to files_directory_tree, files_find_paths, and files_search_text for all remaining codebase exploration.',
          ].join('\n'),
        },
        messageMetadata,
      };
    }

    const collection = indexResult.repoIndex.qdrantCollection;
    const directoryFilter = this.normalizeDirectoryFilter(
      gitRepoDirectory,
      repoRoot,
    );

    let results: CodebaseSearchResult[];
    try {
      results = await this.repoIndexService.searchCodebase({
        collection,
        query: normalizedQuery,
        repoId: indexResult.repoIndex.repoUrl,
        topK: args.top_k ?? DEFAULT_TOP_K,
        directoryFilter,
        languageFilter: args.language ?? undefined,
        minScore: DEFAULT_MIN_SCORE,
      });
    } catch (searchError) {
      const errMsg =
        searchError instanceof Error
          ? searchError.message
          : String(searchError);

      const isAuthError = /auth|api.key|unauthorized|forbidden/i.test(errMsg);

      if (isAuthError) {
        return {
          output: {
            error: dedent`
              Embedding service authentication failed: ${errMsg}

              STOP: Do not retry codebase_search — the embedding service is unavailable.
              Switch immediately to these tools for all remaining codebase exploration:
              - files_directory_tree — to understand project structure
              - files_find_paths — to locate files by name/pattern
              - files_search_text — to search file contents with regex patterns
            `,
          },
          messageMetadata,
        };
      }

      throw searchError;
    }

    return {
      output: { results },
      messageMetadata,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: repo discovery
  // ---------------------------------------------------------------------------

  /**
   * Auto-detect the git repository under /runtime-workspace when the caller
   * does not provide gitRepoDirectory. Lists top-level directories and returns
   * the first one that contains a .git folder.
   */
  private async autoDiscoverRepo(
    config: FilesBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<string | null> {
    // List immediate children of the workspace that are git repos.
    const res = await this.execCommand(
      {
        cmd: `find ${shQuote(BASE_RUNTIME_WORKDIR)} -maxdepth 2 -name .git -type d 2>/dev/null | head -1`,
      },
      config,
      cfg,
    );
    if (res.exitCode !== 0) {
      return null;
    }
    const gitDir = res.stdout.trim();
    if (!gitDir) {
      return null;
    }
    // .git dir found — return the parent (repo root)
    const repoRoot = gitDir.replace(/\/\.git$/, '');
    return repoRoot.length ? repoRoot : null;
  }

  private async resolveRepoRoot(
    config: FilesBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
    directory: string,
  ): Promise<string | null> {
    const trimmed = directory.trim();
    const absoluteDir = trimmed.startsWith(BASE_RUNTIME_WORKDIR)
      ? trimmed
      : joinPath(BASE_RUNTIME_WORKDIR, trimmed.replace(/^\/+/, ''));
    const res = await this.execCommand(
      { cmd: `git -C ${shQuote(absoluteDir)} rev-parse --show-toplevel` },
      config,
      cfg,
    );
    if (res.exitCode !== 0) {
      return null;
    }
    const root = res.stdout.trim();
    return root.length ? root : null;
  }

  private async resolveRepoInfo(
    repoRoot: string,
    config: FilesBaseToolConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<{ repoId: string } | { error: string }> {
    const remoteRes = await this.execCommand(
      { cmd: `git -C ${shQuote(repoRoot)} remote get-url origin` },
      config,
      cfg,
    );
    const remoteUrl = remoteRes.exitCode === 0 ? remoteRes.stdout.trim() : '';
    const repoId = remoteUrl
      ? this.repoIndexerService.deriveRepoId(remoteUrl)
      : `local:${repoRoot}`;
    return { repoId };
  }

  // ---------------------------------------------------------------------------
  // Private: path normalization
  // ---------------------------------------------------------------------------

  private normalizeDirectoryFilter(
    directory: string | undefined,
    repoRoot: string,
  ): string | undefined {
    const trimmed = directory?.trim();
    if (!trimmed) {
      return undefined;
    }
    const resolved = isAbsolute(trimmed)
      ? resolve(trimmed)
      : resolve(repoRoot, trimmed);
    const relativeToRepo = relative(repoRoot, resolved);
    if (!relativeToRepo || relativeToRepo === '.') {
      return '';
    }
    if (!relativeToRepo.startsWith('..') && !isAbsolute(relativeToRepo)) {
      return posixPath
        .normalize(relativeToRepo.replace(/\\/g, '/'))
        .replace(/^\/+/, '');
    }
    return posixPath.normalize(trimmed.replace(/\\/g, '/')).replace(/^\/+/, '');
  }

  /**
   * Resolve the branch currently checked out in the repo.
   * For detached HEAD, resolves the remote default branch to avoid
   * creating an orphaned index per commit SHA.
   */
  private async resolveCurrentBranch(
    repoRoot: string,
    execFn: RepoExecFn,
  ): Promise<string> {
    // 1. Try the local branch name (works for normal checkouts)
    const branchRes = await execFn({
      cmd: `git -C ${shQuote(repoRoot)} symbolic-ref --short HEAD`,
    });
    if (branchRes.exitCode === 0) {
      const branch = branchRes.stdout.trim();
      if (branch.length) {
        return branch;
      }
    }

    // 2. Detached HEAD — resolve the remote's default branch so we reuse
    //    an existing index instead of creating a per-commit-SHA orphan.
    const remoteHeadRes = await execFn({
      cmd: `git -C ${shQuote(repoRoot)} symbolic-ref refs/remotes/origin/HEAD`,
    });
    if (remoteHeadRes.exitCode === 0) {
      const ref = remoteHeadRes.stdout.trim();
      const defaultBranch = ref.replace('refs/remotes/origin/', '');
      if (defaultBranch.length) {
        return defaultBranch;
      }
    }

    // 3. Last resort — try common default branch names before giving up
    const defaultBranchRes = await execFn({
      cmd: `git -C ${shQuote(repoRoot)} branch --list main master`,
    });
    if (defaultBranchRes.exitCode === 0) {
      const branches = defaultBranchRes.stdout
        .split('\n')
        .map((b) => b.replace(/^\*?\s+/, '').trim())
        .filter(Boolean);
      if (branches.includes('main')) {
        return 'main';
      }
      if (branches.includes('master')) {
        return 'master';
      }
    }

    return 'main';
  }
}
