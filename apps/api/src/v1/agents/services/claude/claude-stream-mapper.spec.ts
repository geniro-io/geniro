import { AIMessage, ChatMessage, ToolMessage } from '@langchain/core/messages';
import type {
  SdkAssistantMessage,
  SdkResultMessage,
  SdkUserMessage,
} from '@packages/claude-bridge';
import { beforeEach, describe, expect, it } from 'vitest';

import { BaseAgentConfigurable } from '../../agents.types';
import { AgentEventType } from '../agents/base-agent';
import { ClaudeStreamMapper } from './claude-stream-mapper';

const CONFIG = {
  configurable: {
    thread_id: 't-1',
    graph_id: 'g-1',
    node_id: 'n-1',
    run_id: 'r-1',
    effective_cost_limit_usd: 1,
  } as BaseAgentConfigurable,
};

const assistant = (
  overrides: Partial<SdkAssistantMessage['message']> = {},
  parentToolUseId: string | null = null,
): SdkAssistantMessage => ({
  type: 'assistant',
  session_id: 'sess-1',
  parent_tool_use_id: parentToolUseId,
  message: {
    id: 'msg-1',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: 'hello' }],
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  },
});

describe('ClaudeStreamMapper', () => {
  let events: AgentEventType[];
  let mapper: ClaudeStreamMapper;

  const createMapper = (
    calculatePriceUsd?: (usage: { totalTokens: number }) => number,
  ) => {
    events = [];
    mapper = new ClaudeStreamMapper({
      threadId: 't-1',
      config: CONFIG,
      model: 'claude-sonnet-4-6',
      emit: (event) => events.push(event),
      ...(calculatePriceUsd && {
        calculatePriceUsd: calculatePriceUsd as never,
      }),
    });
  };

  beforeEach(() => {
    createMapper();
  });

  const messageEvents = () =>
    events.filter((e) => e.type === 'message') as Extract<
      AgentEventType,
      { type: 'message' }
    >[];
  const stateEvents = () =>
    events.filter((e) => e.type === 'stateUpdate') as Extract<
      AgentEventType,
      { type: 'stateUpdate' }
    >[];

  const toolUse = (id: string, name: string) => ({
    type: 'tool_use' as const,
    id,
    name,
    input: {},
  });

  describe('resolveToolUseId (name-FIFO join for the Communication-block fix)', () => {
    it('returns a forwarded tool call SDK tool_use_id by name, consuming it FIFO', () => {
      mapper.onSdkMessage(
        assistant({
          content: [toolUse('toolu_comm_1', 'mcp__geniro__communication_exec')],
        }),
      );

      // the mcp__geniro__ prefix is stripped — the dispatcher passes the bare name
      expect(mapper.resolveToolUseId('communication_exec')).toBe(
        'toolu_comm_1',
      );
      // consumed — a second resolve of the same name finds nothing pending
      expect(mapper.resolveToolUseId('communication_exec')).toBeUndefined();
    });

    it('resolves two same-name forwarded calls in FIFO order', () => {
      mapper.onSdkMessage(
        assistant({
          id: 'msg-a',
          content: [toolUse('toolu_comm_1', 'mcp__geniro__communication_exec')],
        }),
      );
      mapper.onSdkMessage(
        assistant({
          id: 'msg-b',
          content: [toolUse('toolu_comm_2', 'mcp__geniro__communication_exec')],
        }),
      );

      expect(mapper.resolveToolUseId('communication_exec')).toBe(
        'toolu_comm_1',
      );
      expect(mapper.resolveToolUseId('communication_exec')).toBe(
        'toolu_comm_2',
      );
      expect(mapper.resolveToolUseId('communication_exec')).toBeUndefined();
    });

    it('returns undefined when no forwarded call of that name is pending', () => {
      expect(mapper.resolveToolUseId('communication_exec')).toBeUndefined();
    });

    it('does not enqueue built-in (non-forwardable) tools — they never dispatch to the host', () => {
      // Built-in SDK tools (Bash/Read/Edit) run in-sandbox and never produce a
      // host tool_call_request, so their tool_use_id must not be queued.
      mapper.onSdkMessage(
        assistant({ content: [toolUse('toolu_bash_1', 'Bash')] }),
      );

      expect(mapper.resolveToolUseId('Bash')).toBeUndefined();
    });
    // NOTE: the FIFO-drift-on-refused-dispatch case is owned by the dispatcher,
    // not the mapper (the mapper has no knowledge of dispatch outcomes and its
    // FIFO correctly returns the first enqueued id). It is covered end-to-end in
    // claude-tool-dispatcher.spec.ts ("does not inherit a cost-refused
    // delegation tool_use_id on the next delegation").
  });

  it('maps an assistant text message to an AIMessage with __model and __requestUsage', () => {
    createMapper(() => 0.0123);

    mapper.onSdkMessage(assistant());
    mapper.flush();

    const emitted = messageEvents();
    expect(emitted).toHaveLength(1);
    const ai = emitted[0]!.data.messages[0] as AIMessage;
    expect(ai).toBeInstanceOf(AIMessage);
    expect(ai.content).toBe('hello');
    expect(ai.additional_kwargs.__model).toBe('claude-sonnet-4-6');
    expect(ai.additional_kwargs.__requestUsage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      totalTokens: 150,
      totalPrice: 0.0123,
    });
    expect(mapper.getTotalPriceUsd()).toBeCloseTo(0.0123);
  });

  it('emits a stateUpdate snapshot with accumulated totals after each assistant message', () => {
    createMapper(() => 0.01);

    mapper.onSdkMessage(assistant());
    mapper.onSdkMessage(assistant({ id: 'msg-2' }));

    const snapshots = stateEvents();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]!.data.stateChange).toMatchObject({
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      totalPrice: 0.02,
      effectiveCostLimitUsd: 1,
    });
  });

  it('folds cache read/creation tokens into inputTokens and cachedInputTokens', () => {
    mapper.onSdkMessage(
      assistant({
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 20,
        },
      }),
    );
    mapper.flush();

    const ai = messageEvents()[0]!.data.messages[0] as AIMessage;
    expect(ai.additional_kwargs.__requestUsage).toMatchObject({
      inputTokens: 120,
      cachedInputTokens: 90,
      outputTokens: 5,
      totalTokens: 125,
    });
  });

  it('maps tool_use blocks to tool_calls, synthesizes ToolMessages from tool_result, and stamps __answeredToolCallNames', () => {
    mapper.onSdkMessage(
      assistant({
        content: [
          { type: 'text', text: 'running a tool' },
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'Read',
            input: { file_path: '/x' },
          },
        ],
      }),
    );

    const userMessage: SdkUserMessage = {
      type: 'user',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'file body' },
        ],
      },
    };
    mapper.onSdkMessage(userMessage);

    mapper.onSdkMessage(
      assistant({ id: 'msg-3', content: [{ type: 'text', text: 'done' }] }),
    );
    mapper.flush();

    const emitted = messageEvents();
    const first = emitted[0]!.data.messages[0] as AIMessage;
    expect(first.tool_calls).toEqual([
      {
        id: 'tu-1',
        name: 'Read',
        args: { file_path: '/x' },
        type: 'tool_call',
      },
    ]);

    const toolMsg = emitted[1]!.data.messages[0] as ToolMessage;
    expect(toolMsg).toBeInstanceOf(ToolMessage);
    expect(toolMsg.tool_call_id).toBe('tu-1');
    expect(toolMsg.name).toBe('Read');
    expect(toolMsg.content).toBe('file body');

    const answering = emitted[2]!.data.messages[0] as AIMessage;
    expect(answering.additional_kwargs.__answeredToolCallNames).toEqual([
      'Read',
    ]);
  });

  it('strips the mcp__geniro__ prefix from tool names', () => {
    mapper.onSdkMessage(
      assistant({
        content: [
          {
            type: 'tool_use',
            id: 'tu-2',
            name: 'mcp__geniro__knowledge_search',
            input: {},
          },
        ],
      }),
    );
    mapper.flush();

    const ai = messageEvents()[0]!.data.messages[0] as AIMessage;
    expect(ai.tool_calls?.[0]?.name).toBe('knowledge_search');
  });

  it('tags SDK-subagent traffic with __subagentCommunication and __toolCallId', () => {
    mapper.onSdkMessage(assistant({}, 'parent-tu-9'));
    mapper.flush();

    const ai = messageEvents()[0]!.data.messages[0] as AIMessage;
    expect(ai.additional_kwargs.__subagentCommunication).toBe(true);
    expect(ai.additional_kwargs.__toolCallId).toBe('parent-tu-9');
  });

  it('maps thinking blocks to a reasoning message', () => {
    mapper.onSdkMessage(
      assistant({
        content: [
          { type: 'thinking', thinking: 'pondering...' },
          { type: 'text', text: 'answer' },
        ],
      }),
    );
    mapper.flush();

    const built = messageEvents()[0]!.data.messages;
    expect(built).toHaveLength(2);
    const reasoning = built[0] as ChatMessage;
    expect(reasoning.role).toBe('reasoning');
    expect(reasoning.content).toBe('pondering...');
    expect(built[1]).toBeInstanceOf(AIMessage);
  });

  it('ignores plain-text user echoes (the host already emitted Human messages)', () => {
    const userEcho: SdkUserMessage = {
      type: 'user',
      session_id: 'sess-1',
      message: { content: 'typed text' },
    };

    mapper.onSdkMessage(userEcho);

    expect(messageEvents()).toHaveLength(0);
  });

  it('captures session id, sdk cost and error state from the result message', () => {
    const result: SdkResultMessage = {
      type: 'result',
      subtype: 'error_max_turns',
      session_id: 'sess-9',
      total_cost_usd: 0.42,
      is_error: false,
    };

    mapper.onSdkMessage(result);

    expect(mapper.sessionId).toBe('sess-9');
    expect(mapper.sdkTotalCostUsd).toBe(0.42);
    expect(mapper.isError).toBe(true);
    expect(stateEvents()).toHaveLength(1);
  });

  it('collapses a non-string result subtype to undefined and marks the turn errored (trust-boundary guard)', () => {
    // A crafted/garbage result frame can carry a non-string `subtype`; the
    // guard must collapse it to undefined so it never renders verbatim (e.g.
    // `[object Object]`) into the user-visible failure message, and a
    // non-'success' subtype marks the turn errored.
    const result = {
      type: 'result',
      subtype: { evil: true },
      session_id: 'sess-evil',
      total_cost_usd: 0,
      is_error: false,
    } as unknown as SdkResultMessage;

    mapper.onSdkMessage(result);

    expect(mapper.resultSubtype).toBeUndefined();
    expect(mapper.isError).toBe(true);
  });

  it('stamps the residual turn usage and SDK cost onto the buffered last assistant message at result time', () => {
    // LiteLLM-passthrough shape: per-message usage is all zeros; the result
    // message carries the real turn totals + total_cost_usd.
    mapper.onSdkMessage(
      assistant({ usage: { input_tokens: 0, output_tokens: 0 } }),
    );

    const result: SdkResultMessage = {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      total_cost_usd: 0.5,
      usage: { input_tokens: 1000, output_tokens: 100 },
    };
    mapper.onSdkMessage(result);

    const emitted = messageEvents();
    expect(emitted).toHaveLength(1);
    const ai = emitted[0]!.data.messages[0] as AIMessage;
    expect(ai.additional_kwargs.__requestUsage).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 100,
      totalTokens: 1100,
      totalPrice: 0.5,
      // The turn's input size is the context proxy — point-in-time, stamped
      // so the thread rollup can surface a context-usage % for Claude threads.
      currentContext: 1000,
    });
    expect(mapper.getTotalPriceUsd()).toBeCloseTo(0.5);

    const finalSnapshot = stateEvents().at(-1)!;
    expect(finalSnapshot.data.stateChange).toMatchObject({
      totalTokens: 1100,
      totalPrice: 0.5,
      currentContext: 1000,
    });
  });

  it('counts a turn once, on the tool-call frame, when one message arrives as text+tool_use frames sharing an id', () => {
    // Production shape (Opus 4.8 via bridge): a single assistant message is
    // streamed as two `assistant` frames — a text block, then a tool_use block
    // — that BOTH carry the same cumulative non-zero `usage`. The turn must be
    // counted exactly once (no double-bill) AND the cost must land on the
    // tool-call frame (the working block), not the preamble text frame.
    createMapper(() => 0.25);

    mapper.onSdkMessage(
      assistant({
        id: 'msg-dup',
        content: [{ type: 'text', text: "I'll pull up that issue." }],
        usage: { input_tokens: 1000, output_tokens: 100 },
      }),
    );
    mapper.onSdkMessage(
      assistant({
        id: 'msg-dup',
        content: [
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'mcp__linear__get_issue',
            input: { id: 'CI-319' },
          },
        ],
        usage: { input_tokens: 1000, output_tokens: 100 },
      }),
    );
    mapper.flush();

    const aiMsgs = messageEvents()
      .flatMap((e) => e.data.messages)
      .filter((m): m is AIMessage => m instanceof AIMessage);

    // Two persisted AI rows that share the SDK message id.
    expect(aiMsgs).toHaveLength(2);
    expect(aiMsgs.every((m) => m.id === 'msg-dup')).toBe(true);

    // Exactly ONE row carries usage, and it is the TOOL-call frame (working
    // block) — not the preamble text frame.
    const withUsage = aiMsgs.filter((m) => m.additional_kwargs.__requestUsage);
    expect(withUsage).toHaveLength(1);
    const toolFrame = aiMsgs.find(
      (m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    const textFrame = aiMsgs.find(
      (m) => !m.tool_calls || m.tool_calls.length === 0,
    );
    expect(toolFrame?.additional_kwargs.__requestUsage).toBeDefined();
    expect(textFrame?.additional_kwargs.__requestUsage).toBeUndefined();

    // Σ requestTokenUsage across the rows equals one turn, not two.
    const sumPrice = aiMsgs.reduce(
      (acc, m) =>
        acc +
        ((m.additional_kwargs.__requestUsage as { totalPrice?: number })
          ?.totalPrice ?? 0),
      0,
    );
    expect(sumPrice).toBeCloseTo(0.25);

    // Run-scoped aggregate (folded into the caller's state) is single-counted.
    expect(mapper.getTotalPriceUsd()).toBeCloseTo(0.25);
    expect(mapper.getTotalUsage().totalTokens).toBe(1100);
  });

  it('stamps currentContext as the full input (regular + cache create + read) onto the parent message', () => {
    // Cache-heavy turn: the live context is regular input + cache-creation +
    // cache-read, even though only `input_tokens` is "new". currentContext must
    // reflect the whole prompt size so the context gauge denominator is right.
    mapper.onSdkMessage(
      assistant({ usage: { input_tokens: 0, output_tokens: 0 } }),
    );

    const result: SdkResultMessage = {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      total_cost_usd: 0.2,
      usage: {
        input_tokens: 2_000,
        cache_creation_input_tokens: 3_000,
        cache_read_input_tokens: 30_000,
        output_tokens: 500,
      },
    };
    mapper.onSdkMessage(result);

    const ai = messageEvents()[0]!.data.messages[0] as AIMessage;
    const usage = ai.additional_kwargs.__requestUsage as {
      inputTokens: number;
      currentContext?: number;
    };
    // 2000 + 3000 + 30000 = 35000 — the whole prompt, not just the 2000 "new".
    expect(usage.inputTokens).toBe(35_000);
    expect(usage.currentContext).toBe(35_000);
    expect(stateEvents().at(-1)!.data.stateChange).toMatchObject({
      currentContext: 35_000,
    });
  });

  it('defaults per-message totalPrice to 0 without a price calculator', () => {
    mapper.onSdkMessage(assistant());
    mapper.flush();

    const ai = messageEvents()[0]!.data.messages[0] as AIMessage;
    expect(
      (ai.additional_kwargs.__requestUsage as { totalPrice?: number })
        .totalPrice,
    ).toBe(0);
  });

  it('counts total_cost_usd toward the turn rollup when the result message omits usage', () => {
    // The SDK result `usage` field is optional on the wire (protocol.types.ts);
    // a billed cost without token counts must still reach the rollup the
    // cost-limit guard reads — otherwise the spend is invisible to enforcement.
    mapper.onSdkMessage(
      assistant({ usage: { input_tokens: 0, output_tokens: 0 } }),
    );

    const result: SdkResultMessage = {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      total_cost_usd: 0.5,
    };
    mapper.onSdkMessage(result);

    expect(mapper.getTotalPriceUsd()).toBeCloseTo(0.5);
    expect(stateEvents().at(-1)!.data.stateChange).toMatchObject({
      totalPrice: 0.5,
    });
  });

  it('ignores assistant/user frames whose message payload is not an object', () => {
    expect(() => {
      mapper.onSdkMessage({
        type: 'assistant',
        session_id: 'sess-1',
      } as never);
      mapper.onSdkMessage({
        type: 'user',
        session_id: 'sess-1',
        message: null,
      } as never);
    }).not.toThrow();

    expect(messageEvents()).toHaveLength(0);
  });

  it('tolerates crafted content shapes (string content, null blocks)', () => {
    expect(() => {
      // content as a string instead of a block array
      mapper.onSdkMessage(assistant({ content: 'not-an-array' as never }));
      // null elements inside otherwise valid block arrays
      mapper.onSdkMessage(
        assistant({
          id: 'msg-mixed',
          content: [null, { type: 'text', text: 'still works' }] as never,
        }),
      );
      mapper.onSdkMessage({
        type: 'user',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        message: { content: [null] },
      } as never);
      mapper.flush();
    }).not.toThrow();

    // The valid block among the garbage still produces its message.
    const allMessages = messageEvents().flatMap((e) => e.data.messages);
    expect(allMessages.some((m) => m.content === 'still works')).toBe(true);
  });

  it('stamps __toolError on ToolMessages built from is_error tool_results', () => {
    mapper.onSdkMessage(
      assistant({
        content: [{ type: 'tool_use', id: 'tu-err', name: 'Bash', input: {} }],
      }),
    );
    const errorResult: SdkUserMessage = {
      type: 'user',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-err',
            content: 'command failed',
            is_error: true,
          },
        ],
      },
    };
    mapper.onSdkMessage(errorResult);

    const allMessages = messageEvents().flatMap((e) => e.data.messages);
    const toolMsg = allMessages.find((m) => m instanceof ToolMessage);
    expect(toolMsg?.additional_kwargs.__toolError).toBe(true);
  });

  it('synthesizes a parent usage message when the turn ends on a tool_result (no buffered assistant)', () => {
    // Per-message usage is zeros through the passthrough; if the last
    // pre-result SDK message is a tool_result, the whole turn's residual must
    // still land on a persisted row — billed spend must never exist only in
    // the in-memory totals.
    mapper.onSdkMessage(
      assistant({
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [
          { type: 'text', text: 'using a tool' },
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} },
        ],
      }),
    );
    const toolResult: SdkUserMessage = {
      type: 'user',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }],
      },
    };
    mapper.onSdkMessage(toolResult);

    const result: SdkResultMessage = {
      type: 'result',
      subtype: 'error_max_turns',
      session_id: 'sess-1',
      usage: { input_tokens: 400, output_tokens: 90 },
      total_cost_usd: 0.07,
    };
    mapper.onSdkMessage(result);
    mapper.flush();

    const allMessages = messageEvents().flatMap((e) => e.data.messages);
    const synthetic = allMessages.at(-1) as AIMessage;
    expect(synthetic).toBeInstanceOf(AIMessage);
    expect(synthetic.content).toBe('');
    expect(synthetic.additional_kwargs.__subagentCommunication).toBeUndefined();
    expect(synthetic.additional_kwargs.__requestUsage).toMatchObject({
      inputTokens: 400,
      outputTokens: 90,
      totalTokens: 490,
      totalPrice: 0.07,
    });
    expect(mapper.getTotalPriceUsd()).toBeCloseTo(0.07);
  });

  it('does not stamp the whole-turn residual onto a buffered SDK-subagent message', () => {
    // Stamping parent turn totals onto a `::sub::` surrogate would inflate
    // the subagent bucket and zero the parent in every byNode rollup.
    mapper.onSdkMessage(
      assistant({ usage: { input_tokens: 0, output_tokens: 0 } }, 'tu-sub-1'),
    );

    const result: SdkResultMessage = {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      usage: { input_tokens: 200, output_tokens: 40 },
      total_cost_usd: 0.05,
    };
    mapper.onSdkMessage(result);

    const allMessages = messageEvents().flatMap((e) => e.data.messages);
    const subagentMsg = allMessages.find(
      (m) => m.additional_kwargs?.__subagentCommunication,
    ) as AIMessage;
    expect(
      (subagentMsg.additional_kwargs.__requestUsage as { totalPrice?: number })
        .totalPrice,
    ).toBe(0);

    const synthetic = allMessages.at(-1) as AIMessage;
    expect(synthetic.additional_kwargs.__subagentCommunication).toBeUndefined();
    expect(synthetic.additional_kwargs.__requestUsage).toMatchObject({
      totalTokens: 240,
      totalPrice: 0.05,
    });
  });

  it('clamps the residual to zero when per-message accounting exceeds the result totals', () => {
    createMapper(() => 0.04);
    mapper.onSdkMessage(assistant());

    const result: SdkResultMessage = {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      // Result reports LESS than the per-message path accumulated (150 tokens,
      // $0.04): the residual must clamp at 0, never go negative.
      usage: { input_tokens: 50, output_tokens: 10 },
      total_cost_usd: 0.01,
    };
    mapper.onSdkMessage(result);
    mapper.flush();

    const emitted = messageEvents();
    expect(emitted).toHaveLength(1);
    const ai = emitted[0]!.data.messages[0] as AIMessage;
    expect(
      (ai.additional_kwargs.__requestUsage as { totalTokens: number })
        .totalTokens,
    ).toBe(150);
    expect(mapper.getTotalPriceUsd()).toBeCloseTo(0.04);
  });

  it('stamps total_cost_usd onto the buffered assistant message when the result omits usage', () => {
    // Persistence is insert-only: if the billed cost is not on the emitted
    // message, `Σ messages.requestTokenUsage` permanently under-reports the
    // turn (mapper contract: message rollup equals billed turn totals).
    mapper.onSdkMessage(
      assistant({ usage: { input_tokens: 0, output_tokens: 0 } }),
    );

    const result: SdkResultMessage = {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      total_cost_usd: 0.5,
    };
    mapper.onSdkMessage(result);

    const emitted = messageEvents();
    expect(emitted).toHaveLength(1);
    const ai = emitted[0]!.data.messages[0] as AIMessage;
    expect(
      (ai.additional_kwargs.__requestUsage as { totalPrice?: number })
        .totalPrice,
    ).toBeCloseTo(0.5);
  });

  describe('proxied tool usage (recordToolUsage)', () => {
    const toolUseAssistant = (): SdkAssistantMessage =>
      assistant({
        id: 'msg-tool',
        content: [
          {
            type: 'tool_use',
            id: 'tu-9',
            name: 'mcp__geniro__knowledge_search_docs',
            input: { query: 'x' },
          },
        ],
        usage: { input_tokens: 0, output_tokens: 0 },
      });

    const toolResultEcho = (): SdkUserMessage => ({
      type: 'user',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu-9', content: 'PASSAGE' },
        ],
      },
    });

    const usage = {
      inputTokens: 40,
      cachedInputTokens: 0,
      outputTokens: 10,
      totalTokens: 50,
      totalPrice: 0.02,
    };

    it('stamps __toolTokenUsage on the matching synthesized ToolMessage (FIFO by name)', () => {
      mapper.onSdkMessage(toolUseAssistant());
      mapper.recordToolUsage('knowledge_search_docs', usage);
      mapper.onSdkMessage(toolResultEcho());
      mapper.flush();

      const toolMessages = messageEvents()
        .flatMap((e) => e.data.messages)
        .filter((m): m is ToolMessage => m instanceof ToolMessage);
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]!.additional_kwargs.__toolTokenUsage).toEqual(
        usage,
      );
    });

    it('does not stamp usage on a ToolMessage of a different tool name', () => {
      mapper.onSdkMessage(toolUseAssistant());
      mapper.recordToolUsage('web_search', usage);
      mapper.onSdkMessage(toolResultEcho());
      mapper.flush();

      const toolMessages = messageEvents()
        .flatMap((e) => e.data.messages)
        .filter((m): m is ToolMessage => m instanceof ToolMessage);
      expect(
        toolMessages[0]!.additional_kwargs.__toolTokenUsage,
      ).toBeUndefined();
    });

    it('folds tool usage into total price and state snapshots', () => {
      createMapper(() => 0.01);
      mapper.onSdkMessage(assistant());
      mapper.recordToolUsage('knowledge_search_docs', usage);
      mapper.onSdkMessage(assistant({ id: 'msg-2' }));

      // 2 assistant messages priced 0.01 each + 0.02 tool spend.
      expect(mapper.getTotalPriceUsd()).toBeCloseTo(0.04);
      const last = stateEvents().at(-1)!;
      expect(last.data.stateChange).toMatchObject({
        totalPrice: 0.04,
        totalTokens: 300 + 50,
      });
    });

    it('keeps the result-message residual reconciliation blind to tool usage', () => {
      createMapper(() => 0);
      mapper.onSdkMessage(toolUseAssistant());
      mapper.recordToolUsage('knowledge_search_docs', usage);
      mapper.onSdkMessage(toolResultEcho());

      const result: SdkResultMessage = {
        type: 'result',
        subtype: 'success',
        session_id: 'sess-1',
        total_cost_usd: 0.1,
        usage: { input_tokens: 200, output_tokens: 100 },
      };
      mapper.onSdkMessage(result);

      // The residual ($0.10 turn cost) must be computed against LLM-side
      // totals only; the $0.02 tool spend then adds on top of it.
      expect(mapper.getTotalPriceUsd()).toBeCloseTo(0.12);
    });
  });
});
