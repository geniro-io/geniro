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
