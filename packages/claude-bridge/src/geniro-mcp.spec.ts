import { describe, expect, it, vi } from 'vitest';

import {
  buildCanUseTool,
  buildGeniroSdkTools,
  PendingHostRequests,
  type QuestionResolution,
  type ToolCallResolution,
} from './geniro-mcp';
import type { BridgeEvent } from './protocol.types';

describe('PendingHostRequests', () => {
  it('resolves a created request by id exactly once', async () => {
    const pending = new PendingHostRequests<ToolCallResolution>('tool');
    const { id, resolution } = pending.create();

    expect(pending.resolve(id, { result: 'ok' })).toBe(true);
    await expect(resolution).resolves.toEqual({ result: 'ok' });
    expect(pending.resolve(id, { result: 'again' })).toBe(false);
  });

  it('returns false for unknown ids', () => {
    const pending = new PendingHostRequests<ToolCallResolution>('tool');
    expect(pending.resolve('tool-999', { result: 'x' })).toBe(false);
  });

  it('fails every outstanding request on failAll', async () => {
    const pending = new PendingHostRequests<QuestionResolution>('question');
    const first = pending.create();
    const second = pending.create();

    pending.failAll('session aborted');

    await expect(first.resolution).rejects.toThrow('session aborted');
    await expect(second.resolution).rejects.toThrow('session aborted');
    expect(pending.resolve(first.id, {})).toBe(false);
  });
});

describe('buildGeniroSdkTools', () => {
  const definition = {
    name: 'knowledge_search_docs',
    description: 'Search docs.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  };

  it('emits an id-correlated tool_call_request and returns the host result', async () => {
    const events: BridgeEvent[] = [];
    const pending = new PendingHostRequests<ToolCallResolution>('tool');
    const [sdkTool] = buildGeniroSdkTools(
      [definition],
      (e) => events.push(e),
      pending,
    );

    const call = sdkTool!.handler({ query: 'threads' }, {});
    expect(events).toHaveLength(1);
    const request = events[0] as Extract<
      BridgeEvent,
      { type: 'tool_call_request' }
    >;
    expect(request.type).toBe('tool_call_request');
    expect(request.toolName).toBe('knowledge_search_docs');
    expect(request.args).toEqual({ query: 'threads' });

    pending.resolve(request.id, { result: 'PASSAGE: found it' });
    await expect(call).resolves.toEqual({
      content: [{ type: 'text', text: 'PASSAGE: found it' }],
    });
  });

  it('maps a host error resolution to an MCP error result', async () => {
    const events: BridgeEvent[] = [];
    const pending = new PendingHostRequests<ToolCallResolution>('tool');
    const [sdkTool] = buildGeniroSdkTools(
      [definition],
      (e) => events.push(e),
      pending,
    );

    const call = sdkTool!.handler({ query: 'x' }, {});
    const request = events[0] as Extract<
      BridgeEvent,
      { type: 'tool_call_request' }
    >;
    pending.resolve(request.id, { error: 'boom' });

    await expect(call).resolves.toEqual({
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    });
  });

  it('settles as an error result (not a rejection) when the session ends mid-call', async () => {
    const pending = new PendingHostRequests<ToolCallResolution>('tool');
    const [sdkTool] = buildGeniroSdkTools([definition], vi.fn(), pending);

    const call = sdkTool!.handler({ query: 'x' }, {});
    pending.failAll('session aborted');

    await expect(call).resolves.toEqual({
      content: [{ type: 'text', text: 'Tool call failed: session aborted' }],
      isError: true,
    });
  });
});

describe('buildCanUseTool', () => {
  it('passes non-AskUserQuestion tools through allowed and unchanged', async () => {
    const emit = vi.fn();
    const pending = new PendingHostRequests<QuestionResolution>('question');
    const canUseTool = buildCanUseTool(emit, pending);

    const input = { command: 'ls' };
    await expect(canUseTool('Bash', input, {} as never)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: input,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('answers AskUserQuestion via updatedInput.answers keyed by question text', async () => {
    const events: BridgeEvent[] = [];
    const pending = new PendingHostRequests<QuestionResolution>('question');
    const canUseTool = buildCanUseTool((e) => events.push(e), pending);

    const input = {
      questions: [
        {
          question: 'Which DB?',
          header: 'DB',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: 'pg' },
            { label: 'MySQL', description: 'my' },
          ],
        },
      ],
    };
    const call = canUseTool('AskUserQuestion', input, {} as never);

    const request = events[0] as Extract<
      BridgeEvent,
      { type: 'question_request' }
    >;
    expect(request.type).toBe('question_request');
    expect(request.questions[0]?.question).toBe('Which DB?');
    expect(request.questions[0]?.options?.[0]?.label).toBe('Postgres');

    pending.resolve(request.id, { answers: ['Postgres'] });
    await expect(call).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Which DB?': 'Postgres' } },
    });
  });

  it('denies gracefully when the host denies or answers are missing', async () => {
    const events: BridgeEvent[] = [];
    const pending = new PendingHostRequests<QuestionResolution>('question');
    const canUseTool = buildCanUseTool((e) => events.push(e), pending);

    const call = canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'Q?' }] },
      {} as never,
    );
    const request = events[0] as Extract<
      BridgeEvent,
      { type: 'question_request' }
    >;
    pending.resolve(request.id, { deny: true });

    await expect(call).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('keeps answer-to-question index alignment when earlier answers are undefined holes', async () => {
    const events: BridgeEvent[] = [];
    const pending = new PendingHostRequests<QuestionResolution>('question');
    const canUseTool = buildCanUseTool((e) => events.push(e), pending);

    const input = {
      questions: [{ question: 'First?' }, { question: 'Second?' }],
    };
    const call = canUseTool('AskUserQuestion', input, {} as never);
    const request = events[0] as Extract<
      BridgeEvent,
      { type: 'question_request' }
    >;

    // An invalid first answer arrives as an undefined hole — the second
    // answer must still land on the SECOND question, never shift onto the first.
    pending.resolve(request.id, { answers: [undefined, 'B'] });

    await expect(call).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Second?': 'B' } },
    });
  });

  it('denies gracefully when the session ends before an answer arrives', async () => {
    const pending = new PendingHostRequests<QuestionResolution>('question');
    const canUseTool = buildCanUseTool(vi.fn(), pending);

    const call = canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'Q?' }] },
      {} as never,
    );
    pending.failAll('session ended');

    await expect(call).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('extracts only structurally valid questions from a crafted input', async () => {
    const events: BridgeEvent[] = [];
    const pending = new PendingHostRequests<QuestionResolution>('question');
    const canUseTool = buildCanUseTool((e) => events.push(e), pending);

    const call = canUseTool(
      'AskUserQuestion',
      {
        questions: [
          null,
          42,
          { question: 'Real?', options: ['garbage', { label: 'Yes' }] },
        ],
      },
      {} as never,
    );
    const request = events[0] as Extract<
      BridgeEvent,
      { type: 'question_request' }
    >;
    expect(request.questions).toEqual([
      { question: 'Real?', options: [{ label: 'Yes' }] },
    ]);

    pending.resolve(request.id, { answers: ['Yes'] });
    await expect(call).resolves.toMatchObject({ behavior: 'allow' });
  });
});
