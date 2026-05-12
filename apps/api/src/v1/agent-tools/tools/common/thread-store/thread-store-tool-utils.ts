import { ThreadStoreEntry } from '../../../../thread-store/dto/thread-store.dto';
import { ThreadStoreEntryOutput } from './thread-store-tools.types';

export function toEntryOutput(entry: ThreadStoreEntry): ThreadStoreEntryOutput {
  return {
    namespace: entry.namespace,
    key: entry.key,
    value: entry.value,
    mode: entry.mode,
    authorAgentId: entry.authorAgentId,
    tags: entry.tags,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}
