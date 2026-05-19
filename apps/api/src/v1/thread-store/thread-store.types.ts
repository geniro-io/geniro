export enum ThreadStoreEntryMode {
  /** Upsertable key-value entry. Callers supply a stable key. */
  Kv = 'kv',
  /** Append-only log entry. Key is auto-generated and entries cannot be overwritten or deleted. */
  Append = 'append',
}

export enum ThreadStoreAction {
  Put = 'put',
  Append = 'append',
  Delete = 'delete',
}

export interface NamespaceSummaryRow {
  namespace: string;
  mode: ThreadStoreEntryMode;
  entryCount: number;
  lastUpdatedAt: Date;
}

export const THREAD_STORE_MAX_VALUE_BYTES = 32 * 1024;
export const THREAD_STORE_MAX_ENTRIES_PER_NAMESPACE = 500;
export const THREAD_STORE_MAX_NAMESPACE_LENGTH = 128;
export const THREAD_STORE_MAX_KEY_LENGTH = 256;

export interface PutEntryInput {
  namespace: string;
  key: string;
  value: unknown;
  authorAgentId?: string;
  tags?: string[];
}

export interface AppendEntryInput {
  namespace: string;
  value: unknown;
  authorAgentId?: string;
  tags?: string[];
}
