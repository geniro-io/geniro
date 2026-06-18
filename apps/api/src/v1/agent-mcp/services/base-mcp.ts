import type { ToolRunnableConfig } from '@langchain/core/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Injectable } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import { EventEmitter } from 'events';
import { z } from 'zod';

import { BuiltAgentTool } from '../../agent-tools/tools/base-tool';
import type { BaseAgentConfigurable } from '../../agents/agents.types';
import { RuntimeStartParams } from '../../runtime/runtime.types';
import { BaseRuntime } from '../../runtime/services/base-runtime';
import { DaytonaRuntime } from '../../runtime/services/daytona-runtime';
import { K8sRuntime } from '../../runtime/services/k8s-runtime';
import { RuntimeProvider } from '../../runtime/services/runtime-provider';
import { RuntimeThreadProvider } from '../../runtime/services/runtime-thread-provider';
import { IMcpServerConfig, McpStatus } from '../agent-mcp.types';
import { BaseMcpTool } from './base-mcp-tool';
import { DaytonaExecTransport } from './daytona-exec-transport';
import { DockerExecTransport } from './docker-exec-transport';
import { K8sExecTransport } from './k8s-exec-transport';

export type McpInitializeEvent = {
  config: unknown;
  error?: unknown;
};

export type McpReadyEvent = {
  toolCount: number;
};

export type McpDestroyEvent = {
  error?: unknown;
};

export type McpEventType =
  | { type: 'initialize'; data: McpInitializeEvent }
  | { type: 'ready'; data: McpReadyEvent }
  | { type: 'destroy'; data: McpDestroyEvent };

/**
 * Configuration for a mapped MCP tool
 */
export interface McpToolMetadata {
  /** Optional: Detailed instructions for this specific tool */
  getDetailedInstructions?: () => string;
  /** Optional: Generate a dynamic title for tool execution based on arguments */
  generateTitle?: (args: Record<string, unknown>) => string;
}

/**
 * Base class for all MCP implementations
 * Lifecycle: setup() → discoverTools() → execute() → cleanup()
 * Cleanup is called explicitly by GraphCompiler, not by NestJS lifecycle
 */
@Injectable()
export abstract class BaseMcp<TConfig = unknown> {
  /** Process-level cache: tracks images verified as available per runtime instance */
  private static readonly verifiedImages = new WeakMap<
    BaseRuntime,
    Set<string>
  >();
  /** Process-level cache: tracks runtimes whose Docker daemon has been confirmed ready */
  private static readonly daemonReadyRuntimes = new WeakSet<BaseRuntime>();

  protected runtimeThreadProvider?: RuntimeThreadProvider;
  protected logger: DefaultLogger;
  protected status: McpStatus = McpStatus.IDLE;
  protected eventEmitter = new EventEmitter();
  public config?: TConfig;
  private cachedTools?: BuiltAgentTool[];
  private readonly clients = new Map<string, Client>();
  private readonly clientRuntimes = new Map<string, BaseRuntime>();
  private registeredJobId?: string;
  private executorNodeId?: string;

  constructor(logger: DefaultLogger) {
    this.logger = logger;
  }

  /**
   * Subscribe to MCP events
   * Returns an unsubscriber function
   */
  subscribe(callback: (event: McpEventType) => Promise<void>): () => void {
    const handler = (event: McpEventType) => callback(event);
    this.eventEmitter.on('event', handler);
    return () => {
      this.eventEmitter.off('event', handler);
    };
  }

  /**
   * Emit MCP events
   */
  protected emit(event: McpEventType): void {
    this.eventEmitter.emit('event', event);
  }

  /**
   * Get current MCP status
   */
  getStatus(): McpStatus {
    return this.status;
  }

  /**
   * Whether the MCP has been initialized and is ready for tool calls
   */
  get isReady(): boolean {
    return this.status === McpStatus.READY;
  }

  protected getRuntimeInstance(): RuntimeThreadProvider | undefined {
    return this.runtimeThreadProvider;
  }

  /**
   * Optional: Define a mapping of tools to expose with additional metadata.
   * If defined, only tools in this mapping will be exposed.
   * If not defined, all tools from the MCP server will be exposed.
   *
   * @returns Array of tool mappings with optional metadata, or undefined to expose all tools
   */
  protected toolsMapping?(): Map<string, McpToolMetadata> | undefined;

  /**
   * Returns MCP server configuration (command, args, env)
   */
  public abstract getMcpConfig(config: TConfig): IMcpServerConfig;

  /**
   * Returns the initialization timeout in milliseconds
   * Override this method in subclasses to customize timeout per MCP
   * Default: 5 minutes (300000ms) - suitable for Docker image pulls
   */
  protected getInitTimeoutMs(): number {
    return 300_000;
  }

  /**
   * Setup: Initialize SDK client with DockerExecTransport
   * Runs MCP server command inside the connected Runtime (Docker type)
   */
  public async setup(config: TConfig, runtime: BaseRuntime): Promise<Client> {
    this.config = config;
    const mcpConfig = this.getMcpConfig(config);

    if (mcpConfig.requiresDockerDaemon) {
      await this.ensureDockerDaemonReady(runtime);
    }

    // Initialize transport based on runtime type
    let transport: Transport;
    if (runtime instanceof DaytonaRuntime) {
      const sandbox = runtime.getSandbox();
      if (!sandbox) {
        throw new Error(
          'Daytona runtime not started — cannot create MCP transport',
        );
      }
      transport = new DaytonaExecTransport(
        sandbox,
        mcpConfig.command,
        mcpConfig.args,
        mcpConfig.env || {},
        this.logger,
      );
    } else if (runtime instanceof K8sRuntime) {
      transport = new K8sExecTransport(
        runtime,
        mcpConfig.command,
        mcpConfig.args,
        mcpConfig.env || {},
        this.logger,
      );
    } else {
      transport = new DockerExecTransport(
        () => runtime,
        mcpConfig.command,
        mcpConfig.args,
        mcpConfig.env || {},
        this.logger,
      );
    }

    const client = new Client(
      {
        name: mcpConfig.name,
        version: '1.0.0',
      },
      {
        capabilities: {},
      },
    );

    await this.connectWithTimeout(client, transport, this.getInitTimeoutMs());
    return client;
  }

  protected async ensureDockerDaemonReady(
    runtime: BaseRuntime,
    timeoutMs = 90_000,
    intervalMs = 1000,
  ): Promise<void> {
    if (BaseMcp.daemonReadyRuntimes.has(runtime)) {
      return;
    }

    const start = Date.now();
    for (;;) {
      try {
        const res = await runtime.exec({
          cmd: 'docker info >/dev/null 2>&1',
          timeoutMs: 30_000,
          tailTimeoutMs: 10_000,
        });
        if (!res.fail) {
          BaseMcp.daemonReadyRuntimes.add(runtime);
          return;
        }
      } catch {
        //
      }

      if (Date.now() - start >= timeoutMs) {
        throw new Error('DOCKER_DAEMON_NOT_READY');
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  protected async ensureImagePulled(
    runtime: BaseRuntime,
    image: string,
    options?: {
      pullTimeoutMs?: number;
      tailTimeoutMs?: number;
      maxRetries?: number;
      retryDelayMs?: number;
    },
  ): Promise<void> {
    // Fast path: skip if we already verified this image on this runtime instance
    const verified = BaseMcp.verifiedImages.get(runtime);
    if (verified?.has(image)) {
      return;
    }

    const {
      pullTimeoutMs = 20 * 60_000,
      tailTimeoutMs = 5 * 60_000,
      maxRetries = 3,
      retryDelayMs = 10_000,
    } = options ?? {};

    const inspectResult = await runtime.exec({
      cmd: `docker image inspect "${image}" >/dev/null 2>&1`,
      timeoutMs: 30_000,
      tailTimeoutMs: 10_000,
    });

    if (!inspectResult.fail) {
      this.logger.log(`Image ${image} already available locally`);
      this.markImageVerified(runtime, image);
      return;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.logger.log(
        `Pulling image ${image} (attempt ${attempt}/${maxRetries})...`,
      );

      const pullResult = await runtime.exec({
        cmd: `docker pull "${image}"`,
        timeoutMs: pullTimeoutMs,
        tailTimeoutMs,
      });

      if (!pullResult.fail) {
        this.logger.log(`Image ${image} pulled successfully`);
        this.markImageVerified(runtime, image);
        return;
      }

      this.logger.warn(
        `Image pull attempt ${attempt}/${maxRetries} failed: ${pullResult.stderr || pullResult.stdout}`,
      );

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }

    throw new Error(
      `Failed to pull image ${image} after ${maxRetries} attempts`,
    );
  }

  private markImageVerified(runtime: BaseRuntime, image: string): void {
    let set = BaseMcp.verifiedImages.get(runtime);
    if (!set) {
      set = new Set();
      BaseMcp.verifiedImages.set(runtime, set);
    }
    set.add(image);
  }

  /**
   * Connect client with timeout
   */
  private async connectWithTimeout(
    client: Client,
    transport: Transport,
    timeoutMs: number,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `MCP initialization timed out after ${timeoutMs / 1000} seconds`,
          ),
        );
      }, timeoutMs);
    });

    try {
      await Promise.race([
        client.connect(transport, {
          timeout: timeoutMs,
        }),
        timeoutPromise,
      ]);
    } catch (error) {
      // Cleanup client on timeout or connection error
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  public async initialize(
    config: TConfig,
    runtimeThreadProvider: RuntimeThreadProvider,
    runtime: BaseRuntime,
    executorNodeId: string,
  ): Promise<void> {
    this.config = config;
    this.runtimeThreadProvider = runtimeThreadProvider;
    this.executorNodeId = executorNodeId;
    this.registerRuntimeInitJob();

    this.status = McpStatus.INITIALIZING;
    this.emit({ type: 'initialize', data: { config } });

    try {
      const client = await this.setup(config, runtime);
      const tools = await this.listTools(client);
      this.cachedTools = tools;
      await client.close().catch(() => undefined);

      this.status = McpStatus.READY;
      this.emit({ type: 'ready', data: { toolCount: tools.length } });
    } catch (error) {
      this.status = McpStatus.IDLE;
      this.emit({ type: 'initialize', data: { config, error } });
      throw error;
    }
  }

  /**
   * Resolve this block's MCP launch config against a SPECIFIC runtime, for a
   * consumer that spawns the server itself — the Claude Agent runs the SDK
   * inside the runtime and launches stdio MCP children directly, so it needs
   * only the `{command,args,env}`, not this class's exec-transport. Unlike
   * `initialize()` this opens no transport and lists no tools.
   *
   * `getMcpConfig` reads the runtime from internal state (e.g. the filesystem
   * block derives its workdir from `getRuntimeInstance()`), so the target
   * `runtimeThreadProvider` is set BEFORE the call and RESTORED immediately
   * after: a single MCP node can be wired to both a SimpleAgent and a Claude
   * node, and the restore keeps this shared instance's own runtime binding
   * (set by the block's `initialize()`) intact for the other consumer. The
   * swap window is purely synchronous (`getMcpConfig` is sync), so it is
   * invisible to any concurrent async caller; the Docker-daemon check uses the
   * passed `runtime` directly and runs after the binding is restored.
   */
  public async resolveServerConfigForRuntime(
    config: TConfig,
    runtimeThreadProvider: RuntimeThreadProvider,
    runtime: BaseRuntime,
  ): Promise<IMcpServerConfig> {
    const priorProvider = this.runtimeThreadProvider;
    const priorConfig = this.config;
    this.runtimeThreadProvider = runtimeThreadProvider;
    this.config = config;
    let mcpConfig: IMcpServerConfig;
    try {
      mcpConfig = this.getMcpConfig(config);
    } finally {
      this.runtimeThreadProvider = priorProvider;
      this.config = priorConfig;
    }

    if (mcpConfig.requiresDockerDaemon) {
      await this.ensureDockerDaemonReady(runtime);
    }

    return mcpConfig;
  }

  public async provideTemporaryRuntime(params: {
    runtimeProvider: RuntimeProvider;
    graphId: string;
    runtimeNodeId: string;
    runtimeConfig: RuntimeStartParams;
  }): Promise<BaseRuntime> {
    const { runtime } = await params.runtimeProvider.provide({
      graphId: params.graphId,
      runtimeNodeId: params.runtimeNodeId,
      threadId: `mcp-init-${params.graphId}-${params.runtimeNodeId}`,
      type: params.runtimeProvider.getDefaultRuntimeType(),
      runtimeStartParams: params.runtimeConfig,
      temporary: true,
    });

    return runtime;
  }

  private registerRuntimeInitJob(): void {
    if (!this.runtimeThreadProvider || !this.config) {
      return;
    }
    if (!this.executorNodeId) {
      return;
    }
    if (this.registeredJobId) {
      return;
    }

    const jobId = `mcp-init:${this.getMcpConfig(this.config).name}`;
    this.registeredJobId = jobId;

    this.runtimeThreadProvider.registerJob(
      this.executorNodeId,
      jobId,
      async (runtime, cfg) => {
        const threadId = this.getThreadId(cfg);
        await this.ensureClient(threadId, runtime);
      },
    );
  }

  private async listTools(client: Client): Promise<BuiltAgentTool[]> {
    const result = await client.listTools();
    let tools = result.tools;

    const mapping: Map<string, McpToolMetadata> =
      this.toolsMapping?.() || new Map<string, McpToolMetadata>();
    if (mapping && mapping.size > 0) {
      tools = tools.filter((tool) => mapping.has(tool.name));
    }

    const builtTools: BuiltAgentTool[] = [];

    for (const mcpTool of tools) {
      const toolMetadata = mapping.get(mcpTool.name);
      const toolInstance = new BaseMcpTool<
        z.infer<typeof mcpTool.inputSchema>,
        TConfig
      >(mcpTool, this.callTool.bind(this), toolMetadata);
      const builtAgentTool = toolInstance.build(this.config || ({} as TConfig));
      builtTools.push(builtAgentTool);
    }

    return builtTools;
  }

  /**
   * Discover available tools from the MCP server
   * Filters tools based on toolsMapping if defined
   */
  public async discoverTools(): Promise<BuiltAgentTool[]> {
    if (this.cachedTools) {
      return this.cachedTools;
    }
    throw new Error('MCP tools not initialized. Call initialize() first');
  }

  public async callTool(
    toolName: string,
    args: Record<string, unknown>,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ) {
    if (!this.runtimeThreadProvider) {
      throw new Error('Runtime provider not initialized for MCP');
    }
    if (!this.config) {
      throw new Error('MCP config not initialized');
    }

    const threadId = this.getThreadId(cfg);
    const runtime = await this.runtimeThreadProvider.provide(cfg);
    const client = await this.ensureClient(threadId, runtime);
    return client.callTool({
      name: toolName,
      arguments: args,
    });
  }

  private async ensureClient(
    threadId: string,
    runtime: BaseRuntime,
  ): Promise<Client> {
    const existing = this.clients.get(threadId);
    const existingRuntime = this.clientRuntimes.get(threadId);
    if (existing && existingRuntime === runtime) {
      return existing;
    }

    if (existing) {
      await existing.close().catch(() => undefined);
    }

    const client = await this.setup(this.config as TConfig, runtime);
    this.clients.set(threadId, client);
    this.clientRuntimes.set(threadId, runtime);
    return client;
  }

  private getThreadId(cfg: ToolRunnableConfig<BaseAgentConfigurable>): string {
    const threadId =
      cfg.configurable?.parent_thread_id || cfg.configurable?.thread_id;
    if (!threadId) {
      throw new Error('Thread id is required for MCP execution');
    }
    return threadId;
  }

  /**
   * Explicit cleanup - called by GraphCompiler on graph destruction
   * NOT called by NestJS lifecycle (TRANSIENT services don't get onModuleDestroy reliably)
   */
  public async cleanup(): Promise<void> {
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    this.clientRuntimes.clear();
    this.cachedTools = undefined;

    let cleanupError: unknown;

    await Promise.all(
      clients.map(async (client) => {
        try {
          await client.close();
        } catch (error) {
          cleanupError = error;
          this.logger.error(
            error instanceof Error ? error : new Error(String(error)),
            'Error closing MCP client',
          );
        }
      }),
    );

    if (this.runtimeThreadProvider && this.executorNodeId) {
      this.runtimeThreadProvider.removeExecutor(this.executorNodeId);
    }

    this.status = McpStatus.DESTROYED;
    this.emit({
      type: 'destroy',
      data: { ...(cleanupError ? { error: cleanupError } : {}) },
    });
  }

  /**
   * Optional: Provide detailed instructions for this MCP
   */
  public getDetailedInstructions?(config: TConfig): string;
}
