import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { MockedFunction } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LitellmService } from '../../../litellm/services/litellm.service';
import { BaseAgentConfigurable, BaseAgentState } from '../../agents.types';
import { SummarizeNode } from './summarize-node';

vi.mock('@langchain/openai');

describe('SummarizeNode', () => {
  let node: SummarizeNode;
  let mockLlm: ChatOpenAI;
  let mockLlmResolver: (currentContext?: number) => ChatOpenAI;
  const extractTokenUsageFromResponseMock = vi.fn().mockResolvedValue(null);
  const countTokensMock = vi.fn().mockResolvedValue(0);
  const mockLitellmService = {
    extractTokenUsageFromResponse: extractTokenUsageFromResponseMock,
    estimateThreadTotalPriceFromModelRates: vi.fn().mockResolvedValue(null),
    countTokens: countTokensMock,
  } as unknown as LitellmService;
  let mockInvoke: MockedFunction<(messages: unknown[]) => Promise<AIMessage>>;

  beforeEach(async () => {
    mockInvoke = vi.fn() as MockedFunction<
      (messages: unknown[]) => Promise<AIMessage>
    >;
    mockLlm = {
      invoke: mockInvoke,
    } as unknown as ChatOpenAI;
    mockLlmResolver = () => mockLlm;

    node = new SummarizeNode(mockLitellmService, mockLlmResolver, {
      maxTokens: 1000,
      keepTokens: 500,
      tokenCountModel: 'gpt-5.1',
    });
  });

  const createMockState = (
    overrides: Partial<BaseAgentState> = {},
  ): BaseAgentState => ({
    messages: [],
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
  });

  const createMockConfig =
    (): LangGraphRunnableConfig<BaseAgentConfigurable> => ({
      configurable: {
        run_id: 'test-run-id',
        thread_id: 'test-thread-id',
      },
    });

  describe('invoke', () => {
    it('should return messages unchanged if maxTokens <= 0', async () => {
      const nodeWithZeroMax = new SummarizeNode(
        mockLitellmService,
        mockLlmResolver,
        {
          maxTokens: 0,
          keepTokens: 500,
          tokenCountModel: 'gpt-5.1',
        },
      );
      const messages = [new HumanMessage('Test')];
      const state = createMockState({ messages });

      const result = await nodeWithZeroMax.invoke(state, createMockConfig());

      // No summarization/changes should be applied at all
      expect(result).toEqual({});
      expect(countTokensMock).not.toHaveBeenCalled();
    });

    it('should return messages unchanged if currentContext is not available', async () => {
      const messages = [new HumanMessage('Test')];
      const state = createMockState({ messages });

      countTokensMock.mockResolvedValue(100);

      const result = await node.invoke(state, createMockConfig());

      // No summarization/changes should be applied at all
      expect(result).toEqual({});
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should update state.summary when summarization occurs (scheme A)', async () => {
      const messages = Array.from(
        { length: 10 },
        (_, i) => new HumanMessage(`Message ${i}`),
      );
      const state = createMockState({
        messages,
        currentContext: 2000,
      });

      countTokensMock.mockImplementation(
        async (_model: string, text: unknown) => {
          const s = String(text ?? '');
          if (s.startsWith('Message')) {
            return 200;
          }
          return s.length;
        },
      );

      const newSummary = 'Summarized conversation';
      mockInvoke.mockResolvedValue(new AIMessage(newSummary));

      const result = await node.invoke(state, createMockConfig());

      expect(result.messages?.items).toBeDefined();
      const returnedMessages = result.messages?.items || [];

      const summaryMsg = returnedMessages.find(
        (m) =>
          m instanceof SystemMessage &&
          m.content === 'Conversation history was summarized.',
      ) as SystemMessage | undefined;
      expect(summaryMsg).toBeDefined();
      expect(summaryMsg?.additional_kwargs?.__hideForLlm).toBe(true);
      expect(result.summary).toBe(newSummary);
      expect(countTokensMock).toHaveBeenCalledWith(
        'gpt-5.1',
        expect.anything(),
      );
    });

    it('should store summary in state.summary without adding a summary message (scheme A)', async () => {
      const messages = Array.from(
        { length: 10 },
        (_, i) => new HumanMessage(`Message ${i}`),
      );
      const state = createMockState({
        messages,
        currentContext: 2000,
      });

      countTokensMock.mockImplementation(
        async (_model: string, text: unknown) => {
          const s = String(text ?? '');
          if (s.startsWith('Message')) {
            return 200;
          }
          return s.length;
        },
      );

      const newSummary = 'Summarized conversation';
      mockInvoke.mockResolvedValue(new AIMessage(newSummary));

      const result = await node.invoke(state, createMockConfig());

      expect(result.summary).toBe(newSummary);

      const returnedMessages = result.messages?.items || [];
      const summaryMsg = returnedMessages.find(
        (m) =>
          m instanceof SystemMessage &&
          m.content === 'Conversation history was summarized.',
      ) as SystemMessage | undefined;

      expect(summaryMsg).toBeDefined();
      expect(summaryMsg?.additional_kwargs?.__hideForLlm).toBe(true);
    });

    it('should not include a summary message when fold returns empty summary', async () => {
      const messages = [new HumanMessage('Test')];
      const state = createMockState({
        messages,
        currentContext: 2000,
      });

      mockInvoke.mockResolvedValue(new AIMessage(''));

      const result = await node.invoke(state, createMockConfig());

      const returnedMessages = result.messages?.items || [];
      expect(
        returnedMessages.some(
          (m) =>
            m instanceof SystemMessage &&
            m.content === 'Conversation history was summarized.',
        ),
      ).toBe(false);
      expect(result.summary).toBe('');
    });

    it('should not include summary message when fold returns empty summary (older messages exist)', async () => {
      const messages = [new HumanMessage('Test message with enough tokens')];
      const state = createMockState({
        messages,
        currentContext: 2000,
      });

      countTokensMock.mockImplementation(
        async (_model: string, text: unknown) => {
          const s = String(text ?? '');
          if (s.includes('Test message')) {
            return 2000;
          }
          return s.length;
        },
      );

      mockInvoke.mockResolvedValue(new AIMessage(''));

      const result = await node.invoke(state, createMockConfig());

      const returnedMessages = result.messages?.items || [];
      expect(
        returnedMessages.some(
          (m) =>
            m instanceof SystemMessage &&
            m.content === 'Conversation history was summarized.',
        ),
      ).toBe(false);
      expect(result.summary).toBe('');
    });

    it('should trigger summarization based on currentContext (from LLM usage)', async () => {
      const nodeWithTightBudget = new SummarizeNode(
        mockLitellmService,
        mockLlmResolver,
        {
          maxTokens: 1000,
          keepTokens: 0,
          tokenCountModel: 'gpt-5.1',
        },
      );
      const messages = [
        new HumanMessage('Message 1'),
        new HumanMessage('Message 2'),
        new HumanMessage('Message 3'),
      ];
      const state = createMockState({
        messages,
        currentContext: 1500,
      });

      mockInvoke.mockResolvedValue(new AIMessage('Summary'));

      const result = await nodeWithTightBudget.invoke(
        state,
        createMockConfig(),
      );

      expect(mockInvoke).toHaveBeenCalled();
      expect(result.messages?.mode).toBe('replace');
      expect(result.summary).toBe('Summary');
    });

    it('should still fold at least one block when currentContext exceeds maxTokens but local keepTokens trimming keeps everything', async () => {
      const nodeWithLargeKeep = new SummarizeNode(
        mockLitellmService,
        mockLlmResolver,
        {
          maxTokens: 1000,
          keepTokens: 10_000,
          tokenCountModel: 'gpt-5.1',
        },
      );

      const state = createMockState({
        summary: '',
        messages: [new HumanMessage('Old message'), new HumanMessage('Newest')],
        currentContext: 2000,
      });

      // Make token estimator think both messages fit comfortably into keepTokens.
      countTokensMock.mockResolvedValue(1);
      mockInvoke.mockResolvedValue(new AIMessage('Summary'));

      const result = await nodeWithLargeKeep.invoke(state, createMockConfig());

      expect(mockInvoke).toHaveBeenCalled();
      expect(result.summary).toBe('Summary');

      // We should keep at least the last message (tail) after compaction.
      const returnedMessages = result.messages?.items || [];
      expect(returnedMessages.at(-1)?.content).toBe('Newest');
    });

    it('should handle keepTokens = 0 by keeping only last message', async () => {
      const nodeWithZeroKeep = new SummarizeNode(
        mockLitellmService,
        mockLlmResolver,
        {
          maxTokens: 1000,
          keepTokens: 0,
          tokenCountModel: 'gpt-5.1',
        },
      );

      const messages = [
        new HumanMessage('Message 1'),
        new HumanMessage('Message 2'),
        new HumanMessage('Message 3'),
      ];
      const state = createMockState({
        messages,
        currentContext: 2000,
      });

      countTokensMock.mockImplementation(
        async (_model: string, text: unknown) => {
          const s = String(text ?? '');
          if (s.startsWith('Message')) {
            return 500; // High token count per message to exceed maxTokens
          }
          return s.length;
        },
      );

      mockInvoke.mockResolvedValue(new AIMessage('Summary'));

      const result = await nodeWithZeroKeep.invoke(state, createMockConfig());

      expect(mockInvoke).toHaveBeenCalled();
      const returnedMessages = result.messages?.items || [];
      expect(returnedMessages.at(-1)?.content).toBe('Message 3');
    });

    it('should use custom systemNote when provided', async () => {
      const customSystemNote = 'Custom summarization instruction';
      const nodeWithCustomNote = new SummarizeNode(
        mockLitellmService,
        mockLlmResolver,
        {
          maxTokens: 1000,
          keepTokens: 500,
          systemNote: customSystemNote,
          tokenCountModel: 'gpt-5.1',
        },
      );

      const messages = Array.from(
        { length: 10 },
        (_, i) => new HumanMessage(`Message ${i}`),
      );
      const state = createMockState({
        messages,
        currentContext: 2000,
      });

      countTokensMock.mockImplementation(
        async (_model: string, text: unknown) => {
          const s = String(text ?? '');
          if (s.startsWith('Message')) {
            return 200; // High token count per message to exceed maxTokens
          }
          return s.length;
        },
      );

      mockInvoke.mockResolvedValue(new AIMessage('Summary'));

      await nodeWithCustomNote.invoke(state, createMockConfig());

      // Check that the custom system note was used in the fold operation
      const invokeCalls = mockInvoke.mock.calls;
      expect(invokeCalls.length).toBeGreaterThan(0);
      const firstCall = invokeCalls[0]?.[0] as SystemMessage[];
      const systemMessage = firstCall?.find((m) => m instanceof SystemMessage);
      expect(systemMessage?.content).toBe(customSystemNote);
    });

    it('should never fold system prompts, and should use state.summary for delta-folding', async () => {
      const state = createMockState({
        summary: 'Older summary',
        messages: [
          new SystemMessage('Pinned system'),
          new HumanMessage('Old human 1'),
          new HumanMessage('Old human 2'),
          new HumanMessage('Tail human'),
        ],
        currentContext: 2000,
      });

      // Force tail to be only the last human message so older includes the two "Old human" messages.
      const nodeWithSmallKeep = new SummarizeNode(
        mockLitellmService,
        mockLlmResolver,
        {
          maxTokens: 1000,
          keepTokens: 1,
          tokenCountModel: 'gpt-5.1',
        },
      );
      countTokensMock.mockResolvedValue(1);
      mockInvoke.mockResolvedValue(new AIMessage('Updated summary'));

      await nodeWithSmallKeep.invoke(state, createMockConfig());

      const invokeCalls = mockInvoke.mock.calls;
      expect(invokeCalls.length).toBeGreaterThan(0);
      const callMessages = invokeCalls[0]?.[0] as unknown[];
      const human = callMessages.find((m) => m instanceof HumanMessage) as
        | HumanMessage
        | undefined;
      expect(human).toBeDefined();
      // The previous summary should be passed as TEXT in the prompt, not as a message
      expect(String(human?.content)).toContain(
        'Previous summary:\nOlder summary',
      );
      // The older messages should be folded in
      expect(String(human?.content)).toContain('HUMAN: Old human 1');
      expect(String(human?.content)).toContain('HUMAN: Old human 2');
    });

    it('should drop tool-usage-guard system messages (__hideForSummary) during compaction so they are not pinned', async () => {
      const pinned = new SystemMessage('Pinned system');
      const toolUsageGuard = new SystemMessage(
        "You must call a tool before finishing. Call the 'finish' tool.",
      );
      toolUsageGuard.additional_kwargs = { __hideForSummary: true };

      const state = createMockState({
        messages: [
          pinned,
          new HumanMessage('Old human 1'),
          toolUsageGuard,
          new HumanMessage('Tail human'),
        ],
        currentContext: 2000,
      });

      // Force compaction to happen and make the tail small so "Old human 1" folds.
      const nodeWithSmallKeep = new SummarizeNode(
        mockLitellmService,
        mockLlmResolver,
        {
          maxTokens: 1000,
          keepTokens: 1,
          tokenCountModel: 'gpt-5.1',
        },
      );
      countTokensMock.mockResolvedValue(1);
      mockInvoke.mockResolvedValue(new AIMessage('Updated summary'));

      const result = await nodeWithSmallKeep.invoke(state, createMockConfig());

      const returnedMessages = result.messages?.items || [];

      // Pinned system stays.
      expect(
        returnedMessages.some(
          (m) => m instanceof SystemMessage && m.content === 'Pinned system',
        ),
      ).toBe(true);

      // Tool-usage-guard system message is dropped (not pinned, not kept).
      expect(
        returnedMessages.some(
          (m) =>
            m instanceof SystemMessage &&
            typeof m.content === 'string' &&
            m.content.includes('You must call a tool before finishing'),
        ),
      ).toBe(false);
    });

    it('should skip summarization when pending tool calls exist', async () => {
      const aiMsgWithToolCall = new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'call_123',
            name: 'test_tool',
            args: { arg: 'value' },
            type: 'tool_call',
          },
        ],
      });

      const state = createMockState({
        messages: [
          new HumanMessage('Test'),
          aiMsgWithToolCall,
          // No ToolMessage yet - pending!
        ],
        currentContext: 2000,
      });

      const result = await node.invoke(state, createMockConfig());

      // Should not summarize - pending tool call
      expect(result).toEqual({});
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should allow summarization when all tool calls have results', async () => {
      const aiMsgWithToolCall = new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'call_123',
            name: 'test_tool',
            args: { arg: 'value' },
            type: 'tool_call',
          },
        ],
      });

      const toolResult = new ToolMessage({
        content: 'Tool result',
        tool_call_id: 'call_123',
      });

      const state = createMockState({
        messages: [
          new HumanMessage('Test message 1'),
          new HumanMessage('Test message 2'),
          new HumanMessage('Test message 3'),
          aiMsgWithToolCall,
          toolResult,
          new HumanMessage('Another message'),
        ],
        currentContext: 2000,
      });

      countTokensMock.mockImplementation(
        async (_model: string, text: unknown) => {
          const s = String(text ?? '');
          if (s.includes('Test message')) {
            return 500;
          }
          return 50;
        },
      );
      mockInvoke.mockResolvedValue(new AIMessage('Summary'));

      const result = await node.invoke(state, createMockConfig());

      // Should summarize - all tool calls have results
      expect(mockInvoke).toHaveBeenCalled();
      expect(result.messages).toBeDefined();
    });

    it('should preserve tool-call atomicity when trimming', async () => {
      const aiMsgWithToolCall = new AIMessage({
        content: 'Calling tool',
        tool_calls: [
          {
            id: 'call_456',
            name: 'test_tool',
            args: { arg: 'value' },
            type: 'tool_call',
          },
        ],
      });

      const toolResult = new ToolMessage({
        content: 'Tool result',
        tool_call_id: 'call_456',
      });

      const state = createMockState({
        messages: [
          new HumanMessage('Old message 1'),
          new HumanMessage('Old message 2'),
          aiMsgWithToolCall,
          toolResult,
          new HumanMessage('Recent message'),
        ],
        currentContext: 2000,
      });

      // Set up token counting to force trimming
      countTokensMock.mockImplementation(
        async (_model: string, text: unknown) => {
          const s = String(text ?? '');
          if (s.includes('Old message')) {
            return 500;
          }
          return 50;
        },
      );

      mockInvoke.mockResolvedValue(new AIMessage('Summary'));

      const result = await node.invoke(state, createMockConfig());

      const returnedMessages = result.messages?.items || [];

      // If the AI message with tool call is in the result, its tool result must also be present
      const hasAiMsg = returnedMessages.some(
        (m) => m instanceof AIMessage && m.content === 'Calling tool',
      );
      const hasToolResult = returnedMessages.some(
        (m) => m instanceof ToolMessage && m.tool_call_id === 'call_456',
      );

      if (hasAiMsg) {
        expect(hasToolResult).toBe(true);
      }
    });

    it('should keep a full tool-roundtrip block when keepTokens = 0 and tool result is the last message', async () => {
      const nodeWithZeroKeep = new SummarizeNode(
        mockLitellmService,
        mockLlmResolver,
        {
          maxTokens: 1000,
          keepTokens: 0,
          tokenCountModel: 'gpt-5.1',
        },
      );

      const aiMsgWithToolCall = new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'call_keep0',
            name: 'test_tool',
            args: { arg: 'value' },
            type: 'tool_call',
          },
        ],
      });

      const toolResult = new ToolMessage({
        content: 'Tool result',
        tool_call_id: 'call_keep0',
      });

      const state = createMockState({
        messages: [
          new HumanMessage('Old message'),
          aiMsgWithToolCall,
          toolResult,
        ],
        currentContext: 2000,
      });

      mockInvoke.mockResolvedValue(new AIMessage('Summary'));
      countTokensMock.mockResolvedValue(1);

      const result = await nodeWithZeroKeep.invoke(state, createMockConfig());

      const returnedMessages = result.messages?.items || [];
      expect(returnedMessages.some((m) => m instanceof ToolMessage)).toBe(true);
      expect(
        returnedMessages.some(
          (m) => m instanceof ToolMessage && m.tool_call_id === 'call_keep0',
        ),
      ).toBe(true);
      expect(
        returnedMessages.some(
          (m) =>
            m instanceof AIMessage &&
            Array.isArray(m.tool_calls) &&
            m.tool_calls.some((tc) => tc.id === 'call_keep0'),
        ),
      ).toBe(true);
    });

    it('should handle multiple tool calls in a single AI message', async () => {
      const aiMsgWithMultipleToolCalls = new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            name: 'tool_1',
            args: {},
            type: 'tool_call',
          },
          {
            id: 'call_2',
            name: 'tool_2',
            args: {},
            type: 'tool_call',
          },
        ],
      });

      const toolResult1 = new ToolMessage({
        content: 'Result 1',
        tool_call_id: 'call_1',
      });

      // Missing call_2 result - pending!
      const state = createMockState({
        messages: [
          new HumanMessage('Test'),
          aiMsgWithMultipleToolCalls,
          toolResult1,
        ],
        currentContext: 2000,
      });

      const result = await node.invoke(state, createMockConfig());

      // Should not summarize - one tool call is still pending
      expect(result).toEqual({});
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should detect pending tool calls in additional_kwargs.tool_calls', async () => {
      const aiMsgWithToolCallInKwargs = new AIMessage({
        content: '',
        additional_kwargs: {
          tool_calls: [
            {
              id: 'call_456',
              type: 'function',
              function: { name: 'test_tool', arguments: '{}' },
            },
          ],
        },
      });

      const state = createMockState({
        messages: [new HumanMessage('Test'), aiMsgWithToolCallInKwargs],
        currentContext: 2000,
      });

      const result = await node.invoke(state, createMockConfig());

      // Should not summarize - pending tool call in additional_kwargs
      expect(result).toEqual({});
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should pass currentContext to llmResolver when folding', async () => {
      const resolverSpy = vi.fn().mockReturnValue(mockLlm);
      const nodeWithSpy = new SummarizeNode(mockLitellmService, resolverSpy, {
        maxTokens: 1000,
        keepTokens: 0,
        tokenCountModel: 'gpt-5.1',
      });

      const state = createMockState({
        messages: [
          new HumanMessage('Message 1'),
          new HumanMessage('Message 2'),
        ],
        currentContext: 45000,
      });

      mockInvoke.mockResolvedValue(new AIMessage('Summary'));

      await nodeWithSpy.invoke(state, createMockConfig());

      expect(resolverSpy).toHaveBeenCalledWith(45000, undefined);
    });

    it('fold() passes providerCost to extractTokenUsageFromResponse when cost is present in response_metadata', async () => {
      // Two messages are required so that splitKeepingLastBlock() has at least 2 blocks
      // and can produce a non-empty messagesForSummarize slice, reaching fold().
      const messages = [
        new HumanMessage('Old message'),
        new HumanMessage('Newer message'),
      ];
      const state = createMockState({ messages, currentContext: 2000 });

      // keepTokens = 500; each message at 200 tokens → older message gets folded.
      countTokensMock.mockResolvedValue(200);

      const aiResponseWithCost = new AIMessage('Summary');
      aiResponseWithCost.response_metadata = {
        usage: { total_tokens: 100, cost: 0.0005 },
      };
      mockInvoke.mockResolvedValue(aiResponseWithCost);

      await node.invoke(state, createMockConfig());

      expect(extractTokenUsageFromResponseMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cost: 0.0005 }),
      );
    });

    it('fold() does not pass cost to extractTokenUsageFromResponse when cost absent from response_metadata', async () => {
      // Two messages are required so splitKeepingLastBlock() reaches fold().
      const messages = [
        new HumanMessage('Old message'),
        new HumanMessage('Newer message'),
      ];
      const state = createMockState({ messages, currentContext: 2000 });

      countTokensMock.mockResolvedValue(200);

      const aiResponseWithoutCost = new AIMessage('Summary');
      aiResponseWithoutCost.response_metadata = {
        usage: { total_tokens: 100 },
      };
      mockInvoke.mockResolvedValue(aiResponseWithoutCost);

      await node.invoke(state, createMockConfig());

      expect(extractTokenUsageFromResponseMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.objectContaining({ cost: expect.anything() }),
      );
    });

    it('should return token usage deltas for accumulation (not reset existing stats)', async () => {
      const messages = Array.from(
        { length: 10 },
        (_, i) => new HumanMessage(`Message ${i}`),
      );
      const state = createMockState({
        messages,
        currentContext: 2000,
        // Existing accumulated usage in state - these should NOT be reset
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 300,
        reasoningTokens: 50,
        totalTokens: 1350,
        totalPrice: 0.05,
      });

      countTokensMock.mockImplementation(
        async (_model: string, text: unknown) => {
          const s = String(text ?? '');
          if (s.startsWith('Message')) {
            return 200;
          }
          return 50;
        },
      );

      const mockUsage = {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningTokens: 10,
        totalTokens: 140,
        totalPrice: 0.002,
      };

      mockInvoke.mockResolvedValue(new AIMessage('Summary'));
      extractTokenUsageFromResponseMock.mockResolvedValue(mockUsage);

      const result = await node.invoke(state, createMockConfig());

      // Verify that we return the DELTA (usage from the summarization call),
      // NOT the total. The state reducer will add this to existing values.
      expect(result.inputTokens).toBe(100); // Delta, not 1100
      expect(result.cachedInputTokens).toBe(20); // Delta, not 520
      expect(result.outputTokens).toBe(30); // Delta, not 330
      expect(result.reasoningTokens).toBe(10); // Delta, not 60
      expect(result.totalTokens).toBe(140); // Delta, not 1490
      expect(result.totalPrice).toBe(0.002); // Delta, not 0.052

      // Note: The actual accumulation happens in the LangGraph state reducer,
      // which uses: reducer: (left, right) => left + (right ?? 0)
      // So when LangGraph processes this return value, it will do:
      // newInputTokens = 1000 + 100 = 1100
      // newOutputTokens = 300 + 30 = 330, etc.
    });
  });
});
