import { EntityManager } from '@mikro-orm/postgresql';
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, Mock, vi } from 'vitest';

import {
  AGENT_MEMORY_MAX_ENTRIES_PER_NAMESPACE,
  AGENT_MEMORY_MAX_ENTRIES_PER_PROJECT,
  AgentMemoryEntryMode,
} from '../agent-memory.types';
import { AgentMemoryDao } from '../dao/agent-memory.dao';
import { AgentMemoryEntryEntity } from '../entity/agent-memory-entry.entity';
import { AgentMemoryService } from './agent-memory.service';

const PROJECT = 'project-1';

function fakeEntity(
  overrides: Partial<AgentMemoryEntryEntity> = {},
): AgentMemoryEntryEntity {
  return {
    id: overrides.id ?? 'id-1',
    projectId: PROJECT,
    namespace: 'facts',
    key: overrides.key ?? 'k',
    title: null,
    value: 'v',
    mode: AgentMemoryEntryMode.Kv,
    authorAgentId: null,
    tags: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as AgentMemoryEntryEntity;
}

describe('AgentMemoryService prune-to-capacity', () => {
  let service: AgentMemoryService;
  let dao: {
    upsertKvEntry: Mock;
    countForNamespace: Mock;
    countForProject: Mock;
    findOldest: Mock;
    hardDeleteById: Mock;
  };
  let warnSpy: Mock;

  const txEm = {} as EntityManager;
  const em = {
    fork: () => ({
      transactional: async (cb: (e: EntityManager) => Promise<unknown>) =>
        await cb(txEm),
    }),
  } as unknown as EntityManager;

  beforeEach(() => {
    dao = {
      upsertKvEntry: vi.fn().mockResolvedValue(fakeEntity()),
      countForNamespace: vi.fn().mockResolvedValue(0),
      countForProject: vi.fn().mockResolvedValue(0),
      findOldest: vi.fn().mockResolvedValue([]),
      hardDeleteById: vi.fn().mockResolvedValue(undefined),
    };
    service = new AgentMemoryService(em, dao as unknown as AgentMemoryDao);
    warnSpy = vi.spyOn(Logger.prototype, 'warn') as unknown as Mock;
    warnSpy.mockClear();
  });

  const save = () =>
    service.putForProject('user-1', PROJECT, {
      namespace: 'facts',
      key: 'k',
      value: 'v',
    });

  it('does not prune when under both caps', async () => {
    dao.countForNamespace.mockResolvedValue(10);
    dao.countForProject.mockResolvedValue(10);

    await save();

    expect(dao.findOldest).not.toHaveBeenCalled();
    expect(dao.hardDeleteById).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('prunes the oldest entries over the namespace cap and logs each', async () => {
    dao.countForNamespace.mockResolvedValue(
      AGENT_MEMORY_MAX_ENTRIES_PER_NAMESPACE + 2,
    );
    dao.countForProject.mockResolvedValue(10);
    dao.findOldest.mockResolvedValue([
      fakeEntity({ id: 'old-1', key: 'a' }),
      fakeEntity({ id: 'old-2', key: 'b' }),
    ]);

    await save();

    expect(dao.findOldest).toHaveBeenCalledWith(
      { projectId: PROJECT, namespace: 'facts' },
      2,
      txEm,
    );
    expect(dao.hardDeleteById).toHaveBeenCalledTimes(2);
    expect(dao.hardDeleteById).toHaveBeenCalledWith('old-1', txEm);
    expect(dao.hardDeleteById).toHaveBeenCalledWith('old-2', txEm);
    // Never silent: every prune is logged.
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('prunes over the project cap and logs each', async () => {
    dao.countForNamespace.mockResolvedValue(10);
    dao.countForProject.mockResolvedValue(
      AGENT_MEMORY_MAX_ENTRIES_PER_PROJECT + 1,
    );
    dao.findOldest.mockResolvedValue([fakeEntity({ id: 'old-x', key: 'x' })]);

    await save();

    expect(dao.findOldest).toHaveBeenCalledWith(
      { projectId: PROJECT },
      1,
      txEm,
    );
    expect(dao.hardDeleteById).toHaveBeenCalledWith('old-x', txEm);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
