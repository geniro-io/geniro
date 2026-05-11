import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';

import type { LitellmService } from '../../../litellm/services/litellm.service';
import { CostLimitExceededError } from '../../agents.errors';
import { BaseAgentState } from '../../agents.types';
import { ToolExecutorNode } from './tool-executor-node';

describe('ToolExecutorNode', () => {
  let node: ToolExecutorNode;
  let mockTool1: DynamicStructuredTool;
  let mockTool2: DynamicStructuredTool;
  let mockFinishTool: DynamicStructuredTool;
  let mockLitellmService: LitellmService;

  beforeEach(() => {
    mockTool1 = {
      name: 'test-tool-1',
      description: 'Test tool 1',
      invoke: vi.fn(),
    } as unknown as DynamicStructuredTool;

    mockTool2 = {
      name: 'test-tool-2',
      description: 'Test tool 2',
      invoke: vi.fn(),
    } as unknown as DynamicStructuredTool;

    mockFinishTool = {
      name: 'finish',
      description: 'Finish tool',
      invoke: vi.fn(),
    } as unknown as DynamicStructuredTool;

    mockLitellmService = {
      sumTokenUsages: vi.fn().mockReturnValue(null),
    } as unknown as LitellmService;

    node = new ToolExecutorNode(
      [mockTool1, mockTool2, mockFinishTool],
      mockLitellmService,
    );
  });

  describe('constructor', () => {
    it('should initialize with tools', () => {
      expect(node['tools']).toHaveLength(3);
      expect(node['tools']).toContain(mockTool1);
      expect(node['tools']).toContain(mockTool2);
      expect(node['tools']).toContain(mockFinishTool);
    });

    it('should default maxOutputChars to 500000', () => {
      expect(node['maxOutputChars']).toBe(500_000);
    });

    it('should initialize with empty tools array', () => {
      const emptyNode = new ToolExecutorNode([], mockLitellmService);
      expect(emptyNode['tools']).toHaveLength(0);
    });
  });

  describe('invoke', () => {
    let mockState: BaseAgentState;
    let mockConfig: Record<string, unknown>;

    beforeEach(() => {
      mockState = {
        messages: [],
        summary: '',
        toolUsageGuardActivated: false,
        toolsMetadata: {},
        toolUsageGuardActivatedCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        totalPrice: 0,
        currentContext: 0,
      };

      mockConfig = {
        configurable: {
          thread_id: 'test-thread',
        },
      };
    });

    it('should execute tool calls from AI message', async () => {
      const toolCall = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { input: 'test input' },
      };

      const aiMessage = new AIMessage({
        content: 'I will use the tool',
        tool_calls: [toolCall],
      });

      mockState.messages = [aiMessage];
      mockTool1.invoke = vi.fn().mockResolvedValue({ output: 'Tool result 1' });

      const result = await node.invoke(mockState, mockConfig);

      expect(mockTool1.invoke).toHaveBeenCalledWith(
        { input: 'test input' },
        {
          configurable: {
            ...(mockConfig.configurable as Record<string, unknown>),
            __toolCallId: 'call-1',
          },
          signal: undefined,
        },
      );

      expect(result.messages?.items).toHaveLength(1);
      expect(result.messages?.items[0]).toBeInstanceOf(ToolMessage);
      expect(result.messages?.items[0]?.content).toBe('Tool result 1');
      expect((result.messages?.items[0] as ToolMessage)?.tool_call_id).toBe(
        'call-1',
      );
    });

    it('should execute multiple tool calls', async () => {
      const toolCall1 = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { input: 'input 1' },
      };

      const toolCall2 = {
        id: 'call-2',
        name: 'test-tool-2',
        args: { input: 'input 2' },
      };

      const aiMessage = new AIMessage({
        content: 'I will use multiple tools',
        tool_calls: [toolCall1, toolCall2],
      });

      mockState.messages = [aiMessage];
      mockTool1.invoke = vi.fn().mockResolvedValue({ output: 'Result 1' });
      mockTool2.invoke = vi.fn().mockResolvedValue({ output: 'Result 2' });

      const result = await node.invoke(mockState, mockConfig);

      expect(mockTool1.invoke).toHaveBeenCalledWith(
        { input: 'input 1' },
        {
          configurable: {
            ...(mockConfig.configurable as Record<string, unknown>),
            __toolCallId: 'call-1',
          },
          signal: undefined,
        },
      );
      expect(mockTool2.invoke).toHaveBeenCalledWith(
        { input: 'input 2' },
        {
          configurable: {
            ...(mockConfig.configurable as Record<string, unknown>),
            __toolCallId: 'call-2',
          },
          signal: undefined,
        },
      );

      expect(result.messages?.items).toHaveLength(2);
      expect(result.messages?.items?.[0]?.content).toBe('Result 1');
      expect(result.messages?.items?.[1]?.content).toBe('Result 2');
    });

    it('should handle tool not found error', async () => {
      const toolCall = {
        id: 'call-1',
        name: 'non-existent-tool',
        args: { input: 'test' },
      };

      const aiMessage = new AIMessage({
        content: 'Using unknown tool',
        tool_calls: [toolCall],
      });

      mockState.messages = [aiMessage];

      const result = await node.invoke(mockState, mockConfig);

      expect(result.messages?.items).toHaveLength(1);
      expect(result.messages?.items[0]).toBeInstanceOf(ToolMessage);
      expect(result.messages?.items?.[0]?.content).toContain(
        "Tool 'non-existent-tool' not found",
      );
      expect((result.messages?.items[0] as ToolMessage).tool_call_id).toBe(
        'call-1',
      );
    });

    it('should handle tool execution errors', async () => {
      const toolCall = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { input: 'test' },
      };

      const aiMessage = new AIMessage({
        content: 'Using tool that will fail',
        tool_calls: [toolCall],
      });

      mockState.messages = [aiMessage];
      const mockError = new Error('Tool execution failed');
      mockTool1.invoke = vi.fn().mockRejectedValue(mockError);

      const result = await node.invoke(mockState, mockConfig);

      expect(result.messages?.items).toHaveLength(1);
      expect(result.messages?.items[0]).toBeInstanceOf(ToolMessage);
      expect(result.messages?.items?.[0]?.content).toContain(
        "Error executing tool 'test-tool-1'",
      );
      expect(result.messages?.items?.[0]?.content).toContain(
        'Tool execution failed',
      );
    });

    it('should return empty messages when no tool calls', async () => {
      const aiMessage = new AIMessage({
        content: 'No tools used',
        tool_calls: [],
      });

      mockState.messages = [aiMessage];

      const result = await node.invoke(mockState, mockConfig);

      expect(result.messages?.items).toHaveLength(0);
    });

    it('should handle undefined tool calls', async () => {
      const aiMessage = new AIMessage({
        content: 'No tools used',
        // tool_calls is undefined
      });

      mockState.messages = [aiMessage];

      const result = await node.invoke(mockState, mockConfig);

      expect(result.messages?.items).toHaveLength(0);
    });

    it('should normalise undefined tool call ids so ToolMessages match AIMessage', async () => {
      // Reproduces the subagent infinite-loop bug: some providers (e.g. Gemini
      // via LiteLLM) return tool_calls with undefined ids.  ToolExecutorNode
      // must backpatch generated ids onto the AIMessage so filterMessagesForLlm
      // can pair them with the resulting ToolMessages.
      const toolCall = {
        // id is intentionally absent / undefined
        name: 'test-tool-1',
        args: { input: 'test' },
      };

      const aiMessage = new AIMessage({
        content: 'Using tool',
        tool_calls: [toolCall],
      });

      mockState.messages = [aiMessage];
      mockTool1.invoke = vi.fn().mockResolvedValue({ output: 'result' });

      const result = await node.invoke(mockState, mockConfig);

      // After invoke, the AIMessage's tool_calls should have a generated id
      const patchedId = aiMessage.tool_calls?.[0]?.id;
      expect(patchedId).toBeDefined();
      expect(typeof patchedId).toBe('string');
      expect(patchedId!.startsWith('generated_id_')).toBe(true);

      // And the ToolMessage must use the same id
      const toolMsg = result.messages?.items?.[0] as ToolMessage;
      expect(toolMsg).toBeInstanceOf(ToolMessage);
      expect(toolMsg.tool_call_id).toBe(patchedId);
    });

    it('should handle non-AI messages gracefully', async () => {
      const humanMessage = new HumanMessage('Hello');
      mockState.messages = [humanMessage];

      const result = await node.invoke(mockState, mockConfig);

      expect(result.messages?.items).toHaveLength(0);
    });

    it('should handle mixed message types', async () => {
      const toolCall = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { input: 'test' },
      };

      const humanMessage = new HumanMessage('Hello');
      const aiMessage = new AIMessage({
        content: 'Using tool',
        tool_calls: [toolCall],
      });

      mockState.messages = [humanMessage, aiMessage];
      mockTool1.invoke = vi.fn().mockResolvedValue({ output: 'Tool result' });

      const result = await node.invoke(mockState, mockConfig);

      expect(result.messages?.items).toHaveLength(1);
      expect(result.messages?.items?.[0]?.content).toBe('Tool result');
    });

    it('should serialize tool results correctly', async () => {
      const toolCall = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { input: 'test' },
      };

      const aiMessage = new AIMessage({
        content: 'Using tool',
        tool_calls: [toolCall],
      });

      mockState.messages = [aiMessage];

      // Return complex object that needs serialization
      const complexResult = {
        data: { nested: 'value' },
        array: [1, 2, 3],
        boolean: true,
      };
      mockTool1.invoke = vi.fn().mockResolvedValue({ output: complexResult });

      const result = await node.invoke(mockState, mockConfig);

      expect(result.messages?.items).toHaveLength(1);
      expect(result.messages?.items?.[0]?.content).toBe(
        stringifyYaml(complexResult).trimEnd(),
      );
    });

    it('should convert JSON string tool results to YAML', async () => {
      const toolCall = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { input: 'test' },
      };

      const aiMessage = new AIMessage({
        content: 'Using tool',
        tool_calls: [toolCall],
      });

      mockState.messages = [aiMessage];

      const jsonString = JSON.stringify({
        data: { nested: 'value' },
        array: [1, 2, 3],
        boolean: true,
      });
      mockTool1.invoke = vi.fn().mockResolvedValue({ output: jsonString });

      const result = await node.invoke(mockState, mockConfig);

      expect(result.messages?.items).toHaveLength(1);
      expect(result.messages?.items?.[0]?.content).toBe(
        stringifyYaml(JSON.parse(jsonString)).trimEnd(),
      );
    });

    it('should trim tool output that exceeds maxOutputChars and append suffix', async () => {
      const limitedNode = new ToolExecutorNode(
        [mockTool1],
        mockLitellmService,
        {
          maxOutputChars: 10,
        },
      );

      const toolCall = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { input: 'test' },
      };

      const aiMessage = new AIMessage({
        content: 'Using tool',
        tool_calls: [toolCall],
      });

      mockState.messages = [aiMessage];
      const longOutput = 'a'.repeat(12);
      mockTool1.invoke = vi.fn().mockResolvedValue({ output: longOutput });

      const result = await limitedNode.invoke(mockState, mockConfig);
      const expectedSuffix = '\n\n[output trimmed to 10 characters from 12]';

      expect(result.messages?.items).toHaveLength(1);
      expect(result.messages?.items?.[0]?.content).toBe(
        `${longOutput.slice(0, 10)}${expectedSuffix}`,
      );
    });

    it('should handle string tool results', async () => {
      const toolCall = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { input: 'test' },
      };

      const aiMessage = new AIMessage({
        content: 'Using tool',
        tool_calls: [toolCall],
      });

      mockState.messages = [aiMessage];
      mockTool1.invoke = vi.fn().mockResolvedValue({
        output: 'Simple string result',
      });

      const result = await node.invoke(mockState, mockConfig);

      expect(result.messages?.items).toHaveLength(1);
      expect(result.messages?.items?.[0]?.content).toBe('Simple string result');
    });

    it('should pass correct config to tools', async () => {
      const toolCall = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { input: 'test' },
      };

      const aiMessage = new AIMessage({
        content: 'Using tool',
        tool_calls: [toolCall],
      });

      const customConfig = {
        configurable: {
          thread_id: 'custom-thread',
          custom_param: 'value',
        },
        recursionLimit: 100,
      };

      mockState.messages = [aiMessage];
      mockTool1.invoke = vi.fn().mockResolvedValue({ output: 'result' });

      await node.invoke(mockState, customConfig);

      expect(mockTool1.invoke).toHaveBeenCalledWith(
        { input: 'test' },
        {
          configurable: {
            ...customConfig.configurable,
            __toolCallId: 'call-1',
          },
          signal: undefined,
        },
      );
    });

    it('should persist finish stateChange', async () => {
      const toolCall = {
        id: 'call-1',
        name: 'finish',
        args: {
          purpose: 'Completing the task',
          message: 'Task completed successfully',
        },
      };

      const aiMessage = new AIMessage({
        content: 'Finishing task',
        tool_calls: [toolCall],
      });

      mockState.messages = [aiMessage];
      mockFinishTool.invoke = vi.fn().mockResolvedValue({
        output: {
          message: 'Task completed successfully',
          needsMoreInfo: false,
        },
        stateChange: { done: true, needsMoreInfo: false },
      });

      const result = await node.invoke(mockState, mockConfig);

      expect(result.toolsMetadata).toEqual({
        finish: { done: true, needsMoreInfo: false },
      });
      expect(result.messages?.items?.[0]?.content).toBe(
        stringifyYaml({
          message: 'Task completed successfully',
          needsMoreInfo: false,
        }).trimEnd(),
      );
    });

    it('should handle finish tool stateChange with needsMoreInfo and mirror it', async () => {
      const toolCall = {
        id: 'call-1',
        name: 'finish',
        args: {
          purpose: 'Asking for more information',
          message: 'What is the target environment?',
          needsMoreInfo: true,
        },
      };

      const aiMessage = new AIMessage({
        content: 'Need more info',
        tool_calls: [toolCall],
      });

      mockState.messages = [aiMessage];
      mockFinishTool.invoke = vi.fn().mockResolvedValue({
        output: {
          message: 'What is the target environment?',
          needsMoreInfo: true,
        },
        stateChange: { done: false, needsMoreInfo: true },
      });

      const result = await node.invoke(mockState, mockConfig);

      expect(result.toolsMetadata).toEqual({
        finish: { done: false, needsMoreInfo: true },
      });
      expect(result.messages?.items?.[0]?.content).toBe(
        stringifyYaml({
          message: 'What is the target environment?',
          needsMoreInfo: true,
        }).trimEnd(),
      );
    });

    it('should capture and aggregate tool request usage', async () => {
      const toolCall1 = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { input: 'input 1' },
      };

      const toolCall2 = {
        id: 'call-2',
        name: 'test-tool-2',
        args: { input: 'input 2' },
      };

      const aiMessage = new AIMessage({
        content: 'Using tools with usage tracking',
        tool_calls: [toolCall1, toolCall2],
      });

      mockState.messages = [aiMessage];

      // Mock tool 1 returns usage
      mockTool1.invoke = vi.fn().mockResolvedValue({
        output: 'Result 1',
        toolRequestUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          totalPrice: 0.001,
        },
      });

      // Mock tool 2 returns usage
      mockTool2.invoke = vi.fn().mockResolvedValue({
        output: 'Result 2',
        toolRequestUsage: {
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 300,
          totalPrice: 0.002,
        },
      });

      // Mock litellmService.sumTokenUsages to aggregate
      mockLitellmService.sumTokenUsages = vi.fn().mockReturnValue({
        inputTokens: 300,
        outputTokens: 150,
        totalTokens: 450,
        totalPrice: 0.003,
      });

      const result = await node.invoke(mockState, mockConfig);

      // Verify sumTokenUsages was called with both usages
      expect(mockLitellmService.sumTokenUsages).toHaveBeenCalledWith([
        {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          totalPrice: 0.001,
        },
        {
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 300,
          totalPrice: 0.002,
        },
      ]);

      // Verify aggregated usage is in the state change
      expect(result.inputTokens).toBe(300);
      expect(result.outputTokens).toBe(150);
      expect(result.totalTokens).toBe(450);
      expect(result.totalPrice).toBe(0.003);

      // Verify usage is attached to tool messages:
      // __toolTokenUsage = tool's own execution cost
      // __requestUsage = parent LLM call (undefined here since mock AI has none)
      expect(result.messages?.items).toHaveLength(2);
      expect(
        result.messages?.items?.[0]?.additional_kwargs?.__toolTokenUsage,
      ).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        totalPrice: 0.001,
      });
      expect(
        result.messages?.items?.[0]?.additional_kwargs?.__requestUsage,
      ).toBeUndefined();
      expect(
        result.messages?.items?.[1]?.additional_kwargs?.__toolTokenUsage,
      ).toEqual({
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        totalPrice: 0.002,
      });
      expect(
        result.messages?.items?.[1]?.additional_kwargs?.__requestUsage,
      ).toBeUndefined();
    });

    it('should handle tools without usage tracking', async () => {
      const toolCall = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { input: 'test' },
      };

      const aiMessage = new AIMessage({
        content: 'Using tool',
        tool_calls: [toolCall],
      });

      mockState.messages = [aiMessage];

      // Tool returns no usage
      mockTool1.invoke = vi.fn().mockResolvedValue({
        output: 'Result without usage',
      });

      const result = await node.invoke(mockState, mockConfig);

      // Verify no usage fields in state change
      expect(result.inputTokens).toBeUndefined();
      expect(result.outputTokens).toBeUndefined();
      expect(result.totalTokens).toBeUndefined();

      // Verify no usage attached to message
      expect(
        result.messages?.items?.[0]?.additional_kwargs?.__requestUsage,
      ).toBeUndefined();
    });

    it('should interleave additional messages immediately after their corresponding tool result', async () => {
      const toolCall1 = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { input: 'test1' },
      };

      const toolCall2 = {
        id: 'call-2',
        name: 'test-tool-2',
        args: { input: 'test2' },
      };

      const aiMessage = new AIMessage({
        content: 'Using multiple tools',
        tool_calls: [toolCall1, toolCall2],
      });

      mockState.messages = [aiMessage];

      // Tool 1 returns a result WITH additional messages
      const additionalMsg1 = new AIMessage({
        content: 'Tool 1 status report',
      });

      mockTool1.invoke = vi.fn().mockResolvedValue({
        output: 'Result from tool 1',
        additionalMessages: [additionalMsg1],
      });

      // Tool 2 returns a result WITHOUT additional messages
      mockTool2.invoke = vi.fn().mockResolvedValue({
        output: 'Result from tool 2',
      });

      const result = await node.invoke(mockState, mockConfig);

      // Should have 3 messages: tool1 result, additional message, tool2 result
      expect(result.messages?.items).toHaveLength(3);

      // First message should be tool 1 result
      expect(result.messages?.items?.[0]).toBeInstanceOf(ToolMessage);
      expect(result.messages?.items?.[0]?.content).toBe('Result from tool 1');

      // Second message should be the additional message from tool 1
      expect(result.messages?.items?.[1]).toBeInstanceOf(AIMessage);
      expect(result.messages?.items?.[1]?.content).toBe('Tool 1 status report');

      // Third message should be tool 2 result
      expect(result.messages?.items?.[2]).toBeInstanceOf(ToolMessage);
      expect(result.messages?.items?.[2]?.content).toBe('Result from tool 2');
    });

    it('should handle multiple additional messages from a single tool', async () => {
      const toolCall = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { input: 'test' },
      };

      const aiMessage = new AIMessage({
        content: 'Using tool',
        tool_calls: [toolCall],
      });

      mockState.messages = [aiMessage];

      const additionalMsg1 = new AIMessage({
        content: 'First status update',
      });

      const additionalMsg2 = new AIMessage({
        content: 'Second status update',
      });

      mockTool1.invoke = vi.fn().mockResolvedValue({
        output: 'Tool result',
        additionalMessages: [additionalMsg1, additionalMsg2],
      });

      const result = await node.invoke(mockState, mockConfig);

      // Should have 3 messages: tool result + 2 additional messages
      expect(result.messages?.items).toHaveLength(3);

      // First should be tool result
      expect(result.messages?.items?.[0]).toBeInstanceOf(ToolMessage);
      expect(result.messages?.items?.[0]?.content).toBe('Tool result');

      // Second should be first additional message
      expect(result.messages?.items?.[1]).toBeInstanceOf(AIMessage);
      expect(result.messages?.items?.[1]?.content).toBe('First status update');

      // Third should be second additional message
      expect(result.messages?.items?.[2]).toBeInstanceOf(AIMessage);
      expect(result.messages?.items?.[2]?.content).toBe('Second status update');
    });

    it('re-throws CostLimitExceededError with the higher of subagent-local and parent+folded total on cost-limit result', async () => {
      const toolCall = {
        id: 'call-cost-limit',
        name: 'test-tool-1',
        args: { input: 'test' },
      };

      const aiMessage = new AIMessage({
        content: 'Using tool',
        tool_calls: [toolCall],
      });

      // Parent state has already spent $0.30
      mockState.totalPrice = 0.3;
      mockState.messages = [aiMessage];

      // Tool returns a cost-limit stop with subagent-local stopCostUsd=$0.15
      // and toolRequestUsage.totalPrice=$0.05 (the folded usage from the sub-agent run)
      mockTool1.invoke = vi.fn().mockResolvedValue({
        output: 'stopped',
        stopReason: 'cost_limit' as const,
        stopCostUsd: 0.15,
        toolRequestUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          totalPrice: 0.05,
        },
      });

      // sumTokenUsages returns the folded usage containing totalPrice
      mockLitellmService.sumTokenUsages = vi.fn().mockReturnValue({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        totalPrice: 0.05,
      });

      const configWithLimit = {
        configurable: {
          thread_id: 'test-thread',
          effective_cost_limit_usd: 0.3,
        },
      };

      // Expected: Math.max(subagent-local=0.15, parent+folded=0.3+0.05=0.35) = 0.35
      await expect(node.invoke(mockState, configWithLimit)).rejects.toSatisfy(
        (err: unknown) => {
          if (!(err instanceof CostLimitExceededError)) {
            return false;
          }
          return err.totalPriceUsd === 0.35;
        },
      );
    });

    it('re-throws CostLimitExceededError with subagent-local stopCostUsd when it exceeds parent+folded', async () => {
      const toolCall = {
        id: 'call-cost-limit-2',
        name: 'test-tool-1',
        args: { input: 'test' },
      };

      const aiMessage = new AIMessage({
        content: 'Using tool',
        tool_calls: [toolCall],
      });

      // Parent state has spent very little
      mockState.totalPrice = 0.01;
      mockState.messages = [aiMessage];

      // Tool returns a cost-limit stop with subagent-local stopCostUsd=$0.50
      // and toolRequestUsage.totalPrice=$0.01 (folded usage from the sub-agent run)
      mockTool1.invoke = vi.fn().mockResolvedValue({
        output: 'stopped',
        stopReason: 'cost_limit' as const,
        stopCostUsd: 0.5,
        toolRequestUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          totalPrice: 0.01,
        },
      });

      // sumTokenUsages returns the folded usage
      mockLitellmService.sumTokenUsages = vi.fn().mockReturnValue({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        totalPrice: 0.01,
      });

      const configWithLimit = {
        configurable: {
          thread_id: 'test-thread',
          effective_cost_limit_usd: 0.3,
        },
      };

      // Expected: Math.max(subagent-local=0.50, parent+folded=0.01+0.01=0.02) = 0.50
      await expect(node.invoke(mockState, configWithLimit)).rejects.toSatisfy(
        (err: unknown) => {
          if (!(err instanceof CostLimitExceededError)) {
            return false;
          }
          return err.totalPriceUsd === 0.5;
        },
      );
    });

    it('should mark tool message with __hideForLlm when messageMetadata specifies it', async () => {
      const toolCall = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { message: 'Status update' },
      };

      const aiMessage = new AIMessage({
        content: 'Reporting status',
        tool_calls: [toolCall],
      });

      mockState.messages = [aiMessage];

      // Tool returns result with messageMetadata.__hideForLlm
      const additionalMsg = new AIMessage({
        content: 'Status update for user',
        additional_kwargs: {
          __hideForLlm: true,
        },
      });

      mockTool1.invoke = vi.fn().mockResolvedValue({
        output: { reported: true },
        messageMetadata: {
          __hideForLlm: true, // This should hide the tool message
        },
        additionalMessages: [additionalMsg],
      });

      const result = await node.invoke(mockState, mockConfig);

      // Should have 2 messages: tool result + additional message
      expect(result.messages?.items).toHaveLength(2);

      // Tool message should have __hideForLlm from messageMetadata
      expect(result.messages?.items?.[0]).toBeInstanceOf(ToolMessage);
      expect(result.messages?.items?.[0]?.additional_kwargs?.__hideForLlm).toBe(
        true,
      );

      // Additional AI message should have __hideForLlm
      expect(result.messages?.items?.[1]).toBeInstanceOf(AIMessage);
      expect(result.messages?.items?.[1]?.additional_kwargs?.__hideForLlm).toBe(
        true,
      );
    });
  });

  describe('streaming tool support', () => {
    let mockState: BaseAgentState;
    let mockConfig: Record<string, unknown>;

    beforeEach(() => {
      mockState = {
        messages: [],
        summary: '',
        toolUsageGuardActivated: false,
        toolsMetadata: {},
        toolUsageGuardActivatedCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        totalPrice: 0,
        currentContext: 0,
      };

      mockConfig = {
        configurable: {
          thread_id: 'test-thread',
          caller_agent: {
            emit: vi.fn(),
          },
        },
      };
    });

    function createStreamingTool(
      name: string,
      chunks: AIMessage[][],
      finalResult: {
        output: unknown;
        messageMetadata?: unknown;
        toolRequestUsage?: unknown;
      },
    ) {
      async function* streamingInvoke() {
        for (const chunk of chunks) {
          yield chunk;
        }
        return finalResult;
      }

      return {
        name,
        description: `Streaming ${name}`,
        invoke: vi.fn().mockResolvedValue(finalResult),
        __streamingInvoke: vi.fn().mockImplementation(streamingInvoke),
      } as unknown as DynamicStructuredTool;
    }

    it('should consume streaming tool and collect yielded messages as additionalMessages', async () => {
      const streamedMsg1 = new AIMessage({ content: 'Step 1 done' });
      const streamedMsg2 = new AIMessage({ content: 'Step 2 done' });

      const streamingTool = createStreamingTool(
        'streaming-tool',
        [[streamedMsg1], [streamedMsg2]],
        { output: 'Final result' },
      );

      const streamingNode = new ToolExecutorNode(
        [streamingTool],
        mockLitellmService,
      );

      const toolCall = {
        id: 'call-1',
        name: 'streaming-tool',
        args: { input: 'test' },
      };

      const aiMessage = new AIMessage({
        content: 'Using streaming tool',
        tool_calls: [toolCall],
      });

      mockState.messages = [aiMessage];

      const result = await streamingNode.invoke(mockState, mockConfig);

      // Should have 3 messages: tool result + 2 streamed messages
      expect(result.messages?.items).toHaveLength(3);

      // First is the tool message
      expect(result.messages?.items?.[0]).toBeInstanceOf(ToolMessage);
      expect(result.messages?.items?.[0]?.content).toBe('Final result');

      // Then the streamed messages as additionalMessages
      expect(result.messages?.items?.[1]).toBeInstanceOf(AIMessage);
      expect(result.messages?.items?.[1]?.content).toBe('Step 1 done');

      expect(result.messages?.items?.[2]).toBeInstanceOf(AIMessage);
      expect(result.messages?.items?.[2]?.content).toBe('Step 2 done');
    });

    it('should mark streamed messages with __streamedRealtime, __hideForLlm, and __toolCallId', async () => {
      const streamedMsg = new AIMessage({ content: 'Progress update' });

      const streamingTool = createStreamingTool(
        'streaming-tool',
        [[streamedMsg]],
        { output: 'Done' },
      );

      const streamingNode = new ToolExecutorNode(
        [streamingTool],
        mockLitellmService,
      );

      const toolCall = {
        id: 'call-1',
        name: 'streaming-tool',
        args: {},
      };

      mockState.messages = [
        new AIMessage({ content: 'Go', tool_calls: [toolCall] }),
      ];

      const result = await streamingNode.invoke(mockState, mockConfig);

      const additionalMsg = result.messages?.items?.[1];
      // Already emitted in real-time — skip in emitNewMessages
      expect(additionalMsg?.additional_kwargs?.__streamedRealtime).toBe(true);
      // Hidden from LLM context — subagent internal messages
      expect(additionalMsg?.additional_kwargs?.__hideForLlm).toBe(true);
      // Linked to the parent tool call for UI grouping
      expect(additionalMsg?.additional_kwargs?.__toolCallId).toBe('call-1');
    });

    it('should emit streamed messages in real-time via caller_agent', async () => {
      const streamedMsg = new AIMessage({ content: 'Live update' });
      const mockEmit = vi.fn();

      const configWithAgent: Record<string, unknown> = {
        configurable: {
          thread_id: 'test-thread',
          caller_agent: { emit: mockEmit },
        },
      };

      const streamingTool = createStreamingTool(
        'streaming-tool',
        [[streamedMsg]],
        { output: 'Done' },
      );

      const streamingNode = new ToolExecutorNode(
        [streamingTool],
        mockLitellmService,
      );

      const toolCall = {
        id: 'call-1',
        name: 'streaming-tool',
        args: {},
      };

      mockState.messages = [
        new AIMessage({ content: 'Go', tool_calls: [toolCall] }),
      ];

      await streamingNode.invoke(mockState, configWithAgent);

      expect(mockEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'message',
          data: expect.objectContaining({
            threadId: 'test-thread',
          }),
        }),
      );
    });

    it('should not call standard invoke when __streamingInvoke is present', async () => {
      const streamingTool = createStreamingTool('streaming-tool', [], {
        output: 'Result',
      });

      const streamingNode = new ToolExecutorNode(
        [streamingTool],
        mockLitellmService,
      );

      const toolCall = {
        id: 'call-1',
        name: 'streaming-tool',
        args: {},
      };

      mockState.messages = [
        new AIMessage({ content: 'Go', tool_calls: [toolCall] }),
      ];

      await streamingNode.invoke(mockState, mockConfig);

      // Standard invoke should NOT be called
      expect(streamingTool.invoke).not.toHaveBeenCalled();
    });

    it('should handle streaming tool errors gracefully', async () => {
      async function* failingStream() {
        yield [new AIMessage({ content: 'Before error' })];
        throw new Error('Stream failed');
      }

      const failingTool = {
        name: 'failing-stream',
        description: 'Fails during streaming',
        invoke: vi.fn(),
        __streamingInvoke: vi.fn().mockImplementation(failingStream),
      } as unknown as DynamicStructuredTool;

      const streamingNode = new ToolExecutorNode(
        [failingTool],
        mockLitellmService,
        undefined,
        {
          error: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          log: vi.fn(),
        } as unknown as import('@packages/common').DefaultLogger,
      );

      const toolCall = {
        id: 'call-1',
        name: 'failing-stream',
        args: {},
      };

      mockState.messages = [
        new AIMessage({ content: 'Go', tool_calls: [toolCall] }),
      ];

      const result = await streamingNode.invoke(mockState, mockConfig);

      // Should have the error message + the message streamed before the error
      expect(result.messages?.items).toHaveLength(2);
      expect(result.messages?.items?.[0]?.content).toContain(
        "Error executing tool 'failing-stream'",
      );
      expect(result.messages?.items?.[0]?.content).toContain('Stream failed');

      // The already-streamed message is preserved for state consistency
      expect(result.messages?.items?.[1]).toBeInstanceOf(AIMessage);
      expect(result.messages?.items?.[1]?.content).toBe('Before error');
    });

    it('should merge streamed messages with tool additionalMessages', async () => {
      const streamedMsg = new AIMessage({ content: 'Streamed' });
      const toolAdditionalMsg = new AIMessage({ content: 'Tool additional' });

      async function* streamWithAdditional() {
        yield [streamedMsg];
        return {
          output: 'Result',
          additionalMessages: [toolAdditionalMsg],
        };
      }

      const mergeTool = {
        name: 'merge-tool',
        description: 'Tool with both stream and additionalMessages',
        invoke: vi.fn(),
        __streamingInvoke: vi.fn().mockImplementation(streamWithAdditional),
      } as unknown as DynamicStructuredTool;

      const streamingNode = new ToolExecutorNode(
        [mergeTool],
        mockLitellmService,
      );

      const toolCall = {
        id: 'call-1',
        name: 'merge-tool',
        args: {},
      };

      mockState.messages = [
        new AIMessage({ content: 'Go', tool_calls: [toolCall] }),
      ];

      const result = await streamingNode.invoke(mockState, mockConfig);

      // Should have 3 messages: tool result + streamed + tool additional
      expect(result.messages?.items).toHaveLength(3);
      expect(result.messages?.items?.[0]).toBeInstanceOf(ToolMessage);
      expect(result.messages?.items?.[1]?.content).toBe('Streamed');
      expect(result.messages?.items?.[2]?.content).toBe('Tool additional');
    });
  });

  describe('circuit breaker for repeated tool errors', () => {
    let mockState: BaseAgentState;
    let mockConfig: Record<string, unknown>;

    beforeEach(() => {
      mockState = {
        messages: [],
        summary: '',
        toolUsageGuardActivated: false,
        toolsMetadata: {},
        toolUsageGuardActivatedCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        totalPrice: 0,
        currentContext: 0,
      };

      mockConfig = {
        configurable: {
          thread_id: 'test-thread',
        },
      };
    });

    /** Helper: invoke node with a single tool call that returns the given error. */
    async function invokeWithError(
      errorNode: ToolExecutorNode,
      state: BaseAgentState,
      cfg: Record<string, unknown>,
      errorMessage: string,
    ) {
      const toolCall = {
        id: `call-${Math.random().toString(36).slice(2)}`,
        name: 'test-tool-1',
        args: { input: 'test' },
      };
      const aiMessage = new AIMessage({
        content: 'Using tool',
        tool_calls: [toolCall],
      });
      state.messages = [aiMessage];
      mockTool1.invoke = vi.fn().mockRejectedValue(new Error(errorMessage));
      return errorNode.invoke(state, cfg);
    }

    /** Helper: invoke node with a single tool call that succeeds. */
    async function invokeWithSuccess(
      successNode: ToolExecutorNode,
      state: BaseAgentState,
      cfg: Record<string, unknown>,
    ) {
      const toolCall = {
        id: `call-${Math.random().toString(36).slice(2)}`,
        name: 'test-tool-1',
        args: { input: 'test' },
      };
      const aiMessage = new AIMessage({
        content: 'Using tool',
        tool_calls: [toolCall],
      });
      state.messages = [aiMessage];
      mockTool1.invoke = vi.fn().mockResolvedValue({ output: 'Success' });
      return successNode.invoke(state, cfg);
    }

    it('should not inject SystemMessage when results are mixed (error + success)', async () => {
      // Batch with 2 tool calls: one error, one success
      const toolCall1 = {
        id: 'call-1',
        name: 'test-tool-1',
        args: { input: 'test' },
      };
      const toolCall2 = {
        id: 'call-2',
        name: 'test-tool-2',
        args: { input: 'test' },
      };
      const aiMessage = new AIMessage({
        content: 'Using tools',
        tool_calls: [toolCall1, toolCall2],
      });
      mockState.messages = [aiMessage];

      mockTool1.invoke = vi
        .fn()
        .mockRejectedValue(new Error('Connection refused'));
      mockTool2.invoke = vi.fn().mockResolvedValue({ output: 'OK' });

      const result = await node.invoke(mockState, mockConfig);

      const systemMessages = result.messages?.items?.filter(
        (m) => m instanceof SystemMessage,
      );
      expect(systemMessages).toHaveLength(0);
    });

    it('should not inject SystemMessage when errors have different messages across batches', async () => {
      // 3 consecutive batches with different error messages each time
      await invokeWithError(node, mockState, mockConfig, 'Error A');
      await invokeWithError(node, mockState, mockConfig, 'Error B');
      const result = await invokeWithError(
        node,
        mockState,
        mockConfig,
        'Error C',
      );

      const systemMessages = result.messages?.items?.filter(
        (m) => m instanceof SystemMessage,
      );
      expect(systemMessages).toHaveLength(0);
    });

    it('should inject SystemMessage after 3 consecutive identical error batches', async () => {
      const errorMsg = 'Connection refused';

      await invokeWithError(node, mockState, mockConfig, errorMsg);
      await invokeWithError(node, mockState, mockConfig, errorMsg);
      const result = await invokeWithError(
        node,
        mockState,
        mockConfig,
        errorMsg,
      );

      const systemMessages = result.messages?.items?.filter(
        (m) => m instanceof SystemMessage,
      );
      expect(systemMessages).toHaveLength(1);

      const stopMessage = systemMessages![0]!;
      expect(stopMessage.content).toContain('CRITICAL');
      expect(stopMessage.content).toContain('3 times consecutively');
      expect(stopMessage.content).toContain('finish tool');
    });

    it('should include the error text in the SystemMessage', async () => {
      const errorMsg = 'ENOENT: file not found';

      await invokeWithError(node, mockState, mockConfig, errorMsg);
      await invokeWithError(node, mockState, mockConfig, errorMsg);
      const result = await invokeWithError(
        node,
        mockState,
        mockConfig,
        errorMsg,
      );

      const systemMessages = result.messages?.items?.filter(
        (m) => m instanceof SystemMessage,
      );
      expect(systemMessages).toHaveLength(1);
      // The error text wraps the original message with makeErrorMsg format:
      // "Error executing tool 'test-tool-1': ENOENT: file not found"
      expect(systemMessages![0]!.content).toContain('ENOENT: file not found');
    });

    it('should reset circuit breaker count on success between error batches', async () => {
      const errorMsg = 'Connection refused';

      // 2 identical errors
      await invokeWithError(node, mockState, mockConfig, errorMsg);
      await invokeWithError(node, mockState, mockConfig, errorMsg);

      // Success resets the counter
      await invokeWithSuccess(node, mockState, mockConfig);

      // 2 more identical errors (count should be 2, not 4)
      await invokeWithError(node, mockState, mockConfig, errorMsg);
      const result = await invokeWithError(
        node,
        mockState,
        mockConfig,
        errorMsg,
      );

      const systemMessages = result.messages?.items?.filter(
        (m) => m instanceof SystemMessage,
      );
      expect(systemMessages).toHaveLength(0);
    });

    it('should mark the SystemMessage with __hideForUi and __hideForSummary', async () => {
      const errorMsg = 'Timeout';

      await invokeWithError(node, mockState, mockConfig, errorMsg);
      await invokeWithError(node, mockState, mockConfig, errorMsg);
      const result = await invokeWithError(
        node,
        mockState,
        mockConfig,
        errorMsg,
      );

      const systemMessages = result.messages?.items?.filter(
        (m) => m instanceof SystemMessage,
      );
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages![0]!.additional_kwargs?.__hideForUi).toBe(true);
      expect(systemMessages![0]!.additional_kwargs?.__hideForSummary).toBe(
        true,
      );
    });

    it('should continue injecting SystemMessage on subsequent error batches after threshold', async () => {
      const errorMsg = 'Connection refused';

      await invokeWithError(node, mockState, mockConfig, errorMsg);
      await invokeWithError(node, mockState, mockConfig, errorMsg);
      await invokeWithError(node, mockState, mockConfig, errorMsg); // triggers at 3

      // 4th error batch should also trigger (count is now 4 >= 3)
      const result = await invokeWithError(
        node,
        mockState,
        mockConfig,
        errorMsg,
      );

      const systemMessages = result.messages?.items?.filter(
        (m) => m instanceof SystemMessage,
      );
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages![0]!.content).toContain('4 times consecutively');
    });
  });

  describe('deferred tool resolution', () => {
    let mockState: BaseAgentState;
    let mockConfig: Record<string, unknown>;

    beforeEach(() => {
      mockState = {
        messages: [],
        summary: '',
        toolUsageGuardActivated: false,
        toolsMetadata: {},
        toolUsageGuardActivatedCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        totalPrice: 0,
        currentContext: 0,
      };

      mockConfig = {
        configurable: {
          thread_id: 'test-thread',
        },
      };
    });

    it('should resolve an unloaded tool via deferredToolResolver and execute it successfully', async () => {
      const deferredTool = {
        name: 'deferred-tool',
        description: 'A tool loaded on demand',
        invoke: vi.fn().mockResolvedValue({ output: 'Deferred result' }),
      } as unknown as DynamicStructuredTool;

      const resolver = vi.fn().mockReturnValue({
        tool: deferredTool,
        instructions: 'Use this tool carefully.',
      });

      const deferredNode = new ToolExecutorNode(
        [],
        mockLitellmService,
        undefined,
        undefined,
        resolver,
      );

      const toolCall = {
        id: 'call-1',
        name: 'deferred-tool',
        args: { input: 'test' },
      };

      mockState.messages = [
        new AIMessage({
          content: 'Using deferred tool',
          tool_calls: [toolCall],
        }),
      ];

      const result = await deferredNode.invoke(mockState, mockConfig);

      expect(resolver).toHaveBeenCalledWith('deferred-tool');
      expect(deferredTool.invoke).toHaveBeenCalled();

      // Should have only the tool result — instructions are no longer injected as SystemMessages
      const items = result.messages?.items ?? [];
      expect(items).toHaveLength(1);

      expect(items[0]).toBeInstanceOf(ToolMessage);
      expect(items[0]?.content).toBe('Deferred result');
    });

    it('should set __loadedTools in ToolMessage additional_kwargs when tool is auto-loaded via deferredToolResolver', async () => {
      const deferredTool = {
        name: 'auto-tool',
        description: 'An auto-loaded tool',
        invoke: vi.fn().mockResolvedValue({ output: 'Auto result' }),
      } as unknown as DynamicStructuredTool;

      const resolver = vi.fn().mockReturnValue({
        tool: deferredTool,
      });

      const deferredNode = new ToolExecutorNode(
        [],
        mockLitellmService,
        undefined,
        undefined,
        resolver,
      );

      const toolCall = {
        id: 'call-auto-1',
        name: 'auto-tool',
        args: {},
      };

      mockState.messages = [
        new AIMessage({
          content: 'Using auto tool',
          tool_calls: [toolCall],
        }),
      ];

      const result = await deferredNode.invoke(mockState, mockConfig);

      const items = result.messages?.items ?? [];
      expect(items).toHaveLength(1);
      expect(items[0]).toBeInstanceOf(ToolMessage);

      const toolMsg = items[0] as ToolMessage;
      expect(toolMsg.additional_kwargs.__loadedTools).toEqual(['auto-tool']);
    });

    it('should NOT set __loadedTools when tool was already loaded (not via deferred resolver)', async () => {
      const preloadedTool = {
        name: 'preloaded-tool',
        description: 'A pre-loaded tool',
        invoke: vi.fn().mockResolvedValue({ output: 'Preloaded result' }),
      } as unknown as DynamicStructuredTool;

      const nodeWithPreloaded = new ToolExecutorNode(
        [preloadedTool],
        mockLitellmService,
      );

      const toolCall = {
        id: 'call-pre-1',
        name: 'preloaded-tool',
        args: {},
      };

      mockState.messages = [
        new AIMessage({
          content: 'Using preloaded tool',
          tool_calls: [toolCall],
        }),
      ];

      const result = await nodeWithPreloaded.invoke(mockState, mockConfig);

      const items = result.messages?.items ?? [];
      expect(items).toHaveLength(1);
      expect(items[0]).toBeInstanceOf(ToolMessage);

      const toolMsg = items[0] as ToolMessage;
      expect(toolMsg.additional_kwargs.__loadedTools).toBeUndefined();
    });

    it('should return standard "Tool not found" error when resolver returns null', async () => {
      const resolver = vi.fn().mockReturnValue(null);

      const deferredNode = new ToolExecutorNode(
        [],
        mockLitellmService,
        undefined,
        undefined,
        resolver,
      );

      const toolCall = {
        id: 'call-1',
        name: 'unknown-tool',
        args: {},
      };

      mockState.messages = [
        new AIMessage({
          content: 'Using unknown tool',
          tool_calls: [toolCall],
        }),
      ];

      const result = await deferredNode.invoke(mockState, mockConfig);

      const items = result.messages?.items ?? [];
      expect(items).toHaveLength(1);
      expect(items[0]).toBeInstanceOf(ToolMessage);
      expect(items[0]?.content).toContain("Tool 'unknown-tool' not found");
    });

    it('should behave as before (tool not found) when no resolver is provided', async () => {
      // Node with no resolver and no registered tools
      const noResolverNode = new ToolExecutorNode([], mockLitellmService);

      const toolCall = {
        id: 'call-1',
        name: 'missing-tool',
        args: {},
      };

      mockState.messages = [
        new AIMessage({
          content: 'Using missing tool',
          tool_calls: [toolCall],
        }),
      ];

      const result = await noResolverNode.invoke(mockState, mockConfig);

      const items = result.messages?.items ?? [];
      expect(items).toHaveLength(1);
      expect(items[0]).toBeInstanceOf(ToolMessage);
      expect(items[0]?.content).toContain("Tool 'missing-tool' not found");
    });

    it('should not inject SystemMessage when resolved tool has instructions (instructions are no longer injected)', async () => {
      const deferredTool = {
        name: 'tool-with-instructions',
        description: 'Tool with detailed instructions',
        invoke: vi.fn().mockResolvedValue({ output: 'OK' }),
      } as unknown as DynamicStructuredTool;

      const resolver = vi.fn().mockReturnValue({
        tool: deferredTool,
        instructions: 'Step 1: do X. Step 2: do Y.',
      });

      const deferredNode = new ToolExecutorNode(
        [],
        mockLitellmService,
        undefined,
        undefined,
        resolver,
      );

      const toolCall = {
        id: 'call-1',
        name: 'tool-with-instructions',
        args: {},
      };

      mockState.messages = [
        new AIMessage({ content: 'Using tool', tool_calls: [toolCall] }),
      ];

      const result = await deferredNode.invoke(mockState, mockConfig);

      const items = result.messages?.items ?? [];
      const sysMessages = items.filter((m) => m instanceof SystemMessage);
      expect(sysMessages).toHaveLength(0);

      // Should only have the tool result
      expect(items).toHaveLength(1);
      expect(items[0]).toBeInstanceOf(ToolMessage);
      expect(items[0]?.content).toBe('OK');
    });

    it('should not inject SystemMessage when resolved tool has no instructions', async () => {
      const deferredTool = {
        name: 'tool-no-instructions',
        description: 'Tool without instructions',
        invoke: vi.fn().mockResolvedValue({ output: 'Done' }),
      } as unknown as DynamicStructuredTool;

      const resolver = vi.fn().mockReturnValue({
        tool: deferredTool,
        // No instructions field
      });

      const deferredNode = new ToolExecutorNode(
        [],
        mockLitellmService,
        undefined,
        undefined,
        resolver,
      );

      const toolCall = {
        id: 'call-1',
        name: 'tool-no-instructions',
        args: {},
      };

      mockState.messages = [
        new AIMessage({ content: 'Using tool', tool_calls: [toolCall] }),
      ];

      const result = await deferredNode.invoke(mockState, mockConfig);

      const items = result.messages?.items ?? [];
      const sysMessages = items.filter((m) => m instanceof SystemMessage);
      expect(sysMessages).toHaveLength(0);

      // Should only have the tool result
      expect(items).toHaveLength(1);
      expect(items[0]).toBeInstanceOf(ToolMessage);
      expect(items[0]?.content).toBe('Done');
    });

    it('should use cached toolsMap entry when same deferred tool is called twice in a batch', async () => {
      const deferredTool = {
        name: 'shared-deferred-tool',
        description: 'Tool called twice in same batch',
        invoke: vi.fn().mockResolvedValue({ output: 'Batch result' }),
      } as unknown as DynamicStructuredTool;

      const resolver = vi.fn().mockReturnValue({
        tool: deferredTool,
      });

      const deferredNode = new ToolExecutorNode(
        [],
        mockLitellmService,
        undefined,
        undefined,
        resolver,
      );

      const toolCall1 = {
        id: 'call-1',
        name: 'shared-deferred-tool',
        args: { input: 'first' },
      };

      const toolCall2 = {
        id: 'call-2',
        name: 'shared-deferred-tool',
        args: { input: 'second' },
      };

      mockState.messages = [
        new AIMessage({
          content: 'Calling same tool twice',
          tool_calls: [toolCall1, toolCall2],
        }),
      ];

      const result = await deferredNode.invoke(mockState, mockConfig);

      // Resolver may be called once or twice (parallel execution), but both calls succeed
      expect(resolver).toHaveBeenCalledWith('shared-deferred-tool');
      expect(deferredTool.invoke).toHaveBeenCalledTimes(2);

      const items = result.messages?.items ?? [];
      // Two tool results — no instruction messages (no instructions provided)
      const toolMessages = items.filter((m) => m instanceof ToolMessage);
      expect(toolMessages).toHaveLength(2);
      expect(toolMessages[0]?.content).toBe('Batch result');
      expect(toolMessages[1]?.content).toBe('Batch result');
    });
  });
});
