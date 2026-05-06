import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphDao } from '../../../graphs/dao/graph.dao';
import { MessageTransformerService } from '../../../graphs/services/message-transformer.service';
import type { IAgentMessageNotification } from '../../../notifications/notifications.types';
import { NotificationEvent } from '../../../notifications/notifications.types';
import { MessagesDao } from '../../../threads/dao/messages.dao';
import { ThreadsDao } from '../../../threads/dao/threads.dao';
import { ThreadEntity } from '../../../threads/entity/thread.entity';
import { AgentMessageNotificationHandler } from './agent-message-notification-handler';

describe('AgentMessageNotificationHandler', () => {
  let handler: AgentMessageNotificationHandler;
  let threadsDao: ThreadsDao;
  let messagesDao: MessagesDao;
  let graphDao: GraphDao;

  const mockGraphId = 'graph-123';
  const mockNodeId = 'node-456';
  const mockThreadId = 'thread-external-789';
  const mockParentThreadId = 'thread-parent-000';
  const mockOwnerId = 'user-999';

  const createMockThreadEntity = (
    overrides: Partial<ThreadEntity> = {},
  ): ThreadEntity => ({
    id: '11111111-1111-4111-8111-111111111111',
    graphId: mockGraphId,
    createdBy: mockOwnerId,
    projectId: 'project-abc',
    externalThreadId: mockParentThreadId,
    metadata: {},
    lastRunId: undefined,
    status: 'running' as ThreadEntity['status'],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentMessageNotificationHandler,
        MessageTransformerService,
        {
          provide: GraphDao,
          useValue: {
            getOne: vi.fn().mockResolvedValue({
              id: mockGraphId,
              createdBy: mockOwnerId,
              projectId: 'project-abc',
            }),
          },
        },
        {
          provide: ThreadsDao,
          useValue: {
            getOne: vi.fn(),
          },
        },
        {
          provide: MessagesDao,
          useValue: {
            createMany: vi
              .fn()
              .mockImplementation(async (dataArray: unknown[]) => {
                return dataArray.map((data) => {
                  const record = data as Record<string, unknown>;
                  return {
                    id: '22222222-2222-4222-8222-222222222222',
                    threadId: record.threadId,
                    externalThreadId: record.externalThreadId,
                    nodeId: record.nodeId,
                    message: record.message,
                    requestTokenUsage: record.requestTokenUsage,
                    role: record.role,
                    name: record.name,
                    toolCallNames: record.toolCallNames,
                    toolCallIds: record.toolCallIds,
                    answeredToolCallNames: record.answeredToolCallNames,
                    additionalKwargs: record.additionalKwargs,
                    toolTokenUsage: record.toolTokenUsage,
                    createdAt: new Date('2024-01-01T00:00:00Z'),
                    updatedAt: new Date('2024-01-01T00:00:00Z'),
                  };
                });
              }),
          },
        },
      ],
    }).compile();

    handler = module.get<AgentMessageNotificationHandler>(
      AgentMessageNotificationHandler,
    );
    threadsDao = module.get<ThreadsDao>(ThreadsDao);
    messagesDao = module.get<MessagesDao>(MessagesDao);
    graphDao = module.get<GraphDao>(GraphDao);

    vi.spyOn(threadsDao, 'getOne').mockResolvedValue(createMockThreadEntity());
  });

  it('saves requestTokenUsage only for AI messages, not for tool messages', async () => {
    const aiTokenUsage = {
      inputTokens: 100,
      outputTokens: 92,
      totalTokens: 192,
      totalPrice: 0.0003,
    };
    const toolCallId = 'call_shell_1';

    const ai = new AIMessage({
      content: '',
      tool_calls: [
        {
          id: toolCallId,
          type: 'tool_call',
          name: 'shell',
          args: { cmd: 'pwd' },
        },
      ],
      additional_kwargs: {
        __requestUsage: aiTokenUsage, // Full request-level token usage
        __tokenUsage: { totalTokens: 192, totalPrice: 0.0003 }, // Message-level usage
      },
    });

    const tool = new ToolMessage({
      content: JSON.stringify({ exitCode: 0, stdout: 'ok', stderr: '' }),
      tool_call_id: toolCallId,
      name: 'shell',
    });
    // Tool message should only have __tokenUsage (for counting tokens),
    // NOT __requestUsage (it's not from an LLM request)
    Object.assign(tool, {
      additional_kwargs: {
        __model: 'openai/gpt-5.2',
        __tokenUsage: { totalTokens: 500, totalPrice: 0.001 }, // Message-level usage
      },
    });

    const notification: IAgentMessageNotification = {
      type: NotificationEvent.AgentMessage,
      graphId: mockGraphId,
      nodeId: mockNodeId,
      threadId: mockThreadId,
      parentThreadId: mockParentThreadId,
      data: {
        messages: [ai, tool],
      },
    };

    await handler.handle(notification);

    expect(graphDao.getOne).toHaveBeenCalledWith({ id: mockGraphId });
    expect(threadsDao.getOne).toHaveBeenCalledWith({
      externalThreadId: mockParentThreadId,
    });

    expect(messagesDao.createMany).toHaveBeenCalledTimes(1);

    const createManyCall = vi.mocked(messagesDao.createMany).mock
      .calls[0]?.[0] as Record<string, unknown>[];

    expect(createManyCall).toHaveLength(2);

    // AI message should have requestTokenUsage (from LLM request)
    expect(createManyCall[0]?.requestTokenUsage).toEqual(aiTokenUsage);

    // Tool message should NOT have requestTokenUsage (it's a function execution result, not an LLM response)
    expect(createManyCall[1]?.requestTokenUsage).toBeUndefined();
  });

  it('AI messages have __requestUsage, tool messages do not', async () => {
    const toolCallId = 'call_test_123';
    const requestUsage = {
      inputTokens: 13780,
      outputTokens: 37,
      totalTokens: 13817,
      cachedInputTokens: 13696,
      reasoningTokens: 0,
      totalPrice: 0.0030618,
      currentContext: 13780,
    };

    // AI message with __requestUsage (from LLM request)
    const ai = new AIMessage({
      content: '',
      tool_calls: [
        {
          id: toolCallId,
          type: 'tool_call',
          name: 'finish',
          args: { message: 'Test' },
        },
      ],
      additional_kwargs: {
        __model: 'azure/gpt-5.2',
        __tokenUsage: {
          totalTokens: 61,
          totalPrice: 0.000013517391619020047,
        },
        __requestUsage: requestUsage,
      },
    });

    // Tool message should only have __tokenUsage, NOT __requestUsage
    // (it's a function execution result, not an LLM response)
    const tool = new ToolMessage({
      content: JSON.stringify({ success: true }),
      tool_call_id: toolCallId,
      name: 'finish',
    });
    Object.assign(tool, {
      additional_kwargs: {
        __model: 'azure/gpt-5.2',
        __tokenUsage: {
          totalTokens: 23,
          totalPrice: 0.00004025,
        },
        // No __requestUsage for tool messages
      },
    });

    const notification: IAgentMessageNotification = {
      type: NotificationEvent.AgentMessage,
      graphId: mockGraphId,
      nodeId: mockNodeId,
      threadId: mockThreadId,
      parentThreadId: mockParentThreadId,
      data: {
        messages: [ai, tool],
      },
    };

    await handler.handle(notification);

    // Verify messagesDao.createMany was called once with an array of 2 messages
    expect(messagesDao.createMany).toHaveBeenCalledTimes(1);

    const createManyCall = vi.mocked(messagesDao.createMany).mock
      .calls[0]?.[0] as Record<string, unknown>[];

    expect(createManyCall).toHaveLength(2);

    // Check AI message - should have requestTokenUsage from LLM request
    const aiCreateData = createManyCall[0];
    expect(aiCreateData?.requestTokenUsage).toEqual(requestUsage);
    expect(aiCreateData?.toolCallNames).toEqual(['finish']);
    expect(aiCreateData?.toolCallIds).toEqual([toolCallId]);
    expect(aiCreateData?.role).toBe('ai');
    expect(aiCreateData?.additionalKwargs).toBeDefined();

    // Check Tool message - should NOT have requestTokenUsage
    // (it's a function execution result, not an LLM response)
    const toolCreateData = createManyCall[1];
    expect(toolCreateData?.requestTokenUsage).toBeUndefined();
    expect(toolCreateData?.toolCallNames).toBeUndefined();
    expect(toolCreateData?.toolCallIds).toBeUndefined();
    expect(toolCreateData?.role).toBe('tool');
    expect(toolCreateData?.name).toBe('finish');
    expect(toolCreateData?.additionalKwargs).toBeDefined();
  });

  it('does not save requestTokenUsage for tool messages even when __requestUsage is present', async () => {
    const parentAiUsage = {
      inputTokens: 13257,
      outputTokens: 63,
      totalTokens: 13320,
      totalPrice: 0.0068175,
    };
    const toolCallId = 'call_finish_1';

    // AI message calling finish
    const ai = new AIMessage({
      content: '',
      tool_calls: [
        {
          id: toolCallId,
          type: 'tool_call' as const,
          name: 'finish',
          args: { message: 'done' },
        },
      ],
      additional_kwargs: {
        __requestUsage: parentAiUsage,
      },
    });

    // Tool message carries __requestUsage from parent AI (set by ToolExecutorNode),
    // but this should NOT be stored as requestTokenUsage (would double-count)
    const tool = new ToolMessage({
      content: JSON.stringify({ message: 'done' }),
      tool_call_id: toolCallId,
      name: 'finish',
    });
    Object.assign(tool, {
      additional_kwargs: {
        __requestUsage: parentAiUsage,
      },
    });

    const notification: IAgentMessageNotification = {
      type: NotificationEvent.AgentMessage,
      graphId: mockGraphId,
      nodeId: mockNodeId,
      threadId: mockThreadId,
      parentThreadId: mockParentThreadId,
      data: {
        messages: [ai, tool],
      },
    };

    await handler.handle(notification);

    const createManyCall = vi.mocked(messagesDao.createMany).mock
      .calls[0]?.[0] as Record<string, unknown>[];

    expect(createManyCall).toHaveLength(2);

    // AI message should have requestTokenUsage
    expect(createManyCall[0]?.requestTokenUsage).toEqual(parentAiUsage);

    // Tool message should NOT — even though __requestUsage is on the original message,
    // it's the parent AI's usage and storing it would double-count the LLM call
    expect(createManyCall[1]?.requestTokenUsage).toBeUndefined();
    expect(createManyCall[1]?.role).toBe('tool');
  });

  it('saves requestTokenUsage for subagent internal AI messages (__hideForLlm)', async () => {
    const subagentUsage = {
      inputTokens: 3500,
      outputTokens: 90,
      totalTokens: 3590,
      totalPrice: 0,
    };

    // Subagent internal AI message — has __hideForLlm and __requestUsage
    const subagentAi = new AIMessage({
      content: 'I will read the file first.',
      tool_calls: [
        {
          id: 'call_sub_1',
          type: 'tool_call' as const,
          name: 'files_read',
          args: { filePath: '/workspace/file.js' },
        },
      ],
      additional_kwargs: {
        __hideForLlm: true,
        __streamedRealtime: true,
        __toolCallId: 'call_parent_subagent',
        __requestUsage: subagentUsage,
      },
    });

    const notification: IAgentMessageNotification = {
      type: NotificationEvent.AgentMessage,
      graphId: mockGraphId,
      nodeId: mockNodeId,
      threadId: mockThreadId,
      parentThreadId: mockParentThreadId,
      data: {
        messages: [subagentAi],
      },
    };

    await handler.handle(notification);

    expect(messagesDao.createMany).toHaveBeenCalledTimes(1);

    const createManyCall = vi.mocked(messagesDao.createMany).mock
      .calls[0]?.[0] as Record<string, unknown>[];

    expect(createManyCall).toHaveLength(1);

    // Subagent internal AI message should have requestTokenUsage in column
    expect(createManyCall[0]?.requestTokenUsage).toEqual(subagentUsage);

    // __requestUsage stripped from additionalKwargs (now in dedicated column)
    const kwargs = createManyCall[0]?.additionalKwargs as Record<
      string,
      unknown
    >;
    expect(kwargs.__requestUsage).toBeUndefined();
  });

  it('persists surrogate nodeId for subagent messages', async () => {
    const subagentUsage = {
      inputTokens: 200,
      outputTokens: 50,
      totalTokens: 250,
      totalPrice: 0.0005,
    };

    const subagentAi = new AIMessage({
      content: 'Subagent step result',
      additional_kwargs: {
        __subagentCommunication: true,
        __toolCallId: 'call_xyz',
        __requestUsage: subagentUsage,
      },
    });

    const notification: IAgentMessageNotification = {
      type: NotificationEvent.AgentMessage,
      graphId: mockGraphId,
      nodeId: 'parent-node',
      threadId: mockThreadId,
      parentThreadId: mockParentThreadId,
      data: {
        messages: [subagentAi],
      },
    };

    await handler.handle(notification);

    expect(messagesDao.createMany).toHaveBeenCalledTimes(1);

    const createManyCall = vi.mocked(messagesDao.createMany).mock
      .calls[0]?.[0] as Record<string, unknown>[];

    expect(createManyCall).toHaveLength(1);
    expect(createManyCall[0]?.nodeId).toBe('parent-node::sub::call_xyz');
  });

  it('keeps event nodeId for non-subagent messages', async () => {
    const regularUsage = {
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      totalPrice: 0.0002,
    };

    const regularAi = new AIMessage({
      content: 'Regular AI response',
      additional_kwargs: {
        __requestUsage: regularUsage,
      },
    });

    const notification: IAgentMessageNotification = {
      type: NotificationEvent.AgentMessage,
      graphId: mockGraphId,
      nodeId: mockNodeId,
      threadId: mockThreadId,
      parentThreadId: mockParentThreadId,
      data: {
        messages: [regularAi],
      },
    };

    await handler.handle(notification);

    expect(messagesDao.createMany).toHaveBeenCalledTimes(1);

    const createManyCall = vi.mocked(messagesDao.createMany).mock
      .calls[0]?.[0] as Record<string, unknown>[];

    expect(createManyCall).toHaveLength(1);
    expect(createManyCall[0]?.nodeId).toBe(mockNodeId);
  });

  it('falls back to event nodeId when __subagentCommunication is true but __toolCallId is missing', async () => {
    const subagentUsage = {
      inputTokens: 300,
      outputTokens: 60,
      totalTokens: 360,
      totalPrice: 0.0008,
    };

    // __subagentCommunication present but __toolCallId absent — defensive fallback
    const incompleteSubagentAi = new AIMessage({
      content: 'Subagent output without toolCallId',
      additional_kwargs: {
        __subagentCommunication: true,
        __requestUsage: subagentUsage,
      },
    });

    const notification: IAgentMessageNotification = {
      type: NotificationEvent.AgentMessage,
      graphId: mockGraphId,
      nodeId: mockNodeId,
      threadId: mockThreadId,
      parentThreadId: mockParentThreadId,
      data: {
        messages: [incompleteSubagentAi],
      },
    };

    await handler.handle(notification);

    expect(messagesDao.createMany).toHaveBeenCalledTimes(1);

    const createManyCall = vi.mocked(messagesDao.createMany).mock
      .calls[0]?.[0] as Record<string, unknown>[];

    expect(createManyCall).toHaveLength(1);
    expect(createManyCall[0]?.nodeId).toBe(mockNodeId);
  });

  it('does not save requestTokenUsage for tool messages, only toolTokenUsage', async () => {
    const parentToolCallId = 'call_parent_subagent';

    // Parent AI message dispatching subagent — has __requestUsage
    const parentAiUsage = {
      inputTokens: 5000,
      outputTokens: 150,
      totalTokens: 5150,
      totalPrice: 0.01,
    };
    const parentAi = new AIMessage({
      content: '',
      tool_calls: [
        {
          id: parentToolCallId,
          type: 'tool_call' as const,
          name: 'subagents_run_task',
          args: { task: 'do something' },
        },
      ],
      additional_kwargs: {
        __requestUsage: parentAiUsage,
      },
    });

    // Parent tool result (subagents_run_task) — carries:
    // __requestUsage = parent LLM call usage (same as parentAiUsage)
    // __toolTokenUsage = aggregated subagent usage (tool's own cost)
    const subagentToolUsage = {
      inputTokens: 3500,
      outputTokens: 90,
      totalTokens: 3590,
      totalPrice: 0.005,
    };
    const toolResult = new ToolMessage({
      content: JSON.stringify({ result: 'done' }),
      tool_call_id: parentToolCallId,
      name: 'subagents_run_task',
    });
    Object.assign(toolResult, {
      additional_kwargs: {
        __requestUsage: parentAiUsage,
        __toolTokenUsage: subagentToolUsage,
      },
    });

    const notification: IAgentMessageNotification = {
      type: NotificationEvent.AgentMessage,
      graphId: mockGraphId,
      nodeId: mockNodeId,
      threadId: mockThreadId,
      parentThreadId: mockParentThreadId,
      data: {
        messages: [parentAi, toolResult],
      },
    };

    await handler.handle(notification);

    expect(messagesDao.createMany).toHaveBeenCalledTimes(1);

    const createManyCall = vi.mocked(messagesDao.createMany).mock
      .calls[0]?.[0] as Record<string, unknown>[];

    expect(createManyCall).toHaveLength(2);

    // Parent AI message should have requestTokenUsage
    expect(createManyCall[0]?.requestTokenUsage).toEqual(parentAiUsage);

    // Tool messages should NOT have requestTokenUsage — it would double-count the parent AI's LLM call.
    // The __requestUsage on the tool message is the parent AI's context, not a separate LLM request.
    expect(createManyCall[1]?.requestTokenUsage).toBeUndefined();

    // Subagent tool result: toolTokenUsage = tool's own execution cost
    expect(createManyCall[1]?.toolTokenUsage).toEqual(subagentToolUsage);

    // additionalKwargs should have __requestUsage and __toolTokenUsage stripped
    // (already stored in dedicated columns, no need to duplicate in JSONB)
    const aiKwargs = createManyCall[0]?.additionalKwargs as Record<
      string,
      unknown
    >;
    expect(aiKwargs).toBeDefined();
    expect(aiKwargs.__requestUsage).toBeUndefined();

    const toolKwargs = createManyCall[1]?.additionalKwargs as Record<
      string,
      unknown
    >;
    expect(toolKwargs).toBeDefined();
    expect(toolKwargs.__requestUsage).toBeUndefined();
    expect(toolKwargs.__toolTokenUsage).toBeUndefined();
  });

  it('extracts answeredToolCallNames from additional_kwargs', async () => {
    // AI message that answers tool calls (no tool_calls of its own)
    const ai = new AIMessage({
      content: 'Based on the search results...',
      additional_kwargs: {
        __requestUsage: {
          inputTokens: 50,
          outputTokens: 30,
          totalTokens: 80,
          totalPrice: 0.004,
        },
        __answeredToolCallNames: ['search', 'shell'],
      },
    });

    const notification: IAgentMessageNotification = {
      type: NotificationEvent.AgentMessage,
      graphId: mockGraphId,
      nodeId: mockNodeId,
      threadId: mockThreadId,
      parentThreadId: mockParentThreadId,
      data: {
        messages: [ai],
      },
    };

    await handler.handle(notification);

    const createManyCall = vi.mocked(messagesDao.createMany).mock
      .calls[0]?.[0] as Record<string, unknown>[];

    expect(createManyCall).toHaveLength(1);
    expect(createManyCall[0]?.answeredToolCallNames).toEqual([
      'search',
      'shell',
    ]);
    // No tool calls in this AI message
    expect(createManyCall[0]?.toolCallNames).toBeUndefined();
    expect(createManyCall[0]?.toolCallIds).toBeUndefined();
  });

  it('does not save requestTokenUsage for human messages', async () => {
    // Human message (user input - should NOT have requestTokenUsage)
    const human = new HumanMessage({
      content: 'Hello, how are you?',
    });

    // AI response (should have requestTokenUsage)
    const aiTokenUsage = {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      totalPrice: 0.001,
    };
    const ai = new AIMessage({
      content: 'I am doing well, thank you!',
      additional_kwargs: {
        __requestUsage: aiTokenUsage,
      },
    });

    const notification: IAgentMessageNotification = {
      type: NotificationEvent.AgentMessage,
      graphId: mockGraphId,
      nodeId: mockNodeId,
      threadId: mockThreadId,
      parentThreadId: mockParentThreadId,
      data: {
        messages: [human, ai],
      },
    };

    await handler.handle(notification);

    expect(messagesDao.createMany).toHaveBeenCalledTimes(1);

    const createManyCall = vi.mocked(messagesDao.createMany).mock
      .calls[0]?.[0] as Record<string, unknown>[];

    expect(createManyCall).toHaveLength(2);

    // Check human message - should NOT have requestTokenUsage
    const humanCreateData = createManyCall[0];
    expect(humanCreateData?.requestTokenUsage).toBeUndefined();
    expect(humanCreateData?.toolCallNames).toBeUndefined();
    expect(humanCreateData?.role).toBe('human');

    // Check AI message - SHOULD have requestTokenUsage (no tool calls)
    const aiCreateData = createManyCall[1];
    expect(aiCreateData?.requestTokenUsage).toEqual(aiTokenUsage);
    expect(aiCreateData?.toolCallNames).toBeUndefined(); // No toolCalls in this AI message
    expect(aiCreateData?.role).toBe('ai');
  });
});
