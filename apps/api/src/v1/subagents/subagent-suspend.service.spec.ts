import { beforeEach, describe, expect, it } from 'vitest';

import { CalleeSuspendRecord } from './subagent-ask-back.types';
import { SubagentSuspendService } from './subagent-suspend.service';

const makeRecord = (
  overrides: Partial<CalleeSuspendRecord> = {},
): CalleeSuspendRecord => ({
  suspendId: 'subagent-abc',
  calleeType: 'subagent',
  agentId: 'system:simple',
  durableThreadId: 'subagent-abc',
  question: 'Which file?',
  askBackCount: 0,
  ...overrides,
});

describe('SubagentSuspendService', () => {
  let service: SubagentSuspendService;

  beforeEach(() => {
    service = new SubagentSuspendService();
  });

  it('registers and retrieves a record by suspendId', () => {
    const record = makeRecord();
    service.register(record);
    expect(service.get('subagent-abc')).toEqual(record);
  });

  it('returns undefined for an unknown suspendId', () => {
    expect(service.get('does-not-exist')).toBeUndefined();
  });

  it('removes a record so it can no longer be retrieved', () => {
    service.register(makeRecord());
    service.remove('subagent-abc');
    expect(service.get('subagent-abc')).toBeUndefined();
  });

  it('overwrites a record on re-register (the ask -> answer -> ask loop updates askBackCount in place)', () => {
    service.register(makeRecord({ askBackCount: 0 }));
    service.register(makeRecord({ askBackCount: 3, question: 'Second?' }));
    const got = service.get('subagent-abc');
    expect(got?.askBackCount).toBe(3);
    expect(got?.question).toBe('Second?');
  });

  it('keeps records for distinct suspendIds isolated', () => {
    service.register(makeRecord({ suspendId: 'subagent-1' }));
    service.register(makeRecord({ suspendId: 'subagent-2' }));
    service.remove('subagent-1');
    expect(service.get('subagent-1')).toBeUndefined();
    expect(service.get('subagent-2')).toBeDefined();
  });
});
