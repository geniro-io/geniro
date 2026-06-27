export enum AgentMemoryEntryMode {
  /** Upsertable key-value entry. Callers supply a stable key. */
  Kv = 'kv',
  /** Append-only log entry. Key is auto-generated and entries cannot be overwritten. */
  Append = 'append',
}

export enum AgentMemoryAction {
  Put = 'put',
  Append = 'append',
  Delete = 'delete',
  Prune = 'prune',
}

/**
 * Per-field length caps, bound to the `agent_memory_entries` column widths
 * (varchar(N)). These are NOT operator-tunable: the DTO and the agent tool
 * schemas both read them, so the human and agent write paths reject an
 * over-long value identically — before the DB would otherwise truncate or
 * 500 on insert. A length cap can only change together with a column-widening
 * migration, which is why it lives here as a constant rather than in the env.
 * The genuinely operational caps (value byte size and the per-namespace /
 * per-project entry quotas) stay env-configurable in environment.prod.ts.
 */
export const AGENT_MEMORY_MAX_NAMESPACE_LENGTH = 128;
export const AGENT_MEMORY_MAX_KEY_LENGTH = 256;
export const AGENT_MEMORY_MAX_TITLE_LENGTH = 256;

/** Tag caps shared by the DTO and the agent tool schemas (`tags` is text[]). */
export const AGENT_MEMORY_MAX_TAG_LENGTH = 64;
export const AGENT_MEMORY_MAX_TAGS_COUNT = 16;

// The M2 semantic-search bounds (default / max result limit) and the embed-input
// truncation budget are operational, model-coupled knobs — they live in the env
// (agentMemorySearchDefaultLimit / agentMemorySearchMaxLimit / agentMemoryEmbedMaxChars
// in environment.prod.ts, parsed via getEnvPositiveInt, fail-closed). Only the
// column-bound LENGTH caps above are baked constants.

/** A semantic-search hit: enough to locate the entry, no body. */
export interface AgentMemorySearchMatch {
  namespace: string;
  key: string;
  title: string | null;
}

export interface NamespaceSummaryRow {
  namespace: string;
  mode: AgentMemoryEntryMode;
  entryCount: number;
  lastUpdatedAt: Date;
}

/** A single row of the live project memory index (titles/keys/tags, no bodies). */
export interface ProjectMemoryIndexRow {
  namespace: string;
  key: string;
  title: string | null;
  mode: AgentMemoryEntryMode;
  tags: string[] | null;
  updatedAt: Date;
}

export interface PutEntryInput {
  namespace: string;
  key: string;
  value: unknown;
  title?: string | null;
  authorAgentId?: string | null;
  tags?: string[] | null;
}

export interface AppendEntryInput {
  namespace: string;
  value: unknown;
  title?: string | null;
  authorAgentId?: string | null;
  tags?: string[] | null;
}
