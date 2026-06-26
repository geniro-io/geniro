import { AgentMemoryEntryMode } from '../../../../agent-memory/agent-memory.types';

export type AgentMemoryWriteOutput = {
  id: string;
  namespace: string;
  key: string;
};

export type AgentMemoryEntryOutput = {
  namespace: string;
  key: string;
  title: string | null;
  value: unknown;
  mode: AgentMemoryEntryMode;
  authorAgentId: string | null;
  tags: string[] | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentMemoryIndexRowOutput = {
  namespace: string;
  key: string;
  title: string | null;
  mode: AgentMemoryEntryMode;
  tags: string[] | null;
  updatedAt: string;
};

export type AgentMemoryListOutput = {
  entries: AgentMemoryIndexRowOutput[];
};

export type AgentMemoryDeleteOutput = {
  namespace: string;
  key: string;
  deleted: true;
};
