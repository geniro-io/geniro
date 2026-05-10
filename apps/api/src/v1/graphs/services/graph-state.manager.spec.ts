import { Duplex, PassThrough } from 'node:stream';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationEvent } from '../../notifications/notifications.types';
import { NotificationsService } from '../../notifications/services/notifications.service';
import {
  RuntimeExecParams,
  RuntimeExecResult,
} from '../../runtime/runtime.types';
import { BaseRuntime } from '../../runtime/services/base-runtime';
import {
  THREAD_WAITING_EVENT,
  ThreadStatus,
} from '../../threads/threads.types';
import {
  CompiledGraphNode,
  GraphExecutionMetadata,
  GraphNodeInstanceHandle,
  GraphNodeStatus,
  NodeKind,
} from '../graphs.types';
import { GraphStateManager } from './graph-state.manager';

class TestRuntime extends BaseRuntime {
  async start(): Promise<void> {
    this.emit({ type: 'start', data: { params: {} } });
  }

  async stop(): Promise<void> {
    this.emit({ type: 'stop', data: {} });
  }

  async exec(params: RuntimeExecParams): Promise<RuntimeExecResult> {
    const execId = 'test-exec-id';

    // Emit start
    this.emit({
      type: 'execStart',
      data: { execId, params },
    });

    // Simulate async
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Simulate execution
    const result: RuntimeExecResult = {
      fail: false,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      execPath: '/runtime-workspace/test',
    };

    // Emit end
    this.emit({
      type: 'execEnd',
      data: { execId, params, result },
    });

    return result;
  }

  public getRuntimeInfo(): string {
    return 'Runtime type: TestRuntime';
  }

  async execStream(
    _command: string[],
    _options?: {
      workdir?: string;
      env?: Record<string, string>;
    },
  ): Promise<{
    stdin: Duplex;
    stdout: PassThrough;
    stderr: PassThrough;
    close: () => void;
  }> {
    const stdin = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    return {
      stdin,
      stdout,
      stderr,
      close: () => {
        stdin.destroy();
        stdout.destroy();
        stderr.destroy();
      },
    };
  }

  public override getGraphNodeMetadata(
    context?: GraphExecutionMetadata,
  ): Record<string, unknown> | undefined {
    if (!context?.threadId) {
      return undefined;
    }
    return { threadId: context.threadId };
  }
}

const makeHandle = <TInstance>(
  instance: TInstance,
): GraphNodeInstanceHandle<TInstance, any> => ({
  provide: async () => instance,
  configure: async () => {},
  destroy: async () => {},
});

describe('GraphStateManager', () => {
  let notifications: NotificationsService;
  let logger: DefaultLogger;
  let eventEmitter: EventEmitter2;
  let manager: GraphStateManager;

  beforeEach(() => {
    notifications = {
      emit: vi.fn().mockResolvedValue(undefined),
    } as unknown as NotificationsService;
    logger = {
      error: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as DefaultLogger;
    eventEmitter = {
      emit: vi.fn(),
    } as unknown as EventEmitter2;
    manager = new GraphStateManager(notifications, logger, eventEmitter);
    manager.setGraphId('graph-1');
  });

  describe('Additional metadata', () => {
    it('should include additional node metadata when available', () => {
      const runtime = new TestRuntime();
      const node: CompiledGraphNode<TestRuntime> = {
        id: 'runtime-1',
        type: NodeKind.Runtime,
        template: 'runtime',
        config: {},
        instance: runtime,
        handle: makeHandle(runtime),
      };

      manager.registerNode('runtime-1');
      manager.attachGraphNode('runtime-1', node);

      const snapshots = manager.getSnapshots('thread-1');
      expect(snapshots[0]?.additionalNodeMetadata).toEqual({
        threadId: 'thread-1',
      });
    });
  });

  describe('Sequential event processing', () => {
    it('should process agent events sequentially (invoke completes before message starts)', async () => {
      const agent: any = {
        subscribe: vi.fn(),
        getGraphNodeMetadata: vi.fn(),
      };
      let agentHandler: any;
      agent.subscribe.mockImplementation((handler: any) => {
        agentHandler = handler;
        return vi.fn();
      });

      const node: CompiledGraphNode = {
        id: 'agent-1',
        type: NodeKind.SimpleAgent,
        template: 'simple-agent',
        config: {},
        instance: agent,
        handle: makeHandle(agent),
      };

      manager.registerNode('agent-1');
      manager.attachGraphNode('agent-1', node);

      const executionOrder: string[] = [];

      // Make the invoke notification slow so we can detect if message waits for it
      vi.mocked(notifications.emit).mockImplementation(async (event: any) => {
        executionOrder.push(event.type);
        if (event.type === NotificationEvent.AgentInvoke) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          executionOrder.push('invoke-done');
        }
        if (event.type === NotificationEvent.AgentMessage) {
          executionOrder.push('message-done');
        }
      });

      const commonConfig = {
        configurable: {
          graph_id: 'graph-1',
          node_id: 'agent-1',
          parent_thread_id: 'p1',
        },
      };

      // Fire both events without awaiting — simulates synchronous EventEmitter.emit
      const invokePromise = agentHandler({
        type: 'invoke',
        data: { threadId: 't1', messages: [], config: commonConfig },
      });
      const messagePromise = agentHandler({
        type: 'message',
        data: { threadId: 't1', messages: [], config: commonConfig },
      });

      await Promise.all([invokePromise, messagePromise]);

      // Invoke must fully complete before message starts
      const invokeDoneIdx = executionOrder.indexOf('invoke-done');
      const messageStartIdx = executionOrder.indexOf(
        NotificationEvent.AgentMessage,
      );
      expect(invokeDoneIdx).toBeLessThan(messageStartIdx);
    });
  });

  describe('Agent events', () => {
    it('should emit ThreadUpdate notification only for active threads on agent stop', async () => {
      const agent: any = {
        subscribe: vi.fn(),
        handle: makeHandle({}),
        getGraphNodeMetadata: vi.fn(),
      };
      let agentHandler: any;
      agent.subscribe.mockImplementation((handler: any) => {
        agentHandler = handler;
        return vi.fn();
      });

      const node: CompiledGraphNode = {
        id: 'agent-1',
        type: NodeKind.SimpleAgent,
        template: 'simple-agent',
        config: {},
        instance: agent,
        handle: makeHandle(agent),
      };

      manager.registerNode('agent-1');
      manager.attachGraphNode('agent-1', node);

      // Simulate thread execution
      await agentHandler({
        type: 'invoke',
        data: {
          threadId: 'thread-1',
          config: { configurable: { graph_id: 'graph-1', node_id: 'agent-1' } },
        },
      });

      vi.mocked(notifications.emit).mockClear();

      // Simulate agent stop
      await agentHandler({
        type: 'stop',
        data: {
          config: { configurable: { graph_id: 'graph-1', node_id: 'agent-1' } },
        },
      });

      expect(notifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationEvent.ThreadUpdate,
          threadId: 'thread-1',
          data: { status: ThreadStatus.Stopped },
        }),
      );
    });

    it('should not mark parent thread done when child agent completes', async () => {
      const agent: any = {
        subscribe: vi.fn(),
        getGraphNodeMetadata: vi.fn(),
      };
      let agentHandler: any;
      agent.subscribe.mockImplementation((handler: any) => {
        agentHandler = handler;
        return vi.fn();
      });

      const node: CompiledGraphNode = {
        id: 'agent-1',
        type: NodeKind.SimpleAgent,
        template: 'simple-agent',
        config: {},
        instance: agent,
        handle: makeHandle(agent),
      };

      manager.registerNode('agent-1');
      manager.attachGraphNode('agent-1', node);

      // Simulate child agent execution
      await agentHandler({
        type: 'run',
        data: {
          threadId: 'child-thread',
          config: {
            configurable: {
              graph_id: 'graph-1',
              node_id: 'agent-1',
              parent_thread_id: 'parent-thread',
            },
          },
        },
      });

      const threadUpdate = vi
        .mocked(notifications.emit)
        .mock.calls.find(
          (call: any) => call[0].type === NotificationEvent.ThreadUpdate,
        );

      expect(threadUpdate).toBeUndefined();
    });

    it('should not mark parent thread stopped when a child agent (via communication_exec) stops', async () => {
      const agent: any = {
        subscribe: vi.fn(),
        getGraphNodeMetadata: vi.fn(),
      };
      let agentHandler: any;
      agent.subscribe.mockImplementation((handler: any) => {
        agentHandler = handler;
        return vi.fn();
      });

      const node: CompiledGraphNode = {
        id: 'agent-1',
        type: NodeKind.SimpleAgent,
        template: 'simple-agent',
        config: {},
        instance: agent,
        handle: makeHandle(agent),
      };

      manager.registerNode('agent-1');
      manager.attachGraphNode('agent-1', node);

      // Register the child thread as an active execution
      await agentHandler({
        type: 'invoke',
        data: {
          threadId: 'child-thread',
          config: {
            configurable: {
              graph_id: 'graph-1',
              node_id: 'agent-1',
              parent_thread_id: 'parent-thread',
            },
          },
        },
      });

      vi.mocked(notifications.emit).mockClear();

      // Fire a cost-limit stop for the child agent
      await agentHandler({
        type: 'stop',
        data: {
          stopReason: 'cost_limit',
          stopCostUsd: 2.5,
          config: {
            configurable: {
              graph_id: 'graph-1',
              node_id: 'agent-1',
              parent_thread_id: 'parent-thread',
            },
          },
        },
      });

      const threadUpdate = vi
        .mocked(notifications.emit)
        .mock.calls.find(
          (call: any) => call[0].type === NotificationEvent.ThreadUpdate,
        );

      expect(threadUpdate).toBeUndefined();
    });

    it('should emit ThreadUpdate(Stopped) for the root thread on handleAgentStop', async () => {
      const agent: any = {
        subscribe: vi.fn(),
        getGraphNodeMetadata: vi.fn(),
      };
      let agentHandler: any;
      agent.subscribe.mockImplementation((handler: any) => {
        agentHandler = handler;
        return vi.fn();
      });

      const node: CompiledGraphNode = {
        id: 'agent-1',
        type: NodeKind.SimpleAgent,
        template: 'simple-agent',
        config: {},
        instance: agent,
        handle: makeHandle(agent),
      };

      manager.registerNode('agent-1');
      manager.attachGraphNode('agent-1', node);

      // Register the root thread as an active execution (no parent_thread_id)
      await agentHandler({
        type: 'invoke',
        data: {
          threadId: 'root-thread',
          config: {
            configurable: {
              graph_id: 'graph-1',
              node_id: 'agent-1',
            },
          },
        },
      });

      vi.mocked(notifications.emit).mockClear();

      // Fire a cost-limit stop for the root agent
      await agentHandler({
        type: 'stop',
        data: {
          stopReason: 'cost_limit',
          stopCostUsd: 2.5,
          config: {
            configurable: {
              graph_id: 'graph-1',
              node_id: 'agent-1',
            },
          },
        },
      });

      const threadUpdateCall = vi
        .mocked(notifications.emit)
        .mock.calls.find(
          (call: any) => call[0].type === NotificationEvent.ThreadUpdate,
        );

      expect(threadUpdateCall).toBeDefined();
      expect(threadUpdateCall![0]).toEqual(
        expect.objectContaining({
          type: NotificationEvent.ThreadUpdate,
          threadId: 'root-thread',
          data: expect.objectContaining({
            status: ThreadStatus.Stopped,
            stopReason: 'cost_limit',
            stopCostUsd: 2.5,
          }),
        }),
      );
    });

    it('should keep agent node status as Idle regardless of active threads', async () => {
      const agent: any = {
        subscribe: vi.fn(),
        getGraphNodeMetadata: vi.fn(),
      };
      let agentHandler: any;
      agent.subscribe.mockImplementation((handler: any) => {
        agentHandler = handler;
        return vi.fn();
      });

      const node: CompiledGraphNode = {
        id: 'agent-1',
        type: NodeKind.SimpleAgent,
        template: 'simple-agent',
        config: {},
        instance: agent,
        handle: makeHandle(agent),
      };

      manager.registerNode('agent-1');
      manager.attachGraphNode('agent-1', node);

      // Start thread 1
      await agentHandler({
        type: 'invoke',
        data: {
          threadId: 'thread-1',
          config: { configurable: { graph_id: 'graph-1', node_id: 'agent-1' } },
        },
      });
      // Agent node stays Idle — status tracking is only for runtime/trigger/mcp
      expect(manager.getNodeStatus('agent-1')).toBe(GraphNodeStatus.Idle);

      // End thread 1
      await agentHandler({
        type: 'run',
        data: {
          threadId: 'thread-1',
          config: { configurable: { graph_id: 'graph-1', node_id: 'agent-1' } },
        },
      });
      expect(manager.getNodeStatus('agent-1')).toBe(GraphNodeStatus.Idle);
    });

    it('should emit all agent notification types correctly', async () => {
      const agent: any = {
        subscribe: vi.fn(),
        getGraphNodeMetadata: vi.fn(),
      };
      let agentHandler: any;
      agent.subscribe.mockImplementation((handler: any) => {
        agentHandler = handler;
        return vi.fn();
      });

      const node: CompiledGraphNode = {
        id: 'agent-1',
        type: NodeKind.SimpleAgent,
        template: 'simple-agent',
        config: {},
        instance: agent,
        handle: makeHandle(agent),
      };

      manager.registerNode('agent-1');
      manager.attachGraphNode('agent-1', node);

      const commonConfig = {
        configurable: {
          graph_id: 'graph-1',
          node_id: 'agent-1',
          parent_thread_id: 'p1',
          source: 'test',
        },
      };

      // Invoke
      await agentHandler({
        type: 'invoke',
        data: { threadId: 't1', messages: [], config: commonConfig },
      });
      expect(notifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationEvent.AgentInvoke }),
      );

      // Message
      await agentHandler({
        type: 'message',
        data: { threadId: 't1', messages: [], config: commonConfig },
      });
      expect(notifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationEvent.AgentMessage }),
      );

      // State update
      await agentHandler({
        type: 'stateUpdate',
        data: { threadId: 't1', stateChange: {}, config: commonConfig },
      });
      expect(notifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationEvent.AgentStateUpdate }),
      );
    });

    it('should use threadId as parentThreadId for root agent events (no parent_thread_id)', async () => {
      const agent: any = {
        subscribe: vi.fn(),
        getGraphNodeMetadata: vi.fn(),
      };
      let agentHandler: any;
      agent.subscribe.mockImplementation((handler: any) => {
        agentHandler = handler;
        return vi.fn();
      });

      const node: CompiledGraphNode = {
        id: 'agent-1',
        type: NodeKind.SimpleAgent,
        template: 'simple-agent',
        config: {},
        instance: agent,
        handle: makeHandle(agent),
      };

      manager.registerNode('agent-1');
      manager.attachGraphNode('agent-1', node);

      vi.mocked(notifications.emit).mockClear();

      const threadId = 'root-thread';
      const cfg = {
        configurable: {
          graph_id: 'graph-1',
          node_id: 'agent-1',
          // parent_thread_id intentionally missing
        },
      };

      await agentHandler({
        type: 'invoke',
        data: { threadId, messages: [], config: cfg },
      });

      await agentHandler({
        type: 'message',
        data: { threadId, messages: [], config: cfg },
      });

      await agentHandler({
        type: 'stateUpdate',
        data: { threadId, stateChange: { totalPrice: 0.01 }, config: cfg },
      });

      const agentInvoke = vi
        .mocked(notifications.emit)
        .mock.calls.find(
          (c: any) => c[0]?.type === NotificationEvent.AgentInvoke,
        )?.[0];
      const agentMessage = vi
        .mocked(notifications.emit)
        .mock.calls.find(
          (c: any) => c[0]?.type === NotificationEvent.AgentMessage,
        )?.[0];
      const agentStateUpdate = vi
        .mocked(notifications.emit)
        .mock.calls.find(
          (c: any) => c[0]?.type === NotificationEvent.AgentStateUpdate,
        )?.[0];

      expect(agentInvoke).toMatchObject({
        threadId,
        parentThreadId: threadId,
      });
      expect(agentMessage).toMatchObject({
        threadId,
        parentThreadId: threadId,
      });
      expect(agentStateUpdate).toMatchObject({
        threadId,
        parentThreadId: threadId,
      });
    });

    it('should not emit GraphNodeUpdate for agent invoke events (agent stays Idle)', async () => {
      const agent: any = {
        subscribe: vi.fn(),
        getGraphNodeMetadata: vi.fn(),
      };
      let agentHandler: any;
      agent.subscribe.mockImplementation((handler: any) => {
        agentHandler = handler;
        return vi.fn();
      });

      const node: CompiledGraphNode = {
        id: 'agent-1',
        type: NodeKind.SimpleAgent,
        template: 'simple-agent',
        config: {},
        instance: agent,
        handle: makeHandle(agent),
      };

      manager.registerNode('agent-1');
      manager.attachGraphNode('agent-1', node);

      vi.mocked(notifications.emit).mockClear();

      // Agent invoke should not change node status
      await agentHandler({
        type: 'invoke',
        data: {
          threadId: 't1',
          config: { configurable: { graph_id: 'graph-1', node_id: 'agent-1' } },
        },
      });

      const updates = vi
        .mocked(notifications.emit)
        .mock.calls.filter(
          (call: any) => call[0].type === NotificationEvent.GraphNodeUpdate,
        );

      // No GraphNodeUpdate emitted — agent node stays Idle, no status change
      expect(updates.length).toBe(0);
    });

    it('should update additional metadata when agent emits nodeAdditionalMetadataUpdate', async () => {
      const agent: any = {
        subscribe: vi.fn(),
        getGraphNodeMetadata: vi.fn(),
      };
      let agentHandler: any;
      agent.subscribe.mockImplementation((handler: any) => {
        agentHandler = handler;
        return vi.fn();
      });

      const node: CompiledGraphNode = {
        id: 'agent-1',
        type: NodeKind.SimpleAgent,
        template: 'simple-agent',
        config: {},
        instance: agent,
        handle: makeHandle(agent),
      };

      manager.registerNode('agent-1');
      manager.attachGraphNode('agent-1', node);

      const metadata = { threadId: 'thread-1' };
      const additionalMetadata = { key: 'value' };

      await agentHandler({
        type: 'nodeAdditionalMetadataUpdate',
        data: { metadata, additionalMetadata },
      });

      const snapshots = manager.getSnapshots('thread-1');
      expect(snapshots[0]?.additionalNodeMetadata).toEqual(additionalMetadata);
    });
  });

  describe('Agent waiting status', () => {
    const setupAgentNode = () => {
      const agent: any = {
        subscribe: vi.fn(),
        getGraphNodeMetadata: vi.fn(),
      };
      let agentHandler: any;
      agent.subscribe.mockImplementation((handler: any) => {
        agentHandler = handler;
        return vi.fn();
      });

      const node: CompiledGraphNode = {
        id: 'agent-1',
        type: NodeKind.SimpleAgent,
        template: 'simple-agent',
        config: {},
        instance: agent,
        handle: makeHandle(agent),
      };

      manager.registerNode('agent-1');
      manager.attachGraphNode('agent-1', node);

      return { agentHandler: () => agentHandler };
    };

    it('should emit ThreadStatus.Waiting when result.waiting is true', async () => {
      const { agentHandler } = setupAgentNode();

      // Invoke first to register execution
      await agentHandler()({
        type: 'invoke',
        data: {
          threadId: 'thread-1',
          config: {
            configurable: { graph_id: 'graph-1', node_id: 'agent-1' },
          },
        },
      });

      vi.mocked(notifications.emit).mockClear();

      await agentHandler()({
        type: 'run',
        data: {
          threadId: 'thread-1',
          config: {
            configurable: { graph_id: 'graph-1', node_id: 'agent-1' },
          },
          result: {
            messages: [],
            threadId: 'thread-1',
            waiting: true,
            waitMetadata: {
              durationSeconds: 300,
              checkPrompt: 'Check CI status',
              reason: 'Waiting for CI pipeline',
            },
          },
        },
      });

      const threadUpdate = vi
        .mocked(notifications.emit)
        .mock.calls.find(
          (call: any) => call[0].type === NotificationEvent.ThreadUpdate,
        )?.[0] as any;

      expect(threadUpdate).toBeDefined();
      expect(threadUpdate.data.status).toBe(ThreadStatus.Waiting);
    });

    it('should include scheduledResumeAt and waitReason in notification when waiting', async () => {
      const { agentHandler } = setupAgentNode();

      await agentHandler()({
        type: 'invoke',
        data: {
          threadId: 'thread-1',
          config: {
            configurable: { graph_id: 'graph-1', node_id: 'agent-1' },
          },
        },
      });

      vi.mocked(notifications.emit).mockClear();

      const beforeTime = Date.now();

      await agentHandler()({
        type: 'run',
        data: {
          threadId: 'thread-1',
          config: {
            configurable: { graph_id: 'graph-1', node_id: 'agent-1' },
          },
          result: {
            messages: [],
            threadId: 'thread-1',
            waiting: true,
            waitMetadata: {
              durationSeconds: 600,
              checkPrompt: 'Check deployment',
              reason: 'Waiting for deploy to finish',
            },
          },
        },
      });

      const threadUpdate = vi
        .mocked(notifications.emit)
        .mock.calls.find(
          (call: any) => call[0].type === NotificationEvent.ThreadUpdate,
        )?.[0] as any;

      expect(threadUpdate.data.waitReason).toBe('Waiting for deploy to finish');
      expect(threadUpdate.data.scheduledResumeAt).toBeDefined();

      const scheduledAt = new Date(
        threadUpdate.data.scheduledResumeAt,
      ).getTime();
      // scheduledResumeAt should be approximately now + 600s
      expect(scheduledAt).toBeGreaterThanOrEqual(beforeTime + 600 * 1000);
      expect(scheduledAt).toBeLessThanOrEqual(Date.now() + 600 * 1000 + 1000);
    });

    it('should emit THREAD_WAITING_EVENT via EventEmitter2 when waiting', async () => {
      const { agentHandler } = setupAgentNode();

      await agentHandler()({
        type: 'invoke',
        data: {
          threadId: 'thread-1',
          config: {
            configurable: { graph_id: 'graph-1', node_id: 'agent-1' },
          },
        },
      });

      vi.mocked(eventEmitter.emit).mockClear();

      await agentHandler()({
        type: 'run',
        data: {
          threadId: 'thread-1',
          config: {
            configurable: { graph_id: 'graph-1', node_id: 'agent-1' },
          },
          result: {
            messages: [],
            threadId: 'thread-1',
            waiting: true,
            waitMetadata: {
              durationSeconds: 120,
              checkPrompt: 'Check PR status',
              reason: 'Waiting for PR review',
            },
          },
        },
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        THREAD_WAITING_EVENT,
        expect.objectContaining({
          graphId: 'graph-1',
          nodeId: 'agent-1',
          threadId: 'thread-1',
          durationSeconds: 120,
          checkPrompt: 'Check PR status',
          reason: 'Waiting for PR review',
        }),
      );
    });

    it('should not emit THREAD_WAITING_EVENT when result is not waiting', async () => {
      const { agentHandler } = setupAgentNode();

      await agentHandler()({
        type: 'invoke',
        data: {
          threadId: 'thread-1',
          config: {
            configurable: { graph_id: 'graph-1', node_id: 'agent-1' },
          },
        },
      });

      vi.mocked(eventEmitter.emit).mockClear();

      await agentHandler()({
        type: 'run',
        data: {
          threadId: 'thread-1',
          config: {
            configurable: { graph_id: 'graph-1', node_id: 'agent-1' },
          },
          result: {
            messages: [],
            threadId: 'thread-1',
          },
        },
      });

      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        THREAD_WAITING_EVENT,
        expect.anything(),
      );
    });
  });

  describe('Snapshots and Filters', () => {
    it('should return snapshots with filters', () => {
      const runtime = new TestRuntime();
      const node: CompiledGraphNode<TestRuntime> = {
        id: 'runtime-1',
        type: NodeKind.Runtime,
        template: 'runtime',
        config: { c: 1 },
        instance: runtime,
        handle: makeHandle(runtime),
      };

      manager.registerNode('runtime-1');
      manager.attachGraphNode('runtime-1', node);

      const snapshots = manager.getSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        id: 'runtime-1',
        type: NodeKind.Runtime,
        config: { c: 1 },
      });
    });
  });

  describe('Cleanup', () => {
    it('should handle destroy cleanup', async () => {
      const runtime = new TestRuntime();

      const node: CompiledGraphNode<TestRuntime> = {
        id: 'runtime-1',
        type: NodeKind.Runtime,
        template: 'runtime',
        config: {},
        instance: runtime,
        handle: makeHandle(runtime),
      };

      manager.registerNode('runtime-1');
      manager.attachGraphNode('runtime-1', node);

      manager.destroy();

      expect(manager.getSnapshots()).toHaveLength(0);
    });
  });
});
