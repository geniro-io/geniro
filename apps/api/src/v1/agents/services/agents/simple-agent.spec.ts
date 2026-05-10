import {
  AIMessage,
  type AIMessageChunk,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { RunnableConfig } from '@langchain/core/runnables';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { Test, TestingModule } from '@nestjs/testing';
import { LoggerModule } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LitellmService } from '../../../litellm/services/litellm.service';
import { LlmModelsService } from '../../../litellm/services/llm-models.service';
import { NotificationsService } from '../../../notifications/services/notifications.service';
import { CostLimitExceededError } from '../../agents.errors';
import {
  BaseAgentConfigurable,
  NewMessageMode,
  ReasoningEffort,
} from '../../agents.types';
import { buildReasoningMessage } from '../../agents.utils';
import { GraphThreadState, IGraphThreadStateData } from '../graph-thread-state';
import { PgCheckpointSaver } from '../pg-checkpoint-saver';
import { AgentEventType } from './base-agent';
import { SimpleAgent, SimpleAgentSchemaType } from './simple-agent';

// Mock dependencies
vi.mock('@langchain/core/messages', () => ({
  HumanMessage: class MockHumanMessage {
    content: string;
    type: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    additional_kwargs: Record<string, unknown>;
    constructor(content: string) {
      this.content = content;
      this.type = 'human';
      this.additional_kwargs = {};
    }
  },
  ChatMessage: class MockChatMessage {
    content: string;
    type: string;
    role: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    additional_kwargs: Record<string, unknown>;
    constructor(content: string, role: string) {
      this.content = content;
      this.role = role;
      this.type = role;
      this.additional_kwargs = {};
    }
  },
  AIMessage: class MockAIMessage {
    content: string;
    type: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    additional_kwargs: Record<string, unknown>;
    constructor(content: string) {
      this.content = typeof content === 'string' ? content : '';
      this.type = 'ai';
      this.additional_kwargs = {};
    }
  },
  SystemMessage: class MockSystemMessage {
    content: string;
    type: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    additional_kwargs: Record<string, unknown>;
    constructor(content: string) {
      this.content = content;
      this.type = 'system';
      this.additional_kwargs = {};
    }
  },
  ToolMessage: class MockToolMessage {
    content: string;
    type: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    tool_call_id: string;
    name: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    additional_kwargs: Record<string, unknown>;
    constructor(fields: {
      tool_call_id: string;
      name: string;
      content: string;
    }) {
      this.tool_call_id = fields.tool_call_id;
      this.name = fields.name;
      this.content = fields.content;
      this.type = 'tool';
      this.additional_kwargs = {};
    }
  },
}));
vi.mock('@langchain/openai');
vi.mock('@langchain/langgraph');

describe('SimpleAgent', () => {
  let agent: SimpleAgent;
  let mockCheckpointSaver: PgCheckpointSaver;
  const _mockNotificationsService = {
    emit: vi.fn(),
  } as unknown as NotificationsService;

  const buildAgentState = () => ({
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
  });

  const setGraphThreadState = (state: GraphThreadState) => {
    const agentRef = agent as unknown as {
      graphThreadState?: GraphThreadState;
      graphThreadStateUnsubscribe?: () => void;
      handleThreadStateChange?: (
        threadId: string,
        nextState: IGraphThreadStateData,
        prevState?: IGraphThreadStateData,
      ) => void;
    };

    agentRef.graphThreadStateUnsubscribe?.();
    agentRef.graphThreadState = state;

    if (typeof agentRef.handleThreadStateChange === 'function') {
      agentRef.graphThreadStateUnsubscribe = state.subscribe(
        agentRef.handleThreadStateChange,
      );
    }
  };

  const waitForMicrotasks = () =>
    new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCheckpointSaver = {
      // Mock checkpoint saver methods
    } as unknown as PgCheckpointSaver;

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({
          appName: 'test',
          appVersion: '1.0.0',
          environment: 'test',
          prettyPrint: true,
          level: 'debug',
        }),
      ],
      providers: [
        SimpleAgent,
        {
          provide: LitellmService,
          useValue: {
            supportsStreaming: vi.fn().mockResolvedValue(true),
          } as unknown as LitellmService,
        },
        {
          provide: LlmModelsService,
          useValue: {
            getSummarizeModel: vi.fn().mockReturnValue('gpt-5-mini'),
          } as unknown as LlmModelsService,
        },
        {
          provide: PgCheckpointSaver,
          useValue: mockCheckpointSaver,
        },
      ],
    }).compile();

    agent = await module.resolve<SimpleAgent>(SimpleAgent);
  });

  // Schema validation tests moved to simple-agent.template.spec.ts
  // (SimpleAgentSchema now lives in the template, not the agent).

  // (no tests here) message emission de-dupe is handled by correct state seeding in run()

  describe('addTool', () => {
    it('should add tool to tools map', () => {
      const mockTool = {
        name: 'test-tool',
        description: 'Test tool',
        invoke: vi.fn(),
      } as unknown as DynamicStructuredTool;

      const initialToolCount = agent['tools'].size;

      agent.addTool(mockTool);

      expect(agent['tools'].size).toBe(initialToolCount + 1);
      expect(agent['tools'].get(mockTool.name)).toBe(mockTool);
    });

    it('should add multiple tools', () => {
      const mockTool1 = {
        name: 'tool1',
        invoke: vi.fn(),
      } as unknown as DynamicStructuredTool;
      const mockTool2 = {
        name: 'tool2',
        invoke: vi.fn(),
      } as unknown as DynamicStructuredTool;

      const initialToolCount = agent['tools'].size;

      agent.addTool(mockTool1);
      agent.addTool(mockTool2);

      expect(agent['tools'].size).toBe(initialToolCount + 2);
      expect(agent['tools'].get(mockTool1.name)).toBe(mockTool1);
      expect(agent['tools'].get(mockTool2.name)).toBe(mockTool2);
    });
  });

  describe('buildLLM', () => {
    it('should create ChatOpenAI instance with correct configuration', () => {
      // Test that buildLLM method exists and returns something
      const llm = agent.buildLLM('gpt-5-mini');
      expect(llm).toBeDefined();
      expect(typeof llm).toBe('object');
      expect(ChatOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5-mini',
        }),
      );
    });
  });

  describe('buildState', () => {
    it('should have buildState method available', () => {
      // buildState is a private method, just test that the agent has the method
      expect(typeof agent['buildState']).toBe('function');
    });
  });

  describe('run', () => {
    it('should execute agent with valid configuration', async () => {
      const mockMessages = [new HumanMessage('Response')];

      // Mock async generator for stream
      async function* mockStream() {
        yield [
          'updates',
          {
            'agent-1': {
              messages: {
                mode: 'append',
                items: mockMessages,
              },
            },
          },
        ] as const;
      }

      // Mock the graph compilation and execution
      const mockGraph = {
        stream: vi.fn().mockReturnValue(mockStream()),
      };

      // Mock buildGraph to return our mock graph
      agent['buildGraph'] = vi.fn().mockReturnValue(mockGraph);

      const config = {
        summarizeMaxTokens: 1000,
        summarizeKeepTokens: 500,
        instructions: 'Test instructions',
        name: 'Test Agent',
        description: 'Test agent description',
        invokeModelName: 'gpt-5-mini',
        invokeModelReasoningEffort: ReasoningEffort.None,
        maxIterations: 50,
      };

      const messages = [new HumanMessage('Hello')];
      const threadId = 'test-thread';

      const result = await agent.run(threadId, messages, config);

      expect(agent['buildGraph']).toHaveBeenCalled();
      expect(mockGraph.stream).toHaveBeenCalledTimes(1);
      const [initialState, runnable] = mockGraph.stream.mock.calls[0]!;

      expect(initialState).toMatchObject({
        messages: {
          mode: 'append',
        },
        toolsMetadata: {},
        toolUsageGuardActivated: false,
        toolUsageGuardActivatedCount: 0,
      });
      expect(Array.isArray(initialState.messages.items)).toBe(true);
      expect(initialState.messages.items[0]).toBeInstanceOf(HumanMessage);

      expect(runnable.configurable).toMatchObject({
        thread_id: threadId,
        caller_agent: agent,
      });
      expect(typeof runnable.configurable.run_id).toBe('string');
      expect(runnable.recursionLimit).toBe(config.maxIterations);
      expect(runnable.streamMode).toEqual(['updates', 'messages']);
      expect(runnable.signal).toBeInstanceOf(AbortSignal);
      expect(result).toEqual({
        messages: mockMessages,
        threadId: 'test-thread',
        checkpointNs: undefined,
        needsMoreInfo: false,
        waiting: false,
      });
    });

    it('should not emit synthetic summary messages when summarize replace shrinks history (scheme A)', async () => {
      const emitSpy = vi.spyOn(agent as any, 'emit');

      const m1 = new HumanMessage('m1');
      const m2 = new HumanMessage('m2');
      const m3 = new HumanMessage('m3');
      for (const m of [m1, m2, m3]) {
        (m as any).additional_kwargs = { __runId: 'run-1' };
      }

      async function* mockStream() {
        yield [
          'updates',
          {
            node1: {
              messages: {
                mode: 'append',
                items: [m1, m2, m3],
              },
            },
          },
        ] as const;

        // Shrink history via replace: old length is 3, new length is 2.
        // Scheme A: summarization never inserts a summary message into history.
        yield [
          'updates',
          {
            summarize: {
              messages: {
                mode: 'replace',
                items: [m3],
              },
            },
          },
        ] as const;
      }

      const mockGraph = {
        stream: vi.fn().mockReturnValue(mockStream()),
      };
      agent['buildGraph'] = vi.fn().mockReturnValue(mockGraph);

      const config = {
        summarizeMaxTokens: 1000,
        summarizeKeepTokens: 500,
        instructions: 'Test instructions',
        name: 'Test Agent',
        description: 'Test agent description',
        invokeModelName: 'gpt-5-mini',
        invokeModelReasoningEffort: ReasoningEffort.None,
        maxIterations: 50,
      };

      await agent.run(
        'thread-summarize-replace',
        [new HumanMessage('Hello')],
        config,
        {
          configurable: { run_id: 'run-1', graph_id: 'graph-1' },
        } as unknown as RunnableConfig<BaseAgentConfigurable>,
      );

      const messageEvents = emitSpy.mock.calls
        .map((c) => c[0] as AgentEventType)
        .filter(
          (e): e is Extract<AgentEventType, { type: 'message' }> =>
            e?.type === 'message',
        );

      const hasSyntheticSummaryMessage = messageEvents.some((e) =>
        e.data.messages.some(
          (m) =>
            typeof (m as any)?.content === 'string' &&
            (m as any).content.startsWith('Conversation summary:\n'),
        ),
      );
      expect(hasSyntheticSummaryMessage).toBe(false);
    });

    it('should handle custom runnable config', async () => {
      async function* mockStream() {
        yield [
          'updates',
          {
            node1: {
              messages: {
                mode: 'append',
                items: [],
              },
            },
          },
        ] as const;
      }

      const mockGraph = {
        stream: vi.fn().mockReturnValue(mockStream()),
      };

      agent['buildGraph'] = vi.fn().mockReturnValue(mockGraph);

      const config = {
        summarizeMaxTokens: 1000,
        summarizeKeepTokens: 500,
        instructions: 'Test instructions',
        name: 'Test Agent',
        description: 'Test agent description',
        invokeModelName: 'gpt-5-mini',
        invokeModelReasoningEffort: ReasoningEffort.None,
        maxIterations: 50,
      };

      const customRunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'test-thread', custom: 'value' },
      };

      await agent.run('test-thread', [], config, customRunnableConfig);

      expect(mockGraph.stream).toHaveBeenCalledTimes(1);
      const [, runnable] = mockGraph.stream.mock.calls[0]!;
      expect(runnable.recursionLimit).toBe(
        Math.min(customRunnableConfig.recursionLimit, config.maxIterations),
      );
      expect(runnable.configurable).toMatchObject({
        thread_id: 'test-thread',
        caller_agent: agent,
        custom: 'value',
      });
    });

    it('should handle errors during execution', async () => {
      const mockError = new Error('Graph execution failed');

      async function* mockStream() {
        yield [
          'updates',
          { 'agent-1': { messages: { mode: 'append', items: [] } } },
        ] as const;
        throw mockError;
      }

      const mockGraph = {
        stream: vi.fn().mockReturnValue(mockStream()),
      };

      agent['buildGraph'] = vi.fn().mockReturnValue(mockGraph);

      const config = {
        summarizeMaxTokens: 1000,
        summarizeKeepTokens: 500,
        instructions: 'Test instructions',
        name: 'Test Agent',
        description: 'Test agent description',
        invokeModelName: 'gpt-5-mini',
        invokeModelReasoningEffort: ReasoningEffort.None,
        maxIterations: 50,
      };

      await expect(agent.run('test-thread', [], config)).rejects.toThrow(
        'Graph execution failed',
      );
    });
  });

  describe('runOrAppend', () => {
    const baseConfig = {
      summarizeMaxTokens: 1000,
      summarizeKeepTokens: 500,
      instructions: 'Test instructions',
      name: 'Test Agent',
      description: 'Test agent description',
      invokeModelName: 'gpt-5-mini',
      invokeModelReasoningEffort: ReasoningEffort.None,
      mcpServices: [],
    };

    beforeEach(() => {
      agent.setConfig(baseConfig);
      agent['activeRuns'].clear();
    });

    it('should throw when configuration is not set', async () => {
      agent['currentConfig'] = undefined;
      await expect(
        agent.runOrAppend('thread-1', [new HumanMessage('hi')]),
      ).rejects.toThrow('Agent configuration is required for execution');
    });

    it('should start a new run when no active run exists', async () => {
      const runSpy = vi
        .spyOn(agent, 'run')
        .mockResolvedValue(
          {} as unknown as Awaited<ReturnType<SimpleAgent['run']>>,
        );

      await agent.runOrAppend('thread-1', [new HumanMessage('hi')]);

      expect(runSpy).toHaveBeenCalled();
      runSpy.mockRestore();
    });

    it('should append pending messages when inject_after_tool_call', async () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);

      const runnableConfig = {
        configurable: { run_id: 'run-1', graph_id: 'graph-1' },
      };

      const lastState = buildAgentState();
      agent['activeRuns'].set('run-1', {
        abortController: new AbortController(),
        runnableConfig: runnableConfig as RunnableConfig<BaseAgentConfigurable>,
        threadId: 'thread-1',
        lastState,
      });

      const message = new HumanMessage('Follow-up');
      const result = await agent.runOrAppend('thread-1', [message]);

      const threadState = graphThreadState.getByThread('thread-1');
      expect(threadState.pendingMessages).toHaveLength(1);
      expect(threadState.pendingMessages[0]?.additional_kwargs?.__runId).toBe(
        'run-1',
      );

      expect(result).toEqual({
        messages: lastState.messages,
        threadId: 'thread-1',
        checkpointNs: undefined,
        needsMoreInfo: false,
      });
    });

    it('should keep newMessageMode when mode is wait_for_completion', async () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);

      graphThreadState.applyForThread('thread-1', {
        pendingMessages: [],
        newMessageMode: NewMessageMode.WaitForCompletion,
      });

      const runnableConfig = {
        configurable: { run_id: 'run-1', graph_id: 'graph-1' },
      };

      agent['activeRuns'].set('run-1', {
        abortController: new AbortController(),
        runnableConfig: runnableConfig as RunnableConfig<BaseAgentConfigurable>,
        threadId: 'thread-1',
        lastState: buildAgentState(),
      });

      await agent.runOrAppend('thread-1', [new HumanMessage('hi')]);

      const threadState = graphThreadState.getByThread('thread-1');
      expect(threadState.pendingMessages).toHaveLength(1);
      expect(threadState.newMessageMode).toBe(NewMessageMode.WaitForCompletion);
    });

    it('should emit nodeAdditionalMetadataUpdate when pending messages change', async () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);

      const runnableConfig = {
        configurable: { run_id: 'run-1', graph_id: 'graph-1' },
      };

      const lastState = buildAgentState();
      agent['activeRuns'].set('run-1', {
        abortController: new AbortController(),
        runnableConfig: runnableConfig as RunnableConfig<BaseAgentConfigurable>,
        threadId: 'thread-1',
        lastState,
      });

      const emitSpy = vi.spyOn(agent as any, 'emit');

      await agent.runOrAppend('thread-1', [new HumanMessage('Follow-up')]);

      const nodeMetadataEvent = emitSpy.mock.calls
        .map((call) => call[0] as AgentEventType)
        .find(
          (
            event,
          ): event is Extract<
            AgentEventType,
            { type: 'nodeAdditionalMetadataUpdate' }
          > => event?.type === 'nodeAdditionalMetadataUpdate',
        );

      expect(nodeMetadataEvent).toBeDefined();

      if (!nodeMetadataEvent) {
        throw new Error('nodeAdditionalMetadataUpdate event not emitted');
      }

      const additionalMetadata = nodeMetadataEvent.data.additionalMetadata as
        | { pendingMessages?: { content?: string }[] }
        | undefined;

      expect(nodeMetadataEvent).toEqual(
        expect.objectContaining({
          type: 'nodeAdditionalMetadataUpdate',
          data: expect.objectContaining({
            metadata: { threadId: 'thread-1', runId: 'run-1' },
          }),
        }),
      );

      expect(additionalMetadata?.pendingMessages).toBeDefined();
      expect(additionalMetadata?.pendingMessages?.[0]?.content).toBe(
        'Follow-up',
      );
    });
  });

  describe('buildGraph', () => {
    it('should have buildGraph method available', () => {
      // buildGraph is a private method, just test that the agent has the method
      expect(typeof agent['buildGraph']).toBe('function');
    });
  });

  describe('stop', () => {
    it('should handle stop when no active runs exist', async () => {
      // Verify no active runs
      expect(agent['activeRuns'].size).toBe(0);

      // Stop should not throw
      await expect(agent.stop()).resolves.not.toThrow();
    });

    it('should dispose compiled graph and reset cache on stop', async () => {
      await agent.stop();

      expect(agent['graph']).toBeUndefined();
    });

    it('should handle abort errors gracefully during stream processing', async () => {
      const mockGraph = {
        stream: vi.fn(),
      } as unknown as { stream: any };

      async function* mockStream() {
        yield [
          'updates',
          {
            node1: {
              messages: { mode: 'append', items: [] },
            },
          },
        ] as const;
        await new Promise((resolve) => setTimeout(resolve, 50));
        // Simulate abort error
        const error = new Error('The operation was aborted');
        (error as any).name = 'AbortError';
        throw error;
      }

      mockGraph.stream = vi.fn().mockImplementation((_state) => {
        // Get the abort controller from the agent's active runs and abort it
        // This simulates what happens when stop() is called
        setTimeout(() => {
          const activeRuns = agent['activeRuns'];
          for (const run of activeRuns.values()) {
            run.abortController.abort();
          }
        }, 10);
        return mockStream();
      });

      agent['buildGraph'] = vi.fn().mockReturnValue(mockGraph);

      const config = {
        summarizeMaxTokens: 1000,
        summarizeKeepTokens: 500,
        instructions: 'Test instructions',
        name: 'Test Agent',
        description: 'Test agent description',
        invokeModelName: 'gpt-5-mini',
        invokeModelReasoningEffort: ReasoningEffort.None,
        maxIterations: 50,
      };

      // Run should complete without throwing (abort error is swallowed)
      const result = await agent.run(
        'thread-789',
        [new HumanMessage('Hello')],
        config,
      );

      expect(result).toBeDefined();
      expect(agent['activeRuns'].size).toBe(0);
    });
  });

  describe('setConfig', () => {
    it('should update configuration and clear graph', () => {
      const config = {
        summarizeMaxTokens: 1000,
        summarizeKeepTokens: 500,
        instructions: 'Test instructions',
        name: 'Test Agent',
        description: 'Test agent description',
        invokeModelName: 'gpt-5-mini',
        invokeModelReasoningEffort: ReasoningEffort.None,
        maxIterations: 50,
      };

      // Simulate a graph being built
      agent['graph'] = {} as any;
      agent['currentConfig'] = config;

      const newConfig = {
        ...config,
        instructions: 'Updated instructions',
      };

      // Call setConfig
      agent.setConfig(newConfig);

      // Graph should be cleared for rebuild
      expect(agent['graph']).toBeUndefined();
      // New config should be stored
      expect(agent['currentConfig']).toEqual(newConfig);
    });

    it('should clear graph even when no graph exists', () => {
      const config = {
        summarizeMaxTokens: 1000,
        summarizeKeepTokens: 500,
        instructions: 'Test instructions',
        name: 'Test Agent',
        description: 'Test agent description',
        invokeModelName: 'gpt-5-mini',
        invokeModelReasoningEffort: ReasoningEffort.None,
        maxIterations: 50,
      };

      // Ensure no graph exists
      agent['graph'] = undefined;

      // Call setConfig
      agent.setConfig(config);

      // Graph should remain undefined
      expect(agent['graph']).toBeUndefined();
      // Config should be stored
      expect(agent['currentConfig']).toEqual(config);
    });
  });

  describe('getGraphNodeMetadata', () => {
    it('should return undefined when no graph thread state is set', () => {
      const metadata = agent.getGraphNodeMetadata({ threadId: 'thread-1' });
      // When no config is set, metadata should be undefined or only contain connectedTools
      if (metadata) {
        expect(metadata).toEqual({ connectedTools: [] });
      } else {
        expect(metadata).toBeUndefined();
      }
    });

    it('should return instructions when configured even without thread state', () => {
      agent.setConfig({
        name: 'Test Agent',
        description: 'Test agent description',
        instructions: 'Follow these steps',
        summarizeMaxTokens: 1000,
        summarizeKeepTokens: 500,
        invokeModelName: 'gpt-5-mini',
        invokeModelReasoningEffort: ReasoningEffort.None,
      });

      const metadata = agent.getGraphNodeMetadata({});

      expect(metadata).toEqual({
        instructions: 'Follow these steps',
        connectedTools: [],
      });
    });

    it('should return empty pending messages when there are no pending messages', () => {
      agent.setConfig({
        name: 'Test Agent',
        description: 'Test agent description',
        instructions: 'Agent instructions',
        summarizeMaxTokens: 1000,
        summarizeKeepTokens: 500,
        invokeModelName: 'gpt-5-mini',
        invokeModelReasoningEffort: ReasoningEffort.None,
      });

      const threadState = new GraphThreadState();
      setGraphThreadState(threadState);

      const metadata = agent.getGraphNodeMetadata({ threadId: 'thread-1' });
      expect(metadata).toEqual({
        pendingMessages: [],
        reasoningChunks: {},
        instructions: 'Agent instructions',
        connectedTools: [],
      });
    });

    it('should return pending messages for a thread', () => {
      agent.setConfig({
        name: 'Test Agent',
        description: 'Test agent description',
        instructions: 'Agent instructions',
        summarizeMaxTokens: 1000,
        summarizeKeepTokens: 500,
        invokeModelName: 'gpt-5-mini',
        invokeModelReasoningEffort: ReasoningEffort.None,
      });

      const threadState = new GraphThreadState();
      setGraphThreadState(threadState);

      const message = new HumanMessage('pending');
      threadState.applyForThread('thread-1', { pendingMessages: [message] });

      const metadata = agent.getGraphNodeMetadata({ threadId: 'thread-1' });

      expect(metadata).toEqual({
        pendingMessages: [
          {
            content: 'pending',
            role: 'human',
            additionalKwargs: {},
          },
        ],
        reasoningChunks: {},
        instructions: 'Agent instructions',
        connectedTools: [],
      });
    });
  });

  describe('reasoning metadata handling', () => {
    const threadId = 'thread-reasoning';
    const runId = 'run-reasoning';

    const registerActiveRun = () => {
      agent['activeRuns'].set(runId, {
        abortController: new AbortController(),
        runnableConfig: {
          configurable: { run_id: runId, graph_id: 'graph-1' },
        } as RunnableConfig<BaseAgentConfigurable>,
        threadId,
        lastState: buildAgentState(),
      });
    };

    afterEach(() => {
      agent['activeRuns'].clear();
    });

    it('should emit node metadata updates when reasoning chunks change', async () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);
      registerActiveRun();

      const events: AgentEventType[] = [];
      const unsubscribe = agent.subscribe(async (event) => {
        events.push(event);
      });

      const reasoningMessage = buildReasoningMessage(
        'planning step',
        'message-1',
      );

      if (!reasoningMessage.id) {
        throw new Error('Reasoning message id missing');
      }

      graphThreadState.applyForThread(threadId, {
        reasoningChunks: new Map([[reasoningMessage.id, reasoningMessage]]),
      });

      await waitForMicrotasks();

      const metadataEvent = events
        .filter(
          (
            event,
          ): event is Extract<
            AgentEventType,
            { type: 'nodeAdditionalMetadataUpdate' }
          > => event.type === 'nodeAdditionalMetadataUpdate',
        )
        .at(-1);

      expect(metadataEvent).toBeDefined();
      expect(metadataEvent?.data.additionalMetadata?.reasoningChunks).toEqual(
        expect.objectContaining({
          [reasoningMessage.id]: expect.objectContaining({
            id: reasoningMessage.id,
            content: reasoningMessage.content,
          }),
        }),
      );

      unsubscribe();
    });

    it('should clear reasoning state and notify subscribers', async () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);
      registerActiveRun();

      const reasoningMessage = buildReasoningMessage(
        'cleanup step',
        'message-2',
      );

      if (!reasoningMessage.id) {
        throw new Error('Reasoning message id missing');
      }

      graphThreadState.applyForThread(threadId, {
        reasoningChunks: new Map([[reasoningMessage.id, reasoningMessage]]),
      });

      const events: AgentEventType[] = [];
      const unsubscribe = agent.subscribe(async (event) => {
        events.push(event);
      });

      events.length = 0;

      (agent as any).clearReasoningState(threadId);

      await waitForMicrotasks();

      const state = graphThreadState.getByThread(threadId);
      expect(state.reasoningChunks.size).toBe(0);

      const metadataEvent = events
        .filter(
          (
            event,
          ): event is Extract<
            AgentEventType,
            { type: 'nodeAdditionalMetadataUpdate' }
          > => event.type === 'nodeAdditionalMetadataUpdate',
        )
        .at(-1);

      expect(metadataEvent).toBeDefined();
      expect(metadataEvent?.data.additionalMetadata?.reasoningChunks).toEqual(
        {},
      );

      unsubscribe();
    });

    it('should align reasoning message ids between notifications and message stream', () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);

      const reasoningChunk = {
        id: 'chunk-123',
        contentBlocks: [
          {
            type: 'reasoning',
            reasoning: 'step 1',
          },
        ],
        response_metadata: {},
      } as AIMessageChunk;

      (agent as any).handleReasoningChunk(threadId, reasoningChunk);

      const metadata = agent.getGraphNodeMetadata({ threadId });
      const reasoningMetadata = metadata?.reasoningChunks as
        | Record<string, { id: string }>
        | undefined;

      const metadataEntry = reasoningMetadata?.['reasoning:chunk-123'];
      expect(metadataEntry).toBeDefined();

      const reasoningMessage = buildReasoningMessage('step 1', 'chunk-123');
      expect(metadataEntry?.id).toBe(reasoningMessage.id);
      expect(reasoningMessage.id).toBe('reasoning:chunk-123');
    });

    it('should extract reasoning from contentBlocks (e.g. DeepSeek via ReasoningAwareChatCompletions)', () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);

      const reasoningChunk = {
        id: 'chunk-deepseek',
        contentBlocks: [
          { type: 'reasoning', reasoning: 'DeepSeek reasoning chunk' },
        ],
        response_metadata: {},
      } as unknown as AIMessageChunk;

      (agent as any).handleReasoningChunk(threadId, reasoningChunk);

      const metadata = agent.getGraphNodeMetadata({ threadId });
      const reasoningMetadata = metadata?.reasoningChunks as
        | Record<string, { id: string; content: string }>
        | undefined;

      const metadataEntry = reasoningMetadata?.['reasoning:chunk-deepseek'];
      expect(metadataEntry).toBeDefined();
      expect(metadataEntry?.content).toBe('DeepSeek reasoning chunk');
    });

    it('should propagate __toolCallId and __interAgentCommunication into the reasoningChunks socket payload', async () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);

      // Register an active run that carries the communication context
      agent['activeRuns'].set(runId, {
        abortController: new AbortController(),
        runnableConfig: {
          configurable: {
            run_id: runId,
            graph_id: 'graph-1',
            __toolCallId: 'tc-1',
            __interAgentCommunication: true,
          },
        } as RunnableConfig<BaseAgentConfigurable>,
        threadId,
        lastState: buildAgentState(),
      });

      const events: AgentEventType[] = [];
      const unsubscribe = agent.subscribe(async (event) => {
        events.push(event);
      });

      const reasoningChunk = {
        id: 'chunk-tagged',
        content: '',
        contentBlocks: [
          { type: 'reasoning', reasoning: 'tagged reasoning step' },
        ],
        response_metadata: {},
      } as AIMessageChunk;

      (agent as any).handleReasoningChunk(threadId, reasoningChunk);

      await waitForMicrotasks();

      const metadataEvent = events
        .filter(
          (
            event,
          ): event is Extract<
            AgentEventType,
            { type: 'nodeAdditionalMetadataUpdate' }
          > => event.type === 'nodeAdditionalMetadataUpdate',
        )
        .at(-1);

      expect(metadataEvent).toBeDefined();

      const reasoningChunks = metadataEvent?.data.additionalMetadata
        ?.reasoningChunks as
        | Record<
            string,
            {
              id: string;
              content: string;
              toolCallId?: string;
              interAgentCommunication?: boolean;
            }
          >
        | undefined;

      const entry = reasoningChunks?.['reasoning:chunk-tagged'];
      expect(entry).toBeDefined();
      expect(entry?.toolCallId).toBe('tc-1');
      expect(entry?.interAgentCommunication).toBe(true);

      unsubscribe();
    });

    it('should forward __toolCallId and __interAgentCommunication to persisted message when clearReasoningState is called with persist:true', async () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);

      const persistRunnableConfig = {
        configurable: {
          run_id: runId,
          graph_id: 'graph-1',
          __toolCallId: 'tc-1',
          __interAgentCommunication: true,
        },
      } as RunnableConfig<BaseAgentConfigurable>;

      // Register active run so handleReasoningChunk can read the context
      agent['activeRuns'].set(runId, {
        abortController: new AbortController(),
        runnableConfig: persistRunnableConfig,
        threadId,
        lastState: buildAgentState(),
      });

      // Drive a reasoning chunk to populate graphThreadState.reasoningChunks
      const reasoningChunk = {
        id: 'chunk-persist',
        content: '',
        contentBlocks: [
          { type: 'reasoning', reasoning: 'persist reasoning step' },
        ],
        response_metadata: {},
      } as AIMessageChunk;

      (agent as any).handleReasoningChunk(threadId, reasoningChunk);

      const events: AgentEventType[] = [];
      const unsubscribe = agent.subscribe(async (event) => {
        events.push(event);
      });

      // Clear with persist:true — this should emit a 'message' event whose
      // reasoning ChatMessage has __toolCallId + __interAgentCommunication
      (agent as any).clearReasoningState(threadId, {
        persist: true,
        config: persistRunnableConfig,
      });

      await waitForMicrotasks();

      const messageEvent = events
        .filter(
          (event): event is Extract<AgentEventType, { type: 'message' }> =>
            event?.type === 'message',
        )
        .at(-1);

      expect(messageEvent).toBeDefined();

      const reasoningMsg = messageEvent?.data.messages.find(
        (m) =>
          (m as unknown as { role?: unknown }).role === 'reasoning' ||
          m.type === 'reasoning',
      );

      expect(reasoningMsg).toBeDefined();

      const kwargs = reasoningMsg?.additional_kwargs as
        | Record<string, unknown>
        | undefined;

      expect(kwargs?.__toolCallId).toBe('tc-1');
      expect(kwargs?.__interAgentCommunication).toBe(true);

      unsubscribe();
    });

    // Test A: two chunks with different ids → two separate persisted ChatMessages
    it('should emit two separate ChatMessages when two chunks with different ids arrive in sequence', async () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);

      const runnableConfig = {
        configurable: {
          run_id: runId,
          graph_id: 'graph-1',
        },
      } as RunnableConfig<BaseAgentConfigurable>;

      agent['activeRuns'].set(runId, {
        abortController: new AbortController(),
        runnableConfig,
        threadId,
        lastState: buildAgentState(),
      });

      const events: AgentEventType[] = [];
      const unsubscribe = agent.subscribe(async (event) => {
        events.push(event);
      });

      // First chunk with id "chunk-A"
      const chunkA = {
        id: 'chunk-A',
        content: '',
        contentBlocks: [{ type: 'reasoning', reasoning: 'reasoning block A' }],
        response_metadata: {},
      } as AIMessageChunk;

      // Second chunk with different id "chunk-B"
      const chunkB = {
        id: 'chunk-B',
        content: '',
        contentBlocks: [{ type: 'reasoning', reasoning: 'reasoning block B' }],
        response_metadata: {},
      } as AIMessageChunk;

      (agent as any).handleReasoningChunk(threadId, chunkA);
      // Arriving chunk-B with a different id should flush chunk-A first
      (agent as any).handleReasoningChunk(threadId, chunkB);

      // Now clear with persist to flush chunk-B
      (agent as any).clearReasoningState(threadId, {
        persist: true,
        config: runnableConfig,
      });

      await waitForMicrotasks();

      const messageEvents = events.filter(
        (event): event is Extract<AgentEventType, { type: 'message' }> =>
          event?.type === 'message',
      );

      const reasoningMessages = messageEvents.flatMap((e) =>
        e.data.messages.filter(
          (m) =>
            (m as unknown as { role?: unknown }).role === 'reasoning' ||
            m.type === 'reasoning',
        ),
      );

      // Must produce exactly two reasoning messages — one per id
      expect(reasoningMessages).toHaveLength(2);

      const contents = reasoningMessages.map((m) =>
        typeof m.content === 'string' ? m.content : '',
      );
      expect(contents).toContain('reasoning block A');
      expect(contents).toContain('reasoning block B');

      // Each emitted message must carry the correct single-prefixed id
      // ("reasoning:<originalId>"), not a double-prefixed one.
      const ids = reasoningMessages.map((m) => m.id);
      expect(ids).toContain('reasoning:chunk-A');
      expect(ids).toContain('reasoning:chunk-B');

      unsubscribe();
    });

    // Test B: multiple chunks with same id → accumulate into one ChatMessage
    it('should accumulate multiple chunks with the same id into one ChatMessage', async () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);

      const runnableConfig = {
        configurable: {
          run_id: runId,
          graph_id: 'graph-1',
        },
      } as RunnableConfig<BaseAgentConfigurable>;

      agent['activeRuns'].set(runId, {
        abortController: new AbortController(),
        runnableConfig,
        threadId,
        lastState: buildAgentState(),
      });

      const events: AgentEventType[] = [];
      const unsubscribe = agent.subscribe(async (event) => {
        events.push(event);
      });

      // Three chunks sharing the same id "chunk-same"
      const makeChunk = (text: string) =>
        ({
          id: 'chunk-same',
          content: '',
          contentBlocks: [{ type: 'reasoning', reasoning: text }],
          response_metadata: {},
        }) as AIMessageChunk;

      (agent as any).handleReasoningChunk(threadId, makeChunk('part 1 '));
      (agent as any).handleReasoningChunk(threadId, makeChunk('part 2 '));
      (agent as any).handleReasoningChunk(threadId, makeChunk('part 3'));

      (agent as any).clearReasoningState(threadId, {
        persist: true,
        config: runnableConfig,
      });

      await waitForMicrotasks();

      const messageEvents = events.filter(
        (event): event is Extract<AgentEventType, { type: 'message' }> =>
          event?.type === 'message',
      );

      const reasoningMessages = messageEvents.flatMap((e) =>
        e.data.messages.filter(
          (m) =>
            (m as unknown as { role?: unknown }).role === 'reasoning' ||
            m.type === 'reasoning',
        ),
      );

      // All three parts should accumulate into one message
      expect(reasoningMessages).toHaveLength(1);
      const content =
        typeof reasoningMessages[0]?.content === 'string'
          ? reasoningMessages[0].content
          : '';
      expect(content).toBe('part 1 part 2 part 3');

      unsubscribe();
    });

    // Test C: in-flight chunk at invoke_llm completion is persisted (not discarded)
    it('should persist in-flight reasoning chunk when invoke_llm node update is received', async () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);

      const runnableConfig = {
        configurable: {
          run_id: runId,
          graph_id: 'graph-1',
        },
      } as RunnableConfig<BaseAgentConfigurable>;

      agent['activeRuns'].set(runId, {
        abortController: new AbortController(),
        runnableConfig,
        threadId,
        lastState: buildAgentState(),
      });

      // Seed an in-flight reasoning chunk directly in the state
      const inFlightReasoning = buildReasoningMessage(
        'in-flight reasoning',
        'chunk-inflight',
      );
      if (!inFlightReasoning.id) {
        throw new Error('Reasoning message id missing');
      }
      graphThreadState.applyForThread(threadId, {
        reasoningChunks: new Map([[inFlightReasoning.id, inFlightReasoning]]),
      });

      const events: AgentEventType[] = [];
      const unsubscribe = agent.subscribe(async (event) => {
        events.push(event);
      });

      // Simulate what happens after invoke_llm: clearReasoningState with persist:true
      (agent as any).clearReasoningState(threadId, {
        persist: true,
        config: runnableConfig,
      });

      await waitForMicrotasks();

      const messageEvents = events.filter(
        (event): event is Extract<AgentEventType, { type: 'message' }> =>
          event?.type === 'message',
      );

      const reasoningMessages = messageEvents.flatMap((e) =>
        e.data.messages.filter(
          (m) =>
            (m as unknown as { role?: unknown }).role === 'reasoning' ||
            m.type === 'reasoning',
        ),
      );

      // The in-flight chunk must be persisted
      expect(reasoningMessages).toHaveLength(1);
      const content =
        typeof reasoningMessages[0]?.content === 'string'
          ? reasoningMessages[0].content
          : '';
      expect(content).toBe('in-flight reasoning');

      // State must be cleared
      const state = graphThreadState.getByThread(threadId);
      expect(state.reasoningChunks.size).toBe(0);

      unsubscribe();
    });

    // Test D: routing metadata is preserved per persisted message
    it('should preserve __toolCallId, __interAgentCommunication, and __sourceAgentNodeId per persisted reasoning message on id change', async () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);

      const runnableConfig = {
        configurable: {
          run_id: runId,
          graph_id: 'graph-1',
          __toolCallId: 'tc-routing',
          __interAgentCommunication: true,
          __sourceAgentNodeId: 'node-src',
        },
      } as RunnableConfig<BaseAgentConfigurable>;

      agent['activeRuns'].set(runId, {
        abortController: new AbortController(),
        runnableConfig,
        threadId,
        lastState: buildAgentState(),
      });

      const events: AgentEventType[] = [];
      const unsubscribe = agent.subscribe(async (event) => {
        events.push(event);
      });

      // First chunk — will be flushed when second different-id chunk arrives
      const chunkFirst = {
        id: 'chunk-first',
        content: '',
        contentBlocks: [{ type: 'reasoning', reasoning: 'first block' }],
        response_metadata: {},
      } as AIMessageChunk;

      // Second chunk with different id — triggers flush of first
      const chunkSecond = {
        id: 'chunk-second',
        content: '',
        contentBlocks: [{ type: 'reasoning', reasoning: 'second block' }],
        response_metadata: {},
      } as AIMessageChunk;

      (agent as any).handleReasoningChunk(threadId, chunkFirst);
      (agent as any).handleReasoningChunk(threadId, chunkSecond);

      // Flush the second chunk
      (agent as any).clearReasoningState(threadId, {
        persist: true,
        config: runnableConfig,
      });

      await waitForMicrotasks();

      const messageEvents = events.filter(
        (event): event is Extract<AgentEventType, { type: 'message' }> =>
          event?.type === 'message',
      );

      const reasoningMessages = messageEvents.flatMap((e) =>
        e.data.messages.filter(
          (m) =>
            (m as unknown as { role?: unknown }).role === 'reasoning' ||
            m.type === 'reasoning',
        ),
      );

      expect(reasoningMessages).toHaveLength(2);

      for (const msg of reasoningMessages) {
        const kwargs = msg.additional_kwargs as Record<string, unknown>;
        expect(kwargs.__toolCallId).toBe('tc-routing');
        expect(kwargs.__interAgentCommunication).toBe(true);
        expect(kwargs.__sourceAgentNodeId).toBe('node-src');
      }

      // Each emitted message must carry the correct single-prefixed id
      // ("reasoning:<originalId>"), not a double-prefixed one.
      const ids = reasoningMessages.map((m) => m.id);
      expect(ids).toContain('reasoning:chunk-first');
      expect(ids).toContain('reasoning:chunk-second');

      unsubscribe();
    });

    // Test E: per-block-id accumulation — regression for OpenAI Responses API
    // where chunk.id changes on every token but contentBlocks[].id is stable.
    it('should accumulate chunks with different chunk.id but same contentBlock.id into one ChatMessage', async () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);

      const runnableConfig = {
        configurable: {
          run_id: runId,
          graph_id: 'graph-1',
        },
      } as RunnableConfig<BaseAgentConfigurable>;

      agent['activeRuns'].set(runId, {
        abortController: new AbortController(),
        runnableConfig,
        threadId,
        lastState: buildAgentState(),
      });

      const events: AgentEventType[] = [];
      const unsubscribe = agent.subscribe(async (event) => {
        events.push(event);
      });

      const stableBlockId = 'block-openai-stable';

      // Three chunks: chunk.id changes every token (OpenAI Responses API behavior),
      // but contentBlocks[].id is stable — that is the true accumulation key.
      const chunk1 = {
        id: 'token-001',
        content: '',
        contentBlocks: [
          { type: 'reasoning', reasoning: 'need ', id: stableBlockId },
        ],
        response_metadata: {},
      } as AIMessageChunk;
      const chunk2 = {
        id: 'token-002',
        content: '',
        contentBlocks: [
          { type: 'reasoning', reasoning: 'to ', id: stableBlockId },
        ],
        response_metadata: {},
      } as AIMessageChunk;
      const chunk3 = {
        id: 'token-003',
        content: '',
        contentBlocks: [
          { type: 'reasoning', reasoning: 'think.', id: stableBlockId },
        ],
        response_metadata: {},
      } as AIMessageChunk;

      (agent as any).handleReasoningChunk(threadId, chunk1);
      (agent as any).handleReasoningChunk(threadId, chunk2);
      (agent as any).handleReasoningChunk(threadId, chunk3);

      // Flush via clearReasoningState
      (agent as any).clearReasoningState(threadId, {
        persist: true,
        config: runnableConfig,
      });

      await waitForMicrotasks();

      const messageEvents = events.filter(
        (event): event is Extract<AgentEventType, { type: 'message' }> =>
          event?.type === 'message',
      );

      const reasoningMessages = messageEvents.flatMap((e) =>
        e.data.messages.filter(
          (m) =>
            (m as unknown as { role?: unknown }).role === 'reasoning' ||
            m.type === 'reasoning',
        ),
      );

      // All three tokens share the same blockId → must produce exactly ONE message
      expect(reasoningMessages).toHaveLength(1);
      const content =
        typeof reasoningMessages[0]?.content === 'string'
          ? reasoningMessages[0].content
          : '';
      expect(content).toBe('need to think.');

      // The persisted message id is keyed on the stable blockId
      expect(reasoningMessages[0]?.id).toBe(`reasoning:${stableBlockId}`);

      unsubscribe();
    });

    // Test F: fallback to chunk.id when contentBlock carries no id (backward compat)
    it('should fall back to chunk.id when contentBlock carries no id', async () => {
      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);

      const runnableConfig = {
        configurable: {
          run_id: runId,
          graph_id: 'graph-1',
        },
      } as RunnableConfig<BaseAgentConfigurable>;

      agent['activeRuns'].set(runId, {
        abortController: new AbortController(),
        runnableConfig,
        threadId,
        lastState: buildAgentState(),
      });

      const events: AgentEventType[] = [];
      const unsubscribe = agent.subscribe(async (event) => {
        events.push(event);
      });

      // Block with no id field — should fall back to chunk.id
      const chunkNoBlockId = {
        id: 'chunk-fallback-id',
        content: '',
        contentBlocks: [{ type: 'reasoning', reasoning: 'fallback reasoning' }],
        response_metadata: {},
      } as AIMessageChunk;

      (agent as any).handleReasoningChunk(threadId, chunkNoBlockId);

      (agent as any).clearReasoningState(threadId, {
        persist: true,
        config: runnableConfig,
      });

      await waitForMicrotasks();

      const messageEvents = events.filter(
        (event): event is Extract<AgentEventType, { type: 'message' }> =>
          event?.type === 'message',
      );

      const reasoningMessages = messageEvents.flatMap((e) =>
        e.data.messages.filter(
          (m) =>
            (m as unknown as { role?: unknown }).role === 'reasoning' ||
            m.type === 'reasoning',
        ),
      );

      expect(reasoningMessages).toHaveLength(1);
      expect(reasoningMessages[0]?.id).toBe('reasoning:chunk-fallback-id');
      expect(
        typeof reasoningMessages[0]?.content === 'string'
          ? reasoningMessages[0].content
          : '',
      ).toBe('fallback reasoning');

      unsubscribe();
    });

    // Test G: LangGraph JS leaks messages-mode events from nested compiled.stream()
    // calls into the parent stream; they carry the same langgraph_node='invoke_llm'
    // but arrive AFTER the parent's updates/invoke_llm event has already fired.
    it('should ignore leaked subagent invoke_llm chunks that arrive after the parent invoke_llm updates event', async () => {
      const config = {
        summarizeMaxTokens: 1000,
        summarizeKeepTokens: 500,
        instructions: 'Test instructions',
        name: 'Test Agent',
        description: 'Test agent description',
        invokeModelName: 'gpt-5-mini',
        invokeModelReasoningEffort: ReasoningEffort.None,
        maxIterations: 50,
      };

      // (a) Parent reasoning chunk for block A — arrives before invoke_llm updates
      const parentChunkA = {
        id: 'resp_parent-A',
        content: '',
        contentBlocks: [{ type: 'reasoning', reasoning: 'parent reasoning A' }],
        response_metadata: {},
      } as AIMessageChunk;

      // (c) Leaked subagent chunk — different block id, arrives after invoke_llm updates
      const leakedChunk = {
        id: 'resp_subagent-B',
        content: '',
        contentBlocks: [{ type: 'reasoning', reasoning: 'subagent leaked' }],
        response_metadata: {},
      } as AIMessageChunk;

      async function* mockStream() {
        // (a) messages-mode: parent reasoning chunk before updates/invoke_llm
        yield [
          'messages',
          [parentChunkA, { langgraph_node: 'invoke_llm' }],
        ] as const;

        // (b) updates-mode: invoke_llm fires — parent's LLM turn complete
        yield [
          'updates',
          {
            invoke_llm: {
              messages: { mode: 'append', items: [] },
            },
          },
        ] as const;

        // (c) messages-mode: leaked subagent chunk arrives AFTER invoke_llm updates
        yield [
          'messages',
          [leakedChunk, { langgraph_node: 'invoke_llm' }],
        ] as const;

        // (d) updates-mode: tools node fires — clears lastUpdatesNode to 'tools'
        yield [
          'updates',
          {
            tools: {
              messages: { mode: 'append', items: [] },
            },
          },
        ] as const;
      }

      const mockGraph = {
        stream: vi.fn().mockReturnValue(mockStream()),
      };
      agent['buildGraph'] = vi.fn().mockReturnValue(mockGraph);

      const emitSpy = vi.spyOn(agent as any, 'emit');

      const graphThreadState = new GraphThreadState();
      setGraphThreadState(graphThreadState);

      await agent.run('thread-leak-guard', [new HumanMessage('test')], config);

      const allEvents = emitSpy.mock.calls.map((c) => c[0] as AgentEventType);

      // Collect all reasoning messages emitted via message events
      const reasoningMessages = allEvents
        .filter(
          (e): e is Extract<AgentEventType, { type: 'message' }> =>
            e?.type === 'message',
        )
        .flatMap((e) =>
          e.data.messages.filter(
            (m) =>
              (m as unknown as { role?: unknown }).role === 'reasoning' ||
              m.type === 'reasoning',
          ),
        );

      // Only block A (parent reasoning) must be persisted — the leaked subagent
      // chunk must be silently dropped.
      expect(reasoningMessages).toHaveLength(1);
      const content =
        typeof reasoningMessages[0]?.content === 'string'
          ? reasoningMessages[0].content
          : '';
      expect(content).toBe('parent reasoning A');
      expect(reasoningMessages[0]?.id).toBe('reasoning:resp_parent-A');
    });
  });

  describe('deferred tool loading', () => {
    const baseConfig: SimpleAgentSchemaType = {
      name: 'Test Agent',
      description: 'Test agent description',
      instructions: 'Test instructions',
      invokeModelName: 'gpt-5-mini',
      invokeModelReasoningEffort: ReasoningEffort.None,
      summarizeMaxTokens: 1000,
      summarizeKeepTokens: 500,
    };

    const makeMockTool = (name: string) =>
      ({
        name,
        description: `Mock tool ${name}`,
        invoke: vi.fn(),
      }) as unknown as DynamicStructuredTool;

    it('initTools() creates deferred registry with non-core tools', async () => {
      const mockTool = makeMockTool('mock-tool');
      agent.addTool(mockTool);

      await agent.initTools(baseConfig);

      // Non-core tool should be in deferred registry
      expect(agent.getDeferredTools().has('mock-tool')).toBe(true);
      // Non-core tool should NOT be in active tools
      const activeNames = agent.getTools().map((t) => t.name);
      expect(activeNames).not.toContain('mock-tool');
    });

    it('getTools() returns only active tools initially', async () => {
      const mockTool = makeMockTool('graph-tool');
      agent.addTool(mockTool);

      await agent.initTools(baseConfig);

      const activeNames = agent.getTools().map((t) => t.name);
      expect(activeNames).toContain('finish');
      expect(activeNames).toContain('wait_for');
      expect(activeNames).toContain('tool_search');
      expect(activeNames).not.toContain('graph-tool');
    });

    it('loadTool() moves tool from deferred to active', async () => {
      const mockTool = makeMockTool('lazy-tool');
      agent.addTool(mockTool);

      await agent.initTools(baseConfig);

      expect(agent.getDeferredTools().has('lazy-tool')).toBe(true);
      expect(agent.getTools().map((t) => t.name)).not.toContain('lazy-tool');

      const result = agent.loadTool('lazy-tool');

      expect(result).not.toBeNull();
      expect(agent.getDeferredTools().has('lazy-tool')).toBe(false);
      expect(agent.getTools().map((t) => t.name)).toContain('lazy-tool');
    });

    it('loadTool() returns null for already-loaded tool (dedup)', async () => {
      const mockTool = makeMockTool('already-loaded');
      agent.addTool(mockTool);

      await agent.initTools(baseConfig);
      agent.loadTool('already-loaded');

      // Second call should return null
      const result = agent.loadTool('already-loaded');
      expect(result).toBeNull();
    });

    it('loadTool() returns null for unknown tool', async () => {
      await agent.initTools(baseConfig);

      const result = agent.loadTool('nonexistent-tool');
      expect(result).toBeNull();
    });

    it('loadTool() pushes to the shared activeTools array', async () => {
      const mockTool = makeMockTool('shared-ref-tool');
      agent.addTool(mockTool);

      await agent.initTools(baseConfig);

      // Capture the array reference before loading
      const toolsArrayBefore = agent.getTools();

      agent.loadTool('shared-ref-tool');

      // The same array reference should now contain the newly loaded tool
      expect(toolsArrayBefore).toBe(agent.getTools());
      expect(toolsArrayBefore.map((t) => t.name)).toContain('shared-ref-tool');
    });

    it('getDeferredTools() returns the deferred map', async () => {
      const mockTool1 = makeMockTool('deferred-a');
      const mockTool2 = makeMockTool('deferred-b');
      agent.addTool(mockTool1);
      agent.addTool(mockTool2);

      await agent.initTools(baseConfig);

      const deferred = agent.getDeferredTools();
      expect(deferred).toBeInstanceOf(Map);
      expect(deferred.has('deferred-a')).toBe(true);
      expect(deferred.has('deferred-b')).toBe(true);
    });

    it('resetTools() clears both active and deferred', async () => {
      const mockTool = makeMockTool('to-be-reset');
      agent.addTool(mockTool);

      await agent.initTools(baseConfig);

      // Pre-condition: there are tools
      expect(agent.getTools().length).toBeGreaterThan(0);
      expect(agent.getDeferredTools().size).toBeGreaterThan(0);

      agent.resetTools();

      expect(agent.getTools()).toHaveLength(0);
      expect(agent.getDeferredTools().size).toBe(0);
      expect(agent['graph']).toBeUndefined();
    });

    it('initTools() continues when an MCP service fails', async () => {
      const failingMcp = {
        discoverTools: vi
          .fn()
          .mockRejectedValue(new Error('MCP connection failed')),
      };
      const workingMcp = {
        discoverTools: vi.fn().mockResolvedValue([
          {
            name: 'mcp-tool',
            description: 'From working MCP',
            invoke: vi.fn(),
          },
        ]),
      };
      agent['mcpServices'] = [failingMcp, workingMcp] as any;

      await agent.initTools(baseConfig);

      // Working MCP's tool should be in deferred
      expect(agent.getDeferredTools().has('mcp-tool')).toBe(true);
      // Core tools should still be active
      const activeNames = agent.getTools().map((t) => t.name);
      expect(activeNames).toContain('finish');
      expect(activeNames).toContain('wait_for');
      expect(activeNames).toContain('tool_search');
    });

    it('MCP tools are moved to deferred registry', async () => {
      const mcpService = {
        discoverTools: vi.fn().mockResolvedValue([
          { name: 'mcp-shell', description: 'MCP shell tool', invoke: vi.fn() },
          {
            name: 'mcp-search',
            description: 'MCP search tool',
            invoke: vi.fn(),
          },
        ]),
      };
      agent['mcpServices'] = [mcpService] as any;

      await agent.initTools(baseConfig);

      // MCP tools should be in deferred, not active
      expect(agent.getDeferredTools().has('mcp-shell')).toBe(true);
      expect(agent.getDeferredTools().has('mcp-search')).toBe(true);
      const activeNames = agent.getTools().map((t) => t.name);
      expect(activeNames).not.toContain('mcp-shell');
      expect(activeNames).not.toContain('mcp-search');
    });

    describe('per-thread initial state restore', () => {
      it('loadTool()-moved tool is restored to deferred when a fresh thread starts', async () => {
        const mockTool = makeMockTool('carryover-tool');
        agent.addTool(mockTool);
        await agent.initTools(baseConfig);

        // Thread A: load the deferred tool
        agent['ensureInitialToolStateForThread']('thread-A');
        agent.loadTool('carryover-tool');
        expect(agent.getTools().map((t) => t.name)).toContain('carryover-tool');
        expect(agent.getDeferredTools().has('carryover-tool')).toBe(false);

        // Thread B: fresh thread — tool must be back in deferred, not active
        agent['ensureInitialToolStateForThread']('thread-B');
        expect(agent.getTools().map((t) => t.name)).not.toContain(
          'carryover-tool',
        );
        expect(agent.getDeferredTools().has('carryover-tool')).toBe(true);
      });

      it('does not reset when the same thread invokes a second time', async () => {
        const mockTool = makeMockTool('persist-in-thread');
        agent.addTool(mockTool);
        await agent.initTools(baseConfig);

        agent['ensureInitialToolStateForThread']('thread-A');
        agent.loadTool('persist-in-thread');
        expect(agent.getTools().map((t) => t.name)).toContain(
          'persist-in-thread',
        );

        // Same thread again — no reset
        agent['ensureInitialToolStateForThread']('thread-A');
        expect(agent.getTools().map((t) => t.name)).toContain(
          'persist-in-thread',
        );
      });

      it('mutates activeTools array in place so node references stay valid', async () => {
        const mockTool = makeMockTool('shared-ref');
        agent.addTool(mockTool);
        await agent.initTools(baseConfig);

        const activeToolsRef = agent.getTools();

        agent['ensureInitialToolStateForThread']('thread-A');
        agent.loadTool('shared-ref');
        expect(activeToolsRef).toBe(agent.getTools());
        expect(activeToolsRef.map((t) => t.name)).toContain('shared-ref');

        agent['ensureInitialToolStateForThread']('thread-B');
        // Same reference, but contents reset
        expect(activeToolsRef).toBe(agent.getTools());
        expect(activeToolsRef.map((t) => t.name)).not.toContain('shared-ref');
      });
    });
  });

  describe('nodeAdditionalMetadataUpdate events', () => {
    beforeEach(() => {
      agent.setConfig({
        summarizeMaxTokens: 1000,
        summarizeKeepTokens: 500,
        instructions: 'Test instructions',
        name: 'Test Agent',
        description: 'Test agent description',
        invokeModelName: 'gpt-5-mini',
        invokeModelReasoningEffort: ReasoningEffort.None,
      });
    });

    it('should emit event even when pending metadata is empty', () => {
      const emitSpy = vi.spyOn(agent as any, 'emit');
      setGraphThreadState(new GraphThreadState());

      (agent as any).emitNodeAdditionalMetadataUpdate({
        threadId: 'thread-1',
      });

      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'nodeAdditionalMetadataUpdate',
          data: {
            metadata: { threadId: 'thread-1' },
            additionalMetadata: {
              pendingMessages: [],
              reasoningChunks: {},
              instructions: 'Test instructions',
              connectedTools: [],
            },
          },
        }),
      );
    });
  });

  describe('cost-limit stop handling', () => {
    const config = {
      summarizeMaxTokens: 1000,
      summarizeKeepTokens: 500,
      instructions: 'Test instructions',
      name: 'Test Agent',
      description: 'Test agent description',
      invokeModelName: 'gpt-5-mini',
      invokeModelReasoningEffort: ReasoningEffort.None,
      maxIterations: 50,
    };

    it('emits stop event with stopReason="cost_limit" when CostLimitExceededError is thrown', async () => {
      const costError = new CostLimitExceededError(5.0, 7.25);

      async function* mockStream() {
        yield [
          'updates',
          { 'agent-1': { messages: { mode: 'append', items: [] } } },
        ] as const;
        throw costError;
      }

      const mockGraph = {
        stream: vi.fn().mockReturnValue(mockStream()),
      };
      agent['buildGraph'] = vi.fn().mockReturnValue(mockGraph);

      const emitSpy = vi.spyOn(agent as any, 'emit');

      // Must NOT throw — cost-limit branch handles the error internally.
      await agent.run(
        'thread-cost-limit',
        [new HumanMessage('Hello')],
        config,
        {
          configurable: {
            run_id: 'run-cl',
            graph_id: 'graph-1',
            thread_created_by: 'user-1',
          },
        } as unknown as RunnableConfig<BaseAgentConfigurable>,
      );

      const stopEvents = emitSpy.mock.calls
        .map((c) => c[0] as AgentEventType)
        .filter(
          (e): e is Extract<AgentEventType, { type: 'stop' }> =>
            e?.type === 'stop',
        );

      expect(stopEvents.length).toBeGreaterThanOrEqual(1);
      const costStop = stopEvents.find(
        (e) => e.data.stopReason === 'cost_limit',
      );
      expect(costStop).toBeDefined();
      expect(costStop?.data.threadId).toBe('thread-cost-limit');
      // stopCostUsd should reflect the over-budget total from the error so the
      // resume guard can persist and consult it.
      expect(costStop?.data.stopCostUsd).toBe(7.25);
    });

    it('emits stop event and no run event when CostLimitExceededError propagates from within the tools phase', async () => {
      // This covers the sub-agent cost-limit propagation path: the sub-agent
      // catches its own CostLimitExceededError, returns stopReason='cost_limit'
      // in SubagentRunResult, the tool wraps it in ToolInvokeResult, and
      // ToolExecutorNode re-throws CostLimitExceededError.  The parent's stream
      // loop catches it (same path as a direct invoke_llm cost-limit) and must
      // emit 'stop' without a 'run' event (no thread flip to Done).

      const costError = new CostLimitExceededError(3.0, 4.5);

      // Simulate the error coming from the tools node (not invoke_llm)
      async function* mockStream() {
        yield [
          'updates',
          { 'tools': { messages: { mode: 'append', items: [] } } },
        ] as const;
        throw costError;
      }

      const mockGraph = {
        stream: vi.fn().mockReturnValue(mockStream()),
      };
      agent['buildGraph'] = vi.fn().mockReturnValue(mockGraph);

      const emitSpy = vi.spyOn(agent as any, 'emit');

      // Must NOT throw.
      await agent.run(
        'thread-tool-cost-limit',
        [new HumanMessage('Hello')],
        config,
        {
          configurable: {
            run_id: 'run-tcl',
            graph_id: 'graph-1',
          },
        } as unknown as RunnableConfig<BaseAgentConfigurable>,
      );

      const allEvents = emitSpy.mock.calls.map((c) => c[0] as AgentEventType);

      const stopEvents = allEvents.filter(
        (e): e is Extract<AgentEventType, { type: 'stop' }> =>
          e?.type === 'stop',
      );
      const runEvents = allEvents.filter(
        (e): e is Extract<AgentEventType, { type: 'run' }> => e?.type === 'run',
      );

      // Must emit a cost_limit stop event.
      expect(stopEvents.length).toBeGreaterThanOrEqual(1);
      const costStop = stopEvents.find(
        (e) => e.data.stopReason === 'cost_limit',
      );
      expect(costStop).toBeDefined();
      expect(costStop?.data.threadId).toBe('thread-tool-cost-limit');
      expect(costStop?.data.stopCostUsd).toBe(4.5);

      // Must NOT emit a 'run' event (which would flip thread to Done).
      expect(runEvents).toHaveLength(0);
    });

    it('Bug C: persists in-flight AIMessage carried by CostLimitExceededError before emitting the system stop message', async () => {
      // Bug C reproduction. When the cost-limit threshold trips inside InvokeLlmNode,
      // the LLM call has already completed (LiteLLM has charged the spend) but the
      // throw happens BEFORE the AIMessage is folded into LangGraph state. The catch
      // handler must emit the in-flight AIMessage so the cost rollup includes that
      // call's spend — otherwise the per-thread cost report leaks the threshold-
      // tripping call (~$0.144 in the original repro on thread 4da2f2ed).
      const inFlightAI = new AIMessage('threshold-tripping LLM response');
      // Stamp __requestUsage and __runId on the in-flight message, mirroring what
      // invoke-llm-node.ts does via updateMessagesListWithMetadata before throwing.
      (inFlightAI.additional_kwargs as Record<string, unknown>).__requestUsage =
        {
          inputTokens: 30000,
          outputTokens: 13801,
          totalTokens: 43801,
          totalPrice: 0.1441275,
          currentContext: 43801,
        };
      (inFlightAI.additional_kwargs as Record<string, unknown>).__runId =
        'run-bug-c';
      const costError = new CostLimitExceededError(0.5, 0.576, [inFlightAI]);

      async function* mockStream() {
        yield [
          'updates',
          { 'invoke_llm': { messages: { mode: 'append', items: [] } } },
        ] as const;
        throw costError;
      }

      const mockGraph = {
        stream: vi.fn().mockReturnValue(mockStream()),
      };
      agent['buildGraph'] = vi.fn().mockReturnValue(mockGraph);

      const emitSpy = vi.spyOn(agent as any, 'emit');

      await agent.run('thread-bug-c', [new HumanMessage('Hello')], config, {
        configurable: {
          run_id: 'run-bug-c',
          graph_id: 'graph-1',
          thread_created_by: 'user-1',
        },
      } as unknown as RunnableConfig<BaseAgentConfigurable>);

      const allEvents = emitSpy.mock.calls.map((c) => c[0] as AgentEventType);
      const messageEvents = allEvents.filter(
        (e): e is Extract<AgentEventType, { type: 'message' }> =>
          e?.type === 'message',
      );

      // Locate the in-flight AIMessage emit and the system "Cost limit reached" emit.
      const inFlightEmitIndex = messageEvents.findIndex((e) =>
        (e.data.messages as unknown[]).some(
          (m) =>
            (m as { type?: string }).type === 'ai' &&
            (m as { content?: string }).content ===
              'threshold-tripping LLM response',
        ),
      );
      const systemStopEmitIndex = messageEvents.findIndex((e) =>
        (e.data.messages as unknown[]).some(
          (m) =>
            (m as { type?: string }).type === 'system' &&
            typeof (m as { content?: string }).content === 'string' &&
            (m as { content: string }).content.includes('Cost limit reached'),
        ),
      );

      // The in-flight AIMessage MUST be emitted (proves it isn't silently dropped).
      expect(inFlightEmitIndex).toBeGreaterThanOrEqual(0);
      // It MUST appear before the system stop message so the messages table
      // shows the threshold-tripping cost line right before the limit notice.
      expect(systemStopEmitIndex).toBeGreaterThanOrEqual(0);
      expect(inFlightEmitIndex).toBeLessThan(systemStopEmitIndex);

      // The leaked spend MUST be attributed to this AI message via __requestUsage,
      // so the message handler writes the cost row that closes the rollup gap.
      const inFlightEvent = messageEvents[inFlightEmitIndex]!;
      const aiMsgFromEmit = (inFlightEvent.data.messages as unknown[]).find(
        (m) => (m as { type?: string }).type === 'ai',
      ) as {
        additional_kwargs?: {
          __requestUsage?: { totalPrice?: number; totalTokens?: number };
          __runId?: string;
        };
      };
      expect(aiMsgFromEmit.additional_kwargs?.__requestUsage?.totalPrice).toBe(
        0.1441275,
      );
      // Proves the full __requestUsage object survives, not just the price field.
      expect(aiMsgFromEmit.additional_kwargs?.__requestUsage?.totalTokens).toBe(
        43801,
      );
      // __runId metadata must survive the in-flight emit path so the message
      // handler can attribute the leaked spend to the correct run.
      expect(
        (aiMsgFromEmit.additional_kwargs as Record<string, unknown>)?.__runId,
      ).toBe('run-bug-c');
    });

    it('Bug C boundary: does not emit in-flight when inFlightMessages is empty array', async () => {
      // Exercises the catch-handler guard: `if (err.inFlightMessages && length > 0)`.
      // An empty array must NOT produce an AI-message emit before the system stop.
      const costError = new CostLimitExceededError(0.5, 0.576, []);

      async function* mockStream() {
        yield [
          'updates',
          { 'invoke_llm': { messages: { mode: 'append', items: [] } } },
        ] as const;
        throw costError;
      }

      const mockGraph = {
        stream: vi.fn().mockReturnValue(mockStream()),
      };
      agent['buildGraph'] = vi.fn().mockReturnValue(mockGraph);

      const emitSpy = vi.spyOn(agent as any, 'emit');

      await agent.run(
        'thread-bug-c-boundary',
        [new HumanMessage('Hello')],
        config,
        {
          configurable: {
            run_id: 'run-bug-c-boundary',
            graph_id: 'graph-1',
            thread_created_by: 'user-1',
          },
        } as unknown as RunnableConfig<BaseAgentConfigurable>,
      );

      const allEvents = emitSpy.mock.calls.map((c) => c[0] as AgentEventType);
      const messageEvents = allEvents.filter(
        (e): e is Extract<AgentEventType, { type: 'message' }> =>
          e?.type === 'message',
      );

      // No AI-message should be emitted before the system stop message.
      const aiEmitIndex = messageEvents.findIndex((e) =>
        (e.data.messages as unknown[]).some(
          (m) => (m as { type?: string }).type === 'ai',
        ),
      );
      const systemStopEmitIndex = messageEvents.findIndex((e) =>
        (e.data.messages as unknown[]).some(
          (m) =>
            (m as { type?: string }).type === 'system' &&
            typeof (m as { content?: string }).content === 'string' &&
            (m as { content: string }).content.includes('Cost limit reached'),
        ),
      );

      // The system stop must fire.
      expect(systemStopEmitIndex).toBeGreaterThanOrEqual(0);
      // No AI-message emit should precede (or exist at all) since inFlightMessages is empty.
      expect(aiEmitIndex).toBe(-1);
    });

    it('A-HIGH-1: tool-executor cost-limit re-throw carries interleavedMessages into catch handler', async () => {
      // Deletion test for the Step 5 sister-site fix in tool-executor-node.ts.
      // When the post-tool-aggregate cost-limit check fires, interleavedMessages
      // (including ToolMessages from the batch) are passed as the 3rd arg to
      // CostLimitExceededError. The catch handler at simple-agent.ts:1165 emits
      // them before the system stop message. Reverting Step 5 (back to 2-arg ctor)
      // means err.inFlightMessages is undefined → the ToolMessage is never emitted.
      const toolMsg = new ToolMessage({
        tool_call_id: 'call-1',
        name: 'test_tool',
        content: 'tool result from cost-limit node',
      });
      // Stamp __requestUsage on the tool message the way ToolExecutorNode does.
      (toolMsg.additional_kwargs as Record<string, unknown>).__toolTokenUsage =
        {
          totalPrice: 0.2,
        };
      const costError = new CostLimitExceededError(0.5, 0.7, [toolMsg]);

      async function* mockStream() {
        yield [
          'updates',
          { 'tools': { messages: { mode: 'append', items: [] } } },
        ] as const;
        throw costError;
      }

      const mockGraph = {
        stream: vi.fn().mockReturnValue(mockStream()),
      };
      agent['buildGraph'] = vi.fn().mockReturnValue(mockGraph);

      const emitSpy = vi.spyOn(agent as any, 'emit');

      await agent.run('thread-a-high-1', [new HumanMessage('Hello')], config, {
        configurable: {
          run_id: 'run-a-high-1',
          graph_id: 'graph-1',
          thread_created_by: 'user-1',
        },
      } as unknown as RunnableConfig<BaseAgentConfigurable>);

      const allEvents = emitSpy.mock.calls.map((c) => c[0] as AgentEventType);
      const messageEvents = allEvents.filter(
        (e): e is Extract<AgentEventType, { type: 'message' }> =>
          e?.type === 'message',
      );

      // Locate the ToolMessage emit and the system stop emit.
      const toolEmitIndex = messageEvents.findIndex((e) =>
        (e.data.messages as unknown[]).some(
          (m) =>
            (m as { type?: string }).type === 'tool' &&
            (m as { content?: string }).content ===
              'tool result from cost-limit node',
        ),
      );
      const systemStopEmitIndex = messageEvents.findIndex((e) =>
        (e.data.messages as unknown[]).some(
          (m) =>
            (m as { type?: string }).type === 'system' &&
            typeof (m as { content?: string }).content === 'string' &&
            (m as { content: string }).content.includes('Cost limit reached'),
        ),
      );

      // The ToolMessage MUST be emitted (not silently dropped).
      expect(toolEmitIndex).toBeGreaterThanOrEqual(0);
      // The system stop MUST fire.
      expect(systemStopEmitIndex).toBeGreaterThanOrEqual(0);
      // The ToolMessage MUST appear BEFORE the system stop so the cost row
      // is recorded in the messages table before the thread is terminated.
      expect(toolEmitIndex).toBeLessThan(systemStopEmitIndex);
    });

    it('stopThread() emits stop event with stopReason=null (explicit clear)', async () => {
      // Register an active run for 'thread-1'
      const runnableConfig = {
        configurable: {
          run_id: 'run-stop',
          graph_id: 'graph-1',
          thread_id: 'thread-1',
        },
      };
      agent['activeRuns'].set('run-stop', {
        abortController: new AbortController(),
        runnableConfig:
          runnableConfig as unknown as RunnableConfig<BaseAgentConfigurable>,
        threadId: 'thread-1',
        lastState: buildAgentState(),
      });

      const emitSpy = vi.spyOn(agent as any, 'emit');

      await agent.stopThread('thread-1', 'manual stop');

      const stopEvents = emitSpy.mock.calls
        .map((c) => c[0] as AgentEventType)
        .filter(
          (e): e is Extract<AgentEventType, { type: 'stop' }> =>
            e?.type === 'stop',
        );

      expect(stopEvents.length).toBeGreaterThanOrEqual(1);
      const manualStop = stopEvents[0]!;
      expect(manualStop.data.stopReason).toBeNull();
      // Manual stop should also explicitly clear stopCostUsd, mirroring stopReason.
      expect(manualStop.data.stopCostUsd).toBeNull();
    });
  });
});
