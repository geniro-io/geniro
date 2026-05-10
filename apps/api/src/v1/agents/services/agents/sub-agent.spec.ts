import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  ChatMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { RunnableConfig } from '@langchain/core/runnables';
import {
  DynamicStructuredTool,
  ToolRunnableConfig,
} from '@langchain/core/tools';
import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ToolInvokeResult } from '../../../agent-tools/tools/base-tool';
import { LitellmService } from '../../../litellm/services/litellm.service';
import { CostLimitExceededError } from '../../agents.errors';
import { BaseAgentConfigurable } from '../../agents.types';
import { filterMessagesForLlm } from '../../agents.utils';
import { AgentEventType } from './base-agent';
import { SubAgent, SubAgentSchemaType } from './sub-agent';

const { mockLlmInvokeRef, mockCompiledStreamRef } = vi.hoisted(() => ({
  mockLlmInvokeRef: vi.fn(),
  // When non-null, the StateGraph mock below routes compiled.stream() here.
  // Leave null for tests that use the real graph (existing tests).
  mockCompiledStreamRef: { current: null as AsyncGenerator<unknown> | null },
}));

// Conditionally intercept compiled.stream() for leak-guard tests.
// When mockCompiledStreamRef.current is non-null, stream() returns it;
// otherwise passes through to the real compiled graph (used by existing tests).
vi.mock('@langchain/langgraph', async (importActual) => {
  const actual = await importActual<typeof import('@langchain/langgraph')>();

  // Wrap StateGraph so compiled.stream() can be intercepted per-test.

  const OriginalStateGraph = actual.StateGraph as any;

  class PatchedStateGraph extends (OriginalStateGraph as new (
    ...a: any[]
  ) => any) {
    compile(...args: any[]) {
      const compiledGraph: { stream: (...s: any[]) => unknown } = super.compile(
        ...args,
      );
      if (mockCompiledStreamRef.current !== null) {
        const injectedStream = mockCompiledStreamRef.current;
        return {
          ...compiledGraph,
          stream: async () => injectedStream,
        };
      }
      return compiledGraph;
    }
  }

  return { ...actual, StateGraph: PatchedStateGraph };
});

vi.mock('../../../../environments', () => ({
  environment: {
    toolMaxOutputTokens: 5000,
    litellmMasterKey: 'test-key',
    llmBaseUrl: 'http://localhost:4000',
  },
}));

// Mock ChatOpenAI so buildLLM() returns our controllable mock.
vi.mock('@langchain/openai', () => {
  // Use a regular function (not arrow) so it can be called with `new`.
  function MockChatOpenAI() {
    return {
      bindTools: vi.fn().mockReturnValue({
        invoke: mockLlmInvokeRef,
      }),
      model: 'test-model',
    };
  }
  return { ChatOpenAI: MockChatOpenAI, ChatOpenAICompletions: class {} };
});

// Suppress the noisy LangGraph "Setting a recursionLimit" warning
vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('SubAgent', () => {
  let subAgent: SubAgent;
  let mockLitellmService: LitellmService;
  let mockLogger: DefaultLogger;

  const defaultCfg: ToolRunnableConfig<BaseAgentConfigurable> = {
    configurable: { thread_id: 'thread-123' },
  };

  const defaultAgentConfig: SubAgentSchemaType = {
    instructions: 'You are a test subagent.',
    invokeModelName: 'test-model',
    maxIterations: 25,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockLitellmService = {
      supportsParallelToolCall: vi.fn().mockResolvedValue(false),
      supportsResponsesApi: vi.fn().mockResolvedValue(false),
      supportsReasoning: vi.fn().mockResolvedValue(false),
      supportsStreaming: vi.fn().mockResolvedValue(false),
      supportsAssistantPrefill: vi.fn().mockResolvedValue(true),
      extractTokenUsageFromResponse: vi.fn().mockResolvedValue({
        inputTokens: 100,
        outputTokens: 30,
        totalTokens: 130,
      }),
      sumTokenUsages: vi.fn().mockReturnValue(null),
    } as unknown as LitellmService;

    mockLogger = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as DefaultLogger;

    subAgent = new SubAgent(mockLitellmService, mockLogger);
    subAgent.setConfig(defaultAgentConfig);
  });

  describe('simple completion', () => {
    it('should return result when LLM responds without tool calls', async () => {
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'Found 5 TypeScript files',
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Find TS files')],
        defaultCfg,
      );

      expect(result.result).toBe('Found 5 TypeScript files');
      expect(result.statistics.totalIterations).toBe(1);
      expect(result.statistics.toolCallsMade).toBe(0);
      expect(result.error).toBeUndefined();
    });

    it('should extract result from array content blocks (output_text)', async () => {
      // Regression test: some providers (e.g. gpt-5.1-codex-mini via LiteLLM)
      // return content as an array of content blocks [{type: "output_text", text: "..."}]
      // instead of a plain string.  Before the fix this fell through to "Task completed."
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: [
            { type: 'output_text', text: 'Findings from analysis' },
          ] as unknown as string,
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Analyze the codebase')],
        defaultCfg,
      );

      expect(result.result).toBe('Findings from analysis');
      expect(result.error).toBeUndefined();
    });

    it('should extract result from mixed text and output_text content blocks', async () => {
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: [
            { type: 'text', text: 'Part one' },
            { type: 'output_text', text: 'Part two' },
          ] as unknown as string,
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Do analysis')],
        defaultCfg,
      );

      expect(result.result).toBe('Part one\nPart two');
      expect(result.error).toBeUndefined();
    });

    it('should fallback after exhausting empty response retries', async () => {
      // All 3 responses are empty: 1 original + 2 retries = 3 total LLM calls
      mockLlmInvokeRef.mockResolvedValue(
        new AIMessage({
          content: '',
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Do something')],
        defaultCfg,
      );

      expect(result.result).toBe('Task completed.');
      // 1 original + 2 retries = 3 LLM invocations
      expect(result.statistics.totalIterations).toBe(3);
      expect(mockLlmInvokeRef).toHaveBeenCalledTimes(3);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('empty response guard exhausted'),
      );
    });
  });

  describe('empty response guard', () => {
    it('should nudge LLM when it returns empty string content', async () => {
      // 1st call: empty content, no tool calls → nudge
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: '',
          response_metadata: { usage: {} },
        }),
      );
      // 2nd call (after nudge): real answer
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'Here is the actual answer.',
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Do something')],
        defaultCfg,
      );

      expect(result.result).toBe('Here is the actual answer.');
      expect(result.error).toBeUndefined();
      expect(result.statistics.totalIterations).toBe(2);
      expect(mockLlmInvokeRef).toHaveBeenCalledTimes(2);
    });

    it('should nudge LLM when it returns empty output_text content block', async () => {
      // Exact scenario from the bug report: content is [{type: "output_text", text: ""}]
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: [{ type: 'output_text', text: '' }] as unknown as string,
          response_metadata: { usage: {} },
        }),
      );
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'Real answer after nudge.',
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Research the codebase')],
        defaultCfg,
      );

      expect(result.result).toBe('Real answer after nudge.');
      expect(result.error).toBeUndefined();
      expect(result.statistics.totalIterations).toBe(2);
    });

    it('should not nudge when LLM returns non-empty content', async () => {
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'A real answer on the first try.',
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Do something')],
        defaultCfg,
      );

      expect(result.result).toBe('A real answer on the first try.');
      expect(result.error).toBeUndefined();
      expect(result.statistics.totalIterations).toBe(1);
      expect(mockLlmInvokeRef).toHaveBeenCalledTimes(1);
    });

    it('should include nudge system message in retry LLM invocation', async () => {
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: '',
          response_metadata: { usage: {} },
        }),
      );

      let capturedMessages: BaseMessage[] = [];
      mockLlmInvokeRef.mockImplementationOnce((msgs: BaseMessage[]) => {
        capturedMessages = msgs;
        return Promise.resolve(
          new AIMessage({
            content: 'Answer after nudge',
            response_metadata: { usage: {} },
          }),
        );
      });

      await subAgent.runSubagent(
        [new HumanMessage('Do something')],
        defaultCfg,
      );

      const systemMessages = capturedMessages.filter(
        (m) => m instanceof SystemMessage,
      );
      expect(
        systemMessages.some(
          (m) =>
            typeof m.content === 'string' &&
            m.content.includes('previous response was empty'),
        ),
      ).toBe(true);
    });
  });

  describe('abort signal', () => {
    it('should respect abort signal before graph invocation', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const result = await subAgent.runSubagent(
        [new HumanMessage('Find files')],
        {
          ...defaultCfg,
          signal: abortController.signal,
        },
      );

      expect(result.error).toBe('Aborted');
      expect(result.statistics.totalIterations).toBe(0);
      expect(mockLlmInvokeRef).not.toHaveBeenCalled();
    });
  });

  describe('token usage extraction', () => {
    it('should return null usage when no tokens were consumed', async () => {
      vi.mocked(
        mockLitellmService.extractTokenUsageFromResponse,
      ).mockResolvedValue(null);

      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'Result',
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Find files')],
        defaultCfg,
      );

      expect(result.statistics.usage).toBeNull();
    });

    it('should extract non-zero usage from state', async () => {
      vi.mocked(
        mockLitellmService.extractTokenUsageFromResponse,
      ).mockResolvedValue({
        inputTokens: 200,
        outputTokens: 50,
        totalTokens: 250,
        totalPrice: 0,
      });

      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'Result',
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Find files')],
        defaultCfg,
      );

      expect(result.statistics.usage).toBeTruthy();
      expect(result.statistics.usage!.inputTokens).toBeGreaterThan(0);
      expect(result.statistics.usage!.totalTokens).toBeGreaterThan(0);
    });
  });

  describe('maxIterations', () => {
    it('should use maxIterations from config', async () => {
      // Make LLM always return tool calls so it loops until limit
      const toolCallMsg = new AIMessage({
        content: '',
        tool_calls: [{ id: 'call-1', name: 'nonexistent', args: {} }],
        response_metadata: { usage: {} },
      });
      mockLlmInvokeRef.mockResolvedValue(toolCallMsg);

      const result = await subAgent.runSubagent(
        [new HumanMessage('Loop forever')],
        defaultCfg,
      );

      expect(result.error).toBe('Max iterations reached');
      expect(result.result).toContain(String(defaultAgentConfig.maxIterations));
    });

    it('should respect custom maxIterations config', async () => {
      subAgent.setConfig({
        ...defaultAgentConfig,
        maxIterations: 5,
      });

      const toolCallMsg = new AIMessage({
        content: '',
        tool_calls: [{ id: 'call-1', name: 'nonexistent', args: {} }],
        response_metadata: { usage: {} },
      });
      mockLlmInvokeRef.mockResolvedValue(toolCallMsg);

      const result = await subAgent.runSubagent(
        [new HumanMessage('Loop forever')],
        defaultCfg,
      );

      expect(result.error).toBe('Max iterations reached');
      expect(result.result).toContain('5');
      // With maxIterations=5 the total LLM invocations should be less than 5
      expect(result.statistics.totalIterations).toBeLessThanOrEqual(5);
    });

    it('should include partial statistics in max iterations result', async () => {
      subAgent.setConfig({
        ...defaultAgentConfig,
        maxIterations: 5,
      });

      vi.mocked(
        mockLitellmService.extractTokenUsageFromResponse,
      ).mockResolvedValue({
        inputTokens: 100,
        outputTokens: 30,
        totalTokens: 130,
        totalPrice: 0,
      });

      const toolCallMsg = new AIMessage({
        content: '',
        tool_calls: [{ id: 'call-1', name: 'nonexistent', args: {} }],
        response_metadata: { usage: {} },
      });
      mockLlmInvokeRef.mockResolvedValue(toolCallMsg);

      const result = await subAgent.runSubagent(
        [new HumanMessage('Loop forever')],
        defaultCfg,
      );

      expect(result.error).toBe('Max iterations reached');
      expect(result.statistics.totalIterations).toBeGreaterThanOrEqual(1);
    });
  });

  describe('maxContextTokens', () => {
    it('should stop when currentContext exceeds maxContextTokens', async () => {
      subAgent.setConfig({
        ...defaultAgentConfig,
        maxContextTokens: 500,
      });

      // Return currentContext in the token usage to trigger the limit
      vi.mocked(
        mockLitellmService.extractTokenUsageFromResponse,
      ).mockResolvedValue({
        inputTokens: 600,
        outputTokens: 30,
        totalTokens: 630,
        currentContext: 600,
        totalPrice: 0,
      });

      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'Partial result before limit.',
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Research the codebase')],
        defaultCfg,
      );

      expect(result.error).toBe('Context limit reached (600/500)');
      expect(result.result).toBe('Partial result before limit.');
      expect(result.statistics.totalIterations).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('SubAgent hit context limit'),
      );
    });

    it('should not stop when currentContext is below maxContextTokens', async () => {
      subAgent.setConfig({
        ...defaultAgentConfig,
        maxContextTokens: 1000,
      });

      vi.mocked(
        mockLitellmService.extractTokenUsageFromResponse,
      ).mockResolvedValue({
        inputTokens: 200,
        outputTokens: 30,
        totalTokens: 230,
        currentContext: 200,
        totalPrice: 0,
      });

      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'Full result completed.',
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Quick task')],
        defaultCfg,
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toBe('Full result completed.');
    });
  });

  describe('exploredFiles extraction', () => {
    it('should return empty array when no files were explored', async () => {
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'No files needed.',
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Answer a question')],
        defaultCfg,
      );

      expect(result.exploredFiles).toEqual([]);
    });

    it('should extract file paths from files_read tool calls', async () => {
      const mockReadTool = {
        name: 'files_read',
        description: 'Read files',
        schema: z.object({
          filesToRead: z.array(z.object({ filePath: z.string() })),
        }),
        invoke: vi.fn(async () => ({
          output: JSON.stringify({
            files: [{ content: 'file content' }],
          }),
        })),
      } as unknown as DynamicStructuredTool;

      subAgent.addTool(mockReadTool);
      subAgent.setConfig({ ...defaultAgentConfig, maxIterations: 10 });

      // 1st call: tool call to read files
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'call_read1',
              name: 'files_read',
              args: {
                filesToRead: [
                  { filePath: '/workspace/src/service.ts' },
                  { filePath: '/workspace/src/controller.ts' },
                ],
              },
              type: 'tool_call',
            },
          ],
          response_metadata: { usage: {} },
        }),
      );

      // 2nd call: final answer
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'Found the service and controller.',
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Read the service files')],
        defaultCfg,
      );

      expect(result.exploredFiles).toEqual([
        '/workspace/src/controller.ts',
        '/workspace/src/service.ts',
      ]);
    });

    it('should return exploredFiles even on abort', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const result = await subAgent.runSubagent(
        [new HumanMessage('Find files')],
        { ...defaultCfg, signal: abortController.signal },
      );

      expect(result.exploredFiles).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('should return graceful error result for non-abort errors', async () => {
      mockLlmInvokeRef.mockRejectedValueOnce(
        new Error('LLM connection failed'),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Find files')],
        defaultCfg,
      );

      expect(result.error).toBe('LLM connection failed');
      expect(result.result).toContain('Subagent execution failed');
      expect(result.result).toContain('LLM connection failed');
      expect(result.statistics.totalIterations).toBe(0);
      expect(result.statistics.toolCallsMade).toBe(0);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should treat AbortError as abort', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockLlmInvokeRef.mockRejectedValueOnce(abortError);

      const result = await subAgent.runSubagent(
        [new HumanMessage('Find files')],
        defaultCfg,
      );

      expect(result.error).toBe('Aborted');
      expect(result.statistics.totalIterations).toBe(0);
    });
  });

  describe('tool call ID normalisation (infinite loop fix)', () => {
    /**
     * Helper: create a simple DynamicStructuredTool whose invoke() returns a
     * ToolInvokeResult. The tool records all invocations so tests can assert
     * how many times it was called and what state the messages were in.
     */
    function createMockTool(
      name: string,
      fn: (args: Record<string, unknown>) => ToolInvokeResult<unknown>,
    ): DynamicStructuredTool {
      const invocations: Record<string, unknown>[] = [];
      const mockTool = {
        name,
        description: `Mock ${name} tool`,
        schema: z.object({ query: z.string().optional() }),
        invoke: vi.fn(async (args: unknown) => {
          const parsed = args as Record<string, unknown>;
          invocations.push(parsed);
          return fn(parsed);
        }),
        __invocations: invocations,
      } as unknown as DynamicStructuredTool;
      return mockTool;
    }

    it('should complete without looping when LLM returns tool calls with undefined ids', async () => {
      // This is the core regression test for the infinite-loop bug.
      //
      // Scenario: The LLM (e.g. Gemini via LiteLLM) returns a tool_call with
      // id=undefined.  Before the fix, ToolExecutorNode would create a
      // ToolMessage with a generated missing_id_xxx, but the AIMessage still
      // had id=undefined.  filterMessagesForLlm would then drop the ToolMessage
      // as "dangling" because its tool_call_id didn't match any safe AI tool
      // call id.  The LLM would only see the original human message and repeat
      // the same tool call, looping until maxIterations.
      //
      // With the fix, ToolExecutorNode backpatches generated IDs onto the
      // AIMessage, so the pair always matches and the LLM sees tool results.

      const mockSearchTool = createMockTool('search', () => ({
        output: 'Found 3 files matching the query.',
      }));

      subAgent.addTool(mockSearchTool);
      subAgent.setConfig({ ...defaultAgentConfig, maxIterations: 10 });

      // 1st LLM call: returns a tool call with NO id (simulates Gemini bug)
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: '',
          tool_calls: [
            {
              // id is intentionally ABSENT — this is the bug scenario
              name: 'search',
              args: { query: 'typescript files' },
              type: 'tool_call',
            },
          ],
          response_metadata: { usage: {} },
        }),
      );

      // 2nd LLM call: returns a final text response (no tool calls)
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'I found 3 TypeScript files.',
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Find TypeScript files')],
        defaultCfg,
      );

      // Must complete successfully — no max iterations error
      expect(result.error).toBeUndefined();
      expect(result.result).toBe('I found 3 TypeScript files.');

      // Exactly 2 LLM iterations: tool call + final answer
      expect(result.statistics.totalIterations).toBe(2);
      expect(result.statistics.toolCallsMade).toBe(1);

      // The tool was actually invoked
      expect(mockSearchTool.invoke).toHaveBeenCalledTimes(1);

      // The LLM was called exactly 2 times
      expect(mockLlmInvokeRef).toHaveBeenCalledTimes(2);

      // On the second LLM call, it should have received messages including
      // the ToolMessage (proving tool results were not filtered out)
      const secondCallMessages = mockLlmInvokeRef.mock
        .calls[1]![0] as BaseMessage[];
      const toolMessages = secondCallMessages.filter(
        (m) => m instanceof ToolMessage,
      );
      expect(toolMessages.length).toBe(1);
      expect(toolMessages[0]?.content).toContain('Found 3 files');
    });

    it('should pass tool results through filterMessagesForLlm when IDs are normalised', async () => {
      // Verify that filterMessagesForLlm correctly handles the normalised
      // state: AIMessage with generated_id + ToolMessage with same generated_id.

      const mockTool = createMockTool('read_file', () => ({
        output: 'file content here',
      }));

      subAgent.addTool(mockTool);
      subAgent.setConfig({ ...defaultAgentConfig, maxIterations: 10 });

      // 1st call: tool call with undefined id
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'read_file',
              args: { query: '/hello.js' },
              type: 'tool_call',
            },
          ],
          response_metadata: { usage: {} },
        }),
      );

      // Capture the messages sent to the LLM on the 2nd call
      let capturedMessages: BaseMessage[] = [];
      mockLlmInvokeRef.mockImplementationOnce((msgs: BaseMessage[]) => {
        capturedMessages = msgs;
        return Promise.resolve(
          new AIMessage({
            content: 'File content is: hello world',
            response_metadata: { usage: {} },
          }),
        );
      });

      const result = await subAgent.runSubagent(
        [new HumanMessage('Read /hello.js')],
        defaultCfg,
      );

      expect(result.error).toBeUndefined();
      expect(result.statistics.totalIterations).toBe(2);

      // Verify the messages the LLM saw on the second call pass through
      // filterMessagesForLlm without losing anything
      const filtered = filterMessagesForLlm(capturedMessages);

      // The system prompt message from InvokeLlmNode is prepended, so we
      // look for relative counts: all messages should survive filtering
      expect(filtered.length).toBe(capturedMessages.length);

      // Specifically, there should be exactly 1 ToolMessage present
      const toolMsgs = filtered.filter((m) => m instanceof ToolMessage);
      expect(toolMsgs.length).toBe(1);
      expect(toolMsgs[0]?.content).toContain('file content here');

      // And 1 AIMessage with tool_calls (the normalised one)
      const aiWithToolCalls = filtered.filter(
        (m) => m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0,
      );
      expect(aiWithToolCalls.length).toBe(1);

      // The AI tool call should now have a generated ID
      const tcId = (aiWithToolCalls[0] as AIMessage)?.tool_calls?.[0]?.id;
      expect(tcId).toBeDefined();
      expect(typeof tcId).toBe('string');
      expect(tcId!.startsWith('generated_id_')).toBe(true);

      // And the ToolMessage should reference the same ID
      const toolCallId = (toolMsgs[0] as ToolMessage).tool_call_id;
      expect(toolCallId).toBe(tcId);
    });

    it('should not loop when multiple tool calls have undefined ids', async () => {
      const mockTool1 = createMockTool('search', () => ({
        output: 'search results',
      }));
      const mockTool2 = createMockTool('read_file', () => ({
        output: 'file content',
      }));

      subAgent.addTool(mockTool1);
      subAgent.addTool(mockTool2);
      subAgent.setConfig({ ...defaultAgentConfig, maxIterations: 10 });

      // 1st call: two parallel tool calls, both with undefined ids
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: '',
          tool_calls: [
            { name: 'search', args: { query: 'ts files' }, type: 'tool_call' },
            { name: 'read_file', args: { query: '/a.ts' }, type: 'tool_call' },
          ],
          response_metadata: { usage: {} },
        }),
      );

      // 2nd call: final answer
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'Done with both tools.',
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Search and read')],
        defaultCfg,
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toBe('Done with both tools.');
      expect(result.statistics.totalIterations).toBe(2);
      expect(result.statistics.toolCallsMade).toBe(2);

      // Both tools were called
      expect(mockTool1.invoke).toHaveBeenCalledTimes(1);
      expect(mockTool2.invoke).toHaveBeenCalledTimes(1);

      // Second LLM call should include both ToolMessages
      const secondCallMessages = mockLlmInvokeRef.mock
        .calls[1]![0] as BaseMessage[];
      const toolMessages = secondCallMessages.filter(
        (m) => m instanceof ToolMessage,
      );
      expect(toolMessages.length).toBe(2);
    });

    it('should work correctly when LLM returns tool calls with proper ids (no regression)', async () => {
      // Verify that the fix doesn't break the normal case where IDs are present.

      const mockTool = createMockTool('search', () => ({
        output: 'results found',
      }));

      subAgent.addTool(mockTool);
      subAgent.setConfig({ ...defaultAgentConfig, maxIterations: 10 });

      // 1st call: tool call WITH a proper id
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'call_abc123',
              name: 'search',
              args: { query: 'test' },
              type: 'tool_call',
            },
          ],
          response_metadata: { usage: {} },
        }),
      );

      // 2nd call: final answer
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'Search completed successfully.',
          response_metadata: { usage: {} },
        }),
      );

      const result = await subAgent.runSubagent(
        [new HumanMessage('Search for test')],
        defaultCfg,
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toBe('Search completed successfully.');
      expect(result.statistics.totalIterations).toBe(2);
      expect(result.statistics.toolCallsMade).toBe(1);

      // The ToolMessage should reference the original id (not a generated one)
      const secondCallMessages = mockLlmInvokeRef.mock
        .calls[1]![0] as BaseMessage[];
      const toolMessages = secondCallMessages.filter(
        (m) => m instanceof ToolMessage,
      );
      expect(toolMessages.length).toBe(1);
      expect((toolMessages[0] as ToolMessage).tool_call_id).toBe('call_abc123');
    });
  });

  describe('cost limit enforcement', () => {
    it('returns stopReason="cost_limit" when CostLimitExceededError is thrown during the sub-agent run', async () => {
      // Sub-agents now enforce cost limits themselves and surface the stop
      // reason so the parent agent can propagate it rather than only catching
      // it on the next parent LLM call.
      const costError = new CostLimitExceededError(1.0, 2.5);
      mockLlmInvokeRef.mockRejectedValueOnce(costError);

      const cfgWithLimit: ToolRunnableConfig<BaseAgentConfigurable> = {
        configurable: {
          thread_id: 'thread-123',
          effective_cost_limit_usd: 1.0,
        },
      };

      const result = await subAgent.runSubagent(
        [new HumanMessage('hi')],
        cfgWithLimit,
      );

      // Must NOT re-throw — the sub-agent catches the error gracefully.
      expect(result.stopReason).toBe('cost_limit');
      expect(result.stopCostUsd).toBe(2.5);
      expect(result.error).toBe('Cost limit reached');
      expect(result.result).toContain('cost limit');
      expect(result.statistics.totalIterations).toBe(0);
    });

    it('does not set stopReason when run completes normally within budget', async () => {
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'done within budget',
          response_metadata: { usage: {} },
        }),
      );

      const cfgWithLimit: ToolRunnableConfig<BaseAgentConfigurable> = {
        configurable: {
          thread_id: 'thread-123',
          effective_cost_limit_usd: 100.0,
        },
      };

      const result = await subAgent.runSubagent(
        [new HumanMessage('hi')],
        cfgWithLimit,
      );

      expect(result.stopReason).toBeUndefined();
      expect(result.error).toBeUndefined();
      expect(result.result).toBe('done within budget');
    });
  });

  describe('reasoning streaming', () => {
    // Helpers for directly invoking private methods on SubAgent
    type SubAgentPrivate = {
      handleReasoningChunk: (
        chunk: AIMessageChunk,
        entries: Map<string, ChatMessage>,
        emitContext: {
          threadId: string;
          toolCallId: string | undefined;
          sourceAgentNodeId: string | undefined;
          modelName: string;
          runnableConfig: RunnableConfig<BaseAgentConfigurable>;
        },
      ) => void;
      flushReasoningEntries: (
        entries: Map<string, ChatMessage>,
        emitContext: {
          threadId: string;
          toolCallId: string | undefined;
          sourceAgentNodeId: string | undefined;
          modelName: string;
          runnableConfig: RunnableConfig<BaseAgentConfigurable>;
        },
      ) => void;
    };

    function makeChunk(id: string, reasoning: string): AIMessageChunk {
      return {
        id,
        contentBlocks: [{ type: 'reasoning', reasoning }],
        response_metadata: {},
      } as unknown as AIMessageChunk;
    }

    function makeEmitContext(overrides?: {
      toolCallId?: string;
      sourceAgentNodeId?: string;
      modelName?: string;
    }): {
      threadId: string;
      toolCallId: string | undefined;
      sourceAgentNodeId: string | undefined;
      modelName: string;
      runnableConfig: RunnableConfig<BaseAgentConfigurable>;
    } {
      return {
        threadId: 'thread-test',
        toolCallId: overrides?.toolCallId,
        sourceAgentNodeId: overrides?.sourceAgentNodeId,
        modelName: overrides?.modelName ?? 'claude-opus-4',
        runnableConfig: { configurable: { thread_id: 'thread-test' } },
      };
    }

    function collectMessageEvents(agent: SubAgent): AgentEventType[] {
      const events: AgentEventType[] = [];
      agent.subscribe(async (event) => {
        if (event.type === 'message') {
          events.push(event);
        }
      });
      return events;
    }

    it('accumulates two chunks with the same id into one emitted message', () => {
      const priv = subAgent as unknown as SubAgentPrivate;
      const entries = new Map<string, ChatMessage>();
      const emitContext = makeEmitContext({ toolCallId: 'tc-1' });
      const events = collectMessageEvents(subAgent);

      const chunk1 = makeChunk('p1', 'hello ');
      const chunk2 = makeChunk('p1', 'world');

      priv.handleReasoningChunk(chunk1, entries, emitContext);
      priv.handleReasoningChunk(chunk2, entries, emitContext);

      // No emit yet — flushed only on id-change or explicit flush
      expect(events).toHaveLength(0);
      expect(entries.size).toBe(1);

      priv.flushReasoningEntries(entries, emitContext);

      expect(events).toHaveLength(1);
      const emittedMsgs = (
        events[0] as Extract<AgentEventType, { type: 'message' }>
      ).data.messages;
      expect(emittedMsgs).toHaveLength(1);
      expect(emittedMsgs[0]?.id).toBe('reasoning:p1');
      expect(emittedMsgs[0]?.content).toBe('hello world');
      expect(entries.size).toBe(0);
    });

    it('emits two separate messages for two distinct chunk ids', () => {
      const priv = subAgent as unknown as SubAgentPrivate;
      const entries = new Map<string, ChatMessage>();
      const emitContext = makeEmitContext();
      const events = collectMessageEvents(subAgent);

      const chunkA = makeChunk('a', 'reasoning-a');
      const chunkB = makeChunk('b', 'reasoning-b');

      // chunk A — stored
      priv.handleReasoningChunk(chunkA, entries, emitContext);
      // chunk B — different id triggers flush of A, then stores B
      priv.handleReasoningChunk(chunkB, entries, emitContext);
      // explicit flush for B
      priv.flushReasoningEntries(entries, emitContext);

      expect(events).toHaveLength(2);
      const firstMsg = (
        events[0] as Extract<AgentEventType, { type: 'message' }>
      ).data.messages[0];
      const secondMsg = (
        events[1] as Extract<AgentEventType, { type: 'message' }>
      ).data.messages[0];

      expect(firstMsg?.id).toBe('reasoning:a');
      expect(firstMsg?.content).toBe('reasoning-a');
      expect(secondMsg?.id).toBe('reasoning:b');
      expect(secondMsg?.content).toBe('reasoning-b');
    });

    it('tags emitted reasoning with __subagentCommunication, __toolCallId, __sourceAgentNodeId, __model', () => {
      const priv = subAgent as unknown as SubAgentPrivate;
      const entries = new Map<string, ChatMessage>();
      const emitContext = makeEmitContext({
        toolCallId: 'tc-parent',
        sourceAgentNodeId: 'node-parent',
        modelName: 'claude-opus-4',
      });
      const events = collectMessageEvents(subAgent);

      priv.handleReasoningChunk(
        makeChunk('x1', 'reasoning text'),
        entries,
        emitContext,
      );
      priv.flushReasoningEntries(entries, emitContext);

      expect(events).toHaveLength(1);
      const msg = (events[0] as Extract<AgentEventType, { type: 'message' }>)
        .data.messages[0];
      const kwargs = msg?.additional_kwargs ?? {};

      expect(kwargs['__subagentCommunication']).toBe(true);
      expect(kwargs['__toolCallId']).toBe('tc-parent');
      expect(kwargs['__sourceAgentNodeId']).toBe('node-parent');
      expect(kwargs['__model']).toBe('claude-opus-4');
    });

    it('skips undefined tags from additional_kwargs when emitContext fields are undefined', () => {
      const priv = subAgent as unknown as SubAgentPrivate;
      const entries = new Map<string, ChatMessage>();
      const emitContext = makeEmitContext({
        toolCallId: undefined,
        sourceAgentNodeId: undefined,
        modelName: 'claude-opus-4',
      });
      const events = collectMessageEvents(subAgent);

      priv.handleReasoningChunk(
        makeChunk('x2', 'some reasoning'),
        entries,
        emitContext,
      );
      priv.flushReasoningEntries(entries, emitContext);

      expect(events).toHaveLength(1);
      const msg = (events[0] as Extract<AgentEventType, { type: 'message' }>)
        .data.messages[0];
      const kwargs = msg?.additional_kwargs ?? {};

      expect(kwargs['__subagentCommunication']).toBe(true);
      expect(kwargs['__model']).toBe('claude-opus-4');
      // Keys must not be present at all (not even as undefined)
      expect(Object.prototype.hasOwnProperty.call(kwargs, '__toolCallId')).toBe(
        false,
      );
      expect(
        Object.prototype.hasOwnProperty.call(kwargs, '__sourceAgentNodeId'),
      ).toBe(false);
    });

    it('is a no-op when chunk has no reasoning text', () => {
      const priv = subAgent as unknown as SubAgentPrivate;
      const entries = new Map<string, ChatMessage>();
      const emitContext = makeEmitContext();
      const events = collectMessageEvents(subAgent);

      const textOnlyChunk = {
        id: 'c1',
        contentBlocks: [{ type: 'text', text: 'hi' }],
        response_metadata: {},
      } as unknown as AIMessageChunk;

      priv.handleReasoningChunk(textOnlyChunk, entries, emitContext);

      expect(entries.size).toBe(0);
      expect(events).toHaveLength(0);
    });

    it('is a no-op when chunk has no id', () => {
      const priv = subAgent as unknown as SubAgentPrivate;
      const entries = new Map<string, ChatMessage>();
      const emitContext = makeEmitContext();
      const events = collectMessageEvents(subAgent);

      const noIdChunk = {
        // id is deliberately absent
        contentBlocks: [{ type: 'reasoning', reasoning: 'some reasoning' }],
        response_metadata: {},
      } as unknown as AIMessageChunk;

      priv.handleReasoningChunk(noIdChunk, entries, emitContext);

      expect(entries.size).toBe(0);
      expect(events).toHaveLength(0);
    });

    it('flushReasoningEntries is a no-op on empty map', () => {
      const priv = subAgent as unknown as SubAgentPrivate;
      const events = collectMessageEvents(subAgent);

      priv.flushReasoningEntries(new Map(), makeEmitContext());

      expect(events).toHaveLength(0);
    });

    it('strips reasoning content blocks from the bundled AIMessage before emitting', async () => {
      // Mock returns an AIMessage with both text and reasoning content blocks.
      // After runSubagent, no emitted bundled message should contain reasoning blocks.
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: [
            { type: 'text', text: 'the answer' },
            { type: 'reasoning', reasoning: 'should-be-stripped' },
          ] as unknown as string,
          response_metadata: { usage: {} },
        }),
      );

      const collectedEvents: AgentEventType[] = [];
      subAgent.subscribe(async (event) => {
        collectedEvents.push(event);
      });

      await subAgent.runSubagent([new HumanMessage('Do work')], defaultCfg);

      const messageEvents = collectedEvents.filter(
        (e): e is Extract<AgentEventType, { type: 'message' }> =>
          e.type === 'message',
      );

      // At least one message event must have been emitted (the bundled AI message)
      expect(messageEvents.length).toBeGreaterThan(0);

      // Collect all content blocks across all emitted message arrays
      const allContentBlocks = messageEvents.flatMap((e) =>
        e.data.messages.flatMap((msg) => {
          const c = msg.content;
          return Array.isArray(c) ? (c as { type?: unknown }[]) : [];
        }),
      );

      // No reasoning block should survive in any bundled message
      const reasoningBlocks = allContentBlocks.filter(
        (b) => b && b.type === 'reasoning',
      );
      expect(reasoningBlocks).toHaveLength(0);

      // Text blocks must still be present
      const textBlocks = allContentBlocks.filter(
        (b) => b && (b.type === 'text' || b.type === 'output_text'),
      );
      expect(textBlocks.length).toBeGreaterThan(0);
    });

    it('flushReasoningEntries emits all entries and clears the map (snapshot-then-clear guarantee)', () => {
      const entries = new Map<string, ChatMessage>();
      const emitContext = makeEmitContext();
      const events = collectMessageEvents(subAgent);

      (subAgent as unknown as SubAgentPrivate).handleReasoningChunk(
        makeChunk('p1', 'partial reasoning'),
        entries,
        emitContext,
      );
      expect(entries.size).toBe(1);

      // Act: flushReasoningEntries must emit the accumulated entry and clear the map.
      (subAgent as unknown as SubAgentPrivate).flushReasoningEntries(
        entries,
        emitContext,
      );

      // The entry was emitted as a message event and the map is empty (snapshot-then-clear:
      // even if emit had thrown, the map would still be cleared).
      expect(events).toHaveLength(1);
      expect(entries.size).toBe(0);
    });

    it('clears the entries Map even when a subscriber throws during emit', () => {
      const entries = new Map<string, ChatMessage>();
      const emitContext = makeEmitContext();

      (subAgent as unknown as SubAgentPrivate).handleReasoningChunk(
        makeChunk('p1', 'reasoning text'),
        entries,
        emitContext,
      );
      expect(entries.size).toBe(1);

      // Attach a subscriber that throws.  The snapshot-then-clear fix means the
      // Map MUST be cleared before the throw propagates so subsequent flush calls
      // won't re-emit the same entries (the duplicate-emit risk SEC-H1 identified).
      subAgent.subscribe(() => {
        throw new Error('subscriber failure');
      });

      expect(() =>
        (subAgent as unknown as SubAgentPrivate).flushReasoningEntries(
          entries,
          emitContext,
        ),
      ).toThrow('subscriber failure');

      // Critical assertion: map was cleared before the throw.
      expect(entries.size).toBe(0);
    });

    it('finally block is present in runSubagent (code-integrity smoke test)', () => {
      // Guards against accidental removal of the finally flush during refactors.
      expect(SubAgent.prototype.runSubagent.toString()).toMatch(/finally/);
    });

    // Per-block-id accumulation: regression tests for OpenAI Responses API
    // where chunk.id changes on every streaming chunk but contentBlocks[].id
    // is stable across chunks for the same reasoning block.

    it('accumulates chunks with different chunk.id but same contentBlock.id into one message', () => {
      const priv = subAgent as unknown as SubAgentPrivate;
      const entries = new Map<string, ChatMessage>();
      const emitContext = makeEmitContext({ toolCallId: 'tc-1' });
      const events = collectMessageEvents(subAgent);

      // Simulate OpenAI Responses API: chunk.id changes on every token,
      // but the reasoning block inside carries a stable blockId.
      const stableBlockId = 'block-stable-001';
      const chunk1 = {
        id: 'chunk-token-001',
        contentBlocks: [
          { type: 'reasoning', reasoning: 'It seems ', id: stableBlockId },
        ],
        response_metadata: {},
      } as unknown as AIMessageChunk;
      const chunk2 = {
        id: 'chunk-token-002',
        contentBlocks: [
          { type: 'reasoning', reasoning: 'like a ', id: stableBlockId },
        ],
        response_metadata: {},
      } as unknown as AIMessageChunk;
      const chunk3 = {
        id: 'chunk-token-003',
        contentBlocks: [
          { type: 'reasoning', reasoning: 'good plan.', id: stableBlockId },
        ],
        response_metadata: {},
      } as unknown as AIMessageChunk;

      priv.handleReasoningChunk(chunk1, entries, emitContext);
      priv.handleReasoningChunk(chunk2, entries, emitContext);
      priv.handleReasoningChunk(chunk3, entries, emitContext);

      // No flush yet — all three tokens share the same blockId
      expect(events).toHaveLength(0);
      expect(entries.size).toBe(1);

      priv.flushReasoningEntries(entries, emitContext);

      expect(events).toHaveLength(1);
      const emittedMsgs = (
        events[0] as Extract<AgentEventType, { type: 'message' }>
      ).data.messages;
      expect(emittedMsgs).toHaveLength(1);
      // id is keyed on the stable blockId, not the per-token chunk.id
      expect(emittedMsgs[0]?.id).toBe(`reasoning:${stableBlockId}`);
      expect(emittedMsgs[0]?.content).toBe('It seems like a good plan.');
      expect(entries.size).toBe(0);
    });

    it('falls back to chunk.id when contentBlock carries no id (backward compat)', () => {
      const priv = subAgent as unknown as SubAgentPrivate;
      const entries = new Map<string, ChatMessage>();
      const emitContext = makeEmitContext();
      const events = collectMessageEvents(subAgent);

      // Block with no id — uses chunk.id as fallback
      const chunk = {
        id: 'chunk-fallback',
        contentBlocks: [{ type: 'reasoning', reasoning: 'fallback text' }],
        response_metadata: {},
      } as unknown as AIMessageChunk;

      priv.handleReasoningChunk(chunk, entries, emitContext);
      priv.flushReasoningEntries(entries, emitContext);

      expect(events).toHaveLength(1);
      const msg = (events[0] as Extract<AgentEventType, { type: 'message' }>)
        .data.messages[0];
      expect(msg?.id).toBe('reasoning:chunk-fallback');
      expect(msg?.content).toBe('fallback text');
    });

    it('two different stable blockIds in sequence produce two separate messages', () => {
      const priv = subAgent as unknown as SubAgentPrivate;
      const entries = new Map<string, ChatMessage>();
      const emitContext = makeEmitContext();
      const events = collectMessageEvents(subAgent);

      const chunkA1 = {
        id: 'c-token-1',
        contentBlocks: [
          { type: 'reasoning', reasoning: 'block-A part 1 ', id: 'block-A' },
        ],
        response_metadata: {},
      } as unknown as AIMessageChunk;
      const chunkA2 = {
        id: 'c-token-2',
        contentBlocks: [
          { type: 'reasoning', reasoning: 'block-A part 2', id: 'block-A' },
        ],
        response_metadata: {},
      } as unknown as AIMessageChunk;
      const chunkB1 = {
        id: 'c-token-3',
        contentBlocks: [
          { type: 'reasoning', reasoning: 'block-B text', id: 'block-B' },
        ],
        response_metadata: {},
      } as unknown as AIMessageChunk;

      priv.handleReasoningChunk(chunkA1, entries, emitContext);
      priv.handleReasoningChunk(chunkA2, entries, emitContext);
      // block-B triggers flush of block-A
      priv.handleReasoningChunk(chunkB1, entries, emitContext);
      priv.flushReasoningEntries(entries, emitContext);

      expect(events).toHaveLength(2);
      const msgA = (events[0] as Extract<AgentEventType, { type: 'message' }>)
        .data.messages[0];
      const msgB = (events[1] as Extract<AgentEventType, { type: 'message' }>)
        .data.messages[0];
      expect(msgA?.id).toBe('reasoning:block-A');
      expect(msgA?.content).toBe('block-A part 1 block-A part 2');
      expect(msgB?.id).toBe('reasoning:block-B');
      expect(msgB?.content).toBe('block-B text');
    });

    // Strip-guard tests for the AIMessage clone path (Part 2 of the fix)

    it('does not emit a clone when AIMessage content is only reasoning blocks', async () => {
      // An AIMessage that contains ONLY reasoning blocks (no text) should be
      // dropped from the clone-emit path entirely. The reasoning was already
      // emitted as per-id ChatMessages via the messages stream.
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: [
            { type: 'reasoning', reasoning: 'pure reasoning, no text' },
          ] as unknown as string,
          response_metadata: { usage: {} },
        }),
      );

      const collectedEvents: AgentEventType[] = [];
      subAgent.subscribe(async (event) => {
        collectedEvents.push(event);
      });

      await subAgent.runSubagent([new HumanMessage('Think only')], defaultCfg);

      const messageEvents = collectedEvents.filter(
        (e): e is Extract<AgentEventType, { type: 'message' }> =>
          e.type === 'message',
      );

      // There must be no bundled AIMessage clone emitted with empty content.
      // (No text content was present, so the clone is dropped.)
      const emptyArrayContentMessages = messageEvents.flatMap((e) =>
        e.data.messages.filter((msg) => {
          const c = msg.content;
          return Array.isArray(c) && (c as unknown[]).length === 0;
        }),
      );
      expect(emptyArrayContentMessages).toHaveLength(0);
    });

    it('emits a clone unchanged when AIMessage has text content but no reasoning blocks', async () => {
      // An AIMessage with only text content should be emitted as-is, with the
      // content array reference not needlessly replaced.
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: [
            { type: 'text', text: 'plain answer' },
          ] as unknown as string,
          response_metadata: { usage: {} },
        }),
      );

      const collectedEvents: AgentEventType[] = [];
      subAgent.subscribe(async (event) => {
        collectedEvents.push(event);
      });

      await subAgent.runSubagent([new HumanMessage('Answer')], defaultCfg);

      const messageEvents = collectedEvents.filter(
        (e): e is Extract<AgentEventType, { type: 'message' }> =>
          e.type === 'message',
      );

      // At least one bundled message event should have text content
      const textBlockMessages = messageEvents.flatMap((e) =>
        e.data.messages.flatMap((msg) => {
          const c = msg.content;
          return Array.isArray(c)
            ? (c as { type?: unknown; text?: unknown }[]).filter(
                (b) => b.type === 'text' || b.type === 'output_text',
              )
            : [];
        }),
      );
      expect(textBlockMessages.length).toBeGreaterThan(0);

      // No reasoning blocks should appear in any clone
      const reasoningBlocks = messageEvents.flatMap((e) =>
        e.data.messages.flatMap((msg) => {
          const c = msg.content;
          return Array.isArray(c)
            ? (c as { type?: unknown }[]).filter((b) => b.type === 'reasoning')
            : [];
        }),
      );
      expect(reasoningBlocks).toHaveLength(0);
    });

    // Part 3: cloneMessageForEmit must return null for standalone ChatMessage(role='reasoning').
    // Such messages are produced by InvokeLlmNode and were already persisted via
    // the messages-mode flush path; emitting them again would double-persist reasoning.
    it('does not emit a standalone ChatMessage(role=reasoning) via the clone path', async () => {
      // An AIMessage (the text response) alongside a standalone reasoning ChatMessage.
      // The clone path must drop the ChatMessage(role='reasoning') entirely.
      mockLlmInvokeRef.mockResolvedValueOnce(
        new AIMessage({
          content: 'final answer',
          response_metadata: { usage: {} },
        }),
      );

      // Inject a standalone ChatMessage(role='reasoning') into the graph state by
      // calling cloneMessageForEmit directly.
      type SubAgentPrivateClone = {
        cloneMessageForEmit: (msg: BaseMessage) => BaseMessage | null;
      };

      const priv = subAgent as unknown as SubAgentPrivateClone;

      const reasoningMsg = new ChatMessage(
        'internal reasoning step',
        'reasoning',
      );
      const result = priv.cloneMessageForEmit(reasoningMsg);

      // Must be null — reasoning ChatMessages are not forwarded to the parent.
      expect(result).toBeNull();
    });

    // Part 2: LangGraph JS leaks messages-mode events from nested compiled.stream()
    // calls into the parent subagent's stream. The guard rejects leaked chunks that
    // arrive after the parent's own updates/invoke_llm event has fired.
    it('should ignore leaked invoke_llm messages-mode chunks that arrive after the parent invoke_llm updates event', async () => {
      const parentChunk = {
        id: 'resp_parent-P1',
        contentBlocks: [
          { type: 'reasoning', reasoning: 'parent reasoning P1' },
        ],
        response_metadata: {},
      } as unknown as AIMessageChunk;

      const leakedChunk = {
        id: 'resp_leaked-L1',
        contentBlocks: [{ type: 'reasoning', reasoning: 'leaked subagent' }],
        response_metadata: {},
      } as unknown as AIMessageChunk;

      async function* leakStream() {
        // (a) Parent reasoning chunk arrives before updates/invoke_llm
        yield [
          'messages',
          [parentChunk, { langgraph_node: 'invoke_llm' }],
        ] as const;

        // (b) updates/invoke_llm fires — marks the boundary
        yield [
          'updates',
          { invoke_llm: { messages: { mode: 'append', items: [] } } },
        ] as const;

        // (c) Leaked subagent chunk arrives after updates/invoke_llm
        yield [
          'messages',
          [leakedChunk, { langgraph_node: 'invoke_llm' }],
        ] as const;
      }

      // Route compiled.stream() to our controlled sequence for this test only.
      mockCompiledStreamRef.current = leakStream();

      const collectedEvents: AgentEventType[] = [];
      subAgent.subscribe(async (event) => {
        collectedEvents.push(event);
      });

      // runSubagent will hit the stream and then try to read finalState.messages.
      // Our mock stream doesn't produce an AIMessage in state, so the result
      // will fall back to 'Task completed.' — that is fine for this test.
      await subAgent.runSubagent(
        [new HumanMessage('test leak guard')],
        defaultCfg,
      );

      // Reset mock stream so subsequent tests use the real graph.
      mockCompiledStreamRef.current = null;

      const reasoningEvents = collectedEvents
        .filter(
          (e): e is Extract<AgentEventType, { type: 'message' }> =>
            e.type === 'message',
        )
        .flatMap((e) =>
          e.data.messages.filter(
            (m) =>
              (m as unknown as { role?: unknown }).role === 'reasoning' ||
              m.type === 'reasoning',
          ),
        );

      // Only the parent's chunk (P1) must be persisted; the leaked chunk must be dropped.
      expect(reasoningEvents).toHaveLength(1);
      const content =
        typeof reasoningEvents[0]?.content === 'string'
          ? reasoningEvents[0].content
          : '';
      expect(content).toBe('parent reasoning P1');
      expect(reasoningEvents[0]?.id).toBe('reasoning:resp_parent-P1');
    });
  });
});
