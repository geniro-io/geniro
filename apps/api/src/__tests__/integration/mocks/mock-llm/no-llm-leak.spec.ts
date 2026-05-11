import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guard test: ensures that `new ChatOpenAI(` and `new OpenAI(` are only ever
 * constructed in the two known seam files.
 *
 * Any additional direct instantiation bypasses the mock seam and will cause
 * integration tests to hit the real LLM proxy.
 *
 * Remediation when this test fails:
 *   - Route the new ChatOpenAI usage through BaseAgent.buildLLM (or inject
 *     ChatOpenAI via the DI token so MockLlmService can intercept it).
 *   - Route the new OpenAI usage through OpenaiService.
 *   - If a genuinely new seam is needed, add it to the allowlist here and
 *     extend MockLlmService to cover the new seam.
 */

// ---- Allowlists (repo-root-relative paths, forward slashes) ----------------

const ALLOWED_CHAT_OPENAI: string[] = [
  'apps/api/src/v1/agents/services/agents/base-agent.ts',
];

const ALLOWED_OPENAI: string[] = ['apps/api/src/v1/openai/openai.service.ts'];

// ---- Directories to scan (repo-root-relative) ------------------------------

const SCAN_DIRS: string[] = ['apps/api/src/v1', 'packages'];

// ---- Repo-root resolution --------------------------------------------------
//
// This file lives at:
//   apps/api/src/__tests__/integration/mocks/mock-llm/no-llm-leak.spec.ts
// That is 7 path segments deep from the repo root, so __dirname + 7x ".."
// reaches the repo root.

const REPO_ROOT = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
);

// ---- File walker -----------------------------------------------------------

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (
      entry.isFile() &&
      full.endsWith('.ts') &&
      !full.endsWith('.spec.ts') &&
      !full.endsWith('.int.ts') &&
      !full.endsWith('.test.ts')
    ) {
      yield full;
    }
  }
}

// ---- Scanner ---------------------------------------------------------------

function findOccurrences(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(REPO_ROOT, dir))) {
      const content = fs.readFileSync(file, 'utf8');
      if (pattern.test(content)) {
        // Normalise to forward-slash repo-root-relative path for stable comparison
        hits.push(path.relative(REPO_ROOT, file).replace(/\\/g, '/'));
      }
    }
  }
  return hits.sort();
}

// ---- Tests -----------------------------------------------------------------

describe('no-llm-leak guard', () => {
  it('only base-agent.ts may construct new ChatOpenAI()', () => {
    const hits = findOccurrences(/\bnew ChatOpenAI\s*\(/);
    const unexpected = hits.filter((f) => !ALLOWED_CHAT_OPENAI.includes(f));
    expect(
      unexpected,
      `Unexpected new ChatOpenAI() in: ${unexpected.join(', ')}\n` +
        `Route the new call through BaseAgent.buildLLM (or inject via DI token) ` +
        `so MockLlmService can intercept it, or extend MockLlmService to cover the new seam ` +
        `and add the file to ALLOWED_CHAT_OPENAI in no-llm-leak.spec.ts.`,
    ).toEqual([]);
  });

  it('only openai.service.ts may construct new OpenAI()', () => {
    const hits = findOccurrences(/\bnew OpenAI\s*\(/);
    const unexpected = hits.filter((f) => !ALLOWED_OPENAI.includes(f));
    expect(
      unexpected,
      `Unexpected new OpenAI() in: ${unexpected.join(', ')}\n` +
        `Route the new call through OpenaiService so MockLlmService can intercept it, ` +
        `or extend MockLlmService to cover the new seam ` +
        `and add the file to ALLOWED_OPENAI in no-llm-leak.spec.ts.`,
    ).toEqual([]);
  });

  it('repo root resolves to a valid directory containing apps/', () => {
    // Sanity check: if the path arithmetic is wrong, the scanner silently
    // finds no files and the leak guard is vacuously true.
    const appsDir = path.join(REPO_ROOT, 'apps');
    expect(
      fs.existsSync(appsDir),
      `REPO_ROOT (${REPO_ROOT}) does not contain an apps/ directory — ` +
        `__dirname path arithmetic in no-llm-leak.spec.ts is wrong.`,
    ).toBe(true);
  });
});
