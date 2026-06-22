import { HumanMessage } from '@langchain/core/messages';
import { ModuleRef } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { LoggerModule, NotFoundException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ManualTrigger } from '../../../agent-triggers/services/manual-trigger';
import { SimpleAgent } from '../../../agents/services/agents/simple-agent';
import {
  CompiledGraphNode,
  GraphNode,
  GraphNodeInstanceHandle,
  GraphNodeStatus,
  NodeKind,
} from '../../../graphs/graphs.types';
import { GraphRegistry } from '../../../graphs/services/graph-registry';
import { OAuthRunPreflightService } from '../../../graphs/services/oauth-run-preflight.service';
import { ThreadsDao } from '../../../threads/dao/threads.dao';
import {
  ManualTriggerTemplate,
  ManualTriggerTemplateSchema,
} from './manual-trigger.template';

const makeHandle = <TInstance>(
  instance: TInstance,
): GraphNodeInstanceHandle<TInstance, any> => ({
  provide: async () => instance,
  configure: async () => {},
  destroy: async () => {},
});

const buildCompiledNode = <TInstance>(options: {
  id: string;
  type: NodeKind;
  template: string;
  instance: TInstance;
  config?: unknown;
}): CompiledGraphNode<TInstance> =>
  ({
    ...options,
    handle: makeHandle(options.instance),
    config: options.config ?? {},
    getStatus: () => GraphNodeStatus.Idle,
  }) as unknown as CompiledGraphNode<TInstance>;

describe('ManualTriggerTemplate', () => {
  let template: ManualTriggerTemplate;
  let mockModuleRef: ModuleRef;
  let mockManualTrigger: ManualTrigger;
  let mockSimpleAgent: SimpleAgent;
  let mockGraphRegistry: GraphRegistry;
  let mockAgentNode: CompiledGraphNode<SimpleAgent>;
  let mockOAuthPreflight: { checkAndPauseIfNeeded: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mockOAuthPreflight = {
      checkAndPauseIfNeeded: vi.fn().mockResolvedValue(false),
    };

    mockSimpleAgent = {
      runOrAppend: vi.fn(),
    } as unknown as SimpleAgent;

    mockAgentNode = buildCompiledNode({
      id: 'agent-1',
      type: NodeKind.SimpleAgent,
      template: 'simple-agent',
      instance: mockSimpleAgent,
    });

    mockManualTrigger = {
      setInvokeAgent: vi.fn(),
      start: vi.fn(),
      getStatus: vi.fn().mockReturnValue('listening'),
    } as unknown as ManualTrigger;

    mockModuleRef = {
      resolve: vi.fn().mockResolvedValue(mockManualTrigger),
      create: vi.fn().mockResolvedValue(mockManualTrigger),
    } as unknown as ModuleRef;

    mockGraphRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn(),
      getNode: vi.fn().mockReturnValue(mockAgentNode),
      getNodeInstance: vi.fn().mockReturnValue(mockSimpleAgent),
      destroy: vi.fn(),
    } as unknown as GraphRegistry;

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
        ManualTriggerTemplate,
        {
          provide: ModuleRef,
          useValue: mockModuleRef,
        },
        {
          provide: GraphRegistry,
          useValue: mockGraphRegistry,
        },
        {
          provide: ThreadsDao,
          useValue: {
            getOne: vi.fn().mockResolvedValue(undefined),
            getAll: vi.fn(),
            create: vi.fn(),
            updateById: vi.fn(),
            deleteById: vi.fn(),
          },
        },
        {
          provide: OAuthRunPreflightService,
          useValue: mockOAuthPreflight,
        },
      ],
    }).compile();

    template = module.get<ManualTriggerTemplate>(ManualTriggerTemplate);
  });

  describe('properties', () => {
    it('should have correct name', () => {
      expect(template.name).toBe('Manual');
    });

    it('should have correct description', () => {
      expect(template.description).toBe(
        'Manual trigger for direct agent invocation',
      );
    });

    it('should have correct kind', () => {
      expect(template.kind).toBe(NodeKind.Trigger);
    });

    it('should have correct schema', () => {
      expect(template.schema).toBe(ManualTriggerTemplateSchema);
    });
  });

  describe('schema validation', () => {
    it('should work with empty config', () => {
      expect(() => ManualTriggerTemplateSchema.parse({})).not.toThrow();
    });

    it('should ignore legacy/unknown fields', () => {
      const dataWithExtra = {
        oldTriggerMode: 'manual',
        extraValue: 123,
      };

      const parsed = ManualTriggerTemplateSchema.parse(dataWithExtra);
      expect(parsed).toEqual({});
      expect(parsed).not.toHaveProperty('oldTriggerMode');
    });
  });

  describe('create', () => {
    const mockMetadata = {
      graphId: 'graph-1',
      nodeId: 'trigger-1',
      version: '1',
      graph_created_by: 'user-1',
      graph_project_id: '11111111-1111-1111-1111-111111111111',
    };

    it('should throw NotFoundException when no agent nodes found in output connections', async () => {
      const handle = await template.create();
      const init: GraphNode<Record<string, never>> = {
        config: {},
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);
      await expect(handle.configure(init, instance)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException with correct error message', async () => {
      const handle = await template.create();
      const init: GraphNode<Record<string, never>> = {
        config: {},
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);
      await expect(handle.configure(init, instance)).rejects.toThrow(
        /No output connections found for trigger/,
      );
    });

    it('should create manual trigger with valid agent node', async () => {
      const outputNodeIds = new Set(['agent-1']);
      const handle = await template.create();
      const init: GraphNode<Record<string, never>> = {
        config: {},
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(instance).toBe(mockManualTrigger);
      expect(mockManualTrigger.start).toHaveBeenCalled();
    });

    it('should configure trigger to invoke agent correctly', async () => {
      const outputNodeIds = new Set(['agent-1']);
      const handle = await template.create();
      const init: GraphNode<Record<string, never>> = {
        config: {},
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockManualTrigger.setInvokeAgent).toHaveBeenCalled();
      const invokeFn = vi.mocked(mockManualTrigger.setInvokeAgent).mock
        .calls[0]![0] as any;
      expect(invokeFn).toBeDefined();

      const input = [new HumanMessage('Hello agent')];
      const config = {
        configurable: { user_id: 'user-1', thread_id: 'manual-thread-id' },
      };

      await invokeFn!(input as any, config as any);

      expect(mockSimpleAgent.runOrAppend).toHaveBeenCalledWith(
        'graph-1:manual-thread-id',
        expect.arrayContaining([expect.any(HumanMessage)]),
        undefined,
        expect.objectContaining({
          configurable: expect.objectContaining({
            user_id: 'user-1',
            graph_id: 'graph-1',
            node_id: 'agent-1',
          }),
        }),
      );
    });

    it('pauses (does NOT invoke the agent) when the OAuth pre-flight returns true', async () => {
      mockOAuthPreflight.checkAndPauseIfNeeded.mockResolvedValueOnce(true);

      const outputNodeIds = new Set(['agent-1']);
      const handle = await template.create();
      const init: GraphNode<Record<string, never>> = {
        config: {},
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      const invokeFn = vi.mocked(mockManualTrigger.setInvokeAgent).mock
        .calls[0]![0] as (
        messages: HumanMessage[],
        config: unknown,
      ) => Promise<{ messages: unknown[]; threadId: string }>;

      const result = await invokeFn([new HumanMessage('do the thing')], {
        configurable: { thread_id: 'manual-thread-id' },
      } as never);

      // The producer was consulted with the run's pause target...
      expect(mockOAuthPreflight.checkAndPauseIfNeeded).toHaveBeenCalledWith(
        expect.objectContaining({
          graphId: 'graph-1',
          externalThreadId: 'graph-1:manual-thread-id',
          agentNodeId: 'agent-1',
          pendingMessageText: 'do the thing',
        }),
      );
      // ...and the agent was NOT run; an empty-message result is returned.
      expect(mockSimpleAgent.runOrAppend).not.toHaveBeenCalled();
      expect(result.messages).toEqual([]);
      expect(result.threadId).toBe('graph-1:manual-thread-id');
    });

    it('should use default thread_id if not provided in config', async () => {
      const outputNodeIds = new Set(['agent-1']);
      const handle = await template.create();
      const init: GraphNode<Record<string, never>> = {
        config: {},
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      const invokeFn = vi.mocked(mockManualTrigger.setInvokeAgent).mock
        .calls[0]![0] as any;
      expect(invokeFn).toBeDefined();
      await invokeFn!(
        [new HumanMessage('hi')] as any,
        { configurable: {} } as any,
      );

      expect(mockSimpleAgent.runOrAppend).toHaveBeenCalledWith(
        expect.stringMatching(/^graph-1:/),
        expect.anything(),
        undefined,
        expect.anything(),
      );
    });

    it('should preserve existing configurable properties when enriching', async () => {
      const outputNodeIds = new Set(['agent-1']);
      const handle = await template.create();
      const init: GraphNode<Record<string, never>> = {
        config: {},
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata: mockMetadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      const invokeFn = vi.mocked(mockManualTrigger.setInvokeAgent).mock
        .calls[0]![0] as any;
      expect(invokeFn).toBeDefined();
      const config = {
        configurable: {
          existing_prop: 'exists',
        },
      };

      await invokeFn!([new HumanMessage('hi')] as any, config as any);

      const runConfig = vi.mocked(mockSimpleAgent.runOrAppend).mock
        .calls[0]![3] as any;
      expect(runConfig.configurable.existing_prop).toBe('exists');
      expect(runConfig.configurable.graph_id).toBe('graph-1');
    });
  });
});
