import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseRuntime } from '../../runtime/services/base-runtime';
import { K8sRuntime } from '../../runtime/services/k8s-runtime';
import { RuntimeThreadProvider } from '../../runtime/services/runtime-thread-provider';
import { IMcpServerConfig, McpStatus } from '../agent-mcp.types';
import { BaseMcp, McpEventType, McpToolMetadata } from './base-mcp';
import { K8sExecTransport } from './k8s-exec-transport';

// Create a concrete test implementation of BaseMcp
class TestMcp extends BaseMcp<Record<string, never>> {
  private toolsMappingInternal?: Map<string, McpToolMetadata>;

  public getMcpConfig(): IMcpServerConfig {
    return {
      name: 'test-mcp',
      command: 'test',
      args: [],
      env: {},
    };
  }

  // Expose toolsMapping for testing
  public setToolsMapping(
    mapping: Map<string, McpToolMetadata> | undefined,
  ): void {
    this.toolsMappingInternal = mapping;
  }

  protected override toolsMapping(): Map<string, McpToolMetadata> | undefined {
    return this.toolsMappingInternal;
  }
}

describe('BaseMcp', () => {
  let testMcp: TestMcp;
  let mockLogger: DefaultLogger;
  let mockRuntime: BaseRuntime;
  let mockRuntimeThreadProvider: RuntimeThreadProvider;

  beforeEach(() => {
    mockLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as DefaultLogger;

    testMcp = new TestMcp(mockLogger);
    mockRuntime = {
      exec: vi.fn(),
      execStream: vi.fn(),
    } as unknown as BaseRuntime;
    mockRuntimeThreadProvider = {
      registerJob: vi.fn(),
      removeExecutor: vi.fn(),
    } as unknown as RuntimeThreadProvider;
  });

  describe('discoverTools', () => {
    const mockTools: ListToolsResult['tools'] = [
      {
        name: 'tool1',
        description: 'Tool 1',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'tool2',
        description: 'Tool 2',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'tool3',
        description: 'Tool 3',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'tool4',
        description: 'Tool 4',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    it('should return all tools when no toolsMapping is set', async () => {
      vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
      vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
        tools: mockTools,
      } as ListToolsResult);
      vi.spyOn(Client.prototype, 'close').mockResolvedValue();

      await testMcp.initialize(
        {},
        mockRuntimeThreadProvider,
        mockRuntime,
        'executor-1',
      );
      const result = await testMcp.discoverTools();

      expect(result).toHaveLength(4);
      // discoverTools() returns BuiltAgentTool[], check the tool names match
      expect(result.map((t) => t.name)).toEqual([
        'tool1',
        'tool2',
        'tool3',
        'tool4',
      ]);
    });

    it('should filter tools when toolsMapping is set', async () => {
      vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
      vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
        tools: mockTools,
      } as ListToolsResult);
      vi.spyOn(Client.prototype, 'close').mockResolvedValue();
      testMcp.setToolsMapping(
        new Map([
          ['tool1', {}],
          ['tool3', {}],
        ]),
      );
      await testMcp.initialize(
        {},
        mockRuntimeThreadProvider,
        mockRuntime,
        'executor-1',
      );
      const result = await testMcp.discoverTools();

      expect(result).toHaveLength(2);
      expect(result.map((t) => t.name)).toEqual(['tool1', 'tool3']);
    });

    it('should return empty array when toolsMapping is set but no tools match', async () => {
      vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
      vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
        tools: mockTools,
      } as ListToolsResult);
      vi.spyOn(Client.prototype, 'close').mockResolvedValue();
      testMcp.setToolsMapping(new Map([['nonexistent', {}]]));
      await testMcp.initialize(
        {},
        mockRuntimeThreadProvider,
        mockRuntime,
        'executor-1',
      );
      const result = await testMcp.discoverTools();

      expect(result).toHaveLength(0);
    });

    it('should return all tools when toolsMapping is empty map', async () => {
      vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
      vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
        tools: mockTools,
      } as ListToolsResult);
      vi.spyOn(Client.prototype, 'close').mockResolvedValue();
      testMcp.setToolsMapping(new Map());
      await testMcp.initialize(
        {},
        mockRuntimeThreadProvider,
        mockRuntime,
        'executor-1',
      );
      const result = await testMcp.discoverTools();

      expect(result).toHaveLength(4);
      // discoverTools() returns BuiltAgentTool[], check the tool names match
      expect(result.map((t) => t.name)).toEqual([
        'tool1',
        'tool2',
        'tool3',
        'tool4',
      ]);
    });

    it('should throw error when tools are not initialized', async () => {
      await expect(testMcp.discoverTools()).rejects.toThrow(
        'MCP tools not initialized. Call initialize() first',
      );
    });
  });

  describe('toolsMapping', () => {
    it('should return undefined metadata when no toolsMapping is set', () => {
      const mapping = testMcp['toolsMapping']?.();
      const metadata = mapping?.get('tool1');

      expect(metadata).toBeUndefined();
    });

    it('should return metadata for a tool when toolsMapping is set', () => {
      const mockInstructions = vi
        .fn()
        .mockReturnValue('Instructions for tool1');
      const mockTitleGenerator = vi.fn().mockReturnValue('Tool1 Title');

      testMcp.setToolsMapping(
        new Map([
          [
            'tool1',
            {
              getDetailedInstructions: mockInstructions,
              generateTitle: mockTitleGenerator,
            },
          ],
          ['tool2', {}],
        ]),
      );

      const mapping = testMcp['toolsMapping']?.();
      const metadata = mapping?.get('tool1');

      expect(metadata).toBeDefined();
      expect(metadata?.getDetailedInstructions).toBe(mockInstructions);
      expect(metadata?.generateTitle).toBe(mockTitleGenerator);
    });

    it('should return undefined for non-existent tool', () => {
      testMcp.setToolsMapping(
        new Map([
          ['tool1', {}],
          ['tool2', {}],
        ]),
      );

      const mapping = testMcp['toolsMapping']?.();
      const metadata = mapping?.get('tool3');

      expect(metadata).toBeUndefined();
    });

    it('should work with partial metadata', () => {
      testMcp.setToolsMapping(
        new Map([
          ['tool1', { getDetailedInstructions: () => 'Instructions' }],
          ['tool2', { generateTitle: () => 'Title' }],
          ['tool3', {}],
        ]),
      );

      const mapping = testMcp['toolsMapping']?.();

      const metadata1 = mapping?.get('tool1');
      expect(metadata1?.getDetailedInstructions).toBeDefined();
      expect(metadata1?.generateTitle).toBeUndefined();

      const metadata2 = mapping?.get('tool2');
      expect(metadata2?.getDetailedInstructions).toBeUndefined();
      expect(metadata2?.generateTitle).toBeDefined();

      const metadata3 = mapping?.get('tool3');
      expect(metadata3?.getDetailedInstructions).toBeUndefined();
      expect(metadata3?.generateTitle).toBeUndefined();
    });
  });

  describe('cleanup', () => {
    it('should close client and clear reference', async () => {
      const mockClient = {
        close: vi.fn(),
      } as unknown as Client;
      (testMcp as any).clients = new Map([['thread-1', mockClient]]);

      await testMcp.cleanup();

      expect(mockClient.close).toHaveBeenCalled();
      expect((testMcp as any).clients.size).toBe(0);
    });

    it('should handle errors gracefully during cleanup', async () => {
      const error = new Error('Close failed');
      const mockClient = {
        close: vi.fn().mockRejectedValue(error),
      } as unknown as Client;
      (testMcp as any).clients = new Map([['thread-1', mockClient]]);

      await expect(testMcp.cleanup()).resolves.not.toThrow();
      expect(mockLogger.error).toHaveBeenCalledWith(
        error,
        'Error closing MCP client',
      );
    });

    it('should not throw when no clients are present', async () => {
      (testMcp as any).clients = new Map();

      await expect(testMcp.cleanup()).resolves.not.toThrow();
    });
  });

  describe('setup', () => {
    beforeEach(() => {
      vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
      vi.spyOn(Client.prototype, 'close').mockResolvedValue();
    });

    it('should successfully connect within timeout', async () => {
      const config = {};

      const client = await testMcp.setup(config, mockRuntime);

      expect(client).toBeDefined();
    });

    it('should throw timeout error if connection takes too long', async () => {
      const config = {};

      vi.useFakeTimers();
      try {
        // Mock connect to never resolve (timeout should win)
        vi.spyOn(Client.prototype, 'connect').mockImplementation(
          () => new Promise<void>(() => {}),
        );

        const setupPromise = testMcp.setup(config, mockRuntime);
        const setupExpectation = expect(setupPromise).rejects.toThrow(
          'MCP initialization timed out after 300 seconds',
        );

        // BaseMcp default uses a 300s (5 minutes) connect timeout
        await vi.advanceTimersByTimeAsync(300_000);

        await setupExpectation;
      } finally {
        vi.useRealTimers();
      }
    });

    it('should cleanup client on connection error', async () => {
      const config = {};
      const connectionError = new Error('Connection failed');

      vi.spyOn(Client.prototype, 'connect').mockRejectedValue(connectionError);

      await expect(testMcp.setup(config, mockRuntime)).rejects.toThrow(
        'Connection failed',
      );
    });

    it('should instantiate K8sExecTransport when runtime is a K8sRuntime instance', async () => {
      // Arrange: build a minimal K8sRuntime stand-in via Object.create so
      // `instanceof K8sRuntime` returns true without triggering the real
      // constructor (which requires a live kubeconfig).
      const mockK8sRuntime = Object.create(K8sRuntime.prototype) as K8sRuntime;

      let capturedTransport: unknown;
      vi.spyOn(Client.prototype, 'connect').mockImplementation(async function (
        this: unknown,
        transport: unknown,
      ) {
        capturedTransport = transport;
      });
      vi.spyOn(Client.prototype, 'close').mockResolvedValue();

      // K8sExecTransport.prototype.start is called by Client.connect internally
      // via the transport; mock it to avoid real SPDY calls.
      vi.spyOn(K8sExecTransport.prototype, 'start').mockResolvedValue();

      await testMcp.setup({}, mockK8sRuntime);

      expect(capturedTransport).toBeInstanceOf(K8sExecTransport);
    });
  });

  describe('status', () => {
    it('should start with IDLE status', () => {
      expect(testMcp.getStatus()).toBe(McpStatus.IDLE);
      expect(testMcp.isReady).toBe(false);
    });

    it('should transition to READY after successful initialize', async () => {
      vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
      vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
        tools: [],
      } as ListToolsResult);
      vi.spyOn(Client.prototype, 'close').mockResolvedValue();

      await testMcp.initialize(
        {},
        mockRuntimeThreadProvider,
        mockRuntime,
        'executor-1',
      );

      expect(testMcp.getStatus()).toBe(McpStatus.READY);
      expect(testMcp.isReady).toBe(true);
    });

    it('should revert to IDLE on failed initialize', async () => {
      vi.spyOn(Client.prototype, 'connect').mockRejectedValue(
        new Error('Connection failed'),
      );
      vi.spyOn(Client.prototype, 'close').mockResolvedValue();

      await expect(
        testMcp.initialize(
          {},
          mockRuntimeThreadProvider,
          mockRuntime,
          'executor-1',
        ),
      ).rejects.toThrow('Connection failed');

      expect(testMcp.getStatus()).toBe(McpStatus.IDLE);
      expect(testMcp.isReady).toBe(false);
    });

    it('should transition to DESTROYED after cleanup', async () => {
      vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
      vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
        tools: [],
      } as ListToolsResult);
      vi.spyOn(Client.prototype, 'close').mockResolvedValue();

      await testMcp.initialize(
        {},
        mockRuntimeThreadProvider,
        mockRuntime,
        'executor-1',
      );
      await testMcp.cleanup();

      expect(testMcp.getStatus()).toBe(McpStatus.DESTROYED);
      expect(testMcp.isReady).toBe(false);
    });
  });

  describe('ensureImagePulled', () => {
    const TEST_IMAGE = 'test/image:latest';

    it('should skip pull when image already exists locally', async () => {
      const execMock = vi.mocked(mockRuntime.exec);
      execMock.mockResolvedValueOnce({
        fail: false,
        exitCode: 0,
        stdout: '',
        stderr: '',
        execPath: '',
      });

      await testMcp['ensureImagePulled'](mockRuntime, TEST_IMAGE);

      expect(execMock).toHaveBeenCalledTimes(1);
      expect(execMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: `docker image inspect "${TEST_IMAGE}" >/dev/null 2>&1`,
        }),
      );
      expect(mockLogger.log).toHaveBeenCalledWith(
        `Image ${TEST_IMAGE} already available locally`,
      );
    });

    it('should pull image on first attempt when not present locally', async () => {
      const execMock = vi.mocked(mockRuntime.exec);
      // inspect fails
      execMock.mockResolvedValueOnce({
        fail: true,
        exitCode: 1,
        stdout: '',
        stderr: 'No such image',
        execPath: '',
      });
      // pull succeeds
      execMock.mockResolvedValueOnce({
        fail: false,
        exitCode: 0,
        stdout: 'Pull complete',
        stderr: '',
        execPath: '',
      });

      await testMcp['ensureImagePulled'](mockRuntime, TEST_IMAGE);

      expect(execMock).toHaveBeenCalledTimes(2);
      expect(execMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          cmd: `docker pull "${TEST_IMAGE}"`,
        }),
      );
      expect(mockLogger.log).toHaveBeenCalledWith(
        `Image ${TEST_IMAGE} pulled successfully`,
      );
    });

    it('should retry and succeed on second attempt', async () => {
      const execMock = vi.mocked(mockRuntime.exec);
      // inspect fails
      execMock.mockResolvedValueOnce({
        fail: true,
        exitCode: 1,
        stdout: '',
        stderr: '',
        execPath: '',
      });
      // first pull fails
      execMock.mockResolvedValueOnce({
        fail: true,
        exitCode: 1,
        stdout: '',
        stderr: 'network error',
        execPath: '',
      });
      // second pull succeeds
      execMock.mockResolvedValueOnce({
        fail: false,
        exitCode: 0,
        stdout: 'Pull complete',
        stderr: '',
        execPath: '',
      });

      await testMcp['ensureImagePulled'](mockRuntime, TEST_IMAGE, {
        maxRetries: 3,
        retryDelayMs: 0,
      });

      expect(execMock).toHaveBeenCalledTimes(3);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('attempt 1/3 failed'),
      );
      expect(mockLogger.log).toHaveBeenCalledWith(
        `Image ${TEST_IMAGE} pulled successfully`,
      );
    });

    it('should throw after all retries are exhausted', async () => {
      const execMock = vi.mocked(mockRuntime.exec);
      // inspect fails
      execMock.mockResolvedValueOnce({
        fail: true,
        exitCode: 1,
        stdout: '',
        stderr: '',
        execPath: '',
      });
      // all 3 pulls fail
      for (let i = 0; i < 3; i++) {
        execMock.mockResolvedValueOnce({
          fail: true,
          exitCode: 1,
          stdout: '',
          stderr: 'timeout',
          execPath: '',
        });
      }

      await expect(
        testMcp['ensureImagePulled'](mockRuntime, TEST_IMAGE, {
          maxRetries: 3,
          retryDelayMs: 0,
        }),
      ).rejects.toThrow(`Failed to pull image ${TEST_IMAGE} after 3 attempts`);

      // 1 inspect + 3 pull attempts
      expect(execMock).toHaveBeenCalledTimes(4);
      expect(mockLogger.warn).toHaveBeenCalledTimes(3);
    });
  });

  describe('resolveServerConfigForRuntime', () => {
    // Records the runtime provider visible to getMcpConfig (re-point proof) and
    // exposes the protected binding so the save/restore invariant is testable.
    class ProbeMcp extends BaseMcp<{ tag?: string }> {
      public seenProviderTag?: string;
      public throwOnConfig = false;
      public requiresDocker = false;

      public getMcpConfig(config: { tag?: string }): IMcpServerConfig {
        const provider = this.getRuntimeInstance() as unknown as
          | { tag?: string }
          | undefined;
        this.seenProviderTag = provider?.tag;
        if (this.throwOnConfig) {
          throw new Error('bad config');
        }
        return {
          name: 'probe',
          command: `cmd-${config.tag ?? 'none'}`,
          args: [],
          env: {},
          ...(this.requiresDocker ? { requiresDockerDaemon: true } : {}),
        };
      }

      public bind(provider: RuntimeThreadProvider, config: { tag?: string }) {
        this.runtimeThreadProvider = provider;
        this.config = config;
      }

      public get boundProvider(): RuntimeThreadProvider | undefined {
        return this.runtimeThreadProvider;
      }
    }

    const taggedProvider = (tag: string): RuntimeThreadProvider =>
      ({ tag }) as unknown as RuntimeThreadProvider;

    it('re-points at the target runtime for getMcpConfig and restores the prior binding', async () => {
      const mcp = new ProbeMcp(mockLogger);
      const priorProvider = taggedProvider('simple-agent');
      const priorConfig = { tag: 'prior' };
      mcp.bind(priorProvider, priorConfig);

      const result = await mcp.resolveServerConfigForRuntime(
        { tag: 'claude' },
        taggedProvider('claude'),
        mockRuntime,
      );

      // getMcpConfig ran against the Claude provider (re-point worked)...
      expect(mcp.seenProviderTag).toBe('claude');
      expect(result.command).toBe('cmd-claude');
      // ...and the shared instance keeps its original (SimpleAgent) binding so a
      // block wired to BOTH a SimpleAgent and a Claude node is not corrupted.
      expect(mcp.boundProvider).toBe(priorProvider);
      expect(mcp.config).toBe(priorConfig);
    });

    it('restores the prior binding even when getMcpConfig throws', async () => {
      const mcp = new ProbeMcp(mockLogger);
      mcp.throwOnConfig = true;
      const priorProvider = taggedProvider('simple-agent');
      const priorConfig = { tag: 'prior' };
      mcp.bind(priorProvider, priorConfig);

      await expect(
        mcp.resolveServerConfigForRuntime(
          { tag: 'claude' },
          taggedProvider('claude'),
          mockRuntime,
        ),
      ).rejects.toThrow('bad config');

      expect(mcp.boundProvider).toBe(priorProvider);
      expect(mcp.config).toBe(priorConfig);
    });

    it('readies the Docker daemon for a docker-based server before returning', async () => {
      const mcp = new ProbeMcp(mockLogger);
      mcp.requiresDocker = true;
      const execMock = vi.mocked(mockRuntime.exec);
      execMock.mockResolvedValue({
        fail: false,
        exitCode: 0,
        stdout: '',
        stderr: '',
        execPath: '',
      });

      const result = await mcp.resolveServerConfigForRuntime(
        { tag: 'playwright' },
        taggedProvider('claude'),
        mockRuntime,
      );

      expect(result.requiresDockerDaemon).toBe(true);
      expect(execMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: expect.stringContaining('docker info'),
        }),
      );
    });
  });

  describe('events', () => {
    it('should emit initialize and ready events on successful initialize', async () => {
      vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
      vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
        tools: [
          {
            name: 'tool1',
            description: 'Tool 1',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      } as ListToolsResult);
      vi.spyOn(Client.prototype, 'close').mockResolvedValue();

      const events: McpEventType[] = [];
      testMcp.subscribe(async (event) => {
        events.push(event);
      });

      await testMcp.initialize(
        {},
        mockRuntimeThreadProvider,
        mockRuntime,
        'executor-1',
      );

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: 'initialize' });
      expect(events[1]).toMatchObject({
        type: 'ready',
        data: { toolCount: 1 },
      });
    });

    it('should emit initialize event with error on failed initialize', async () => {
      vi.spyOn(Client.prototype, 'connect').mockRejectedValue(
        new Error('Connection failed'),
      );
      vi.spyOn(Client.prototype, 'close').mockResolvedValue();

      const events: McpEventType[] = [];
      testMcp.subscribe(async (event) => {
        events.push(event);
      });

      await expect(
        testMcp.initialize(
          {},
          mockRuntimeThreadProvider,
          mockRuntime,
          'executor-1',
        ),
      ).rejects.toThrow();

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: 'initialize' });
      expect(events[1]).toMatchObject({ type: 'initialize' });
      expect(
        (events[1] as { data: { error?: unknown } }).data.error,
      ).toBeDefined();
    });

    it('should emit destroy event on cleanup', async () => {
      const events: McpEventType[] = [];
      testMcp.subscribe(async (event) => {
        events.push(event);
      });

      await testMcp.cleanup();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'destroy' });
    });

    it('should support unsubscribe', async () => {
      const events: McpEventType[] = [];
      const unsub = testMcp.subscribe(async (event) => {
        events.push(event);
      });

      unsub();
      await testMcp.cleanup();

      expect(events).toHaveLength(0);
    });
  });
});
