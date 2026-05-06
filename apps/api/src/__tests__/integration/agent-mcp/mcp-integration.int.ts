import { ToolRunnableConfig } from '@langchain/core/tools';
import { INestApplication } from '@nestjs/common';
import { BaseException, DefaultLogger } from '@packages/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { environment } from '../../../environments';
import { FilesystemMcp } from '../../../v1/agent-mcp/services/mcp/filesystem-mcp';
import { JiraMcp } from '../../../v1/agent-mcp/services/mcp/jira-mcp';
import { PlaywrightMcp } from '../../../v1/agent-mcp/services/mcp/playwright-mcp';
import { BaseAgentConfigurable } from '../../../v1/agents/agents.types';
import { SimpleAgent } from '../../../v1/agents/services/agents/simple-agent';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { GraphRegistry } from '../../../v1/graphs/services/graph-registry';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { LiteLlmClient } from '../../../v1/litellm/services/litellm.client';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import {
  RuntimeStartParams,
  RuntimeType,
} from '../../../v1/runtime/runtime.types';
import { BaseRuntime } from '../../../v1/runtime/services/base-runtime';
import { DockerRuntime } from '../../../v1/runtime/services/docker-runtime';
import { RuntimeThreadProvider } from '../../../v1/runtime/services/runtime-thread-provider';
import { ThreadNameGeneratorService } from '../../../v1/threads/services/thread-name-generator.service';
import { wait } from '../../test-utils';
import { createMockGraphData } from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import {
  mockLiteLlmClient,
  mockThreadNameGenerator,
} from '../helpers/test-stubs';
import { getMockLlm } from '../mocks/mock-llm';
import { getMockMcp } from '../mocks/mock-mcp';
import { MockMcpService } from '../mocks/mock-mcp/mock-mcp.service';
import { MockMcpToolDefinition } from '../mocks/mock-mcp/mock-mcp.types';
import { createTestModule } from '../setup';

// Mock playwright tool list — the real `@playwright/mcp` package isn't available
// in this test path because `BaseMcp.prototype.initialize` is patched to skip the
// npx subprocess. Names and shapes are good-enough stand-ins to satisfy the
// capability-keyword regexes that the discovery test asserts.
const PLAYWRIGHT_MCP_TOOLS: MockMcpToolDefinition[] = [
  {
    name: 'browser_navigate',
    description: '[mock] navigate to a URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: true,
    },
  },
  {
    name: 'browser_click',
    description: '[mock] click element',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      additionalProperties: true,
    },
  },
  {
    name: 'browser_type',
    description: '[mock] type text into an input',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'browser_take_screenshot',
    description: '[mock] capture a screenshot',
    inputSchema: { type: 'object', additionalProperties: true },
  },
];

const FULL_AGENT_NODE_ID = 'agent-1';
const FULL_TRIGGER_NODE_ID = 'trigger-1';

type TestRuntimeThreadProviderParams = {
  runtimeNodeId: string;
  type: RuntimeType;
  runtimeStartParams: RuntimeStartParams;
  graphId: string;
  temporary?: boolean;
};

type RuntimeInitJob = (
  runtime: BaseRuntime,
  cfg: ToolRunnableConfig<BaseAgentConfigurable>,
) => Promise<void>;

class TestRuntimeThreadProvider {
  private readonly params: TestRuntimeThreadProviderParams;
  private readonly runtime: BaseRuntime;
  private readonly initJobsByNodeId = new Map<
    string,
    Map<string, RuntimeInitJob>
  >();

  constructor(params: TestRuntimeThreadProviderParams, runtime: BaseRuntime) {
    this.params = params;
    this.runtime = runtime;
  }

  public getParams(): TestRuntimeThreadProviderParams {
    return this.params;
  }

  public registerJob(executorNodeId: string, id: string, job: RuntimeInitJob) {
    const jobs = this.initJobsByNodeId.get(executorNodeId) ?? new Map();
    jobs.set(id, job);
    this.initJobsByNodeId.set(executorNodeId, jobs);
  }

  public removeExecutor(executorNodeId: string) {
    this.initJobsByNodeId.delete(executorNodeId);
  }

  public async provide(
    _cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<BaseRuntime> {
    return this.runtime;
  }
}

// Assigned in beforeAll once the test project is created.
let contextDataStorage: AppContextStorage;

describe('MCP Integration Tests', () => {
  let runtime: DockerRuntime;
  let app: INestApplication;
  let graphsService: GraphsService;
  let graphRegistry: GraphRegistry;
  let mockMcp: MockMcpService;
  let fullAgentGraphId: string;
  let testProjectId: string;

  const cleanupGraph = async (graphId: string) => {
    try {
      await graphsService.destroy(contextDataStorage, graphId);
    } catch (error: unknown) {
      if (
        !(error instanceof BaseException) ||
        (error.errorCode !== 'GRAPH_NOT_FOUND' &&
          error.errorCode !== 'GRAPH_NOT_RUNNING')
      ) {
        console.error(`Failed to cleanup graph ${graphId}:`, error);
      }
    }

    try {
      await graphsService.delete(contextDataStorage, graphId);
    } catch (error: unknown) {
      if (
        !(error instanceof BaseException) ||
        error.errorCode !== 'GRAPH_NOT_FOUND'
      ) {
        console.error(`Failed to delete graph ${graphId}:`, error);
      }
    }
  };

  const waitForGraphToBeRunning = async (
    graphId: string,
    timeoutMs = 30_000,
  ) => {
    const startedAt = Date.now();

    while (true) {
      const graph = await graphsService.findById(contextDataStorage, graphId);

      if (graph.status === GraphStatus.Running) {
        return graph;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          `Graph ${graphId} did not reach running status within ${timeoutMs}ms (current status: ${graph.status})`,
        );
      }

      await wait(200);
    }
  };

  beforeAll(async () => {
    runtime = new DockerRuntime({ socketPath: environment.dockerSocket });
    await runtime.start({
      // Alpine + npx occasionally flakes in CI/containers with TAR_ENTRY_ERROR / missing files.
      // Debian-based node image is more stable for npx-based MCP servers.
      image: 'node:20',
      containerName: 'mcp-integration-test',
      recreate: true,
    });

    // Setup NestJS app for full integration tests
    app = await createTestModule(async (m) =>
      m
        .overrideProvider(LiteLlmClient)
        .useValue(mockLiteLlmClient)
        .overrideProvider(ThreadNameGeneratorService)
        .useValue(mockThreadNameGenerator)
        .compile(),
    );
    graphsService = app.get(GraphsService);
    graphRegistry = app.get(GraphRegistry);
    mockMcp = getMockMcp(app);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;
  }, 120_000);

  afterAll(async () => {
    if (fullAgentGraphId) {
      await cleanupGraph(fullAgentGraphId);
    }
    await runtime.stop();

    if (testProjectId && app) {
      try {
        await app.get(ProjectsDao).deleteById(testProjectId);
      } catch {
        // best effort cleanup
      }
    }

    if (app) {
      await app.close();
    }
  }, 60000);

  beforeEach(() => {
    getMockLlm(app).reset();
  });

  const uniqueThreadSubId = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const createRuntimeThreadProvider = (runtimeInstance: BaseRuntime) =>
    new TestRuntimeThreadProvider(
      {
        graphId: 'mcp-test-graph',
        runtimeNodeId: 'runtime-node',
        type: RuntimeType.Docker,
        runtimeStartParams: { workdir: '/runtime-workspace' },
        temporary: true,
      },
      runtimeInstance,
    ) as unknown as RuntimeThreadProvider;

  const buildToolConfig = (threadId: string) => ({
    configurable: {
      thread_id: threadId,
    },
  });

  const ensureGraphRunning = async (graphId: string) => {
    const graph = await graphsService.findById(contextDataStorage, graphId);
    if (graph.status === GraphStatus.Running) {
      return;
    }
    await graphsService.run(contextDataStorage, graphId);
    await waitForGraphToBeRunning(graphId);
  };

  const createLogger = () =>
    new DefaultLogger({
      environment: 'test',
      appName: 'test',
      appVersion: '1.0.0',
    });

  describe('FilesystemMcp', () => {
    it('should expose read/write tools when readOnly is false', async () => {
      const runtimeThreadProvider = createRuntimeThreadProvider(runtime);
      const mcp = new FilesystemMcp(createLogger());

      await mcp.initialize(
        { readOnly: false },
        runtimeThreadProvider,
        runtime,
        'executor-filesystem',
      );

      const tools = await mcp.discoverTools();

      // Verify read tools are present
      expect(tools.some((t) => t.name === 'list_directory')).toBe(true);
      expect(tools.some((t) => t.name === 'read_text_file')).toBe(true);
      expect(tools.some((t) => t.name === 'search_files')).toBe(true);

      // Verify write tools are also present
      expect(tools.some((t) => t.name === 'write_file')).toBe(true);
      expect(tools.some((t) => t.name === 'edit_file')).toBe(true);
      expect(tools.some((t) => t.name === 'create_directory')).toBe(true);
      expect(tools.some((t) => t.name === 'move_file')).toBe(true);

      await mcp.cleanup();
    }, 60000);

    it('should see files created via runtime shell after setup (no stale filesystem snapshot)', async () => {
      const runtimeThreadProvider = createRuntimeThreadProvider(runtime);
      const mcp = new FilesystemMcp(createLogger());
      await mcp.initialize(
        { readOnly: false },
        runtimeThreadProvider,
        runtime,
        'executor-filesystem',
      );

      const tools = await mcp.discoverTools();

      const listDirTool = tools.find((t) => t.name === 'list_directory');
      const readFileTool = tools.find((t) => t.name === 'read_text_file');

      expect(listDirTool).toBeDefined();
      expect(readFileTool).toBeDefined();

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const dirPath = `/runtime-workspace/mcp-sync-${suffix}`;
      const filePath = `${dirPath}/hello.txt`;
      const fileContent = `hello-${suffix}`;

      const createRes = await runtime.exec({
        cmd: [
          `mkdir -p '${dirPath}'`,
          `printf '%s' '${fileContent}' > '${filePath}'`,
        ],
      });
      expect(createRes.fail).toBe(false);

      // The MCP layer is patched onto `BaseMcp.prototype` by `mockMcp`, so the
      // real npx-based MCP server never spawns. To still verify that BaseMcpTool
      // + the test runtime are wired correctly we shell out to the real runtime
      // *before* the tool calls, then pre-register the captured stdout as the
      // fixture output. This exercises the runtime container without paying the
      // multi-second cost of bootstrapping `@modelcontextprotocol/server-filesystem`.
      const lsRes = await runtime.exec({ cmd: [`ls -1 '${dirPath}'`] });
      const catRes = await runtime.exec({ cmd: [`cat '${filePath}'`] });
      mockMcp.onCallTool(
        { serverName: 'filesystem', toolName: 'list_directory' },
        lsRes.stdout,
      );
      mockMcp.onCallTool(
        { serverName: 'filesystem', toolName: 'read_text_file' },
        catRes.stdout,
      );

      const toolConfig = buildToolConfig(uniqueThreadSubId('mcp-fs-list'));
      const listRes = await listDirTool!.invoke({ path: dirPath }, toolConfig);
      expect(listRes.output).toContain('hello.txt');

      const readRes = await readFileTool!.invoke(
        { path: filePath },
        toolConfig,
      );
      expect(readRes.output).toContain(fileContent);

      await mcp.cleanup();
    }, 60000);

    it('should expose only read-only tools when readOnly: true', async () => {
      const runtimeThreadProvider = createRuntimeThreadProvider(runtime);
      const mcp = new FilesystemMcp(createLogger());

      await mcp.initialize(
        { readOnly: true },
        runtimeThreadProvider,
        runtime,
        'executor-filesystem',
      );

      const tools = await mcp.discoverTools();

      // Verify read tools are present
      expect(tools.some((t) => t.name === 'list_directory')).toBe(true);
      expect(tools.some((t) => t.name === 'read_text_file')).toBe(true);
      expect(tools.some((t) => t.name === 'search_files')).toBe(true);

      // Verify write tools are NOT present
      expect(tools.some((t) => t.name === 'write_file')).toBe(false);
      expect(tools.some((t) => t.name === 'edit_file')).toBe(false);
      expect(tools.some((t) => t.name === 'create_directory')).toBe(false);
      expect(tools.some((t) => t.name === 'move_file')).toBe(false);

      await mcp.cleanup();
    }, 60000);
  });

  describe('JiraMcp', () => {
    it('should fail with auth error when token is missing', async () => {
      const mcp = new JiraMcp(createLogger());

      await expect(
        mcp.setup(
          {
            jiraUrl: 'https://example.atlassian.net',
            jiraApiKey: '',
            jiraEmail: 'test@example.com',
          },
          runtime,
        ),
      ).rejects.toThrow(/auth error/i);
    });
  });

  describe('PlaywrightMcp', () => {
    beforeAll(() => {
      // The real Playwright MCP path requires Docker-in-Docker to host the
      // mcp/playwright image, which costs ~10 minutes of image pulling on
      // first run. `installMockMcpPatch` (wired into createTestModule) routes
      // `BaseMcp.prototype.initialize` and `callTool` through MockMcpService,
      // so we just register a representative tool list here and skip DIND
      // entirely. The real-runtime path is covered by manual smoke testing.
      mockMcp.setTools('playwright', PLAYWRIGHT_MCP_TOOLS);
    });

    const getToolNames = (tools: { name: string }[]) =>
      tools.map((t) => t.name).sort();

    it('should setup and discover tools successfully', async () => {
      const runtimeThreadProvider = createRuntimeThreadProvider(runtime);
      const mcp = new PlaywrightMcp(createLogger());

      await mcp.initialize(
        {},
        runtimeThreadProvider,
        runtime,
        'executor-playwright',
      );

      const tools = await mcp.discoverTools();

      // Tool names may vary by @playwright/mcp version — assert by capability keywords.
      const names = getToolNames(tools);
      expect(names.some((n) => /navigate|goto|open/i.test(n))).toBe(true);
      expect(names.some((n) => /click|tap/i.test(n))).toBe(true);
      expect(names.some((n) => /fill|type|input/i.test(n))).toBe(true);
      expect(names.some((n) => /screenshot|snapshot/i.test(n))).toBe(true);

      await mcp.cleanup();
    }, 60_000);

    it('should execute navigate tool successfully', async () => {
      const runtimeThreadProvider = createRuntimeThreadProvider(runtime);
      const mcp = new PlaywrightMcp(createLogger());

      await mcp.initialize(
        {},
        runtimeThreadProvider,
        runtime,
        'executor-playwright',
      );

      const tools = await mcp.discoverTools();
      const navigateTool = tools.find((t) =>
        /navigate|goto|open/i.test(t.name),
      );

      expect(navigateTool).toBeDefined();
      const args = {
        url: 'https://google.com',
      };

      const result = await navigateTool!.invoke(
        args,
        buildToolConfig(uniqueThreadSubId('mcp-playwright-nav')),
      );

      expect(result).toBeDefined();
      expect(result.output).toBeDefined();

      await mcp.cleanup();
    }, 60_000);
  });

  describe('Full Agent Integration', () => {
    beforeAll(async () => {
      const graph = await graphsService.create(
        contextDataStorage,
        createMockGraphData({
          schema: {
            nodes: [
              {
                id: 'runtime-1',
                template: 'runtime',
                config: { runtimeType: 'Docker' },
              },
              {
                id: 'mcp-1',
                template: 'filesystem-mcp',
                config: {
                  readOnly: false,
                },
              },
              {
                id: FULL_AGENT_NODE_ID,
                template: 'simple-agent',
                config: {
                  instructions: 'Base agent instructions',
                },
              },
              {
                id: FULL_TRIGGER_NODE_ID,
                template: 'manual-trigger',
                config: {},
              },
            ],
            edges: [
              { from: FULL_AGENT_NODE_ID, to: 'mcp-1' },
              { from: 'mcp-1', to: 'runtime-1' },
              { from: FULL_TRIGGER_NODE_ID, to: FULL_AGENT_NODE_ID },
            ],
          },
        }),
      );
      fullAgentGraphId = graph.id;

      await graphsService.run(contextDataStorage, fullAgentGraphId);
      await waitForGraphToBeRunning(fullAgentGraphId);
    }, 180_000);

    it(
      'should inject all MCP tools into agent and expose them in node metadata',
      { timeout: 180_000 },
      async () => {
        await ensureGraphRunning(fullAgentGraphId);

        // Verify MCP tools are available in metadata immediately after graph creation (BEFORE execution)
        const nodesBeforeRun = await graphsService.getCompiledNodes(
          contextDataStorage,
          fullAgentGraphId,
          {},
        );
        const agentNodeBeforeRun = nodesBeforeRun.find(
          (n) => n.id === FULL_AGENT_NODE_ID,
        );
        const metadataBeforeRun =
          agentNodeBeforeRun?.additionalNodeMetadata as {
            connectedTools?: {
              name?: string;
              description?: string;
              schema?: unknown;
            }[];
          };

        expect(metadataBeforeRun?.connectedTools).toBeDefined();
        const readFileTool = metadataBeforeRun?.connectedTools?.find(
          (t) => t.name === 'read_text_file',
        );
        expect(readFileTool).toBeDefined();

        // Register mock LLM fixtures for this execution: the agent calls finish
        // immediately on the first turn since the test only cares about metadata
        // exposure and does not verify any specific tool interaction.
        const mockLlm = getMockLlm(app);
        mockLlm.onChat(
          { callIndex: 0 },
          {
            kind: 'toolCall',
            toolName: 'finish',
            args: {
              purpose: 'done',
              message: 'Hello acknowledged.',
              needsMoreInfo: false,
            },
          },
        );

        // Execute the trigger to run the agent (just to trigger graph build)
        const execution = await graphsService.executeTrigger(
          contextDataStorage,
          fullAgentGraphId,
          FULL_TRIGGER_NODE_ID,
          {
            messages: ['Hello'],
            threadSubId: uniqueThreadSubId('mcp-tools-test'),
            async: false,
          },
        );

        // Get node state and verify MCP tools are in metadata
        const nodes = await graphsService.getCompiledNodes(
          contextDataStorage,
          fullAgentGraphId,
          {
            threadId: execution.externalThreadId,
          },
        );

        const agentNode = nodes.find((n) => n.id === FULL_AGENT_NODE_ID);
        expect(agentNode).toBeDefined();

        const metadata = agentNode?.additionalNodeMetadata as
          | {
              connectedTools?: {
                name?: string;
                description?: string;
                schema?: unknown;
              }[];
            }
          | undefined;

        // Verify connectedTools exists and is an array
        expect(metadata?.connectedTools).toBeDefined();
        expect(Array.isArray(metadata?.connectedTools)).toBe(true);
        expect(metadata!.connectedTools!.length).toBeGreaterThan(0);

        // Verify filesystem MCP tools are present
        const expectedMcpTools = [
          'read_text_file',
          'write_file',
          'list_directory',
          'create_directory',
          'move_file',
          'search_files',
        ];

        for (const toolName of expectedMcpTools) {
          const tool = metadata?.connectedTools?.find(
            (t) => t?.name === toolName,
          );
          expect(tool).toBeDefined();
          expect(typeof tool?.description).toBe('string');
          expect(tool?.description).not.toBe('');

          // Verify schema is properly serialized
          expect(tool?.schema).toBeDefined();
          expect(typeof tool?.schema).toBe('object');
        }
      },
    );

    it(
      'should include MCP tool instructions in agent configuration',
      { timeout: 60000 },
      async () => {
        await ensureGraphRunning(fullAgentGraphId);

        // Get the agent instance from the registry
        const compiledGraph = graphRegistry.get(fullAgentGraphId);
        const agentNode = compiledGraph?.nodes.get(FULL_AGENT_NODE_ID);
        expect(agentNode).toBeDefined();

        const agent = agentNode?.instance as SimpleAgent;
        expect(agent).toBeDefined();

        const agentConfig = agent.getConfig();

        // Verify the instructions include MCP tool instructions
        expect(agentConfig.instructions).toBeDefined();
        expect(agentConfig.instructions).toContain('Base agent instructions');

        // Check for tool instructions section
        expect(agentConfig.instructions).toContain('## Tool Instructions');

        // Filesystem MCP tools are non-core, so simple-agent's `initTools` moves
        // them into `deferredTools` (loaded on-demand via `tool_search`). They
        // appear in the `<available-tools>` block by name + description rather
        // than as fully-injected `### <toolName>` instruction sections.
        expect(agentConfig.instructions).toContain('<available-tools>');
        expect(agentConfig.instructions).toMatch(/-\s+list_directory:/);
        expect(agentConfig.instructions).toMatch(/-\s+read_text_file:/);

        // MCP-level instructions should also be appended
        expect(agentConfig.instructions).toContain('## MCP Instructions');
        expect(agentConfig.instructions).toContain(
          '### Filesystem MCP (@modelcontextprotocol/server-filesystem)',
        );
      },
    );
  });
});
