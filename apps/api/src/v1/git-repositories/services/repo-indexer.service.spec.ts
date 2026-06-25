import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../environments';
import { LitellmService } from '../../litellm/services/litellm.service';
import { LlmModelsService } from '../../litellm/services/llm-models.service';
import { OpenaiService } from '../../openai/openai.service';
import { QdrantService } from '../../qdrant/services/qdrant.service';
import { RepoExecFn, RepoIndexerService } from './repo-indexer.service';

const mockQdrantService = {
  deleteByFilter: vi.fn().mockResolvedValue(undefined),
  upsertPoints: vi.fn().mockResolvedValue(undefined),
  ensureCollection: vi.fn().mockResolvedValue(undefined),
  ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
  scrollAll: vi.fn().mockResolvedValue([]),
  scrollAllWithVectors: vi.fn().mockResolvedValue([]),
  buildSizedCollectionName: vi.fn(
    (base: string, size: number) => `${base}_${size}`,
  ),
  getVectorSizeFromEmbeddings: vi.fn(() => 3),
  raw: {
    getCollections: vi
      .fn()
      .mockResolvedValue({ collections: [{ name: 'source_collection' }] }),
    scroll: vi.fn().mockResolvedValue({ points: [], next_page_offset: null }),
    retrieve: vi.fn().mockResolvedValue([]),
  },
};

const mockOpenaiService = {
  embeddings: vi.fn().mockResolvedValue({
    embeddings: [[0.1, 0.2, 0.3]],
    usage: { prompt_tokens: 1, completion_tokens: 0 },
  }),
};

const mockLitellmService = {
  getTokenizer: vi.fn().mockResolvedValue({
    encode: vi.fn((text: string) =>
      Array.from({ length: text.length }, (_, i) => i),
    ),
    decode: vi.fn((tokens: number[]) => tokens.map(() => 'a').join('')),
  }),
  countTokens: vi.fn().mockResolvedValue(10),
  getModelMaxInputTokens: vi.fn().mockResolvedValue(null),
};

const mockLlmModelsService = {
  getKnowledgeEmbeddingModel: vi.fn().mockReturnValue('text-embedding-3-small'),
};

const mockLogger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

// Default env: codebaseChunkTargetTokens=200, codebaseChunkOverlapTokens=30,
// codebaseEmbeddingMaxTokens=30000. Effective: targetTokens=200, overlap=30,
// stride=170, factor = 200/170.
const OVERLAP_FACTOR = 200 / 170;

describe('RepoIndexerService', () => {
  let service: RepoIndexerService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new RepoIndexerService(
      mockQdrantService as unknown as QdrantService,
      mockOpenaiService as unknown as OpenaiService,
      mockLitellmService as unknown as LitellmService,
      mockLlmModelsService as unknown as LlmModelsService,
      mockLogger as unknown as DefaultLogger,
    );
  });

  describe('estimateTokenCount', () => {
    it('sums file sizes from git ls-tree, divides by 4, and applies overlap factor', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('ls-tree -r --long HEAD')) {
          return {
            exitCode: 0,
            stdout: [
              '100644 blob abc123    1000\tsrc/index.ts',
              '100644 blob def456    2000\tsrc/utils.ts',
              '100644 blob ghi789     500\tREADME.md',
            ].join('\n'),
            stderr: '',
          };
        }
        // .gitignore / .codebaseindexignore reads
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await service.estimateTokenCount('/repo', execFn);
      expect(result).toBe(Math.floor((3500 / 3) * OVERLAP_FACTOR));
    });

    it('returns 0 when git command fails', async () => {
      const execFn: RepoExecFn = vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'fatal: not a git repo',
      });

      const result = await service.estimateTokenCount('/repo', execFn);
      expect(result).toBe(0);
    });

    it('excludes files matching .codebaseindexignore patterns', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('ls-tree -r --long HEAD')) {
          return {
            exitCode: 0,
            stdout: [
              '100644 blob abc123    1000\tsrc/index.ts',
              '100644 blob def456    2000\tnode_modules/lib/index.js',
              '100644 blob ghi789     500\tdist/bundle.js',
            ].join('\n'),
            stderr: '',
          };
        }
        if (params.cmd.includes('.codebaseindexignore')) {
          return { exitCode: 0, stdout: 'node_modules/\ndist/', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await service.estimateTokenCount('/repo', execFn);
      // Only src/index.ts (1000 bytes) should be counted
      expect(result).toBe(Math.floor((1000 / 3) * OVERLAP_FACTOR));
    });

    it('excludes image and lock files via built-in extension patterns', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('ls-tree -r --long HEAD')) {
          return {
            exitCode: 0,
            stdout: [
              '100644 blob abc123    4000\tsrc/app.ts',
              '100644 blob def456   50000\tassets/logo.png',
              '100644 blob ghi789   10000\tpackage-lock.json',
              '100644 blob jkl012    2000\tfonts/inter.woff2',
            ].join('\n'),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await service.estimateTokenCount('/repo', execFn);
      // Only src/app.ts (4000 bytes) should contribute
      expect(result).toBe(Math.floor((4000 / 3) * OVERLAP_FACTOR));
    });

    it('allows .codebaseindexignore to re-include a built-in excluded extension', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('ls-tree -r --long HEAD')) {
          return {
            exitCode: 0,
            stdout: [
              '100644 blob abc123    4000\tsrc/app.ts',
              '100644 blob def456    2000\ticons/logo.svg',
            ].join('\n'),
            stderr: '',
          };
        }
        if (params.cmd.includes('.codebaseindexignore')) {
          return { exitCode: 0, stdout: '!*.svg', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await service.estimateTokenCount('/repo', execFn);
      // Both files should contribute since .codebaseindexignore negates *.svg
      expect(result).toBe(Math.floor(((4000 + 2000) / 3) * OVERLAP_FACTOR));
    });

    it('excludes built-in dependency / build / tooling directories without any .codebaseindexignore (matched at any depth)', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('ls-tree -r --long HEAD')) {
          return {
            exitCode: 0,
            stdout: [
              '100644 blob a1    4000\tsrc/app.ts',
              '100644 blob a2    9000\tnode_modules/lib/index.js',
              '100644 blob a3    3000\t.turbo/cache.json',
              '100644 blob a4    2000\t.github/workflows/ci.yml',
              '100644 blob a5    1500\t.husky/pre-commit',
              '100644 blob a6    1200\tapps/web/.cursor/rules.md',
              '100644 blob a7    8000\tdist/bundle.js',
            ].join('\n'),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await service.estimateTokenCount('/repo', execFn);
      // Only src/app.ts (4000) survives — every other path is a built-in
      // directory exclude (including the nested apps/web/.cursor, matched at
      // any depth) with NO .codebaseindexignore present.
      expect(result).toBe(Math.floor((4000 / 3) * OVERLAP_FACTOR));
    });

    it('allows .codebaseindexignore to re-include a built-in excluded directory', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('ls-tree -r --long HEAD')) {
          return {
            exitCode: 0,
            stdout: [
              '100644 blob b1    4000\tsrc/app.ts',
              '100644 blob b2    2000\t.github/workflows/deploy.yml',
            ].join('\n'),
            stderr: '',
          };
        }
        if (params.cmd.includes('.codebaseindexignore')) {
          return { exitCode: 0, stdout: '!.github', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await service.estimateTokenCount('/repo', execFn);
      // !.github re-includes the built-in-excluded directory → both files count.
      expect(result).toBe(Math.floor(((4000 + 2000) / 3) * OVERLAP_FACTOR));
    });

    it('uses factor 1.0 when overlap >= target tokens (no division by zero)', async () => {
      const mutableEnv = environment as {
        -readonly [K in keyof typeof environment]: (typeof environment)[K];
      };
      const originalTarget = mutableEnv.codebaseChunkTargetTokens;
      const originalMaxTokens = mutableEnv.codebaseEmbeddingMaxTokens;
      // Force targetTokens to 0 so stride = 0 - 0 = 0, triggering the guard
      mutableEnv.codebaseChunkTargetTokens = 0;
      mutableEnv.codebaseEmbeddingMaxTokens = 0;

      try {
        const execFn: RepoExecFn = vi
          .fn()
          .mockImplementation(async (params) => {
            if (params.cmd.includes('ls-tree -r --long HEAD')) {
              return {
                exitCode: 0,
                stdout: '100644 blob abc123    4000\tsrc/index.ts',
                stderr: '',
              };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
          });

        const result = await service.estimateTokenCount('/repo', execFn);
        // factor = 1.0 when stride <= 0, so no overlap inflation
        expect(result).toBe(Math.floor(4000 / 3));
      } finally {
        mutableEnv.codebaseChunkTargetTokens = originalTarget;
        mutableEnv.codebaseEmbeddingMaxTokens = originalMaxTokens;
      }
    });
  });

  describe('shouldIndexPathSync with built-in exclusions', () => {
    it('excludes png files', async () => {
      const execFn: RepoExecFn = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
      const matcher = await service.preloadIgnoreMatcher('/repo', execFn);
      expect(service.shouldIndexPathSync('assets/logo.png', matcher)).toBe(
        false,
      );
    });

    it('excludes package-lock.json', async () => {
      const execFn: RepoExecFn = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
      const matcher = await service.preloadIgnoreMatcher('/repo', execFn);
      expect(service.shouldIndexPathSync('package-lock.json', matcher)).toBe(
        false,
      );
    });

    it('still indexes .ts files', async () => {
      const execFn: RepoExecFn = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
      const matcher = await service.preloadIgnoreMatcher('/repo', execFn);
      expect(service.shouldIndexPathSync('src/index.ts', matcher)).toBe(true);
    });
  });

  describe('deriveRepoId', () => {
    it('normalizes SSH URLs to HTTPS', () => {
      expect(service.deriveRepoId('git@github.com:owner/repo.git')).toBe(
        'https://github.com/owner/repo',
      );
    });

    it('strips .git suffix from HTTPS URLs', () => {
      expect(service.deriveRepoId('https://github.com/owner/repo.git')).toBe(
        'https://github.com/owner/repo',
      );
    });

    it('leaves clean HTTPS URLs unchanged', () => {
      expect(service.deriveRepoId('https://github.com/owner/repo')).toBe(
        'https://github.com/owner/repo',
      );
    });

    it('handles ssh:// protocol URLs', () => {
      expect(service.deriveRepoId('ssh://git@github.com/owner/repo.git')).toBe(
        'https://github.com/owner/repo',
      );
    });

    it('handles ssh:// URLs with port numbers', () => {
      expect(
        service.deriveRepoId('ssh://git@github.com:2222/owner/repo.git'),
      ).toBe('https://github.com/owner/repo');
    });

    it('strips embedded credentials from HTTPS URLs', () => {
      expect(
        service.deriveRepoId('https://user:token@github.com/owner/repo.git'),
      ).toBe('https://github.com/owner/repo');
    });

    it('handles trailing slashes', () => {
      expect(service.deriveRepoId('https://github.com/owner/repo/')).toBe(
        'https://github.com/owner/repo',
      );
    });

    it('handles case-insensitive .git suffix', () => {
      expect(service.deriveRepoId('https://github.com/owner/repo.GIT')).toBe(
        'https://github.com/owner/repo',
      );
    });
  });

  describe('deriveRepoSlug', () => {
    it('produces a lowercase alphanumeric slug', () => {
      const slug = service.deriveRepoSlug('https://github.com/MyOrg/My-Repo');
      expect(slug).toMatch(/^[a-z0-9_]+$/);
    });

    it('truncates and appends hash for long IDs', () => {
      const longId = 'https://github.com/' + 'a'.repeat(200);
      const slug = service.deriveRepoSlug(longId);
      expect(slug.length).toBeLessThanOrEqual(69); // 60 + 1 + 8
    });
  });

  describe('buildCollectionName', () => {
    it('includes repo slug and vector size', () => {
      const name = service.buildCollectionName('my_repo', 1536);
      expect(name).toBe('codebase_my_repo_1536');
    });

    it('works with different vector sizes', () => {
      const name = service.buildCollectionName('my_repo', 768);
      expect(name).toBe('codebase_my_repo_768');
    });

    it('includes branch slug when provided', () => {
      const name = service.buildCollectionName('my_repo', 1536, 'main');
      expect(name).toBe('codebase_my_repo_main_1536');
    });

    it('includes branch slug with different vector size', () => {
      const name = service.buildCollectionName('my_repo', 768, 'feature_xyz');
      expect(name).toBe('codebase_my_repo_feature_xyz_768');
    });
  });

  describe('deriveBranchSlug', () => {
    it('returns simple branch names as-is in lowercase', () => {
      expect(service.deriveBranchSlug('main')).toBe('main');
    });

    it('replaces slashes and hyphens with underscores', () => {
      expect(service.deriveBranchSlug('feature/my-feature')).toBe(
        'feature_my_feature',
      );
    });

    it('lowercases uppercase branch names', () => {
      expect(service.deriveBranchSlug('MAIN')).toBe('main');
    });

    it('truncates long branch names and appends hash suffix', () => {
      const longBranch = 'feature/' + 'a'.repeat(50);
      const slug = service.deriveBranchSlug(longBranch);
      // Should be truncated to 20 chars + '_' + 8-char hash = 29 chars
      expect(slug.length).toBeLessThanOrEqual(29);
      expect(slug).toMatch(/^[a-z0-9_]+$/);
      // The first part should be the truncated sanitized name
      expect(slug.slice(0, 20)).toBe(
        longBranch
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 20),
      );
    });
  });

  describe('copyCollectionPoints', () => {
    it('returns 0 when source collection does not exist', async () => {
      mockQdrantService.raw.getCollections.mockResolvedValueOnce({
        collections: [],
      });

      const result = await service.copyCollectionPoints(
        'source_collection',
        'target_collection',
      );

      expect(result).toBe(0);
      expect(mockQdrantService.raw.scroll).not.toHaveBeenCalled();
      expect(mockQdrantService.upsertPoints).not.toHaveBeenCalled();
    });

    it('returns 0 when source collection is empty', async () => {
      mockQdrantService.raw.getCollections.mockResolvedValueOnce({
        collections: [{ name: 'source_collection' }],
      });
      mockQdrantService.raw.scroll.mockResolvedValueOnce({
        points: [],
        next_page_offset: null,
      });

      const result = await service.copyCollectionPoints(
        'source_collection',
        'target_collection',
      );

      expect(result).toBe(0);
      expect(mockQdrantService.upsertPoints).not.toHaveBeenCalled();
    });

    it('copies all points from source to target collection', async () => {
      const mockPoints = [
        {
          id: 'point-1',
          vector: [0.1, 0.2, 0.3],
          payload: { repo_id: 'repo1', path: 'file1.ts', text: 'content1' },
        },
        {
          id: 'point-2',
          vector: [0.4, 0.5, 0.6],
          payload: { repo_id: 'repo1', path: 'file2.ts', text: 'content2' },
        },
      ];
      mockQdrantService.raw.getCollections.mockResolvedValueOnce({
        collections: [{ name: 'source_collection' }],
      });
      mockQdrantService.raw.scroll.mockResolvedValueOnce({
        points: mockPoints,
        next_page_offset: null,
      });

      const result = await service.copyCollectionPoints(
        'source_collection',
        'target_collection',
      );

      expect(result).toBe(2);
      expect(mockQdrantService.upsertPoints).toHaveBeenCalledWith(
        'target_collection',
        expect.arrayContaining([
          expect.objectContaining({
            id: 'point-1',
            vector: [0.1, 0.2, 0.3],
            payload: expect.objectContaining({ repo_id: 'repo1' }),
          }),
          expect.objectContaining({
            id: 'point-2',
            vector: [0.4, 0.5, 0.6],
            payload: expect.objectContaining({ repo_id: 'repo1' }),
          }),
        ]),
      );
    });
  });

  describe('getChunkingSignatureHash', () => {
    it('returns a consistent hex string', () => {
      const hash1 = service.getChunkingSignatureHash();
      const hash2 = service.getChunkingSignatureHash();
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('runFullIndex', () => {
    it('deletes old points and upserts new ones', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('ls-files')) {
          return { exitCode: 0, stdout: 'src/index.ts\n', stderr: '' };
        }
        if (params.cmd.includes('.codebaseindexignore')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (params.cmd.includes('head -c')) {
          return { exitCode: 0, stdout: 'export const x = 1;\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      mockOpenaiService.embeddings.mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
        usage: null,
      });

      // No existing chunks — forces fresh indexing path
      mockQdrantService.scrollAll.mockResolvedValue([]);
      // For cleanupOrphanedChunks
      mockQdrantService.raw.scroll.mockResolvedValue({
        points: [],
        next_page_offset: null,
      });

      await service.runFullIndex(
        {
          repoId: 'https://github.com/owner/repo',
          repoRoot: '/workspace/repo',
          currentCommit: 'abc123',
          collection: 'codebase_test_main_3',
          vectorSize: 3,
          embeddingModel: 'text-embedding-3-small',
        },
        execFn,
      );

      expect(mockQdrantService.deleteByFilter).toHaveBeenCalledWith(
        'codebase_test_main_3',
        expect.objectContaining({ must: expect.any(Array) }),
      );
      expect(mockQdrantService.upsertPoints).toHaveBeenCalled();
    });
  });

  describe('resolveCurrentCommit', () => {
    it('returns trimmed stdout from git rev-parse HEAD', async () => {
      const execFn: RepoExecFn = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'abc123def456\n',
        stderr: '',
      });

      const commit = await service.resolveCurrentCommit('/repo', execFn);
      expect(commit).toBe('abc123def456');
    });

    it('retries an exit-0 empty stdout (transient exec artifact) and returns the SHA on a later attempt', async () => {
      // Under heavy parallel load the runtime exec can resolve `rev-parse HEAD`
      // with exitCode 0 but an empty stdout — physically impossible from git in
      // a valid repo. The bounded retry absorbs it instead of throwing.
      const execFn: RepoExecFn = vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '   \n', stderr: '' })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'cafebabe1234\n',
          stderr: '',
        });

      const commit = await service.resolveCurrentCommit('/repo', execFn, 3, 1);
      expect(commit).toBe('cafebabe1234');
      expect(execFn).toHaveBeenCalledTimes(3);
    });

    it('throws after exhausting attempts when stdout stays empty', async () => {
      const execFn: RepoExecFn = vi
        .fn()
        .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

      await expect(
        service.resolveCurrentCommit('/repo', execFn, 3, 1),
      ).rejects.toThrow('Failed to resolve current commit: empty result');
      expect(execFn).toHaveBeenCalledTimes(3);
    });

    it('surfaces a genuine non-zero git error immediately without retrying', async () => {
      const execFn: RepoExecFn = vi.fn().mockResolvedValue({
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: not a git repository',
      });

      await expect(
        service.resolveCurrentCommit('/repo', execFn, 3, 1),
      ).rejects.toThrow(
        'Failed to resolve current commit: fatal: not a git repository',
      );
      expect(execFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('getCurrentBranch', () => {
    it('returns trimmed branch name', async () => {
      const execFn: RepoExecFn = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'feature/my-branch\n',
        stderr: '',
      });

      const branch = await service.getCurrentBranch('/repo', execFn);
      expect(branch).toBe('feature/my-branch');
    });
  });

  describe('estimateChangedTokenCount', () => {
    it('returns estimated tokens for changed files', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('diff --name-only')) {
          return {
            exitCode: 0,
            stdout: 'src/index.ts\nsrc/utils.ts\n',
            stderr: '',
          };
        }
        if (params.cmd.includes('status --porcelain')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (params.cmd.includes('ls-tree -l HEAD --')) {
          return {
            exitCode: 0,
            stdout: [
              '100644 blob abc123    800\tsrc/index.ts',
              '100644 blob def456    400\tsrc/utils.ts',
            ].join('\n'),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await service.estimateChangedTokenCount(
        '/repo',
        'aaa111',
        'bbb222',
        execFn,
      );
      // (800 + 400) / 4 * OVERLAP_FACTOR
      expect(result).toBe(Math.floor(((800 + 400) / 3) * OVERLAP_FACTOR));
    });

    it('falls back to full estimate when diff fails', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('diff --name-only')) {
          return {
            exitCode: 128,
            stdout: '',
            stderr: 'fatal: Invalid revision range',
          };
        }
        if (params.cmd.includes('ls-tree -r --long HEAD')) {
          return {
            exitCode: 0,
            stdout: [
              '100644 blob abc123    2000\tsrc/index.ts',
              '100644 blob def456    1000\tsrc/utils.ts',
              '100644 blob ghi789     600\tREADME.md',
            ].join('\n'),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await service.estimateChangedTokenCount(
        '/repo',
        'aaa111',
        'bbb222',
        execFn,
      );
      // Full repo: (2000 + 1000 + 600) / 4 * OVERLAP_FACTOR
      expect(result).toBe(
        Math.floor(((2000 + 1000 + 600) / 3) * OVERLAP_FACTOR),
      );
    });

    it('includes working tree changes in estimation', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('diff --name-only')) {
          return {
            exitCode: 0,
            stdout: 'src/committed.ts\n',
            stderr: '',
          };
        }
        if (params.cmd.includes('status --porcelain')) {
          return {
            exitCode: 0,
            stdout: ' M src/uncommitted.ts\n',
            stderr: '',
          };
        }
        if (params.cmd.includes('ls-tree -l HEAD --')) {
          return {
            exitCode: 0,
            stdout: [
              '100644 blob abc123    400\tsrc/committed.ts',
              '100644 blob def456    800\tsrc/uncommitted.ts',
            ].join('\n'),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await service.estimateChangedTokenCount(
        '/repo',
        'aaa111',
        'bbb222',
        execFn,
      );
      // (400 + 800) / 4 * OVERLAP_FACTOR
      expect(result).toBe(Math.floor(((400 + 800) / 3) * OVERLAP_FACTOR));
    });

    it('returns 0 when there are no changed files', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('diff --name-only')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (params.cmd.includes('status --porcelain')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await service.estimateChangedTokenCount(
        '/repo',
        'aaa111',
        'bbb222',
        execFn,
      );
      expect(result).toBe(0);
    });

    it('deduplicates files that appear in both diff and working tree', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('diff --name-only')) {
          return {
            exitCode: 0,
            stdout: 'src/shared.ts\n',
            stderr: '',
          };
        }
        if (params.cmd.includes('status --porcelain')) {
          return {
            exitCode: 0,
            stdout: ' M src/shared.ts\n',
            stderr: '',
          };
        }
        if (params.cmd.includes('ls-tree -l HEAD --')) {
          return {
            exitCode: 0,
            stdout: '100644 blob abc123    1200\tsrc/shared.ts',
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await service.estimateChangedTokenCount(
        '/repo',
        'aaa111',
        'bbb222',
        execFn,
      );
      // 1200 / 4 * OVERLAP_FACTOR (file counted only once despite appearing in both)
      expect(result).toBe(Math.floor((1200 / 3) * OVERLAP_FACTOR));
    });

    it('excludes changed files matching .codebaseindexignore patterns', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('diff --name-only')) {
          return {
            exitCode: 0,
            stdout: 'src/index.ts\ndist/bundle.js\n',
            stderr: '',
          };
        }
        if (params.cmd.includes('status --porcelain')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (params.cmd.includes('.codebaseindexignore')) {
          return { exitCode: 0, stdout: 'dist/', stderr: '' };
        }
        if (params.cmd.includes('ls-tree -l HEAD --')) {
          return {
            exitCode: 0,
            stdout: '100644 blob abc123    800\tsrc/index.ts',
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await service.estimateChangedTokenCount(
        '/repo',
        'aaa111',
        'bbb222',
        execFn,
      );
      // Only src/index.ts (800 bytes) should be counted; dist/bundle.js is ignored
      expect(result).toBe(Math.floor((800 / 3) * OVERLAP_FACTOR));
    });
  });

  describe('runIncrementalIndex', () => {
    const baseParams = {
      repoId: 'https://github.com/owner/repo',
      repoRoot: '/workspace/repo',
      currentCommit: 'new123',
      collection: 'codebase_test_main_3',
      vectorSize: 3,
      embeddingModel: 'text-embedding-3-small',
      lastIndexedCommit: 'old456',
    };

    it('processes only changed files between commits', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        // git diff --name-only old456..new123
        if (params.cmd.includes('diff --name-only')) {
          return {
            exitCode: 0,
            stdout: 'src/changed.ts\n',
            stderr: '',
          };
        }
        // git status --porcelain (no working tree changes)
        if (params.cmd.includes('status --porcelain')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // .gitignore / .codebaseindexignore reads
        if (
          params.cmd.includes('.codebaseindexignore') ||
          params.cmd.includes('.gitignore')
        ) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // batchFileExists: file exists → printed to stdout
        if (params.cmd.includes('&& echo')) {
          return { exitCode: 0, stdout: 'src/changed.ts\n', stderr: '' };
        }
        // head -c (read file content)
        if (params.cmd.includes('head -c')) {
          return {
            exitCode: 0,
            stdout: 'const updated = true;\n',
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      mockOpenaiService.embeddings.mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
        usage: null,
      });

      // No existing chunks for this file hash
      mockQdrantService.scrollAll.mockResolvedValue([]);

      await service.runIncrementalIndex(baseParams, execFn);

      // Should have called diff with the correct commit range
      expect(execFn).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: expect.stringContaining('diff --name-only'),
        }),
      );

      // Should upsert new points for the changed file
      expect(mockQdrantService.upsertPoints).toHaveBeenCalled();
    });

    it(
      'throws (no silent chunk deletion) when the existence check times out persistently',
      { timeout: 10_000 },
      async () => {
        const execFn: RepoExecFn = vi
          .fn()
          .mockImplementation(async (params) => {
            if (params.cmd.includes('diff --name-only')) {
              return { exitCode: 0, stdout: 'src/changed.ts\n', stderr: '' };
            }
            if (params.cmd.includes('status --porcelain')) {
              return { exitCode: 0, stdout: '', stderr: '' };
            }
            if (
              params.cmd.includes('.codebaseindexignore') ||
              params.cmd.includes('.gitignore')
            ) {
              return { exitCode: 0, stdout: '', stderr: '' };
            }
            // The existence check times out (exit 124) on every retry attempt.
            if (params.cmd.includes('&& echo')) {
              return { exitCode: 124, stdout: '', stderr: 'timed out' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
          });

        // A timed-out existence check must fail loud, NOT mark the file deleted
        // and drop its chunks.
        await expect(
          service.runIncrementalIndex(baseParams, execFn),
        ).rejects.toThrow(/File-existence check failed/);
        expect(mockQdrantService.deleteByFilter).not.toHaveBeenCalled();
      },
    );

    it('falls back to full index when diff fails (shallow clone case)', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        // git diff --name-only fails (shallow clone missing commit)
        if (params.cmd.includes('diff --name-only')) {
          return {
            exitCode: 128,
            stdout: '',
            stderr: 'fatal: Invalid revision range',
          };
        }
        // After fallback to runFullIndex, git ls-files is called
        if (params.cmd.includes('ls-files')) {
          return { exitCode: 0, stdout: 'src/index.ts\n', stderr: '' };
        }
        // .codebaseindexignore
        if (params.cmd.includes('.codebaseindexignore')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // head -c (read file content)
        if (params.cmd.includes('head -c')) {
          return {
            exitCode: 0,
            stdout: 'const x = 1;\n',
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      mockOpenaiService.embeddings.mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
        usage: null,
      });

      // No existing chunks
      mockQdrantService.scrollAll.mockResolvedValue([]);
      // For cleanupOrphanedChunks in runFullIndex
      mockQdrantService.raw.scroll.mockResolvedValue({
        points: [],
        next_page_offset: null,
      });

      await service.runIncrementalIndex(baseParams, execFn);

      // Should have logged a warning about fallback
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('falling back to full reindex'),
        expect.any(Object),
      );

      // Should call ls-files (full index) instead of relying on diff
      expect(execFn).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: expect.stringContaining('ls-files'),
        }),
      );
    });

    it('handles file deletions by removing old chunks', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        // git diff --name-only returns a deleted file
        if (params.cmd.includes('diff --name-only')) {
          return {
            exitCode: 0,
            stdout: 'src/deleted.ts\n',
            stderr: '',
          };
        }
        // git status --porcelain
        if (params.cmd.includes('status --porcelain')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // .codebaseindexignore
        if (params.cmd.includes('.codebaseindexignore')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // batchFileExists: file does not exist → not printed to stdout
        if (params.cmd.includes('[ -f')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      await service.runIncrementalIndex(baseParams, execFn);

      // Should have batch-deleted old chunks for the removed file
      expect(mockQdrantService.deleteByFilter).toHaveBeenCalledWith(
        'codebase_test_main_3',
        expect.objectContaining({
          must: expect.arrayContaining([
            expect.objectContaining({
              key: 'repo_id',
              match: { value: 'https://github.com/owner/repo' },
            }),
          ]),
          should: expect.arrayContaining([
            expect.objectContaining({
              key: 'path',
              match: { value: 'src/deleted.ts' },
            }),
          ]),
        }),
      );

      // Should NOT have upserted any new points (file was deleted, not updated)
      expect(mockQdrantService.upsertPoints).not.toHaveBeenCalled();
    });
  });

  describe('checkAndCopyExistingChunks (content reuse via runFullIndex)', () => {
    const baseParams = {
      repoId: 'https://github.com/owner/repo',
      repoRoot: '/workspace/repo',
      currentCommit: 'abc123',
      collection: 'codebase_test_main_3',
      vectorSize: 3,
      embeddingModel: 'text-embedding-3-small',
    };

    const makeExecFn = (fileContent: string): RepoExecFn =>
      vi.fn().mockImplementation(async (params: { cmd: string }) => {
        if (params.cmd.includes('ls-files')) {
          return { exitCode: 0, stdout: 'src/index.ts\n', stderr: '' };
        }
        if (params.cmd.includes('.codebaseindexignore')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (params.cmd.includes('head -c')) {
          return { exitCode: 0, stdout: fileContent, stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

    it('skips re-embedding when existing chunks match fileHash+path with current commit', async () => {
      const fileContent = 'const x = 1;';
      const execFn = makeExecFn(fileContent);

      // Prefetch returns matching chunk via raw.scroll
      mockQdrantService.raw.scroll.mockResolvedValue({
        points: [
          {
            payload: {
              path: 'src/index.ts',
              file_hash:
                // sha256 of 'const x = 1;'
                '3f41cbb303012f33212c92326b27f6cc604fd414e20315cb10f2be7f1f6bb83c',
              token_count: 12,
              commit: 'abc123',
            },
          },
        ],
        next_page_offset: null,
      });

      const onProgressUpdate = vi.fn();
      await service.runFullIndex(
        baseParams,
        execFn,
        undefined,
        onProgressUpdate,
      );

      // Should NOT have called embeddings — content was reused
      expect(mockOpenaiService.embeddings).not.toHaveBeenCalled();
      // Should report progress for the reused tokens
      expect(onProgressUpdate).toHaveBeenCalledWith(12);
    });

    it('updates metadata (no re-embedding) when existing chunks match fileHash+path but stale commit', async () => {
      const fileContent = 'const x = 1;';
      const execFn = makeExecFn(fileContent);

      // Prefetch returns chunk with OLD commit
      mockQdrantService.raw.scroll.mockResolvedValue({
        points: [
          {
            payload: {
              path: 'src/index.ts',
              file_hash:
                '3f41cbb303012f33212c92326b27f6cc604fd414e20315cb10f2be7f1f6bb83c',
              token_count: 12,
              commit: 'old-commit',
            },
          },
        ],
        next_page_offset: null,
      });

      // checkAndCopyExistingChunks will be called for stale commit — set up scrollAll
      mockQdrantService.scrollAll.mockResolvedValue([
        {
          id: 'point-1',
          payload: {
            repo_id: baseParams.repoId,
            path: 'src/index.ts',
            file_hash:
              '3f41cbb303012f33212c92326b27f6cc604fd414e20315cb10f2be7f1f6bb83c',
            text: fileContent,
            chunk_hash: 'chunk-hash-1',
            commit: 'old-commit',
            token_count: 12,
          },
        },
      ]);

      // raw.retrieve returns same point with vector for metadata update
      mockQdrantService.raw.retrieve.mockResolvedValue([
        {
          id: 'point-1',
          vector: [0.1, 0.2, 0.3],
          payload: {
            repo_id: baseParams.repoId,
            path: 'src/index.ts',
            file_hash:
              '3f41cbb303012f33212c92326b27f6cc604fd414e20315cb10f2be7f1f6bb83c',
            text: fileContent,
            chunk_hash: 'chunk-hash-1',
            commit: 'old-commit',
            token_count: 12,
          },
        },
      ]);

      await service.runFullIndex(baseParams, execFn);

      // Should NOT have called embeddings — reuse path with metadata update
      expect(mockOpenaiService.embeddings).not.toHaveBeenCalled();
      // Should have upserted updated metadata (new commit)
      expect(mockQdrantService.upsertPoints).toHaveBeenCalledWith(
        baseParams.collection,
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({ commit: 'abc123' }),
          }),
        ]),
      );
    });

    it('re-embeds when no existing chunks exist for the file', async () => {
      const fileContent = 'const x = 1;';
      const execFn = makeExecFn(fileContent);

      // Prefetch returns empty — no existing chunks
      mockQdrantService.raw.scroll.mockResolvedValue({
        points: [],
        next_page_offset: null,
      });
      mockQdrantService.scrollAll.mockResolvedValue([]);

      mockOpenaiService.embeddings.mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
        usage: null,
      });

      await service.runFullIndex(baseParams, execFn);

      // Should have called embeddings — new file
      expect(mockOpenaiService.embeddings).toHaveBeenCalled();
      expect(mockQdrantService.upsertPoints).toHaveBeenCalled();
    });
  });

  describe('cleanupOrphanedChunks (via runFullIndex)', () => {
    it('deletes chunks for files no longer in repo', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('ls-files')) {
          // Only src/keep.ts exists now
          return { exitCode: 0, stdout: 'src/keep.ts\n', stderr: '' };
        }
        if (params.cmd.includes('.codebaseindexignore')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (params.cmd.includes('head -c')) {
          return { exitCode: 0, stdout: 'kept content', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      mockOpenaiService.embeddings.mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
        usage: null,
      });
      mockQdrantService.scrollAll.mockResolvedValue([]);

      // Prefetch returns both keep.ts and deleted.ts — cleanupOrphanedChunks
      // reuses the prefetch map so no second scroll call is needed.
      mockQdrantService.raw.scroll.mockResolvedValueOnce({
        points: [
          {
            payload: {
              path: 'src/keep.ts',
              file_hash: 'different-hash',
              token_count: 10,
              commit: 'abc123',
            },
          },
          {
            payload: {
              path: 'src/deleted.ts',
              file_hash: 'old-hash',
              token_count: 20,
              commit: 'abc123',
            },
          },
        ],
        next_page_offset: null,
      });

      await service.runFullIndex(
        {
          repoId: 'https://github.com/owner/repo',
          repoRoot: '/workspace/repo',
          currentCommit: 'abc123',
          collection: 'codebase_test_main_3',
          vectorSize: 3,
          embeddingModel: 'text-embedding-3-small',
        },
        execFn,
      );

      // Verify orphaned chunks for deleted.ts were cleaned up
      const deleteCalls = mockQdrantService.deleteByFilter.mock.calls;
      const orphanDeleteCall = deleteCalls.find(
        (call: unknown[]) =>
          call[1] && (call[1] as { should?: unknown[] }).should !== undefined,
      );
      expect(orphanDeleteCall).toBeDefined();
      expect(orphanDeleteCall![1]).toEqual(
        expect.objectContaining({
          should: expect.arrayContaining([
            expect.objectContaining({
              key: 'path',
              match: { value: 'src/deleted.ts' },
            }),
          ]),
        }),
      );
    });

    it('does not delete anything when all chunks are valid', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('ls-files')) {
          return { exitCode: 0, stdout: 'src/index.ts\n', stderr: '' };
        }
        if (params.cmd.includes('.codebaseindexignore')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (params.cmd.includes('head -c')) {
          return { exitCode: 0, stdout: 'const x = 1;', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      mockOpenaiService.embeddings.mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
        usage: null,
      });
      mockQdrantService.scrollAll.mockResolvedValue([]);

      // Prefetch and cleanup both return only src/index.ts
      mockQdrantService.raw.scroll.mockResolvedValue({
        points: [{ payload: { path: 'src/index.ts' } }],
        next_page_offset: null,
      });

      await service.runFullIndex(
        {
          repoId: 'https://github.com/owner/repo',
          repoRoot: '/workspace/repo',
          currentCommit: 'abc123',
          collection: 'codebase_test_main_3',
          vectorSize: 3,
          embeddingModel: 'text-embedding-3-small',
        },
        execFn,
      );

      // No orphan delete calls — only per-file deletes
      const deleteCalls = mockQdrantService.deleteByFilter.mock.calls;
      const orphanDeleteCall = deleteCalls.find(
        (call: unknown[]) =>
          call[1] && (call[1] as { should?: unknown[] }).should !== undefined,
      );
      expect(orphanDeleteCall).toBeUndefined();
    });
  });

  describe('chunkText (via runFullIndex)', () => {
    /**
     * chunkText is private, so we test it indirectly through runFullIndex.
     * The mock tokenizer maps each character to one token, so we can
     * control chunk boundaries precisely.
     */

    it('produces no chunks for empty content', async () => {
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('ls-files')) {
          return { exitCode: 0, stdout: 'empty.ts\n', stderr: '' };
        }
        if (params.cmd.includes('.codebaseindexignore')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // Return only whitespace content — prepareFileIndexInput treats empty-after-trim as skip
        if (params.cmd.includes('head -c')) {
          return { exitCode: 0, stdout: '   \n  \n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      mockQdrantService.scrollAll.mockResolvedValue([]);

      await service.runFullIndex(
        {
          repoId: 'https://github.com/owner/repo',
          repoRoot: '/workspace/repo',
          currentCommit: 'abc123',
          collection: 'codebase_test_main_3',
          vectorSize: 3,
          embeddingModel: 'text-embedding-3-small',
        },
        execFn,
      );

      // No embeddings should have been created for empty/whitespace-only content
      expect(mockOpenaiService.embeddings).not.toHaveBeenCalled();
      // upsertPoints should not be called for empty batches
      expect(mockQdrantService.upsertPoints).not.toHaveBeenCalled();
    });

    it('creates a single chunk for small files', async () => {
      // With mock tokenizer: each char = 1 token, default target = 250 tokens
      // A 20-char string will produce a single chunk
      const smallContent = 'const x = 42;';

      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('ls-files')) {
          return { exitCode: 0, stdout: 'small.ts\n', stderr: '' };
        }
        if (params.cmd.includes('.codebaseindexignore')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (params.cmd.includes('head -c')) {
          return { exitCode: 0, stdout: smallContent, stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      mockOpenaiService.embeddings.mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
        usage: null,
      });
      mockQdrantService.scrollAll.mockResolvedValue([]);
      mockQdrantService.raw.scroll.mockResolvedValue({
        points: [],
        next_page_offset: null,
      });

      await service.runFullIndex(
        {
          repoId: 'https://github.com/owner/repo',
          repoRoot: '/workspace/repo',
          currentCommit: 'abc123',
          collection: 'codebase_test_main_3',
          vectorSize: 3,
          embeddingModel: 'text-embedding-3-small',
        },
        execFn,
      );

      // Should embed exactly one chunk
      expect(mockOpenaiService.embeddings).toHaveBeenCalledTimes(1);
      expect(mockOpenaiService.embeddings).toHaveBeenCalledWith(
        expect.objectContaining({
          input: [smallContent],
        }),
      );

      // Should upsert exactly one point
      expect(mockQdrantService.upsertPoints).toHaveBeenCalledWith(
        'codebase_test_main_3',
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              text: smallContent,
              path: 'small.ts',
              start_line: 1,
            }),
          }),
        ]),
      );
    });

    it('creates multiple chunks with overlap for large files', async () => {
      // The mock tokenizer maps each char to 1 token.
      // Default target = 250 tokens, overlap = 30 tokens.
      // Build a string of 300 chars => 300 tokens => should produce 2 chunks.
      // Chunk 1: tokens 0..250 (chars 0..250)
      // Chunk 2: tokens 220..300 (starts at 250 - 30 = 220, ends at 300)
      const largeContent = 'a'.repeat(300);

      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('ls-files')) {
          return { exitCode: 0, stdout: 'large.ts\n', stderr: '' };
        }
        if (params.cmd.includes('.codebaseindexignore')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (params.cmd.includes('head -c')) {
          return { exitCode: 0, stdout: largeContent, stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      // Return matching embeddings for 2 chunks
      mockOpenaiService.embeddings.mockResolvedValue({
        embeddings: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
        usage: null,
      });
      mockQdrantService.scrollAll.mockResolvedValue([]);
      mockQdrantService.raw.scroll.mockResolvedValue({
        points: [],
        next_page_offset: null,
      });

      await service.runFullIndex(
        {
          repoId: 'https://github.com/owner/repo',
          repoRoot: '/workspace/repo',
          currentCommit: 'abc123',
          collection: 'codebase_test_main_3',
          vectorSize: 3,
          embeddingModel: 'text-embedding-3-small',
        },
        execFn,
      );

      // Should embed two chunks in a single batch
      expect(mockOpenaiService.embeddings).toHaveBeenCalledTimes(1);
      expect(mockOpenaiService.embeddings).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.arrayContaining([
            expect.any(String),
            expect.any(String),
          ]),
        }),
      );

      // Should upsert two points
      expect(mockQdrantService.upsertPoints).toHaveBeenCalledWith(
        'codebase_test_main_3',
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              path: 'large.ts',
              start_line: 1,
            }),
          }),
          expect.objectContaining({
            payload: expect.objectContaining({
              path: 'large.ts',
            }),
          }),
        ]),
      );

      // Verify the two chunks overlap: the second chunk's text starts
      // inside the first chunk's region (overlap = 30 tokens = 30 chars)
      const upsertCall = mockQdrantService.upsertPoints.mock.calls[0]!;
      const points = upsertCall[1] as {
        payload: { text: string; token_count: number };
      }[];
      expect(points).toHaveLength(2);
      // First chunk should be 200 tokens (codebaseChunkTargetTokens default)
      expect(points[0]!.payload.token_count).toBe(200);
      // Second chunk should be 130 tokens (300 - (200 - 30 overlap))
      expect(points[1]!.payload.token_count).toBe(130);
      // The second chunk text should be contained within the trailing part of the full content
      expect(largeContent).toContain(points[1]!.payload.text);
    });
  });

  describe('prepareFileIndexInput surrogate sanitization (via runFullIndex)', () => {
    /**
     * prepareFileIndexInput is private, so we test it indirectly through
     * runFullIndex. The mock execFn returns surrogate-containing content from
     * the `head -c` call, and we assert on the text stored in upsertPoints.
     */

    const baseParams = {
      repoId: 'https://github.com/owner/repo',
      repoRoot: '/workspace/repo',
      currentCommit: 'abc123',
      collection: 'codebase_test_main_3',
      vectorSize: 3,
      embeddingModel: 'text-embedding-3-small',
    };

    const makeExecFn = (fileContent: string): RepoExecFn =>
      vi.fn().mockImplementation(async (params: { cmd: string }) => {
        if (params.cmd.includes('ls-files')) {
          return { exitCode: 0, stdout: 'src/file.ts\n', stderr: '' };
        }
        if (params.cmd.includes('.codebaseindexignore')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (params.cmd.includes('head -c')) {
          return { exitCode: 0, stdout: fileContent, stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

    beforeEach(() => {
      mockQdrantService.scrollAll.mockResolvedValue([]);
      mockQdrantService.raw.scroll.mockResolvedValue({
        points: [],
        next_page_offset: null,
      });
      mockOpenaiService.embeddings.mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
        usage: null,
      });
    });

    it('replaces a lone high surrogate with U+FFFD in the indexed payload text', async () => {
      // U+D83D is a high surrogate not followed by a low surrogate
      const loneHighSurrogate = '\uD83D';
      const rawContent = `before${loneHighSurrogate}after`;
      const expectedContent = 'before\uFFFDafter';

      await service.runFullIndex(baseParams, makeExecFn(rawContent));

      expect(mockQdrantService.upsertPoints).toHaveBeenCalledWith(
        baseParams.collection,
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({ text: expectedContent }),
          }),
        ]),
      );
    });

    it('replaces a lone low surrogate with U+FFFD in the indexed payload text', async () => {
      // U+DC00 is a low surrogate not preceded by a high surrogate
      const loneLowSurrogate = '\uDC00';
      const rawContent = `before${loneLowSurrogate}after`;
      const expectedContent = 'before\uFFFDafter';

      await service.runFullIndex(baseParams, makeExecFn(rawContent));

      expect(mockQdrantService.upsertPoints).toHaveBeenCalledWith(
        baseParams.collection,
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({ text: expectedContent }),
          }),
        ]),
      );
    });

    it('passes a valid surrogate pair through unchanged', async () => {
      // U+D83D + U+DE00 forms the valid emoji 😀 (U+1F600)
      const validSurrogatePair = '\uD83D\uDE00';
      const rawContent = `hello ${validSurrogatePair} world`;

      await service.runFullIndex(baseParams, makeExecFn(rawContent));

      expect(mockQdrantService.upsertPoints).toHaveBeenCalledWith(
        baseParams.collection,
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({ text: rawContent }),
          }),
        ]),
      );
    });
  });

  describe('withTimeout', () => {
    it('returns the result when exec completes before timeout', async () => {
      const execFn: RepoExecFn = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
      });

      const wrapped = RepoIndexerService.withTimeout(execFn, 5000);
      const result = await wrapped({ cmd: 'echo ok' });

      expect(result).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
    });

    it('rejects when exec exceeds the timeout', async () => {
      const execFn: RepoExecFn = vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ exitCode: 0, stdout: 'late', stderr: '' }),
                10_000,
              ),
            ),
        );

      const wrapped = RepoIndexerService.withTimeout(execFn, 50);

      await expect(wrapped({ cmd: 'sleep 10' })).rejects.toThrow(
        /Git exec timed out after 50ms/,
      );
    });

    it('returns the original execFn when timeout is <= 0', () => {
      const execFn: RepoExecFn = vi.fn();
      const wrapped = RepoIndexerService.withTimeout(execFn, 0);
      expect(wrapped).toBe(execFn);
    });

    it('propagates errors from the original execFn', async () => {
      const execFn: RepoExecFn = vi
        .fn()
        .mockRejectedValue(new Error('exec failed'));

      const wrapped = RepoIndexerService.withTimeout(execFn, 5000);

      await expect(wrapped({ cmd: 'bad cmd' })).rejects.toThrow('exec failed');
    });
  });

  describe('withRetry', () => {
    it('returns a successful result without retrying', async () => {
      const execFn: RepoExecFn = vi
        .fn()
        .mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' });

      const wrapped = RepoIndexerService.withRetry(execFn, 3, 1);
      const result = await wrapped({ cmd: 'git ls-files' });

      expect(result).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
      expect(execFn).toHaveBeenCalledTimes(1);
    });

    it('retries on a timeout exit code (124) then returns the success', async () => {
      const execFn: RepoExecFn = vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 124, stdout: '', stderr: 'timeout' })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'src/app.ts',
          stderr: '',
        });

      const wrapped = RepoIndexerService.withRetry(execFn, 3, 1);
      const result = await wrapped({ cmd: 'git ls-files' });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('src/app.ts');
      expect(execFn).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry a legitimate non-zero exit (e.g. `[ -f missing ]` -> 1)', async () => {
      const execFn: RepoExecFn = vi
        .fn()
        .mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      const wrapped = RepoIndexerService.withRetry(execFn, 3, 1);
      const result = await wrapped({ cmd: '[ -f missing ] && echo missing' });

      expect(result.exitCode).toBe(1);
      expect(execFn).toHaveBeenCalledTimes(1);
    });

    it('retries on a thrown rejection then resolves', async () => {
      const execFn: RepoExecFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Git exec timed out after 60000ms'))
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'done', stderr: '' });

      const wrapped = RepoIndexerService.withRetry(execFn, 3, 1);
      const result = await wrapped({ cmd: 'git ls-files' });

      expect(result.stdout).toBe('done');
      expect(execFn).toHaveBeenCalledTimes(2);
    });

    it('returns the last timeout result after exhausting all attempts', async () => {
      const execFn: RepoExecFn = vi
        .fn()
        .mockResolvedValue({ exitCode: 124, stdout: '', stderr: 'timeout' });

      const wrapped = RepoIndexerService.withRetry(execFn, 3, 1);
      const result = await wrapped({ cmd: 'git ls-files' });

      expect(result.exitCode).toBe(124);
      expect(execFn).toHaveBeenCalledTimes(3);
    });

    it('throws the last error when every attempt rejects', async () => {
      const execFn: RepoExecFn = vi
        .fn()
        .mockRejectedValue(new Error('exec timed out'));

      const wrapped = RepoIndexerService.withRetry(execFn, 3, 1);

      await expect(wrapped({ cmd: 'git ls-files' })).rejects.toThrow(
        'exec timed out',
      );
      expect(execFn).toHaveBeenCalledTimes(3);
    });

    it('returns the original execFn when attempts <= 1', () => {
      const execFn: RepoExecFn = vi.fn();
      expect(RepoIndexerService.withRetry(execFn, 1)).toBe(execFn);
    });
  });

  describe('listTrackedFiles failure handling (via runFullIndex)', () => {
    it('fails loud instead of silently indexing zero files when git ls-files fails', async () => {
      // A failed read must NOT be mistaken for an empty repository — otherwise a
      // load-induced exec timeout silently produces a 0-file index. exit 1 is a
      // genuine (non-retryable) failure, so this surfaces immediately.
      const execFn: RepoExecFn = vi.fn().mockImplementation(async (params) => {
        if (params.cmd.includes('ls-files')) {
          return { exitCode: 1, stdout: '', stderr: 'fatal: not a git repo' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      await expect(
        service.runFullIndex(
          {
            repoId: 'https://github.com/owner/repo',
            repoRoot: '/workspace/repo',
            currentCommit: 'abc123',
            collection: 'codebase_test_main_3',
            vectorSize: 3,
            embeddingModel: 'text-embedding-3-small',
          },
          execFn,
        ),
      ).rejects.toThrow(/Failed to list tracked files/);

      expect(mockQdrantService.upsertPoints).not.toHaveBeenCalled();
    });
  });

  describe('listWorkingTreeChanges rename parsing', () => {
    it('parses renames using " -> " separator', async () => {
      const execFn: RepoExecFn = vi
        .fn()
        .mockImplementation(async (params: { cmd: string }) => {
          if (params.cmd.includes('status --porcelain')) {
            return {
              exitCode: 0,
              stdout: 'R  old-name.ts -> new-name.ts\n',
              stderr: '',
            };
          }
          if (params.cmd.includes('diff --name-only')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (params.cmd.includes('.codebaseindexignore')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (params.cmd.includes('[ -f')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        });

      // Use runIncrementalIndex which calls listWorkingTreeChanges
      await service.runIncrementalIndex(
        {
          repoId: 'https://github.com/owner/repo',
          repoRoot: '/workspace/repo',
          currentCommit: 'abc123',
          collection: 'codebase_test_main_3',
          vectorSize: 3,
          embeddingModel: 'text-embedding-3-small',
          lastIndexedCommit: 'prev123',
        },
        execFn,
      );

      // Both old and new paths should have been processed
      // The deleteByFilter call should include old-name.ts in should filter
      expect(mockQdrantService.deleteByFilter).toHaveBeenCalledWith(
        'codebase_test_main_3',
        expect.objectContaining({
          should: expect.arrayContaining([
            expect.objectContaining({
              key: 'path',
              match: expect.objectContaining({
                value: expect.stringContaining('name.ts'),
              }),
            }),
          ]),
        }),
      );
    });
  });

  describe('resolveEmbeddingBatchBudget', () => {
    const callResolve = (model: string): Promise<number> =>
      (
        service as unknown as {
          resolveEmbeddingBatchBudget: (m: string) => Promise<number>;
        }
      ).resolveEmbeddingBatchBudget(model);

    it('clamps the env budget down to the model window when smaller', async () => {
      mockLitellmService.getModelMaxInputTokens.mockResolvedValue(8191);

      await expect(callResolve('text-embedding-3-small')).resolves.toBe(8191);
      expect(8191).toBeLessThan(environment.codebaseEmbeddingMaxTokens);
    });

    it('keeps the env budget when the model window is larger', async () => {
      mockLitellmService.getModelMaxInputTokens.mockResolvedValue(300_000);

      await expect(callResolve('big-window-model')).resolves.toBe(
        environment.codebaseEmbeddingMaxTokens,
      );
    });

    it('falls back to the env budget when the model window is unknown', async () => {
      mockLitellmService.getModelMaxInputTokens.mockResolvedValue(null);

      await expect(callResolve('mystery-model')).resolves.toBe(
        environment.codebaseEmbeddingMaxTokens,
      );
    });
  });
});
