import {
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { RequestTokenUsage } from '../../../litellm/litellm.types';
import type { LitellmService } from '../../../litellm/services/litellm.service';
import { CostLimitExceededError } from '../../agents.errors';
import type { BaseAgentState } from '../../agents.types';
import { InvokeLlmNode } from './invoke-llm-node';

describe('InvokeLlmNode', () => {
  let node: InvokeLlmNode;
  let mockLlm: ChatOpenAI;
  let mockLitellm: Pick<
    LitellmService,
    'extractTokenUsageFromResponse' | 'supportsAssistantPrefill'
  >;

  beforeEach(() => {
    mockLitellm = {
      extractTokenUsageFromResponse: vi.fn(),
      supportsAssistantPrefill: vi.fn().mockResolvedValue(true),
    } as unknown as Pick<
      LitellmService,
      'extractTokenUsageFromResponse' | 'supportsAssistantPrefill'
    >;

    const bindTools = vi.fn();

    mockLlm = {
      bindTools,
      model: 'gpt-5-mini',
    } as unknown as ChatOpenAI;

    node = new InvokeLlmNode(
      mockLitellm as unknown as LitellmService,
      mockLlm,
      [],
      { systemPrompt: 'Test system prompt' },
    );
  });

  const createState = (
    overrides: Partial<BaseAgentState> = {},
  ): BaseAgentState =>
    ({
      messages: [new HumanMessage('hi')],
      summary: '',
      toolsMetadata: {},
      toolUsageGuardActivated: false,
      toolUsageGuardActivatedCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      totalPrice: 0,
      currentContext: 0,
      ...overrides,
    }) as BaseAgentState;

  it('sets currentContext from provider-reported prompt tokens (inputTokens)', async () => {
    const usage: RequestTokenUsage = {
      inputTokens: 123,
      outputTokens: 7,
      totalTokens: 130,
      currentContext: 123,
      totalPrice: 0,
    };

    (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(usage);

    const llmRes: AIMessageChunk = {
      id: 'msg-1',
      content: 'ok',
      contentBlocks: [],
      response_metadata: {},
      usage_metadata: {
        input_tokens: 123,
        output_tokens: 7,
        total_tokens: 130,
      },
      tool_calls: [],
    } as unknown as AIMessageChunk;

    // bindTools isn't called until invoke(), so we set up the invoke mock via bindTools return value
    (mockLlm as any).bindTools.mockReturnValueOnce({
      invoke: vi.fn().mockResolvedValue(llmRes),
    });

    const res = await node.invoke(createState(), {
      configurable: { run_id: 'run-1', thread_id: 'thread-1' },
    } as any);

    expect(mockLitellm.extractTokenUsageFromResponse).toHaveBeenCalledWith(
      'gpt-5-mini',
      expect.objectContaining(llmRes.usage_metadata as any),
    );

    expect(res.currentContext).toBe(usage.inputTokens);
  });

  it('attaches durationMs to requestUsage on the AI message', async () => {
    const usage: RequestTokenUsage = {
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      totalPrice: 0,
    };

    (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(usage);

    const llmRes: AIMessageChunk = {
      id: 'msg-dur',
      content: 'ok',
      contentBlocks: [],
      response_metadata: {},
      usage_metadata: {
        input_tokens: 50,
        output_tokens: 10,
        total_tokens: 60,
      },
      tool_calls: [],
    } as unknown as AIMessageChunk;

    (mockLlm as any).bindTools.mockReturnValueOnce({
      invoke: vi.fn().mockResolvedValue(llmRes),
    });

    const res = await node.invoke(createState(), {
      configurable: { run_id: 'run-1', thread_id: 'thread-1' },
    } as any);

    const aiMsg = res.messages?.items?.[0];
    const requestUsage = aiMsg?.additional_kwargs?.__requestUsage as
      | RequestTokenUsage
      | undefined;
    expect(requestUsage).toBeDefined();
    expect(typeof requestUsage!.durationMs).toBe('number');
    expect(requestUsage!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('extracts reasoning from contentBlocks (e.g. DeepSeek via ReasoningAwareChatCompletions)', async () => {
    const usage: RequestTokenUsage = {
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      totalPrice: 0,
    };

    (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(usage);

    const llmRes: AIMessageChunk = {
      id: 'msg-deepseek',
      content: '',
      contentBlocks: [
        {
          type: 'reasoning',
          reasoning: 'Let me think about this step by step...',
        },
      ],
      response_metadata: {},
      usage_metadata: {
        input_tokens: 50,
        output_tokens: 10,
        total_tokens: 60,
      },
      tool_calls: [],
    } as unknown as AIMessageChunk;

    (mockLlm as any).bindTools.mockReturnValueOnce({
      invoke: vi.fn().mockResolvedValue(llmRes),
    });

    const res = await node.invoke(createState(), {
      configurable: { run_id: 'run-1', thread_id: 'thread-1' },
    } as any);

    const items = res.messages?.items ?? [];
    const reasoningMsg = items.find((m) => (m as any).role === 'reasoning');

    expect(reasoningMsg).toBeDefined();
    expect(reasoningMsg?.content).toBe(
      'Let me think about this step by step...',
    );
    expect(reasoningMsg?.additional_kwargs?.__model).toBe('gpt-5-mini');
    expect(reasoningMsg?.additional_kwargs?.__hideForLlm).toBe(true);
    expect(reasoningMsg?.additional_kwargs?.__hideForSummary).toBe(true);
  });

  it('does not produce reasoning messages when contentBlocks has no reasoning', async () => {
    const usage: RequestTokenUsage = {
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      totalPrice: 0,
    };

    (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(usage);

    const llmRes: AIMessageChunk = {
      id: 'msg-no-reasoning',
      content: 'plain response',
      contentBlocks: [],
      response_metadata: {},
      usage_metadata: {
        input_tokens: 50,
        output_tokens: 10,
        total_tokens: 60,
      },
      tool_calls: [],
    } as unknown as AIMessageChunk;

    (mockLlm as any).bindTools.mockReturnValueOnce({
      invoke: vi.fn().mockResolvedValue(llmRes),
    });

    const res = await node.invoke(createState(), {
      configurable: { run_id: 'run-1', thread_id: 'thread-1' },
    } as any);

    const items = res.messages?.items ?? [];
    const reasoningMsg = items.find((m) => (m as any).role === 'reasoning');

    expect(reasoningMsg).toBeUndefined();
  });

  it('passes provider-reported cost from response_metadata.usage to extractTokenUsageFromResponse', async () => {
    const usage: RequestTokenUsage = {
      inputTokens: 3612,
      outputTokens: 272,
      totalTokens: 3884,
      totalPrice: 0.00046689,
    };

    (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(usage);

    const llmRes: AIMessageChunk = {
      id: 'msg-openrouter',
      content: 'ok',
      contentBlocks: [],
      response_metadata: {
        usage: {
          prompt_tokens: 3612,
          completion_tokens: 272,
          total_tokens: 3884,
          cost: 0.00046689,
        },
      },
      usage_metadata: {
        input_tokens: 3612,
        output_tokens: 272,
        total_tokens: 3884,
      },
      tool_calls: [],
    } as unknown as AIMessageChunk;

    (mockLlm as any).bindTools.mockReturnValueOnce({
      invoke: vi.fn().mockResolvedValue(llmRes),
    });

    await node.invoke(createState(), {
      configurable: { run_id: 'run-1', thread_id: 'thread-1' },
    } as any);

    expect(mockLitellm.extractTokenUsageFromResponse).toHaveBeenCalledWith(
      'gpt-5-mini',
      expect.objectContaining({ cost: 0.00046689 }),
    );
  });

  describe('cost normalization (chunkMultiple)', () => {
    it('halves raw cost when streaming aggregation doubles total_tokens (2× detected)', async () => {
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue({
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 13,
        totalPrice: 0.00005,
      });

      const llmRes: AIMessageChunk = {
        id: 'msg-doubled',
        content: 'ok',
        contentBlocks: [],
        response_metadata: {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 3,
            total_tokens: 26,
            cost: 0.0001,
          },
        },
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 3,
          total_tokens: 13,
        },
        tool_calls: [],
      } as unknown as AIMessageChunk;

      (mockLlm as any).bindTools.mockReturnValueOnce({
        invoke: vi.fn().mockResolvedValue(llmRes),
      });

      await node.invoke(createState(), {
        configurable: { run_id: 'run-1', thread_id: 'thread-1' },
      } as any);

      expect(mockLitellm.extractTokenUsageFromResponse).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cost: 0.00005 }),
      );
    });

    it('passes cost through unchanged when normalised and raw token counts match (non-streaming, 1×)', async () => {
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue({
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 13,
        totalPrice: 0.0001,
      });

      const llmRes: AIMessageChunk = {
        id: 'msg-matching',
        content: 'ok',
        contentBlocks: [],
        response_metadata: {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 3,
            total_tokens: 13,
            cost: 0.0001,
          },
        },
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 3,
          total_tokens: 13,
        },
        tool_calls: [],
      } as unknown as AIMessageChunk;

      (mockLlm as any).bindTools.mockReturnValueOnce({
        invoke: vi.fn().mockResolvedValue(llmRes),
      });

      await node.invoke(createState(), {
        configurable: { run_id: 'run-1', thread_id: 'thread-1' },
      } as any);

      expect(mockLitellm.extractTokenUsageFromResponse).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cost: 0.0001 }),
      );
    });

    it('passes cost through unchanged when usage_metadata is absent (chunkMultiple stays 1)', async () => {
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 13,
        totalPrice: 0.0001,
      });

      const llmRes: AIMessageChunk = {
        id: 'msg-no-usage-meta',
        content: 'ok',
        contentBlocks: [],
        response_metadata: {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 3,
            total_tokens: 13,
            cost: 0.0001,
          },
        },
        usage_metadata: undefined,
        tool_calls: [],
      } as unknown as AIMessageChunk;

      (mockLlm as any).bindTools.mockReturnValueOnce({
        invoke: vi.fn().mockResolvedValue(llmRes),
      });

      await node.invoke(createState(), {
        configurable: { run_id: 'run-1', thread_id: 'thread-1' },
      } as any);

      expect(mockLitellm.extractTokenUsageFromResponse).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cost: 0.0001 }),
      );
    });
  });

  describe('invokeWithRetry – auth error retry', () => {
    const makeLlmRes = (): AIMessageChunk =>
      ({
        id: 'msg-retry',
        content: 'ok',
        contentBlocks: [],
        response_metadata: {},
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 1,
          total_tokens: 11,
        },
        tool_calls: [],
      }) as unknown as AIMessageChunk;

    beforeEach(() => {
      vi.useFakeTimers();
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue({
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const runWithTimers = async <T>(promise: Promise<T>): Promise<T> => {
      // Flush pending timers in a loop until the promise settles
      let settled = false;
      let result: T;
      let error: unknown;
      const p = promise.then(
        (r) => {
          settled = true;
          result = r;
        },
        (e) => {
          settled = true;
          error = e;
        },
      );
      while (!settled) {
        await vi.advanceTimersByTimeAsync(5_000);
      }
      await p;
      if (error) {
        throw error;
      }
      return result!;
    };

    it('retries on 401 auth error and succeeds on second attempt', async () => {
      const authError = Object.assign(
        new Error('AuthenticationError: OpenrouterException'),
        {
          status: 401,
        },
      );

      const invokeSpy = vi
        .fn()
        .mockRejectedValueOnce(authError)
        .mockResolvedValueOnce(makeLlmRes());

      (mockLlm as any).bindTools.mockReturnValueOnce({ invoke: invokeSpy });

      const res = await runWithTimers(
        node.invoke(createState(), {
          configurable: { run_id: 'run-1', thread_id: 'thread-1' },
        } as any),
      );

      expect(invokeSpy).toHaveBeenCalledTimes(2);
      expect(res.messages?.items).toBeDefined();
    });

    it('retries on 403 error', async () => {
      const authError = Object.assign(new Error('Forbidden'), { status: 403 });

      const invokeSpy = vi
        .fn()
        .mockRejectedValueOnce(authError)
        .mockResolvedValueOnce(makeLlmRes());

      (mockLlm as any).bindTools.mockReturnValueOnce({ invoke: invokeSpy });

      const res = await runWithTimers(
        node.invoke(createState(), {
          configurable: { run_id: 'run-1', thread_id: 'thread-1' },
        } as any),
      );

      expect(invokeSpy).toHaveBeenCalledTimes(2);
      expect(res.messages?.items).toBeDefined();
    });

    it('throws after exhausting max auth retries', async () => {
      const authError = Object.assign(
        new Error('AuthenticationError: User not found'),
        { status: 401 },
      );

      const invokeSpy = vi.fn().mockRejectedValue(authError);
      (mockLlm as any).bindTools.mockReturnValueOnce({ invoke: invokeSpy });

      await expect(
        runWithTimers(
          node.invoke(createState(), {
            configurable: { run_id: 'run-1', thread_id: 'thread-1' },
          } as any),
        ),
      ).rejects.toThrow('AuthenticationError');

      // 1 initial + 2 retries = 3 total attempts
      expect(invokeSpy).toHaveBeenCalledTimes(3);
    });

    it('does not retry non-auth, non-rate-limit errors', async () => {
      const otherError = new Error('Something else broke');

      const invokeSpy = vi.fn().mockRejectedValueOnce(otherError);
      (mockLlm as any).bindTools.mockReturnValueOnce({ invoke: invokeSpy });

      await expect(
        node.invoke(createState(), {
          configurable: { run_id: 'run-1', thread_id: 'thread-1' },
        } as any),
      ).rejects.toThrow('Something else broke');

      expect(invokeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('proxy_ prefix stripping', () => {
    const makeTool = (name: string) =>
      new DynamicStructuredTool({
        name,
        description: `Tool ${name}`,
        schema: z.object({}),
        func: async () => 'ok',
      });

    it('strips proxy_ prefix from tool_calls in the stored AIMessage', async () => {
      const tools = [makeTool('knowledge_search_docs'), makeTool('gh_clone')];
      const nodeWithTools = new InvokeLlmNode(
        mockLitellm as unknown as LitellmService,
        mockLlm,
        tools,
        { systemPrompt: 'Test' },
      );

      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(
        usage,
      );

      const llmRes: AIMessageChunk = {
        id: 'msg-proxy',
        content: '',
        contentBlocks: [],
        response_metadata: {},
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
        tool_calls: [
          {
            id: 'tc1',
            name: 'proxy_knowledge_search_docs',
            args: {},
            type: 'tool_call',
          },
          { id: 'tc2', name: 'proxy_gh_clone', args: {}, type: 'tool_call' },
        ],
      } as unknown as AIMessageChunk;

      (mockLlm as any).bindTools.mockReturnValueOnce({
        invoke: vi.fn().mockResolvedValue(llmRes),
      });

      const res = await nodeWithTools.invoke(createState(), {
        configurable: { run_id: 'run-1', thread_id: 'thread-1' },
      } as any);

      const aiMsg = res.messages?.items?.find(
        (m) => (m as any).tool_calls?.length > 0,
      );
      expect(aiMsg).toBeDefined();
      const toolCallNames = (aiMsg as any).tool_calls.map((tc: any) => tc.name);
      expect(toolCallNames).toEqual(['knowledge_search_docs', 'gh_clone']);
    });

    it('does not strip proxy_ prefix when tool is genuinely named proxy_*', async () => {
      const tools = [makeTool('proxy_handler')];
      const nodeWithTools = new InvokeLlmNode(
        mockLitellm as unknown as LitellmService,
        mockLlm,
        tools,
        { systemPrompt: 'Test' },
      );

      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(
        usage,
      );

      const llmRes: AIMessageChunk = {
        id: 'msg-proxy-genuine',
        content: '',
        contentBlocks: [],
        response_metadata: {},
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
        tool_calls: [
          {
            id: 'tc1',
            name: 'proxy_handler',
            args: {},
            type: 'tool_call',
          },
        ],
      } as unknown as AIMessageChunk;

      (mockLlm as any).bindTools.mockReturnValueOnce({
        invoke: vi.fn().mockResolvedValue(llmRes),
      });

      const res = await nodeWithTools.invoke(createState(), {
        configurable: { run_id: 'run-1', thread_id: 'thread-1' },
      } as any);

      const aiMsg = res.messages?.items?.find(
        (m) => (m as any).tool_calls?.length > 0,
      );
      expect(aiMsg).toBeDefined();
      const toolCallNames = (aiMsg as any).tool_calls.map((tc: any) => tc.name);
      // Should NOT strip because "proxy_handler" exists as a real tool
      expect(toolCallNames).toEqual(['proxy_handler']);
    });

    it('does not strip proxy_ prefix when no matching tool exists', async () => {
      const tools = [makeTool('my_tool')];
      const nodeWithTools = new InvokeLlmNode(
        mockLitellm as unknown as LitellmService,
        mockLlm,
        tools,
        { systemPrompt: 'Test' },
      );

      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(
        usage,
      );

      const llmRes: AIMessageChunk = {
        id: 'msg-proxy2',
        content: '',
        contentBlocks: [],
        response_metadata: {},
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
        tool_calls: [
          {
            id: 'tc1',
            name: 'proxy_unknown_tool',
            args: {},
            type: 'tool_call',
          },
        ],
      } as unknown as AIMessageChunk;

      (mockLlm as any).bindTools.mockReturnValueOnce({
        invoke: vi.fn().mockResolvedValue(llmRes),
      });

      const res = await nodeWithTools.invoke(createState(), {
        configurable: { run_id: 'run-1', thread_id: 'thread-1' },
      } as any);

      const aiMsg = res.messages?.items?.find(
        (m) => (m as any).tool_calls?.length > 0,
      );
      expect(aiMsg).toBeDefined();
      const toolCallNames = (aiMsg as any).tool_calls.map((tc: any) => tc.name);
      // Should NOT strip because "unknown_tool" is not in the tools list
      expect(toolCallNames).toEqual(['proxy_unknown_tool']);
    });

    it('strips proxy_ prefix from additional_kwargs.tool_calls (OpenAI transport)', async () => {
      const tools = [makeTool('communication_exec')];
      const nodeWithTools = new InvokeLlmNode(
        mockLitellm as unknown as LitellmService,
        mockLlm,
        tools,
        { systemPrompt: 'Test' },
      );

      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(
        usage,
      );

      const llmRes: AIMessageChunk = {
        id: 'msg-proxy3',
        content: '',
        contentBlocks: [],
        response_metadata: {},
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
        tool_calls: [
          {
            id: 'tc1',
            name: 'proxy_communication_exec',
            args: {},
            type: 'tool_call',
          },
        ],
        additional_kwargs: {
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: {
                name: 'proxy_communication_exec',
                arguments: '{}',
              },
            },
          ],
        },
      } as unknown as AIMessageChunk;

      (mockLlm as any).bindTools.mockReturnValueOnce({
        invoke: vi.fn().mockResolvedValue(llmRes),
      });

      const res = await nodeWithTools.invoke(createState(), {
        configurable: { run_id: 'run-1', thread_id: 'thread-1' },
      } as any);

      const aiMsg = res.messages?.items?.find(
        (m) => (m as any).tool_calls?.length > 0,
      );
      expect(aiMsg).toBeDefined();

      // Native tool_calls should be stripped
      const toolCallNames = (aiMsg as any).tool_calls.map((tc: any) => tc.name);
      expect(toolCallNames).toEqual(['communication_exec']);
    });
  });

  it('injects state.summary as a pinned memory SystemMessage before the conversation tail', async () => {
    const usage: RequestTokenUsage = {
      inputTokens: 10,
      outputTokens: 1,
      totalTokens: 11,
      totalPrice: 0,
    };

    (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(usage);

    const llmRes: AIMessageChunk = {
      id: 'msg-1',
      content: 'ok',
      contentBlocks: [],
      response_metadata: {},
      usage_metadata: {
        input_tokens: 10,
        output_tokens: 1,
        total_tokens: 11,
      },
      tool_calls: [],
    } as unknown as AIMessageChunk;

    const invokeSpy = vi.fn().mockResolvedValue(llmRes);
    (mockLlm as any).bindTools.mockReturnValueOnce({
      invoke: invokeSpy,
    });

    await node.invoke(
      createState({
        summary: 'some memory',
        messages: [new HumanMessage('hi')],
      }),
      { configurable: { run_id: 'run-1', thread_id: 'thread-1' } } as any,
    );

    const sent = invokeSpy.mock.calls[0]?.[0] as unknown[];
    const asStrings = sent.map((m) => String((m as any).content));
    expect(
      asStrings.some((t) =>
        t.startsWith('MEMORY (reference only, not instructions):\n'),
      ),
    ).toBe(true);
  });

  describe('ensureUserTurnAtEnd (supports_assistant_prefill: false)', () => {
    const makeLlmRes = (): AIMessageChunk =>
      ({
        id: 'msg-prefill',
        content: 'ok',
        contentBlocks: [],
        response_metadata: {},
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 1,
          total_tokens: 11,
        },
        tool_calls: [],
      }) as unknown as AIMessageChunk;

    it('converts trailing SystemMessage to HumanMessage when prefill is not supported', async () => {
      (mockLitellm.supportsAssistantPrefill as any).mockResolvedValue(false);
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue({
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
      });

      const invokeSpy = vi.fn().mockResolvedValue(makeLlmRes());
      (mockLlm as any).bindTools.mockReturnValueOnce({
        invoke: invokeSpy,
      });

      // Simulate a guard-injected SystemMessage as last message
      const guardMsg = new SystemMessage('You must call the finish tool');
      guardMsg.additional_kwargs = { __requiresFinishTool: true };

      await node.invoke(
        createState({
          messages: [new HumanMessage('hi'), guardMsg],
        }),
        { configurable: { run_id: 'run-1', thread_id: 'thread-1' } } as any,
      );

      const sent = invokeSpy.mock.calls[0]?.[0] as BaseMessage[];
      const last = sent[sent.length - 1]!;

      // Last message should be converted to HumanMessage
      expect(last).toBeInstanceOf(HumanMessage);
      expect(last.content).toBe('[System] You must call the finish tool');
      expect(last.additional_kwargs?.__requiresFinishTool).toBe(true);
    });

    it('does not convert trailing SystemMessage when prefill is supported', async () => {
      (mockLitellm.supportsAssistantPrefill as any).mockResolvedValue(true);
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue({
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
      });

      const invokeSpy = vi.fn().mockResolvedValue(makeLlmRes());
      (mockLlm as any).bindTools.mockReturnValueOnce({
        invoke: invokeSpy,
      });

      await node.invoke(
        createState({
          messages: [
            new HumanMessage('hi'),
            new SystemMessage('Guard message'),
          ],
        }),
        { configurable: { run_id: 'run-1', thread_id: 'thread-1' } } as any,
      );

      const sent = invokeSpy.mock.calls[0]?.[0] as BaseMessage[];
      const last = sent[sent.length - 1]!;

      // Last message should remain a SystemMessage
      expect(last).toBeInstanceOf(SystemMessage);
      expect(last.content).toBe('Guard message');
    });

    it('does not touch messages when last is already a HumanMessage', async () => {
      (mockLitellm.supportsAssistantPrefill as any).mockResolvedValue(false);
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue({
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
      });

      const invokeSpy = vi.fn().mockResolvedValue(makeLlmRes());
      (mockLlm as any).bindTools.mockReturnValueOnce({
        invoke: invokeSpy,
      });

      await node.invoke(createState({ messages: [new HumanMessage('hi')] }), {
        configurable: { run_id: 'run-1', thread_id: 'thread-1' },
      } as any);

      const sent = invokeSpy.mock.calls[0]?.[0] as BaseMessage[];
      const last = sent[sent.length - 1]!;

      expect(last).toBeInstanceOf(HumanMessage);
      expect(last.content).toBe('hi');
    });
  });

  describe('cost limit enforcement', () => {
    const makeLlmRes = (): AIMessageChunk =>
      ({
        id: 'msg-cost',
        content: 'ok',
        contentBlocks: [],
        response_metadata: {},
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 1,
          total_tokens: 11,
        },
        tool_calls: [],
      }) as unknown as AIMessageChunk;

    it('does not enforce when enforceCostLimit is not set (subagent path)', async () => {
      const usage: RequestTokenUsage = {
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
        totalPrice: 5,
      };
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(
        usage,
      );

      const invokeSpy = vi.fn().mockResolvedValue(makeLlmRes());
      (mockLlm as any).bindTools.mockReturnValueOnce({ invoke: invokeSpy });

      const res = await node.invoke(createState({ totalPrice: 100 }), {
        configurable: {
          run_id: 'run-1',
          thread_id: 'thread-1',
          // effective_cost_limit_usd would over-budget but enforceCostLimit=false
          effective_cost_limit_usd: 1,
        },
      } as any);

      expect(res).toBeDefined();
      expect(res.messages?.items).toBeDefined();
    });

    it('does not enforce when effective_cost_limit_usd is null (no limit configured)', async () => {
      const usage: RequestTokenUsage = {
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
        totalPrice: 5,
      };
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(
        usage,
      );

      const invokeSpy = vi.fn().mockResolvedValue(makeLlmRes());
      (mockLlm as any).bindTools.mockReturnValueOnce({ invoke: invokeSpy });

      const enforcingNode = new InvokeLlmNode(
        mockLitellm as unknown as LitellmService,
        mockLlm,
        [],
        { systemPrompt: 'Test', enforceCostLimit: true },
      );

      const res = await enforcingNode.invoke(createState({ totalPrice: 100 }), {
        configurable: {
          run_id: 'run-1',
          thread_id: 'thread-1',
          effective_cost_limit_usd: null,
        },
      } as any);

      expect(res).toBeDefined();
    });

    it('does not throw when cost is under the limit', async () => {
      const usage: RequestTokenUsage = {
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
        totalPrice: 0.01,
      };
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(
        usage,
      );

      const invokeSpy = vi.fn().mockResolvedValue(makeLlmRes());
      (mockLlm as any).bindTools.mockReturnValueOnce({ invoke: invokeSpy });

      const enforcingNode = new InvokeLlmNode(
        mockLitellm as unknown as LitellmService,
        mockLlm,
        [],
        { systemPrompt: 'Test', enforceCostLimit: true },
      );

      await expect(
        enforcingNode.invoke(createState({ totalPrice: 0.5 }), {
          configurable: {
            run_id: 'run-1',
            thread_id: 'thread-1',
            effective_cost_limit_usd: 10.0,
          },
        } as any),
      ).resolves.toBeDefined();
    });

    it('throws CostLimitExceededError when projected cost exceeds the limit', async () => {
      const usage: RequestTokenUsage = {
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
        totalPrice: 3.0,
      };
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(
        usage,
      );

      const invokeSpy = vi.fn().mockResolvedValue(makeLlmRes());
      (mockLlm as any).bindTools.mockReturnValueOnce({ invoke: invokeSpy });

      const enforcingNode = new InvokeLlmNode(
        mockLitellm as unknown as LitellmService,
        mockLlm,
        [],
        { systemPrompt: 'Test', enforceCostLimit: true },
      );

      const error = await enforcingNode
        .invoke(createState({ totalPrice: 4.0 }), {
          configurable: {
            run_id: 'run-1',
            thread_id: 'thread-1',
            effective_cost_limit_usd: 5.0,
          },
        } as any)
        .catch((e) => e);

      expect(error).toBeInstanceOf(CostLimitExceededError);
      expect((error as CostLimitExceededError).effectiveLimitUsd).toBe(5.0);
      expect((error as CostLimitExceededError).totalPriceUsd).toBeCloseTo(
        7.0,
        5,
      );
    });

    it('throws CostLimitExceededError when threadUsage is null and state.totalPrice alone meets the limit', async () => {
      // M9: threadUsage=null — projected = state.totalPrice + 0 = state.totalPrice.
      // If state.totalPrice >= effectiveLimit, enforcement must fire.
      const usage: RequestTokenUsage = {
        inputTokens: 5,
        outputTokens: 1,
        totalTokens: 6,
        totalPrice: 0,
      };
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(
        usage,
      );

      const invokeSpy = vi.fn().mockResolvedValue(makeLlmRes());
      (mockLlm as any).bindTools.mockReturnValueOnce({ invoke: invokeSpy });

      const enforcingNode = new InvokeLlmNode(
        mockLitellm as unknown as LitellmService,
        mockLlm,
        [],
        { systemPrompt: 'Test', enforceCostLimit: true },
      );

      // state.totalPrice (3.0) >= effectiveLimit (3.0) — boundary case, >= fires
      const error = await enforcingNode
        .invoke(createState({ totalPrice: 3.0 }), {
          configurable: {
            run_id: 'run-1',
            thread_id: 'thread-1',
            effective_cost_limit_usd: 3.0,
          },
        } as any)
        .catch((e) => e);

      expect(error).toBeInstanceOf(CostLimitExceededError);
      expect((error as CostLimitExceededError).effectiveLimitUsd).toBe(3.0);
    });

    it('throws CostLimitExceededError when projectedTotal exactly equals the limit (>= boundary)', async () => {
      // M9: exact-boundary — projectedTotal === effectiveLimit must throw because
      // the check uses >=.
      const callCost = 2.0;
      const usage: RequestTokenUsage = {
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
        totalPrice: callCost,
      };
      (mockLitellm.extractTokenUsageFromResponse as any).mockResolvedValue(
        usage,
      );

      const invokeSpy = vi.fn().mockResolvedValue(makeLlmRes());
      (mockLlm as any).bindTools.mockReturnValueOnce({ invoke: invokeSpy });

      const enforcingNode = new InvokeLlmNode(
        mockLitellm as unknown as LitellmService,
        mockLlm,
        [],
        { systemPrompt: 'Test', enforceCostLimit: true },
      );

      // state.totalPrice=3 + callCost=2 = 5 === effectiveLimit=5
      const error = await enforcingNode
        .invoke(createState({ totalPrice: 3.0 }), {
          configurable: {
            run_id: 'run-1',
            thread_id: 'thread-1',
            effective_cost_limit_usd: 5.0,
          },
        } as any)
        .catch((e) => e);

      expect(error).toBeInstanceOf(CostLimitExceededError);
      expect((error as CostLimitExceededError).effectiveLimitUsd).toBe(5.0);
      expect((error as CostLimitExceededError).totalPriceUsd).toBeCloseTo(
        5.0,
        5,
      );
    });
  });
});
