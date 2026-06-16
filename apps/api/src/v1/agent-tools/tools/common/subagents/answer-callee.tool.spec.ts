import { ToolRunnableConfig } from '@langchain/core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import { CalleeSuspendRecord } from '../../../../subagents/subagent-ask-back.types';
import { SubagentSuspendService } from '../../../../subagents/subagent-suspend.service';
import { ToolInvokeResult } from '../../base-tool';
import { AnswerCalleeTool } from './answer-callee.tool';
import { SubagentsToolGroupConfig } from './subagents.types';
import {
  SubagentsRunTaskTool,
  SubagentsRunTaskToolOutput,
} from './subagents-run-task.tool';

const RECORD: CalleeSuspendRecord = {
  suspendId: 'subagent-xyz',
  calleeType: 'subagent',
  agentId: 'system:simple',
  durableThreadId: 'subagent-xyz',
  question: 'Which file?',
  askBackCount: 0,
};

describe('AnswerCalleeTool', () => {
  let tool: AnswerCalleeTool;
  let suspendService: SubagentSuspendService;
  let runTaskTool: SubagentsRunTaskTool;

  const config: SubagentsToolGroupConfig = {};
  const cfg = {
    configurable: {} as BaseAgentConfigurable,
  } as ToolRunnableConfig<BaseAgentConfigurable>;

  beforeEach(() => {
    suspendService = {
      get: vi.fn(),
      register: vi.fn(),
      remove: vi.fn(),
    } as unknown as SubagentSuspendService;

    runTaskTool = {
      resumeSuspendedSubagent: vi.fn().mockResolvedValue({
        output: { result: 'resumed and completed' },
      } satisfies ToolInvokeResult<SubagentsRunTaskToolOutput>),
    } as unknown as SubagentsRunTaskTool;

    tool = new AnswerCalleeTool(suspendService, runTaskTool);
  });

  it('returns an error (without resuming) for an unknown/expired suspendId', async () => {
    vi.mocked(suspendService.get).mockReturnValue(undefined);

    const result = await tool.invoke(
      { purpose: 'answer', suspendId: 'stale-id', answer: 'use file A' },
      config,
      cfg,
    );

    expect(result.output.error).toBe('Unknown or expired suspendId');
    expect(result.output.result).toContain('stale-id');
    expect(runTaskTool.resumeSuspendedSubagent).not.toHaveBeenCalled();
  });

  it('delegates to resumeSuspendedSubagent with the record and answer when the suspendId is known', async () => {
    vi.mocked(suspendService.get).mockReturnValue(RECORD);

    const result = await tool.invoke(
      { purpose: 'answer', suspendId: RECORD.suspendId, answer: 'use file A' },
      config,
      cfg,
    );

    expect(suspendService.get).toHaveBeenCalledWith(RECORD.suspendId);
    expect(runTaskTool.resumeSuspendedSubagent).toHaveBeenCalledWith(
      RECORD,
      'use file A',
      config,
      cfg,
    );
    expect(result.output.result).toBe('resumed and completed');
  });
});
