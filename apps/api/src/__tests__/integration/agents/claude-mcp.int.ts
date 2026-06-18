import { HumanMessage } from '@langchain/core/messages';
import { INestApplication } from '@nestjs/common';
import type { BridgeStartOptions } from '@packages/claude-bridge';
import { DefaultLogger } from '@packages/common';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { BaseMcp } from '../../../v1/agent-mcp/services/base-mcp';
import { CustomMcp } from '../../../v1/agent-mcp/services/mcp/custom-mcp';
import { FilesystemMcp } from '../../../v1/agent-mcp/services/mcp/filesystem-mcp';
import { PlaywrightMcp } from '../../../v1/agent-mcp/services/mcp/playwright-mcp';
import { BaseAgentConfigurable } from '../../../v1/agents/agents.types';
import { ClaudeAgent } from '../../../v1/agents/services/agents/claude-agent';
import { ClaudeBootstrapService } from '../../../v1/agents/services/claude/claude-bootstrap.service';
import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { LiteLlmClient } from '../../../v1/litellm/services/litellm.client';
import { LitellmVirtualKeyService } from '../../../v1/litellm/services/litellm-virtual-key.service';
import type { BaseRuntime } from '../../../v1/runtime/services/base-runtime';
import type { RuntimeThreadProvider } from '../../../v1/runtime/services/runtime-thread-provider';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { createTestProject } from '../helpers/test-context';
import { MockRuntime } from '../mocks/mock-runtime/mock-runtime';
import { MockRuntimeService } from '../mocks/mock-runtime/mock-runtime.service';
import { createTestModule, TEST_USER_ID } from '../setup';

const NODE_ID = 'claude-mcp-agent';
const BRIDGE_PATH = '/opt/geniro-claude/bridge.mjs';
// The workdir the Claude node's runtime reports — the resolver must re-point
// each block at THIS runtime so e.g. the filesystem server's args carry it.
const CLAUDE_WORKDIR = '/claude-runtime-workspace';

/**
 * M1 — external MCP for the Claude Agent node. Drives a real `ClaudeAgent.run()`
 * through the real transport with the bridge replaced by the in-process
 * MockBridge, and asserts on the `externalMcpServers` the bridge `start` frame
 * carried. The MCP blocks are real (`getMcpConfig` runs unmocked); only the
 * Docker-daemon probe is stubbed where it would otherwise shell into a runtime.
 */
describe('Claude Agent — external MCP reuse (integration)', () => {
  let app: INestApplication;
  let graphDao: GraphDao;
  let threadsDao: ThreadsDao;
  let mockRuntimeSvc: MockRuntimeService;

  let projectId: string;
  let graphId: string;
  const externalThreadId = `claude-mcp-int-${Date.now()}`;

  const createLogger = () =>
    new DefaultLogger({
      environment: 'test',
      appName: 'test',
      appVersion: '1.0.0',
    });

  beforeAll(async () => {
    app = await createTestModule();
    graphDao = app.get(GraphDao);
    threadsDao = app.get(ThreadsDao);
    mockRuntimeSvc = app.get(MockRuntimeService);

    const testProject = await createTestProject(app);
    projectId = testProject.projectId;

    const graph = await graphDao.create({
      name: 'claude-mcp-graph',
      description: 'claude external mcp integration',
      error: undefined,
      version: '1.0.0',
      targetVersion: '1.0.0',
      schema: {
        nodes: [
          {
            id: NODE_ID,
            template: 'claude-agent',
            config: { name: 'Claude', instructions: 'test' },
          },
        ],
        edges: [],
      },
      status: GraphStatus.Running,
      metadata: {},
      createdBy: TEST_USER_ID,
      projectId,
      temporary: false,
    });
    graphId = graph.id;

    await threadsDao.create({
      graphId,
      createdBy: TEST_USER_ID,
      projectId,
      externalThreadId,
      metadata: {},
      source: undefined,
      name: 'Claude external MCP thread',
      status: ThreadStatus.Running,
    });
  }, 120_000);

  afterAll(async () => {
    if (graphId) {
      await graphDao.hardDeleteById(graphId);
    }
    await app.close();
  });

  beforeEach(() => {
    mockRuntimeSvc.reset();
  });

  /**
   * A fresh transient ClaudeAgent wired to a MockRuntime whose `execStream`
   * routes the bridge launch to the scripted MockBridge. Bootstrap + cost +
   * virtual-key lookups are stubbed off LiteLLM.
   */
  const prepareAgent = async (): Promise<{
    agent: ClaudeAgent;
    runtime: MockRuntime;
    config: { configurable: BaseAgentConfigurable };
  }> => {
    const bootstrap = app.get(ClaudeBootstrapService);
    vi.spyOn(bootstrap, 'ensureSessionReady').mockResolvedValue({
      bridgePath: BRIDGE_PATH,
      pluginPaths: [],
    });
    vi.spyOn(bootstrap, 'isSessionResumable').mockResolvedValue(false);
    vi.spyOn(app.get(LiteLlmClient), 'getModelInfo').mockResolvedValue({
      model_info: {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
      },
    } as never);
    const virtualKeys = app.get(LitellmVirtualKeyService);
    vi.spyOn(virtualKeys, 'issueThreadKey').mockResolvedValue({
      key: 'sk-test-vkey',
    } as never);
    vi.spyOn(virtualKeys, 'revokeThreadKey').mockResolvedValue(
      undefined as never,
    );

    const runtime = new MockRuntime(mockRuntimeSvc);
    const agent = await app.resolve(ClaudeAgent);
    agent.setConfig({
      name: 'Claude',
      description: 'external mcp',
      instructions: 'be helpful',
      model: 'claude-sonnet-4-6',
    });
    agent.setRuntimeProvider({
      provide: async () => runtime,
      getParams: () => ({
        runtimeNodeId: 'rt-1',
        runtimeStartParams: { workdir: CLAUDE_WORKDIR },
      }),
    } as unknown as RuntimeThreadProvider);

    return {
      agent,
      runtime,
      config: {
        configurable: {
          thread_id: externalThreadId,
          graph_id: graphId,
          node_id: NODE_ID,
          graph_project_id: projectId,
        } as BaseAgentConfigurable,
      },
    };
  };

  /**
   * Run one turn and return the `externalMcpServers` the bridge `start` frame
   * carried. The MockBridge ends the turn immediately with a result + done.
   */
  const captureExternalMcpServers = async (
    agent: ClaudeAgent,
    config: { configurable: BaseAgentConfigurable },
  ): Promise<{
    seen: boolean;
    externalMcpServers?: BridgeStartOptions['externalMcpServers'];
  }> => {
    let captured: BridgeStartOptions['externalMcpServers'];
    let seen = false;
    mockRuntimeSvc.queueBridge((session) => {
      captured = session.startOptions.externalMcpServers;
      seen = true;
      session.emitResult({ totalCostUsd: 0, sessionId: 'sess-mcp' });
      session.done('sess-mcp');
    });

    await agent.run(
      externalThreadId,
      [new HumanMessage('hello')],
      undefined,
      config,
    );

    return { seen, externalMcpServers: captured };
  };

  it('forwards a custom (command-mode) MCP block into the start frame as a stdio server', async () => {
    const { agent, config } = await prepareAgent();
    const block = new CustomMcp(createLogger());
    agent.setExternalMcpServers([
      {
        instance: block,
        config: { command: 'npx -y @org/server --port 3000' },
        nodeId: 'mcp-custom',
      },
    ]);

    const { externalMcpServers } = await captureExternalMcpServers(
      agent,
      config,
    );

    expect(externalMcpServers).toBeDefined();
    expect(externalMcpServers!['custom-mcp']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@org/server', '--port', '3000'],
    });
  });

  it('propagates a block env into the stdio server config (creds-into-runtime path)', async () => {
    const { agent, config } = await prepareAgent();
    const block = new CustomMcp(createLogger());
    agent.setExternalMcpServers([
      {
        instance: block,
        config: { command: 'npx srv', env: { API_TOKEN: 'tok' } },
        nodeId: 'mcp-env',
      },
    ]);

    const { externalMcpServers } = await captureExternalMcpServers(
      agent,
      config,
    );

    // The block's env is baked into the stdio config the SDK spawns inside the
    // runtime — the M1 trust-boundary premise. A regression dropping env ships green.
    expect(externalMcpServers!['custom-mcp']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['srv'],
      env: { API_TOKEN: 'tok' },
    });
  });

  it("resolves a filesystem MCP block's workdir against the Claude node's runtime (re-point)", async () => {
    const { agent, config } = await prepareAgent();
    const block = new FilesystemMcp(createLogger());
    agent.setExternalMcpServers([
      { instance: block, config: { readOnly: false }, nodeId: 'mcp-fs' },
    ]);

    const { externalMcpServers } = await captureExternalMcpServers(
      agent,
      config,
    );

    const fs = externalMcpServers!.filesystem;
    expect(fs).toBeDefined();
    expect(fs).toMatchObject({ type: 'stdio', command: 'npx' });
    // The workdir arg proves the block was re-pointed at the Claude runtime
    // (CLAUDE_WORKDIR) rather than its own temp/init runtime.
    expect((fs as { args: string[] }).args).toContain(CLAUDE_WORKDIR);
  });

  it('readies the Docker daemon for a docker-based MCP block before the SDK spawns it', async () => {
    const { agent, config } = await prepareAgent();
    const block = new PlaywrightMcp(createLogger());
    // ensureDockerDaemonReady is protected; stub it so the assertion is
    // deterministic and no real `docker info` exec is needed.
    const dockerReady = vi
      .spyOn(
        block as unknown as {
          ensureDockerDaemonReady: (rt: BaseRuntime) => Promise<void>;
        },
        'ensureDockerDaemonReady',
      )
      .mockResolvedValue(undefined);
    agent.setExternalMcpServers([
      { instance: block, config: {}, nodeId: 'mcp-pw' },
    ]);

    const { externalMcpServers } = await captureExternalMcpServers(
      agent,
      config,
    );

    expect(dockerReady).toHaveBeenCalledTimes(1);
    expect(externalMcpServers!.playwright).toMatchObject({
      type: 'stdio',
      command: 'docker',
    });
  });

  it('skips a misconfigured MCP block without aborting the run (skip-bad-server)', async () => {
    const { agent, config } = await prepareAgent();
    const bad = new CustomMcp(createLogger()); // empty config -> getMcpConfig throws
    const good = new CustomMcp(createLogger());
    agent.setExternalMcpServers([
      { instance: bad, config: {}, nodeId: 'mcp-bad' },
      { instance: good, config: { command: 'npx good-server' }, nodeId: 'ok' },
    ]);

    const { seen, externalMcpServers } = await captureExternalMcpServers(
      agent,
      config,
    );

    expect(seen).toBe(true); // run completed — the bad block did not abort it
    expect(Object.keys(externalMcpServers!)).toEqual(['custom-mcp']);
    expect(externalMcpServers!['custom-mcp']).toMatchObject({
      command: 'npx',
      args: ['good-server'],
    });
  });

  it('de-duplicates colliding server names across multiple blocks of the same kind', async () => {
    const { agent, config } = await prepareAgent();
    agent.setExternalMcpServers([
      {
        instance: new CustomMcp(createLogger()),
        config: { command: 'npx server-a' },
        nodeId: 'mcp-a',
      },
      {
        instance: new CustomMcp(createLogger()),
        config: { command: 'npx server-b' },
        nodeId: 'mcp-b',
      },
    ]);

    const { externalMcpServers } = await captureExternalMcpServers(
      agent,
      config,
    );

    expect(Object.keys(externalMcpServers!).sort()).toEqual([
      'custom-mcp',
      'custom-mcp-2',
    ]);
    const commands = Object.values(externalMcpServers!).map(
      (s) => (s as { args: string[] }).args[0],
    );
    expect(commands.sort()).toEqual(['server-a', 'server-b']);
  });

  it('de-duplicates a 3+ chain of same-named blocks (custom-mcp, -2, -3)', async () => {
    const { agent, config } = await prepareAgent();
    agent.setExternalMcpServers([
      {
        instance: new CustomMcp(createLogger()),
        config: { command: 'npx server-a' },
        nodeId: 'mcp-a',
      },
      {
        instance: new CustomMcp(createLogger()),
        config: { command: 'npx server-b' },
        nodeId: 'mcp-b',
      },
      {
        instance: new CustomMcp(createLogger()),
        config: { command: 'npx server-c' },
        nodeId: 'mcp-c',
      },
    ]);

    const { externalMcpServers } = await captureExternalMcpServers(
      agent,
      config,
    );

    // The increment loop (not a fixed `-2`) must walk to `-3` on the third
    // collision; a hard-coded suffix would collapse two blocks' tool namespaces.
    expect(Object.keys(externalMcpServers!).sort()).toEqual([
      'custom-mcp',
      'custom-mcp-2',
      'custom-mcp-3',
    ]);
    const commands = Object.values(externalMcpServers!).map(
      (s) => (s as { args: string[] }).args[0],
    );
    expect(commands.sort()).toEqual(['server-a', 'server-b', 'server-c']);
  });

  it('skips a block that resolves to a blank command (empty-command guard)', async () => {
    const { agent, config } = await prepareAgent();
    // A whitespace-only command is truthy, so getMcpConfig returns it without
    // throwing; the resolver's own `!command` guard (distinct from the
    // getMcpConfig-throws skip path) must drop it.
    const blank = new CustomMcp(createLogger());
    const good = new CustomMcp(createLogger());
    agent.setExternalMcpServers([
      { instance: blank, config: { command: '   ' }, nodeId: 'mcp-blank' },
      { instance: good, config: { command: 'npx good-server' }, nodeId: 'ok' },
    ]);

    const { seen, externalMcpServers } = await captureExternalMcpServers(
      agent,
      config,
    );

    expect(seen).toBe(true); // run completed — the blank block did not abort it
    expect(Object.keys(externalMcpServers!)).toEqual(['custom-mcp']);
    expect(externalMcpServers!['custom-mcp']).toMatchObject({
      command: 'npx',
      args: ['good-server'],
    });
  });

  it('suffixes an external block colliding with the reserved `geniro` bridge key', async () => {
    const { agent, config } = await prepareAgent();
    // A block resolving to the name `geniro` must NOT take that key: the bridge
    // registers its in-process Geniro tool server there and spreads external
    // servers AFTER it, so an un-suffixed `geniro` external key would clobber it.
    const geniroNamed = {
      resolveServerConfigForRuntime: async () => ({
        name: 'geniro',
        command: 'npx',
        args: ['geniro-clone'],
      }),
    } as unknown as BaseMcp;
    agent.setExternalMcpServers([
      { instance: geniroNamed, config: {}, nodeId: 'mcp-geniro' },
    ]);

    const { externalMcpServers } = await captureExternalMcpServers(
      agent,
      config,
    );

    expect(Object.keys(externalMcpServers!)).toEqual(['geniro-2']);
    expect(externalMcpServers).not.toHaveProperty('geniro');
  });

  it('sends no externalMcpServers when no MCP block is connected', async () => {
    const { agent, config } = await prepareAgent();

    const { seen, externalMcpServers } = await captureExternalMcpServers(
      agent,
      config,
    );

    expect(seen).toBe(true);
    expect(externalMcpServers).toBeUndefined();
  });
});
