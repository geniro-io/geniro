import { ThreadStoreEntryMode } from '../../../../thread-store/thread-store.types';

export type ThreadStoreEntryOutput = {
  namespace: string;
  key: string;
  value: unknown;
  mode: ThreadStoreEntryMode;
  authorAgentId: string | null;
  tags: string[] | null;
  createdAt: string;
  updatedAt: string;
};
