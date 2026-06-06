import { describe, expect, it } from 'vitest';

import type { SystemAgentDefinition } from './system-agents.types';
import {
  computeContentHash,
  parseSystemAgentFile,
  parseToolEntry,
  SystemAgentFrontmatterSchema,
  toSystemAgentResponse,
} from './system-agents.utils';

const VALID_FILE_CONTENT = `---
id: engineer
name: Engineer
description: A software engineer agent.
tools:
  - shell-tool
  - files-tool
---

You are a senior software engineer.

## Core Responsibilities
- Write clean code
`;

describe('computeContentHash', () => {
  it('returns a sha256 hex string', () => {
    const hash = computeContentHash('hello');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns different hashes for different inputs', () => {
    const hash1 = computeContentHash('hello');
    const hash2 = computeContentHash('world');
    expect(hash1).not.toBe(hash2);
  });

  it('returns the same hash for the same input', () => {
    const hash1 = computeContentHash('same content');
    const hash2 = computeContentHash('same content');
    expect(hash1).toBe(hash2);
  });
});

describe('SystemAgentFrontmatterSchema', () => {
  it('validates a valid frontmatter object', () => {
    const result = SystemAgentFrontmatterSchema.safeParse({
      id: 'engineer',
      name: 'Engineer',
      description: 'A software engineer agent.',
      tools: ['shell-tool'],
    });
    expect(result.success).toBe(true);
  });

  it('defaults defaultModel to null when not provided', () => {
    const result = SystemAgentFrontmatterSchema.safeParse({
      id: 'engineer',
      name: 'Engineer',
      description: 'A software engineer agent.',
      tools: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultModel).toBeNull();
    }
  });

  it('rejects missing id', () => {
    const result = SystemAgentFrontmatterSchema.safeParse({
      name: 'Engineer',
      description: 'Desc',
      tools: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing name', () => {
    const result = SystemAgentFrontmatterSchema.safeParse({
      id: 'engineer',
      description: 'Desc',
      tools: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing description', () => {
    const result = SystemAgentFrontmatterSchema.safeParse({
      id: 'engineer',
      name: 'Engineer',
      tools: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing tools array', () => {
    const result = SystemAgentFrontmatterSchema.safeParse({
      id: 'engineer',
      name: 'Engineer',
      description: 'Desc',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an explicit defaultModel string', () => {
    const result = SystemAgentFrontmatterSchema.safeParse({
      id: 'engineer',
      name: 'Engineer',
      description: 'Desc',
      tools: [],
      defaultModel: 'gpt-4o',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultModel).toBe('gpt-4o');
    }
  });
});

describe('parseToolEntry', () => {
  it('parses a plain tool ID without config', () => {
    expect(parseToolEntry('files-tool')).toEqual({ id: 'files-tool' });
  });

  it('parses a tool ID with JSON config after pipe delimiter', () => {
    expect(parseToolEntry('gh-tool|{"readOnly":true}')).toEqual({
      id: 'gh-tool',
      config: { readOnly: true },
    });
  });

  it('parses config with multiple properties', () => {
    expect(
      parseToolEntry('gh-tool|{"readOnly":true,"additionalLabels":["bug"]}'),
    ).toEqual({
      id: 'gh-tool',
      config: { readOnly: true, additionalLabels: ['bug'] },
    });
  });

  it('throws on invalid JSON after pipe', () => {
    expect(() => parseToolEntry('gh-tool|{invalid}')).toThrow();
  });
});

describe('parseSystemAgentFile', () => {
  it('parses a valid .md file into a SystemAgentDefinition', () => {
    const definition = parseSystemAgentFile('engineer.md', VALID_FILE_CONTENT);

    expect(definition.id).toBe('engineer');
    expect(definition.name).toBe('Engineer');
    expect(definition.description).toBe('A software engineer agent.');
    expect(definition.tools).toEqual([
      { id: 'shell-tool' },
      { id: 'files-tool' },
    ]);
    expect(definition.defaultModel).toBeNull();
    expect(definition.templateId).toBe('system-agent-engineer');
    expect(definition.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('extracts body content as instructions (trimmed)', () => {
    const definition = parseSystemAgentFile('engineer.md', VALID_FILE_CONTENT);
    expect(definition.instructions).toBe(
      'You are a senior software engineer.\n\n## Core Responsibilities\n- Write clean code',
    );
  });

  it('computes contentHash from the full file content', () => {
    const definition = parseSystemAgentFile('engineer.md', VALID_FILE_CONTENT);
    const expectedHash = computeContentHash(VALID_FILE_CONTENT);
    expect(definition.contentHash).toBe(expectedHash);
  });

  it('throws when frontmatter is missing required fields', () => {
    const invalidContent = `---
name: Engineer
---
Body content here.
`;
    expect(() => parseSystemAgentFile('bad.md', invalidContent)).toThrow();
  });

  it('throws when frontmatter is invalid', () => {
    const invalidContent = `---
id: ""
name: Engineer
description: Desc
tools: []
---
Body.
`;
    expect(() => parseSystemAgentFile('bad.md', invalidContent)).toThrow();
  });
});

describe('toSystemAgentResponse', () => {
  const definition: SystemAgentDefinition = {
    id: 'engineer',
    name: 'Engineer',
    description: 'A software engineer agent.',
    tools: [
      { id: 'shell-tool' },
      { id: 'gh-tool', config: { readOnly: true } },
    ],
    defaultModel: 'gpt-4o',
    instructions: 'You are a senior software engineer.',
    contentHash: 'a'.repeat(64),
    templateId: 'system-agent-engineer',
  };

  it('exposes tools as their ids, dropping the internal config', () => {
    expect(toSystemAgentResponse(definition).tools).toEqual([
      'shell-tool',
      'gh-tool',
    ]);
  });

  it('maps all other fields through unchanged', () => {
    expect(toSystemAgentResponse(definition)).toEqual({
      id: 'engineer',
      templateId: 'system-agent-engineer',
      name: 'Engineer',
      description: 'A software engineer agent.',
      tools: ['shell-tool', 'gh-tool'],
      defaultModel: 'gpt-4o',
      instructions: 'You are a senior software engineer.',
      contentHash: 'a'.repeat(64),
    });
  });

  it('returns an empty tools array when the agent has no tools', () => {
    expect(toSystemAgentResponse({ ...definition, tools: [] }).tools).toEqual(
      [],
    );
  });
});
