import { createHash } from 'crypto';
import matter from 'gray-matter';
import { z } from 'zod';

import type {
  SystemAgentDefinition,
  SystemAgentToolEntry,
} from './system-agents.types';

export const SystemAgentFrontmatterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  tools: z.array(z.string()),
  defaultModel: z.string().nullable().optional().default(null),
});

export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function parseToolEntry(raw: string): SystemAgentToolEntry {
  const pipeIdx = raw.indexOf('|');
  if (pipeIdx === -1) {
    return { id: raw };
  }

  const id = raw.slice(0, pipeIdx);
  const jsonStr = raw.slice(pipeIdx + 1);

  return { id, config: JSON.parse(jsonStr) as Record<string, unknown> };
}

export function parseSystemAgentFile(
  filePath: string,
  fileContent: string,
): SystemAgentDefinition {
  const parsed = matter(fileContent);

  const frontmatterResult = SystemAgentFrontmatterSchema.safeParse(parsed.data);

  if (!frontmatterResult.success) {
    throw new Error(
      `Invalid frontmatter in ${filePath}: ${frontmatterResult.error.message}`,
    );
  }

  const frontmatter = frontmatterResult.data;
  const instructions = parsed.content.trim();
  const contentHash = computeContentHash(fileContent);
  const templateId = `system-agent-${frontmatter.id}`;

  return {
    id: frontmatter.id,
    name: frontmatter.name,
    description: frontmatter.description,
    tools: frontmatter.tools.map(parseToolEntry),
    defaultModel: frontmatter.defaultModel,
    instructions,
    contentHash,
    templateId,
  };
}
