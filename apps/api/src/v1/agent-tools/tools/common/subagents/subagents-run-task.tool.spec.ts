import { AIMessage, BaseMessage } from '@langchain/core/messages';
import { ToolRunnableConfig } from '@langchain/core/tools';
import { ModuleRef } from '@nestjs/core';
import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { BaseAgentConfigurable } from '../../../../agents/agents.types';
import type { AgentEventType } from '../../../../agents/services/agents/base-agent';
import { SubagentRunResult } from '../../../../agents/services/agents/sub-agent';
import { LlmModelsService } from '../../../../litellm/services/llm-models.service';
import { SubagentsService } from '../../../../subagents/subagents.service';
import { BuiltAgentTool, ToolInvokeResult } from '../../base-tool';
import { SubagentsToolGroupConfig } from './subagents.types';
import {
  SubagentsRunTaskTool,
  SubagentsRunTaskToolOutput,
} from './subagents-run-task.tool';

vi.mock('../../../../../environments', () => ({
  environment: {
    llmLargeModel: 'openai/gpt-5.2-fallback',
  },
}));

describe('SubagentsRunTaskTool', () => {
  let tool: SubagentsRunTaskTool;
  let mockSubAgent: {
    runSubagent: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    setConfig: ReturnType<typeof vi.fn>;
    addTool: ReturnType<typeof vi.fn>;
  };
  let mockModuleRef: ModuleRef;
  let mockLlmModelsService: LlmModelsService;
  let mockLogger: DefaultLogger;

  const defaultCfg: ToolRunnableConfig<BaseAgentConfigurable> = {
    configurable: { thread_id: 'thread-123' },
  };

  const makeCfgWithParentModel = (
    modelName: string,
  ): ToolRunnableConfig<BaseAgentConfigurable> => ({
    configurable: {
      thread_id: 'thread-123',
      caller_agent: {
        getConfig: () => ({ invokeModelName: modelName }),
        emit: vi.fn(),
      } as unknown as BaseAgentConfigurable['caller_agent'],
    },
  });

  const makeMockSubTool = (name: string): BuiltAgentTool => {
    return {
      name,
      description: `Mock ${name}`,
      schema: z.object({ command: z.string() }),
      invoke: vi.fn(),
    } as unknown as BuiltAgentTool;
  };

  const makeToolSets = (): Map<string, BuiltAgentTool[]> => {
    const toolSets = new Map<string, BuiltAgentTool[]>();
    toolSets.set('shell', [makeMockSubTool('shell')]);
    toolSets.set('shell:read-only', [makeMockSubTool('shell')]);
    toolSets.set('files:read-only', [
      makeMockSubTool('codebase_search'),
      makeMockSubTool('files_read'),
    ]);
    toolSets.set('files:full', [
      makeMockSubTool('codebase_search'),
      makeMockSubTool('files_read'),
      makeMockSubTool('files_write'),
    ]);
    return toolSets;
  };

  const makeConfig = (
    overrides?: Partial<SubagentsToolGroupConfig>,
  ): SubagentsToolGroupConfig => ({
    toolSets: makeToolSets(),
    ...overrides,
  });

  const defaultLoopResult: SubagentRunResult = {
    result: 'Task completed successfully.',
    statistics: {
      totalIterations: 2,
      toolCallsMade: 1,
      usage: {
        inputTokens: 200,
        outputTokens: 50,
        totalTokens: 250,
        totalPrice: 0,
      },
    },
    exploredFiles: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockSubAgent = {
      runSubagent: vi.fn().mockResolvedValue(defaultLoopResult),
      subscribe: vi.fn().mockReturnValue(() => {}),
      setConfig: vi.fn(),
      addTool: vi.fn(),
    };

    mockModuleRef = {
      resolve: vi.fn().mockResolvedValue(mockSubAgent),
    } as unknown as ModuleRef;

    mockLlmModelsService = {
      getSubagentFastModel: vi.fn().mockReturnValue('gpt-5.1-codex-mini'),
      getSubagentExplorerModel: vi.fn().mockReturnValue('gpt-5-mini'),
    } as unknown as LlmModelsService;

    mockLogger = {
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      log: vi.fn(),
    } as unknown as DefaultLogger;

    const subagentsService = new SubagentsService();

    tool = new SubagentsRunTaskTool(
      mockModuleRef,
      mockLlmModelsService,
      subagentsService,
      mockLogger,
    );
  });

  describe('schema validation', () => {
    it('should validate required fields', () => {
      const valid = {
        agentId: 'system:explorer',
        task: 'Find files',
        purpose: 'Explore',
      };
      expect(() => tool.validate(valid)).not.toThrow();
    });

    it('should reject missing agentId', () => {
      expect(() =>
        tool.validate({ task: 'Find files', purpose: 'Explore' }),
      ).toThrow();
    });
  });

  describe('agent resolution', () => {
    it('should return error for unknown agentId', async () => {
      const result = await tool.invoke(
        {
          agentId: 'nonexistent',
          task: 'Do something',
          purpose: 'Test',
        },
        makeConfig(),
        defaultCfg,
      );

      expect(result.output.error).toBe('Invalid agentId');
      expect(result.output.result).toContain('Unknown agent ID "nonexistent"');
      expect(mockSubAgent.runSubagent).not.toHaveBeenCalled();
    });

    it('should resolve explorer agent tools via addTool', async () => {
      await tool.invoke(
        {
          agentId: 'system:explorer',
          task: 'Find files',
          purpose: 'Explore',
        },
        makeConfig(),
        defaultCfg,
      );

      // Explorer has toolIds: ['shell:read-only', 'files:read-only']
      // shell:read-only = 1 tool, files:read-only = 2 tools
      expect(mockSubAgent.addTool).toHaveBeenCalledTimes(3);
    });

    it('should resolve simple agent tools via addTool', async () => {
      await tool.invoke(
        {
          agentId: 'system:simple',
          task: 'Edit file',
          purpose: 'Edit',
        },
        makeConfig(),
        defaultCfg,
      );

      // Simple has toolIds: ['shell', 'files:full']
      // shell = 1 tool, files:full = 3 tools
      expect(mockSubAgent.addTool).toHaveBeenCalledTimes(4);
    });
  });

  describe('model selection', () => {
    it('should use explorer model for system:explorer', async () => {
      await tool.invoke(
        {
          agentId: 'system:explorer',
          task: 'Find files',
          purpose: 'Explore',
        },
        makeConfig(),
        defaultCfg,
      );

      expect(mockLlmModelsService.getSubagentExplorerModel).toHaveBeenCalled();
      expect(mockLlmModelsService.getSubagentFastModel).not.toHaveBeenCalled();
      expect(mockSubAgent.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({ invokeModelName: 'gpt-5-mini' }),
      );
    });

    it('should use fast model for system:simple', async () => {
      await tool.invoke(
        {
          agentId: 'system:simple',
          task: 'Edit file',
          purpose: 'Edit',
        },
        makeConfig(),
        defaultCfg,
      );

      expect(mockLlmModelsService.getSubagentFastModel).toHaveBeenCalled();
      expect(
        mockLlmModelsService.getSubagentExplorerModel,
      ).not.toHaveBeenCalled();
      expect(mockSubAgent.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({ invokeModelName: 'gpt-5.1-codex-mini' }),
      );
    });

    it('should use parent agent model for system:smart', async () => {
      await tool.invoke(
        {
          agentId: 'system:smart',
          task: 'Analyze code',
          purpose: 'Deep analysis',
        },
        makeConfig(),
        makeCfgWithParentModel('anthropic/claude-sonnet-4-20250514'),
      );

      expect(mockSubAgent.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          invokeModelName: 'anthropic/claude-sonnet-4-20250514',
        }),
      );
    });

    it('should fall back to default large model for system:smart when parent is unavailable', async () => {
      await tool.invoke(
        {
          agentId: 'system:smart',
          task: 'Analyze code',
          purpose: 'Deep analysis',
        },
        makeConfig(),
        defaultCfg,
      );

      expect(mockSubAgent.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          invokeModelName: 'openai/gpt-5.2-fallback',
        }),
      );
    });
  });

  describe('context token limits', () => {
    it('should set maxContextTokens for explorer subagent', async () => {
      await tool.invoke(
        {
          agentId: 'system:explorer',
          task: 'Find files',
          purpose: 'Explore',
        },
        makeConfig(),
        defaultCfg,
      );

      expect(mockSubAgent.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({ maxContextTokens: 200_000 }),
      );
    });

    it('should set maxContextTokens for simple subagent', async () => {
      await tool.invoke(
        {
          agentId: 'system:simple',
          task: 'Edit file',
          purpose: 'Edit',
        },
        makeConfig(),
        defaultCfg,
      );

      expect(mockSubAgent.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({ maxContextTokens: 70_000 }),
      );
    });

    it('should not set maxContextTokens for smart subagent', async () => {
      await tool.invoke(
        {
          agentId: 'system:smart',
          task: 'Analyze code',
          purpose: 'Deep analysis',
        },
        makeConfig(),
        defaultCfg,
      );

      const configCall = mockSubAgent.setConfig.mock.calls[0]?.[0];
      expect(configCall).not.toHaveProperty('maxContextTokens');
    });
  });

  describe('system prompt', () => {
    it('should include agent definition system prompt', async () => {
      await tool.invoke(
        {
          agentId: 'system:explorer',
          task: 'Find files',
          purpose: 'Explore',
        },
        makeConfig(),
        defaultCfg,
      );

      const configCall = mockSubAgent.setConfig.mock.calls[0]?.[0];
      expect(configCall?.instructions).toContain('explorer subagent');
    });

    it('should append resource information to system prompt', async () => {
      await tool.invoke(
        {
          agentId: 'system:explorer',
          task: 'Find files',
          purpose: 'Explore',
        },
        makeConfig({ resourcesInformation: '- github-resource: my-repo' }),
        defaultCfg,
      );

      const configCall = mockSubAgent.setConfig.mock.calls[0]?.[0];
      expect(configCall?.instructions).toContain('- github-resource: my-repo');
    });
  });

  describe('result handling', () => {
    it('should wrap loop result into ToolInvokeResult', async () => {
      const result = await tool.invoke(
        {
          agentId: 'system:simple',
          task: 'Do work',
          purpose: 'Test',
        },
        makeConfig(),
        defaultCfg,
      );

      expect(result.output.result).toBe('Task completed successfully.');
      expect(result.output.statistics?.totalIterations).toBe(2);
      expect(result.output.statistics?.toolCallsMade).toBe(1);
      expect(result.toolRequestUsage).toEqual({
        inputTokens: 200,
        outputTokens: 50,
        totalTokens: 250,
        totalPrice: 0,
      });
    });

    it('should include exploredFiles in output when subagent explored files', async () => {
      mockSubAgent.runSubagent.mockResolvedValueOnce({
        result: 'Found service patterns.',
        statistics: {
          totalIterations: 3,
          toolCallsMade: 2,
          usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
        },
        exploredFiles: ['/workspace/src/service.ts', '/workspace/src/dao.ts'],
      });

      const result = await tool.invoke(
        {
          agentId: 'system:explorer',
          task: 'Find service patterns',
          purpose: 'Research',
        },
        makeConfig(),
        defaultCfg,
      );

      expect(result.output.exploredFiles).toEqual([
        '/workspace/src/service.ts',
        '/workspace/src/dao.ts',
      ]);
    });

    it('should omit exploredFiles from output when list is empty', async () => {
      const result = await tool.invoke(
        {
          agentId: 'system:simple',
          task: 'Do work',
          purpose: 'Test',
        },
        makeConfig(),
        defaultCfg,
      );

      expect(result.output.exploredFiles).toBeUndefined();
    });

    it('should propagate error from loop result', async () => {
      mockSubAgent.runSubagent.mockResolvedValueOnce({
        result: 'Subagent was aborted.',
        statistics: { totalIterations: 1, toolCallsMade: 0, usage: null },
        exploredFiles: [],
        error: 'Aborted',
      });

      const result = await tool.invoke(
        {
          agentId: 'system:simple',
          task: 'Do work',
          purpose: 'Test',
        },
        makeConfig(),
        defaultCfg,
      );

      expect(result.output.error).toBe('Aborted');
    });

    it('should surface stopReason="cost_limit" in ToolInvokeResult when sub-agent hits cost limit', async () => {
      mockSubAgent.runSubagent.mockResolvedValueOnce({
        result: 'Subagent stopped: cost limit $2.00 reached (total: $3.5000).',
        statistics: { totalIterations: 2, toolCallsMade: 1, usage: null },
        exploredFiles: [],
        error: 'Cost limit reached',
        stopReason: 'cost_limit' as const,
        stopCostUsd: 3.5,
      });

      const result = await tool.invoke(
        {
          agentId: 'system:simple',
          task: 'Do work',
          purpose: 'Test',
        },
        makeConfig(),
        defaultCfg,
      );

      expect(result.stopReason).toBe('cost_limit');
      expect(result.stopCostUsd).toBe(3.5);
      expect(result.output.error).toBe('Cost limit reached');
    });

    it('should not set stopReason when sub-agent completes normally', async () => {
      const result = await tool.invoke(
        {
          agentId: 'system:simple',
          task: 'Do work',
          purpose: 'Test',
        },
        makeConfig(),
        defaultCfg,
      );

      expect(result.stopReason).toBeUndefined();
      expect(result.stopCostUsd).toBeUndefined();
    });
  });

  describe('title generation', () => {
    it('should generate title with purpose', async () => {
      const result = await tool.invoke(
        {
          agentId: 'system:explorer',
          task: 'Find auth deps',
          purpose: 'Map auth deps',
        },
        makeConfig(),
        defaultCfg,
      );

      expect(result.messageMetadata?.__title).toBe(
        'Calling subagent: Map auth deps',
      );
    });
  });

  describe('build', () => {
    it('should create a DynamicStructuredTool', () => {
      const builtTool = tool.build(makeConfig());
      expect(builtTool).toBeDefined();
      expect(builtTool.name).toBe('subagents_run_task');
      expect(typeof builtTool.invoke).toBe('function');
    });

    it('should include detailed instructions', () => {
      const builtTool = tool.build(makeConfig());
      expect(builtTool.__instructions).toBeDefined();
      expect(builtTool.__instructions).toContain('subagent');
    });

    it('should attach __streamingInvoke to built tool', () => {
      const builtTool = tool.build(makeConfig());
      expect(builtTool.__streamingInvoke).toBeDefined();
      expect(typeof builtTool.__streamingInvoke).toBe('function');
    });
  });

  describe('streamingInvoke', () => {
    /** Helper to consume an async generator and collect results */
    async function consumeStream(
      gen: AsyncGenerator<
        BaseMessage[],
        ToolInvokeResult<SubagentsRunTaskToolOutput>,
        undefined
      >,
    ): Promise<{
      chunks: BaseMessage[][];
      result: ToolInvokeResult<SubagentsRunTaskToolOutput>;
    }> {
      const chunks: BaseMessage[][] = [];
      let iterResult = await gen.next();
      while (!iterResult.done) {
        chunks.push(iterResult.value);
        iterResult = await gen.next();
      }
      return { chunks, result: iterResult.value };
    }

    it('should return error immediately for unknown agentId', async () => {
      const gen = tool.streamingInvoke!(
        {
          agentId: 'nonexistent',
          task: 'Do something',
          purpose: 'Test',
        },
        makeConfig(),
        defaultCfg,
      );

      const { chunks, result } = await consumeStream(gen);

      expect(chunks).toHaveLength(0);
      expect(result.output.error).toBe('Invalid agentId');
      expect(mockSubAgent.runSubagent).not.toHaveBeenCalled();
    });

    it('should yield messages from subagent events', async () => {
      const streamedMsg = new AIMessage({ content: 'Progress update' });

      // Mock subscribe: capture callback so we can fire it at the right time
      let subscribedCallback:
        | ((event: AgentEventType) => Promise<void>)
        | null = null;
      mockSubAgent.subscribe.mockImplementation(
        (callback: (event: AgentEventType) => Promise<void>) => {
          subscribedCallback = callback;
          return () => {};
        },
      );

      // Make runSubagent deliver a message via the callback before resolving
      mockSubAgent.runSubagent.mockImplementation(async () => {
        // Fire event before returning so the generator can yield it
        await subscribedCallback?.({
          type: 'message',
          data: {
            threadId: 'thread-123',
            messages: [streamedMsg],
            config: defaultCfg,
          },
        } as AgentEventType);
        return defaultLoopResult;
      });

      const gen = tool.streamingInvoke!(
        {
          agentId: 'system:explorer',
          task: 'Find files',
          purpose: 'Explore',
        },
        makeConfig(),
        defaultCfg,
      );

      const { chunks, result } = await consumeStream(gen);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.flat().some((m) => m.content === 'Progress update')).toBe(
        true,
      );
      expect(result.output.result).toBe('Task completed successfully.');
    });

    it('should return final result with statistics', async () => {
      const gen = tool.streamingInvoke!(
        {
          agentId: 'system:simple',
          task: 'Do work',
          purpose: 'Test',
        },
        makeConfig(),
        defaultCfg,
      );

      const { result } = await consumeStream(gen);

      expect(result.output.result).toBe('Task completed successfully.');
      expect(result.output.statistics?.totalIterations).toBe(2);
      expect(result.toolRequestUsage).toEqual({
        inputTokens: 200,
        outputTokens: 50,
        totalTokens: 250,
        totalPrice: 0,
      });
    });

    it('should unsubscribe from subagent events on completion', async () => {
      const unsubscribeFn = vi.fn();
      mockSubAgent.subscribe.mockReturnValue(unsubscribeFn);

      const gen = tool.streamingInvoke!(
        {
          agentId: 'system:explorer',
          task: 'Find files',
          purpose: 'Explore',
        },
        makeConfig(),
        defaultCfg,
      );

      await consumeStream(gen);

      expect(unsubscribeFn).toHaveBeenCalled();
    });

    // ── Defensive catch path: unexpected throw escaping SubAgent.runSubagent ──

    it('returns a structured error result when runSubagent rejects unexpectedly', async () => {
      // Mirror the failure mode where the subagent stream throws BEFORE the
      // SubAgent's own try/catch can convert the error into a clean
      // SubagentRunResult (e.g. graph-level abort, runtime cancellation).
      const unsubscribeFn = vi.fn();
      mockSubAgent.subscribe.mockReturnValue(unsubscribeFn);
      mockSubAgent.runSubagent.mockRejectedValue(
        new Error('LLM provider returned 503 service unavailable'),
      );

      const gen = tool.streamingInvoke!(
        {
          agentId: 'system:explorer',
          task: 'Find files',
          purpose: 'Explore',
        },
        makeConfig(),
        defaultCfg,
      );

      const { chunks, result } = await consumeStream(gen);

      expect(chunks).toHaveLength(0);
      expect(result.output.error).toBe(
        'LLM provider returned 503 service unavailable',
      );
      expect(result.output.result).toContain('Subagent execution failed');
      expect(result.output.result).toContain('503 service unavailable');
      // Defensive catch must still unsubscribe via the finally block.
      expect(unsubscribeFn).toHaveBeenCalled();
      // Real, unexpected errors must be logged so they're observable in prod.
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('returns a neutral aborted result without error field on AbortError', async () => {
      // User-initiated thread stops surface as AbortError on the runnable's
      // signal. The defensive catch must NOT mark these as errors — otherwise
      // the FE would render a misleading red badge for runs the user
      // intentionally cancelled.
      const unsubscribeFn = vi.fn();
      mockSubAgent.subscribe.mockReturnValue(unsubscribeFn);
      const abortErr = Object.assign(new Error('The operation was aborted.'), {
        name: 'AbortError',
      });
      mockSubAgent.runSubagent.mockRejectedValue(abortErr);

      const gen = tool.streamingInvoke!(
        {
          agentId: 'system:explorer',
          task: 'Find files',
          purpose: 'Explore',
        },
        makeConfig(),
        defaultCfg,
      );

      const { result } = await consumeStream(gen);

      expect(result.output.error).toBeUndefined();
      expect(result.output.result).toBe('Subagent was aborted.');
      expect(unsubscribeFn).toHaveBeenCalled();
      // Aborts are user-initiated, not bugs — must not flood logs as errors.
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });
});
