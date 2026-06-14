import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { BridgeCommand } from '@packages/claude-bridge';
import type { DefaultLogger } from '@packages/common';
import { describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';

import type { BaseAgentConfigurable } from '../../agents.types';
import type { ClaudeStreamMapper } from './claude-stream-mapper';
import { ClaudeToolDispatcher } from './claude-tool-dispatcher';

type InvokeMock = ReturnType<typeof vi.fn>;

const buildDispatcher = (overrides?: {
  tools?: Map<string, DynamicStructuredTool>;
  signal?: AbortSignal;
  shouldRefuse?: () => string | null;
}) => {
  const sent: BridgeCommand[] = [];
  const mapper = { recordToolUsage: vi.fn() };
  const logger = mockDeep<DefaultLogger>();
  const dispatcher = new ClaudeToolDispatcher({
    tools: overrides?.tools ?? new Map(),
    config: {
      configurable: {
        thread_id: 'thread-1',
        thread_created_by: 'user-1',
        node_id: 'node-1',
      } as BaseAgentConfigurable,
    },
    mapper: mapper as unknown as ClaudeStreamMapper,
    logger,
    signal: overrides?.signal ?? new AbortController().signal,
    send: (command) => sent.push(command),
    ...(overrides?.shouldRefuse && { shouldRefuse: overrides.shouldRefuse }),
  });
  return { dispatcher, sent, mapper, logger };
};

const buildTool = (invoke: InvokeMock): DynamicStructuredTool =>
  ({ invoke }) as unknown as DynamicStructuredTool;

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

describe('ClaudeToolDispatcher', () => {
  it('responds with an error when the tool is not available', async () => {
    const { dispatcher, sent } = buildDispatcher();

    dispatcher.dispatch({ id: 'tool-1', toolName: 'missing', args: {} });
    await flush();

    expect(sent).toEqual([
      {
        type: 'tool_call_response',
        id: 'tool-1',
        error: "Tool 'missing' is not available",
      },
    ]);
  });

  it('invokes the tool with a synthesized configurable and returns the formatted output', async () => {
    const invoke = vi.fn().mockResolvedValue({ output: 'plain result' });
    const tools = new Map([['search', buildTool(invoke)]]);
    const { dispatcher, sent } = buildDispatcher({ tools });

    dispatcher.dispatch({
      id: 'tool-7',
      toolName: 'search',
      args: { query: 'x' },
    });
    await flush();

    expect(invoke).toHaveBeenCalledWith(
      { query: 'x' },
      expect.objectContaining({
        configurable: expect.objectContaining({
          thread_id: 'thread-1',
          thread_created_by: 'user-1',
          __toolCallId: 'tool-7',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(sent).toEqual([
      { type: 'tool_call_response', id: 'tool-7', result: 'plain result' },
    ]);
  });

  it('formats object outputs as YAML (ToolExecutorNode parity)', async () => {
    const invoke = vi.fn().mockResolvedValue({ output: { found: 2 } });
    const tools = new Map([['search', buildTool(invoke)]]);
    const { dispatcher, sent } = buildDispatcher({ tools });

    dispatcher.dispatch({ id: 'tool-1', toolName: 'search', args: {} });
    await flush();

    const response = sent[0] as { result?: string };
    expect(response.result).toBe('found: 2');
  });

  it('trims oversized outputs with an explicit marker', async () => {
    const invoke = vi.fn().mockResolvedValue({ output: 'y'.repeat(600_000) });
    const tools = new Map([['big', buildTool(invoke)]]);
    const { dispatcher, sent } = buildDispatcher({ tools });

    dispatcher.dispatch({ id: 'tool-1', toolName: 'big', args: {} });
    await flush();

    const response = sent[0] as { result?: string };
    expect(response.result).toHaveLength(
      500_000 + '\n\n[output trimmed to 500000 characters from 600000]'.length,
    );
    expect(response.result).toContain('[output trimmed to 500000 characters');
  });

  it('reports toolRequestUsage to the mapper and persists stateChange for later calls', async () => {
    const usage = {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      totalTokens: 15,
      totalPrice: 0.01,
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        output: 'first',
        toolRequestUsage: usage,
        stateChange: { cursor: 'abc' },
      })
      .mockResolvedValueOnce({ output: 'second' });
    const tools = new Map([['search', buildTool(invoke)]]);
    const { dispatcher, sent, mapper } = buildDispatcher({ tools });

    dispatcher.dispatch({ id: 'tool-1', toolName: 'search', args: {} });
    await flush();
    dispatcher.dispatch({ id: 'tool-2', toolName: 'search', args: {} });
    await flush();

    expect(mapper.recordToolUsage).toHaveBeenCalledWith('search', usage);
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      {},
      expect.objectContaining({
        configurable: expect.objectContaining({
          toolMetadata: { cursor: 'abc' },
        }),
      }),
    );
    expect(sent).toHaveLength(2);
  });

  it('honors stateChangeKey when a tool updates another tool metadata slot', async () => {
    const invoke = vi.fn().mockResolvedValue({
      output: 'ok',
      stateChange: { shared: true },
      stateChangeKey: 'other_tool',
    });
    const otherInvoke = vi.fn().mockResolvedValue({ output: 'done' });
    const tools = new Map([
      ['writer', buildTool(invoke)],
      ['other_tool', buildTool(otherInvoke)],
    ]);
    const { dispatcher } = buildDispatcher({ tools });

    dispatcher.dispatch({ id: 'tool-1', toolName: 'writer', args: {} });
    await flush();
    dispatcher.dispatch({ id: 'tool-2', toolName: 'other_tool', args: {} });
    await flush();

    expect(otherInvoke).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        configurable: expect.objectContaining({
          toolMetadata: { shared: true },
        }),
      }),
    );
  });

  it('maps a thrown tool error to an error response and logs it', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('zod validation blew'));
    const tools = new Map([['search', buildTool(invoke)]]);
    const { dispatcher, sent, logger } = buildDispatcher({ tools });

    dispatcher.dispatch({ id: 'tool-1', toolName: 'search', args: {} });
    await flush();

    expect(sent).toEqual([
      {
        type: 'tool_call_response',
        id: 'tool-1',
        error: "Error executing tool 'search': zod validation blew",
      },
    ]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('does not log AbortError failures (user-initiated stop)', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const invoke = vi.fn().mockRejectedValue(abortError);
    const tools = new Map([['search', buildTool(invoke)]]);
    const { dispatcher, sent, logger } = buildDispatcher({ tools });

    dispatcher.dispatch({ id: 'tool-1', toolName: 'search', args: {} });
    await flush();

    expect(sent[0]).toMatchObject({ type: 'tool_call_response', id: 'tool-1' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('answers with a success result, not an error, when the tool resolves without output (output: undefined)', async () => {
    // A side-effect-only tool legally resolves `{ output: undefined }`
    // (ToolInvokeResult<void>). The formatted result must still be a string —
    // the model should see an empty success, never a synthetic error.
    const invoke = vi.fn().mockResolvedValue({ output: undefined });
    const tools = new Map([['noop_action', buildTool(invoke)]]);
    const { dispatcher, sent } = buildDispatcher({ tools });

    dispatcher.dispatch({ id: 'tool-1', toolName: 'noop_action', args: {} });
    await flush();

    const response = sent[0] as {
      type: string;
      id: string;
      result?: string;
      error?: string;
    };
    expect(response).toMatchObject({
      type: 'tool_call_response',
      id: 'tool-1',
    });
    expect(response.error).toBeUndefined();
    expect(typeof response.result).toBe('string');
  });

  it('keeps serving queued dispatches after a response-delivery failure (no permanently wedged queue)', async () => {
    // The dispatch queue self-chains promises; a single rejection (here: the
    // transport pipe throws while delivering the "tool not available" reply,
    // which is sent outside any try/catch) must not poison the chain — later
    // tool calls in the same session still have to execute and be answered.
    const invoke = vi.fn().mockResolvedValue({ output: 'still alive' });
    const tools = new Map([['search', buildTool(invoke)]]);
    const sent: BridgeCommand[] = [];
    let deliveries = 0;
    const dispatcher = new ClaudeToolDispatcher({
      tools,
      config: {
        configurable: {
          thread_id: 'thread-1',
          thread_created_by: 'user-1',
          node_id: 'node-1',
        } as BaseAgentConfigurable,
      },
      mapper: { recordToolUsage: vi.fn() } as unknown as ClaudeStreamMapper,
      logger: mockDeep<DefaultLogger>(),
      signal: new AbortController().signal,
      send: (command) => {
        deliveries += 1;
        if (deliveries === 1) {
          throw new Error('bridge stdin destroyed');
        }
        sent.push(command);
      },
    });

    dispatcher.dispatch({ id: 'tool-1', toolName: 'missing', args: {} });
    await flush();
    dispatcher.dispatch({ id: 'tool-2', toolName: 'search', args: {} });
    await flush();

    expect(sent).toEqual([
      { type: 'tool_call_response', id: 'tool-2', result: 'still alive' },
    ]);
  });

  it('refuses execution when shouldRefuse trips (cost limit) and never invokes the tool', async () => {
    const invoke = vi.fn().mockResolvedValue({ output: 'never' });
    const tools = new Map([['search', buildTool(invoke)]]);
    const { dispatcher, sent } = buildDispatcher({
      tools,
      shouldRefuse: () => 'Cost limit reached ($1.00)',
    });

    dispatcher.dispatch({ id: 'tool-1', toolName: 'search', args: {} });
    await flush();

    expect(invoke).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        type: 'tool_call_response',
        id: 'tool-1',
        error: 'Cost limit reached ($1.00)',
      },
    ]);
  });

  it('executes normally while shouldRefuse returns null', async () => {
    const invoke = vi.fn().mockResolvedValue({ output: 'ok' });
    const tools = new Map([['search', buildTool(invoke)]]);
    const { dispatcher, sent } = buildDispatcher({
      tools,
      shouldRefuse: () => null,
    });

    dispatcher.dispatch({ id: 'tool-1', toolName: 'search', args: {} });
    await flush();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([
      { type: 'tool_call_response', id: 'tool-1', result: 'ok' },
    ]);
  });

  it('refuses agent-context-bound tools even if they were somehow wired (defense in depth)', async () => {
    const invoke = vi.fn().mockResolvedValue({ output: 'never' });
    const tools = new Map([['communication_exec', buildTool(invoke)]]);
    const { dispatcher, sent } = buildDispatcher({ tools });

    dispatcher.dispatch({
      id: 'tool-1',
      toolName: 'communication_exec',
      args: {},
    });
    await flush();

    expect(invoke).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        type: 'tool_call_response',
        id: 'tool-1',
        error:
          "Tool 'communication_exec' cannot be invoked from a Claude session",
      },
    ]);
  });

  it('rejects dispatches over the pending cap and frees capacity as the queue drains', async () => {
    let releaseAll: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const slowInvoke = vi.fn().mockImplementation(async () => {
      await gate;
      return { output: 'done' };
    });
    const tools = new Map([['slow', buildTool(slowInvoke)]]);
    const { dispatcher, sent } = buildDispatcher({ tools });

    for (let i = 0; i < 33; i++) {
      dispatcher.dispatch({ id: `tool-${i}`, toolName: 'slow', args: {} });
    }
    await flush();

    // #33 (index 32) was over the 32-pending cap — refused immediately.
    const refusal = sent.find(
      (command) => (command as { id: string }).id === 'tool-32',
    );
    expect(refusal).toEqual({
      type: 'tool_call_response',
      id: 'tool-32',
      error: 'Tool dispatch queue is full — slow down and retry',
    });

    releaseAll();
    await flush();
    // All capped dispatches completed; capacity is free again.
    expect(sent).toHaveLength(33);
    dispatcher.dispatch({ id: 'tool-after', toolName: 'slow', args: {} });
    await flush();
    expect(
      sent.find((command) => (command as { id: string }).id === 'tool-after'),
    ).toEqual({ type: 'tool_call_response', id: 'tool-after', result: 'done' });
  });

  it('refuses queued dispatches once the run signal aborts (no post-stop tool work)', async () => {
    const controller = new AbortController();
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const slowInvoke = vi.fn().mockImplementation(async () => {
      await firstGate;
      return { output: 'one' };
    });
    const queuedInvoke = vi.fn().mockResolvedValue({ output: 'two' });
    const tools = new Map([
      ['slow', buildTool(slowInvoke)],
      ['queued', buildTool(queuedInvoke)],
    ]);
    const { dispatcher, sent } = buildDispatcher({
      tools,
      signal: controller.signal,
    });

    dispatcher.dispatch({ id: 'tool-1', toolName: 'slow', args: {} });
    dispatcher.dispatch({ id: 'tool-2', toolName: 'queued', args: {} });
    await flush();

    controller.abort();
    releaseFirst();
    await flush();

    expect(queuedInvoke).not.toHaveBeenCalled();
    expect(sent.find((c) => (c as { id: string }).id === 'tool-2')).toEqual({
      type: 'tool_call_response',
      id: 'tool-2',
      error: 'The run was stopped',
    });
  });

  it('serializes dispatches per session — a second call waits for the first', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const slowInvoke = vi.fn().mockImplementation(async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
      return { output: 'one' };
    });
    const fastInvoke = vi.fn().mockImplementation(async () => {
      order.push('second-start');
      return { output: 'two' };
    });
    const tools = new Map([
      ['slow', buildTool(slowInvoke)],
      ['fast', buildTool(fastInvoke)],
    ]);
    const { dispatcher, sent } = buildDispatcher({ tools });

    dispatcher.dispatch({ id: 'tool-1', toolName: 'slow', args: {} });
    dispatcher.dispatch({ id: 'tool-2', toolName: 'fast', args: {} });
    await flush();

    expect(order).toEqual(['first-start']);
    releaseFirst();
    await flush();

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    expect(sent.map((command) => (command as { id: string }).id)).toEqual([
      'tool-1',
      'tool-2',
    ]);
  });
});
