import { HumanMessage } from '@langchain/core/messages';
import { RunnableConfig } from '@langchain/core/runnables';
import type { DefaultLogger } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';

import type { GitTokenResolverService } from '../../../git-auth/services/git-token-resolver.service';
import { MessageRole } from '../../../graphs/graphs.types';
import { RequestTokenUsage } from '../../../litellm/litellm.types';
import type { LiteLlmClient } from '../../../litellm/services/litellm.client';
import type { LitellmVirtualKeyService } from '../../../litellm/services/litellm-virtual-key.service';
import type { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
import type { SecretsService } from '../../../secrets/services/secrets.service';
import type { SecretsStoreService } from '../../../secrets-store/services/secrets-store.service';
import type { MessagesDao } from '../../../threads/dao/messages.dao';
import type { ThreadsDao } from '../../../threads/dao/threads.dao';
import { BaseAgentConfigurable } from '../../agents.types';
import type { ClaudeBootstrapService } from '../claude/claude-bootstrap.service';
import type { ClaudeBridgeHandlers } from '../claude/claude-bridge-transport';
import { ClaudeBridgeTransport } from '../claude/claude-bridge-transport';
import type { ClaudeKeepaliveService } from '../claude/claude-keepalive.service';
import { ClaudeAuthMode } from '../claude/claude-session.types';
import { AgentEventType } from './base-agent';
import { ClaudeAgent, ClaudeAgentSchemaType } from './claude-agent';

const THREAD_ID = 'thread-ext-1';

const AGENT_CONFIG: ClaudeAgentSchemaType = {
  name: 'Claude',
  description: 'test agent',
  instructions: 'be helpful',
  model: 'claude-sonnet-4-6',
};

const usage = (totalPrice: number): RequestTokenUsage => ({
  inputTokens: 100,
  cachedInputTokens: 0,
  outputTokens: 50,
  totalTokens: 150,
  totalPrice,
});

/**
 * Cost-limit enforcement and stop semantics for ClaudeAgent.run — the
 * decisions that bound LLM spend (pre-turn short-circuit, mid-stream trip,
 * key budget computation, revoke-always) and the stop/abort races. The
 * transport is the mocked boundary: tests drive `handlers.*` exactly as the
 * bridge would.
 */
describe('ClaudeAgent', () => {
  let agent: ClaudeAgent;
  let events: AgentEventType[];

  let bootstrap: {
    ensureSessionReady: ReturnType<typeof vi.fn>;
    isSessionResumable: ReturnType<typeof vi.fn>;
    configureGitAuth: ReturnType<typeof vi.fn>;
  };
  let virtualKeys: {
    issueThreadKey: ReturnType<typeof vi.fn>;
    revokeThreadKey: ReturnType<typeof vi.fn>;
  };
  let liteLlmClient: { getModelInfo: ReturnType<typeof vi.fn> };
  let threadsDao: {
    getOne: ReturnType<typeof vi.fn>;
    mergeMetadataKey: ReturnType<typeof vi.fn>;
  };
  let messagesDao: {
    aggregateUsageByNodeId: ReturnType<typeof vi.fn>;
    aggregateToolUsageTotalPrice: ReturnType<typeof vi.fn>;
    getAll: ReturnType<typeof vi.fn>;
  };
  let runtimeProvider: RuntimeThreadProvider;
  let gitTokenResolver: { resolveDefaultToken: ReturnType<typeof vi.fn> };
  let secretsService: { resolveSecretValue: ReturnType<typeof vi.fn> };
  let secretsStore: { isAvailable: ReturnType<typeof vi.fn> };

  let startSpy: ReturnType<typeof vi.spyOn>;
  let capturedHandlers: ClaudeBridgeHandlers | undefined;
  let fakeTransport: {
    send: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    isFinished: ReturnType<typeof vi.fn>;
  };
  /** Resolves the mocked ClaudeBridgeTransport.start promise. */
  let releaseTransportStart: () => void;

  beforeEach(() => {
    events = [];
    bootstrap = {
      ensureSessionReady: vi
        .fn()
        .mockResolvedValue({ bridgePath: '/opt/b.mjs', pluginPaths: [] }),
      isSessionResumable: vi.fn().mockResolvedValue(false),
      configureGitAuth: vi.fn().mockResolvedValue(undefined),
    };
    virtualKeys = {
      issueThreadKey: vi.fn().mockResolvedValue({ key: 'sk-vkey-test' }),
      revokeThreadKey: vi.fn().mockResolvedValue(undefined),
    };
    liteLlmClient = {
      getModelInfo: vi.fn().mockResolvedValue({
        model_info: {
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000002,
        },
      }),
    };
    threadsDao = {
      getOne: vi.fn().mockResolvedValue({ id: 'thread-int-1', metadata: {} }),
      mergeMetadataKey: vi.fn().mockResolvedValue(undefined),
    };
    messagesDao = {
      aggregateUsageByNodeId: vi.fn().mockResolvedValue(new Map()),
      aggregateToolUsageTotalPrice: vi.fn().mockResolvedValue(0),
      getAll: vi.fn().mockResolvedValue([]),
    };
    runtimeProvider = {
      provide: vi.fn().mockResolvedValue({
        getWorkdir: () => '/workspace',
      }),
      getParams: () => ({ runtimeNodeId: 'rt-node-1' }),
    } as unknown as RuntimeThreadProvider;

    const keepalive = {
      createToucher: vi.fn().mockReturnValue(vi.fn()),
    } as unknown as ClaudeKeepaliveService;

    gitTokenResolver = {
      resolveDefaultToken: vi.fn().mockResolvedValue(null),
    };
    secretsService = {
      resolveSecretValue: vi.fn().mockResolvedValue('sk-ant-api03-testkey'),
    };
    secretsStore = {
      isAvailable: vi.fn().mockReturnValue(true),
    };

    agent = new ClaudeAgent(
      mockDeep<DefaultLogger>(),
      bootstrap as unknown as ClaudeBootstrapService,
      keepalive,
      virtualKeys as unknown as LitellmVirtualKeyService,
      liteLlmClient as unknown as LiteLlmClient,
      threadsDao as unknown as ThreadsDao,
      messagesDao as unknown as MessagesDao,
      gitTokenResolver as unknown as GitTokenResolverService,
      secretsService as unknown as SecretsService,
      secretsStore as unknown as SecretsStoreService,
    );
    agent.setConfig(AGENT_CONFIG);
    agent.setRuntimeProvider(runtimeProvider);
    agent.subscribe(async (event) => {
      events.push(event);
    });

    fakeTransport = {
      send: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(),
      isFinished: vi.fn().mockReturnValue(false),
    };
    capturedHandlers = undefined;
    startSpy = vi
      .spyOn(ClaudeBridgeTransport, 'start')
      .mockImplementation(async (params) => {
        capturedHandlers = params.handlers;
        await new Promise<void>((resolve) => {
          releaseTransportStart = resolve;
        });
        return fakeTransport as unknown as ClaudeBridgeTransport;
      });
    releaseTransportStart = () => undefined;
  });

  afterEach(() => {
    startSpy.mockRestore();
  });

  const runnableConfig = (
    costLimitUsd?: number,
    created?: { thread?: string; graph?: string },
  ): RunnableConfig<BaseAgentConfigurable> => ({
    configurable: {
      thread_id: THREAD_ID,
      graph_id: 'g-1',
      node_id: 'claude-1',
      ...(created?.thread !== undefined && {
        thread_created_by: created.thread,
      }),
      ...(created?.graph !== undefined && { graph_created_by: created.graph }),
      ...(costLimitUsd !== undefined && {
        effective_cost_limit_usd: costLimitUsd,
      }),
    } as BaseAgentConfigurable,
  });

  /**
   * run() → transport start resolves → bridge sent the start frame. Returns
   * the run promise WRAPPED in an object — returning it bare would make
   * `await startRunAndOpenBridge()` unwrap the thenable and block on the
   * whole run.
   */
  const startRunAndOpenBridge = async (
    costLimitUsd?: number,
    created?: { thread?: string; graph?: string },
  ): Promise<{ runPromise: ReturnType<ClaudeAgent['run']> }> => {
    const runPromise = agent.run(
      THREAD_ID,
      [new HumanMessage('hi')],
      undefined,
      runnableConfig(costLimitUsd, created),
    );
    await vi.waitFor(() => expect(startSpy).toHaveBeenCalled());
    releaseTransportStart();
    await vi.waitFor(() => expect(fakeTransport.send).toHaveBeenCalled());
    return { runPromise };
  };

  const sentStartFrame = () =>
    fakeTransport.send.mock.calls[0]![0] as {
      options: { prompt: string; resume?: string };
    };

  const stopEvents = () =>
    events.filter((e) => e.type === 'stop') as Extract<
      AgentEventType,
      { type: 'stop' }
    >[];
  const runEvents = () =>
    events.filter((e) => e.type === 'run') as Extract<
      AgentEventType,
      { type: 'run' }
    >[];

  it('short-circuits before starting the session when prior spend already meets the limit', async () => {
    messagesDao.aggregateUsageByNodeId.mockResolvedValue(
      new Map([['claude-1', usage(1.5)]]),
    );

    const output = await agent.run(
      THREAD_ID,
      [new HumanMessage('hi')],
      undefined,
      runnableConfig(1),
    );

    expect(output.messages).toEqual([]);
    expect(startSpy).not.toHaveBeenCalled();
    expect(virtualKeys.issueThreadKey).not.toHaveBeenCalled();
    expect(stopEvents()).toHaveLength(1);
    expect(stopEvents()[0]!.data).toMatchObject({
      stopReason: 'cost_limit',
      stopCostUsd: 1.5,
    });
    // No success 'run' event — the thread transitions to Stopped, not Done.
    expect(runEvents()).toHaveLength(0);
  });

  it('folds prior forwarded-tool spend alone into the cost seed (tool usage with no request usage trips the gate)', async () => {
    // No prior request-usage rows at all, but $1.5 of prior forwarded-tool
    // spend — a previous turn's communication_exec peer call recorded as
    // tool_token_usage. aggregatePriorSpendUsd must add that term, so the seed
    // is $1.5 ≥ the $1 limit and the session short-circuits before starting.
    // If the `+= aggregateToolUsageTotalPrice` fold is removed, the seed reads
    // $0, the session starts, and both asserts below fail — this pins the fold.
    messagesDao.aggregateUsageByNodeId.mockResolvedValue(new Map());
    messagesDao.aggregateToolUsageTotalPrice.mockResolvedValue(1.5);

    const output = await agent.run(
      THREAD_ID,
      [new HumanMessage('hi')],
      undefined,
      runnableConfig(1),
    );

    expect(messagesDao.aggregateToolUsageTotalPrice).toHaveBeenCalled();
    expect(output.messages).toEqual([]);
    expect(startSpy).not.toHaveBeenCalled();
    expect(virtualKeys.issueThreadKey).not.toHaveBeenCalled();
    expect(stopEvents()).toHaveLength(1);
    expect(stopEvents()[0]!.data).toMatchObject({
      stopReason: 'cost_limit',
      stopCostUsd: 1.5,
    });
    expect(runEvents()).toHaveLength(0);
  });

  it('does not let a non-finite forwarded-tool aggregate fail the cost gate open when request spend already meets the limit', async () => {
    // The tool-usage aggregate is a Postgres numeric coerced via Number(...) in
    // MessagesDao.aggregateToolUsageTotalPrice; its declared return is `number`,
    // which includes NaN. aggregatePriorSpendUsd adds it unguarded
    // (`total += await ...`), so a NaN tool term poisons the whole seed:
    // 1.0 (request) + NaN = NaN, and the gate `NaN >= limit` is false. Prior
    // REQUEST spend ALONE ($1.0) already meets the $1 limit, so the gate MUST
    // trip regardless of the tool term — a session that starts here bills past
    // an already-exhausted budget. On current code (no Number.isFinite guard)
    // the gate fails open: the session starts and startSpy is called, so the
    // assertion below fails. The transport start mock is released so the run
    // settles deterministically instead of hanging on the blocked default.
    messagesDao.aggregateUsageByNodeId.mockResolvedValue(
      new Map([['claude-1', usage(1.0)]]),
    );
    messagesDao.aggregateToolUsageTotalPrice.mockResolvedValue(Number.NaN);
    releaseTransportStart = () => undefined;
    startSpy.mockImplementation(
      async (params: Parameters<typeof ClaudeBridgeTransport.start>[0]) => {
        capturedHandlers = params.handlers;
        return fakeTransport as unknown as ClaudeBridgeTransport;
      },
    );

    const runPromise = agent.run(
      THREAD_ID,
      [new HumanMessage('hi')],
      undefined,
      runnableConfig(1),
    );
    // If the gate fails open, the run reaches the (now non-blocking) bridge and
    // waits for stream frames — drive it to a clean done so the run settles and
    // the assertions evaluate rather than timing out.
    await vi.waitFor(() => {
      if (startSpy.mock.calls.length > 0) {
        capturedHandlers!.onDone('sess-nan');
      }
      expect(stopEvents().length + runEvents().length).toBeGreaterThan(0);
    });
    await runPromise;

    // The gate must have short-circuited on the already-exhausted request spend
    // BEFORE touching the transport — a started session means the NaN poisoned
    // the seed and the budget was billed anew.
    expect(startSpy).not.toHaveBeenCalled();
    expect(virtualKeys.issueThreadKey).not.toHaveBeenCalled();
    expect(stopEvents()).toHaveLength(1);
    expect(stopEvents()[0]!.data).toMatchObject({ stopReason: 'cost_limit' });
    expect(runEvents()).toHaveLength(0);
  });

  it('sums request-usage and forwarded-tool spend into the cost seed (neither alone trips, together they do)', async () => {
    // Prior request-usage ($0.6) and prior forwarded-tool spend ($0.6) are each
    // under the $1 limit; the seed is their SUM ($1.2 ≥ $1), so the session
    // short-circuits and reports the combined prior spend. A fold that replaced
    // (rather than added) the tool term, or dropped it, would leave the seed at
    // $0.6 < $1 and start the session — this pins additive summation.
    messagesDao.aggregateUsageByNodeId.mockResolvedValue(
      new Map([['claude-1', usage(0.6)]]),
    );
    messagesDao.aggregateToolUsageTotalPrice.mockResolvedValue(0.6);

    const output = await agent.run(
      THREAD_ID,
      [new HumanMessage('hi')],
      undefined,
      runnableConfig(1),
    );

    expect(output.messages).toEqual([]);
    expect(startSpy).not.toHaveBeenCalled();
    expect(stopEvents()).toHaveLength(1);
    expect(stopEvents()[0]!.data).toMatchObject({
      stopReason: 'cost_limit',
      stopCostUsd: 1.2,
    });
    expect(runEvents()).toHaveLength(0);
  });

  it('issues a model-scoped key with the remaining budget, clamped to the 1-cent floor', async () => {
    messagesDao.aggregateUsageByNodeId.mockResolvedValue(
      new Map([['claude-1', usage(0.999)]]),
    );

    const { runPromise } = await startRunAndOpenBridge(1);
    capturedHandlers!.onDone('sess-1');
    await runPromise;

    expect(virtualKeys.issueThreadKey).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetUsd: 0.01,
        models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
      }),
    );
  });

  it('interrupts the session mid-stream when accumulated price trips the limit, after persisting the tripping message', async () => {
    messagesDao.aggregateUsageByNodeId.mockResolvedValue(
      new Map([['claude-1', usage(0.95)]]),
    );

    const { runPromise } = await startRunAndOpenBridge(1);

    // Assistant message worth $0.25: 0.95 + 0.25 ≥ 1 → in-stream trip.
    // (rates: 100k input @ 1e-6 = $0.1, 75k output @ 2e-6 = $0.15)
    capturedHandlers!.onSdkMessage({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'm-1',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'expensive thought' }],
        usage: { input_tokens: 100_000, output_tokens: 75_000 },
      },
    });
    await vi.waitFor(() => expect(fakeTransport.interrupt).toHaveBeenCalled());
    capturedHandlers!.onAborted('sess-1');
    const output = await runPromise;

    // At least once mid-stream (the trip); run-end cleanup aborts the signal,
    // whose interrupt listener no-ops against the already-closed transport.
    expect(fakeTransport.interrupt).toHaveBeenCalled();
    // Persist-before-stop: the tripping assistant message is in the output
    // (it streamed/persisted before the stop fired).
    expect(output.messages.some((m) => m.content === 'expensive thought')).toBe(
      true,
    );
    expect(stopEvents()).toHaveLength(1);
    expect(stopEvents()[0]!.data.stopReason).toBe('cost_limit');
    expect(stopEvents()[0]!.data.stopCostUsd).toBeCloseTo(1.2);
    expect(runEvents()).toHaveLength(0);
  });

  it('never sends start when the thread was stopped during bootstrap (abort-before-start)', async () => {
    const runPromise = agent.run(
      THREAD_ID,
      [new HumanMessage('hi')],
      undefined,
      runnableConfig(),
    );
    await vi.waitFor(() => expect(startSpy).toHaveBeenCalled());

    // Stop lands while ClaudeBridgeTransport.start is still pending.
    await agent.stopThread(THREAD_ID, 'user stop');
    releaseTransportStart();
    const output = await runPromise;

    expect(fakeTransport.send).not.toHaveBeenCalled();
    expect(fakeTransport.close).toHaveBeenCalled();
    expect(output.messages).toEqual([]);
    // stopThread emitted the stop event; no success 'run' event may follow.
    expect(stopEvents()).toHaveLength(1);
    expect(runEvents()).toHaveLength(0);
  });

  it('suppresses the success run event when a stop races the natural end of the turn', async () => {
    const { runPromise } = await startRunAndOpenBridge();

    await agent.stopThread(THREAD_ID, 'user stop');
    // The bridge already finished the turn: outcome is 'done', not 'aborted'.
    capturedHandlers!.onDone('sess-1');
    await runPromise;

    expect(runEvents()).toHaveLength(0);
  });

  it('revokes the virtual key on success and persists the session id', async () => {
    const { runPromise } = await startRunAndOpenBridge();
    capturedHandlers!.onDone('sess-42');
    await runPromise;

    expect(virtualKeys.revokeThreadKey).toHaveBeenCalledWith('sk-vkey-test');
    expect(threadsDao.mergeMetadataKey).toHaveBeenCalledWith(
      'thread-int-1',
      'claudeSessions',
      { 'claude-1': 'sess-42' },
    );
    expect(runEvents()).toHaveLength(1);
    expect(runEvents()[0]!.data.error).toBeUndefined();
  });

  it('persists the session id when the thread row is created after the run begins (first turn of a fresh thread)', async () => {
    // The invoke/message events that create the thread row are emitted and
    // handled asynchronously, so on the FIRST turn of a brand-new thread the
    // start-of-run getOne can return null while the row exists by the time the
    // bridge finishes. getOne returns null at run-start, then the persisted
    // row on every subsequent lookup.
    threadsDao.getOne
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'thread-int-1', metadata: {} });

    const { runPromise } = await startRunAndOpenBridge();
    capturedHandlers!.onDone('sess-late');
    await runPromise;

    // The session id must be persisted under the now-existing row so the next
    // turn can resume instead of replaying the whole transcript.
    expect(threadsDao.mergeMetadataKey).toHaveBeenCalledWith(
      'thread-int-1',
      'claudeSessions',
      { 'claude-1': 'sess-late' },
    );
  });

  it('revokes the virtual key when the bridge fails fatally', async () => {
    const { runPromise } = await startRunAndOpenBridge();
    capturedHandlers!.onFatal('bridge exploded');

    await expect(runPromise).rejects.toMatchObject({
      errorCode: 'CLAUDE_BRIDGE_FAILED',
    });
    expect(virtualKeys.revokeThreadKey).toHaveBeenCalledWith('sk-vkey-test');
    expect(runEvents()).toHaveLength(1);
    expect(runEvents()[0]!.data.error).toBeDefined();
  });

  it('surfaces a visible failure message when the bridge fails fatally', async () => {
    const { runPromise } = await startRunAndOpenBridge();
    capturedHandlers!.onFatal('bridge stdout error: boom');

    await expect(runPromise).rejects.toMatchObject({
      errorCode: 'CLAUDE_BRIDGE_FAILED',
    });

    // A bridge death must explain itself in the conversation, not leave a bare
    // Failed thread: a visible SystemMessage names the reason.
    const messageEvents = events.filter((e) => e.type === 'message') as Extract<
      AgentEventType,
      { type: 'message' }
    >[];
    const failure = messageEvents
      .flatMap((e) => e.data.messages)
      .find((m) => String(m.content).includes('Claude Agent session failed'));
    expect(failure).toBeDefined();
    expect(String(failure!.content)).toContain('bridge stdout error: boom');
  });

  it('surfaces a visible failure message and a Failed run event when the session ends with an error subtype', async () => {
    const { runPromise } = await startRunAndOpenBridge();

    capturedHandlers!.onSdkMessage({
      type: 'result',
      subtype: 'error_max_turns',
      session_id: 'sess-1',
      is_error: true,
    });
    capturedHandlers!.onDone('sess-1');
    const output = await runPromise;

    const failure = output.messages.find((m) =>
      String(m.content).includes('Claude Agent session failed'),
    );
    expect(failure).toBeDefined();
    expect(String(failure!.content)).toContain('error_max_turns');

    // The run event carries the error (thread → Failed), not a success result.
    const run = runEvents();
    expect(run).toHaveLength(1);
    expect(run[0]!.data.error).toBeDefined();
    expect(run[0]!.data.result).toBeUndefined();
  });

  it('fails a live run visibly (message + Failed run event + revoke + interrupt) when the node is redeployed/torn down', async () => {
    const { runPromise } = await startRunAndOpenBridge();

    await agent.failActiveRunsForRedeploy('a new graph revision was deployed');

    // The live bridge is interrupted and the per-thread key revoked at once.
    expect(fakeTransport.interrupt).toHaveBeenCalled();
    expect(virtualKeys.revokeThreadKey).toHaveBeenCalledWith('sk-vkey-test');

    // The interruption explains itself: a visible message + a Failed run event.
    const messageEvents = events.filter((e) => e.type === 'message') as Extract<
      AgentEventType,
      { type: 'message' }
    >[];
    const failure = messageEvents
      .flatMap((e) => e.data.messages)
      .find((m) => String(m.content).includes('Claude Agent session failed'));
    expect(failure).toBeDefined();
    expect(String(failure!.content)).toContain('a new graph revision');

    const run = runEvents();
    expect(run).toHaveLength(1);
    expect(run[0]!.data.error).toBeDefined();
    expect(run[0]!.data.result).toBeUndefined();

    // The bridge reports the abort; run() must stay silent for the stopped run.
    capturedHandlers!.onAborted('sess-1');
    await runPromise;
    expect(runEvents()).toHaveLength(1);
  });

  it('does not emit a second Failed run event when the bridge dies with a fatal frame after a redeploy abort', async () => {
    const { runPromise } = await startRunAndOpenBridge();

    await agent.failActiveRunsForRedeploy('a new graph revision was deployed');
    // failActiveRunsForRedeploy already emitted exactly one Failed run event.
    expect(runEvents()).toHaveLength(1);

    // The abort tears the bridge stream down; instead of reporting a clean
    // 'aborted' the dying bridge surfaces a 'fatal' (a crashed/severed stream
    // during the interrupt). The run was already failed+stopped, so this must
    // NOT produce a duplicate Failed run event or a duplicate failure message.
    capturedHandlers!.onFatal('bridge stream severed during interrupt');
    await expect(runPromise).rejects.toMatchObject({
      errorCode: 'CLAUDE_BRIDGE_FAILED',
    });

    expect(runEvents()).toHaveLength(1);
    const failureMessages = (
      events.filter((e) => e.type === 'message') as Extract<
        AgentEventType,
        { type: 'message' }
      >[]
    )
      .flatMap((e) => e.data.messages)
      .filter((m) => String(m.content).includes('Claude Agent session failed'));
    expect(failureMessages).toHaveLength(1);
  });

  it('does not overwrite a user Stop with a Failed run event when the bridge dies with a fatal frame after the stop', async () => {
    const { runPromise } = await startRunAndOpenBridge();

    // User stops the thread: a 'stop' event fires (thread → Stopped) and the
    // session is aborted.
    await agent.stopThread(THREAD_ID, 'user stop');
    expect(stopEvents()).toHaveLength(1);

    // The abort severs the bridge stream and it reports 'fatal' rather than a
    // clean 'aborted'. The thread is already user-Stopped, so a Failed 'run'
    // event here would clobber the Stopped status to Failed.
    capturedHandlers!.onFatal('bridge stream severed during interrupt');
    await runPromise.catch(() => undefined);

    expect(runEvents()).toHaveLength(0);
  });

  it('resumes the node-scoped session when the transcript is still on the container', async () => {
    threadsDao.getOne.mockResolvedValue({
      id: 'thread-int-1',
      metadata: { claudeSessions: { 'claude-1': 'sess-old' } },
    });
    bootstrap.isSessionResumable.mockResolvedValue(true);

    const { runPromise } = await startRunAndOpenBridge();
    capturedHandlers!.onDone('sess-old');
    await runPromise;

    expect(bootstrap.isSessionResumable).toHaveBeenCalledWith(
      expect.anything(),
      'sess-old',
    );
    expect(sentStartFrame().options.resume).toBe('sess-old');
    expect(sentStartFrame().options.prompt).not.toContain(
      '<conversation-history>',
    );
  });

  it('replays only THIS node history (tail-truncated) when the session is not resumable', async () => {
    threadsDao.getOne.mockResolvedValue({
      id: 'thread-int-1',
      metadata: { claudeSessions: { 'claude-1': 'sess-gone' } },
    });
    bootstrap.isSessionResumable.mockResolvedValue(false);
    // One short head row + one row longer than the 8000-char replay cap:
    // truncation keeps the TAIL, so the head must be cut from the prompt.
    messagesDao.getAll.mockResolvedValue([
      { role: MessageRole.Human, message: { content: 'earlier question' } },
      { role: MessageRole.AI, message: { content: 'z'.repeat(9_000) } },
    ]);

    const { runPromise } = await startRunAndOpenBridge();
    capturedHandlers!.onDone('sess-new');
    await runPromise;

    // The replay query is node-scoped — other agents' rows on a shared root
    // thread (and ::sub:: surrogates) never enter this node's replay.
    expect(messagesDao.getAll).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'claude-1' }),
      expect.anything(),
    );
    const prompt = sentStartFrame().options.prompt;
    expect(prompt.startsWith('<conversation-history>')).toBe(true);
    expect(prompt).toContain('zzzz');
    expect(prompt).not.toContain('earlier question');
    expect(sentStartFrame().options.resume).toBeUndefined();
  });

  describe('communication session labels (independent sub-conversations)', () => {
    const sessionConfig = (
      session: string,
    ): RunnableConfig<BaseAgentConfigurable> => ({
      configurable: {
        thread_id: THREAD_ID,
        graph_id: 'g-1',
        node_id: 'claude-1',
        __communicationSession: session,
      } as BaseAgentConfigurable,
    });

    const runWithConfig = async (
      cfg: RunnableConfig<BaseAgentConfigurable>,
    ): Promise<{ runPromise: ReturnType<ClaudeAgent['run']> }> => {
      const runPromise = agent.run(
        THREAD_ID,
        [new HumanMessage('hi')],
        undefined,
        cfg,
      );
      await vi.waitFor(() => expect(startSpy).toHaveBeenCalled());
      releaseTransportStart();
      await vi.waitFor(() => expect(fakeTransport.send).toHaveBeenCalled());
      return { runPromise };
    };

    it('opens a NEW conversation under the composite key for a fresh label', async () => {
      threadsDao.getOne.mockResolvedValue({
        id: 'thread-int-1',
        metadata: {},
      });

      const { runPromise } = await runWithConfig(sessionConfig('plan'));
      capturedHandlers!.onDone('sess-plan-1');
      const output = await runPromise;

      expect(output.startedNewSession).toBe(true);
      // Fresh label → nothing to resume; isSessionResumable is never consulted.
      expect(bootstrap.isSessionResumable).not.toHaveBeenCalled();
      expect(sentStartFrame().options.resume).toBeUndefined();
      // Persisted under `${nodeId}::${label}`, leaving other labels untouched.
      expect(threadsDao.mergeMetadataKey).toHaveBeenCalledWith(
        'thread-int-1',
        'claudeSessions',
        { 'claude-1::plan': 'sess-plan-1' },
      );
    });

    it('resumes the per-label session when one is already persisted', async () => {
      threadsDao.getOne.mockResolvedValue({
        id: 'thread-int-1',
        metadata: { claudeSessions: { 'claude-1::plan': 'sess-plan-old' } },
      });
      bootstrap.isSessionResumable.mockResolvedValue(true);

      const { runPromise } = await runWithConfig(sessionConfig('plan'));
      capturedHandlers!.onDone('sess-plan-old');
      const output = await runPromise;

      expect(output.startedNewSession).toBe(false);
      expect(bootstrap.isSessionResumable).toHaveBeenCalledWith(
        expect.anything(),
        'sess-plan-old',
      );
      expect(sentStartFrame().options.resume).toBe('sess-plan-old');
    });

    it('does NOT resume a sibling label — two labels stay independent', async () => {
      // Only the "plan" conversation is persisted; an "implement" delegation to
      // the SAME node must start fresh, not resume plan's session. The old
      // node-id-only key would have resumed it — this pins the composite key.
      threadsDao.getOne.mockResolvedValue({
        id: 'thread-int-1',
        metadata: { claudeSessions: { 'claude-1::plan': 'sess-plan-old' } },
      });
      bootstrap.isSessionResumable.mockResolvedValue(true);

      const { runPromise } = await runWithConfig(sessionConfig('implement'));
      capturedHandlers!.onDone('sess-impl-1');
      const output = await runPromise;

      expect(output.startedNewSession).toBe(true);
      expect(bootstrap.isSessionResumable).not.toHaveBeenCalled();
      expect(sentStartFrame().options.resume).toBeUndefined();
      // Persisted under the implement key; the plan session is left intact.
      expect(threadsDao.mergeMetadataKey).toHaveBeenCalledWith(
        'thread-int-1',
        'claudeSessions',
        { 'claude-1::implement': 'sess-impl-1' },
      );
    });

    it('scopes replay to THIS sub-thread (externalThreadId), not just the node', async () => {
      // Persisted but non-resumable → replay path. The replay query must filter
      // by externalThreadId (the effective sub-thread id) so a sibling label's
      // rows on the same node/root thread cannot be spliced in.
      threadsDao.getOne.mockResolvedValue({
        id: 'thread-int-1',
        metadata: { claudeSessions: { 'claude-1::implement': 'sess-gone' } },
      });
      bootstrap.isSessionResumable.mockResolvedValue(false);
      messagesDao.getAll.mockResolvedValue([
        { role: MessageRole.Human, message: { content: 'impl question' } },
      ]);

      const { runPromise } = await runWithConfig(sessionConfig('implement'));
      capturedHandlers!.onDone('sess-impl-new');
      const output = await runPromise;

      // A non-resumable persisted session is a continuation (replayed), not new.
      expect(output.startedNewSession).toBe(false);
      expect(messagesDao.getAll).toHaveBeenCalledWith(
        expect.objectContaining({
          externalThreadId: THREAD_ID,
          nodeId: 'claude-1',
        }),
        expect.anything(),
      );
    });

    it('keeps the legacy node-id key when NO label is supplied (back-compat)', async () => {
      threadsDao.getOne.mockResolvedValue({
        id: 'thread-int-1',
        metadata: {},
      });

      const { runPromise } = await runWithConfig({
        configurable: {
          thread_id: THREAD_ID,
          graph_id: 'g-1',
          node_id: 'claude-1',
        } as BaseAgentConfigurable,
      });
      capturedHandlers!.onDone('sess-legacy');
      const output = await runPromise;

      expect(output.startedNewSession).toBe(true);
      expect(threadsDao.mergeMetadataKey).toHaveBeenCalledWith(
        'thread-int-1',
        'claudeSessions',
        { 'claude-1': 'sess-legacy' },
      );
    });
  });

  it('rejects concurrent run() calls on the same thread', async () => {
    const runPromise = agent.run(
      THREAD_ID,
      [new HumanMessage('hi')],
      undefined,
      runnableConfig(),
    );
    await vi.waitFor(() => expect(startSpy).toHaveBeenCalled());

    await expect(
      agent.run(THREAD_ID, [new HumanMessage('more')]),
    ).rejects.toMatchObject({ errorCode: 'THREAD_ALREADY_RUNNING' });

    releaseTransportStart();
    await vi.waitFor(() => expect(fakeTransport.send).toHaveBeenCalled());
    capturedHandlers!.onDone('sess-1');
    await runPromise;
  });

  it('buffers a mid-run append racing bootstrap and flushes it right after start', async () => {
    const runPromise = agent.run(
      THREAD_ID,
      [new HumanMessage('hi')],
      undefined,
      runnableConfig(),
    );
    await vi.waitFor(() => expect(startSpy).toHaveBeenCalled());

    // Bridge still booting — the append must buffer, not reject.
    const appended = await agent.runOrAppend(THREAD_ID, [
      new HumanMessage('more'),
    ]);
    expect(appended.needsMoreInfo).toBe(false);

    releaseTransportStart();
    await vi.waitFor(() => expect(fakeTransport.send).toHaveBeenCalled());
    const frames = fakeTransport.send.mock.calls.map(
      (call) => call[0] as { type: string },
    );
    expect(frames[0]!.type).toBe('start');
    expect(frames[1]).toEqual({ type: 'user_message', text: 'more' });

    capturedHandlers!.onDone('sess-1');
    await runPromise;
  });

  it('injects a mid-run append into the live session and persists the Human message', async () => {
    const { runPromise } = await startRunAndOpenBridge();

    const appended = await agent.runOrAppend(THREAD_ID, [
      new HumanMessage('follow-up'),
    ]);

    // Empty on purpose: the append has no callee response yet — a relay must
    // not read the caller's own text back as the agent's answer.
    expect(appended.messages).toHaveLength(0);
    expect(appended.needsMoreInfo).toBe(false);
    expect(fakeTransport.send).toHaveBeenCalledWith({
      type: 'user_message',
      text: 'follow-up',
    });

    const messageEvents = events.filter((e) => e.type === 'message') as Extract<
      AgentEventType,
      { type: 'message' }
    >[];
    const lastBatch = messageEvents.at(-1)!.data.messages;
    expect(String(lastBatch[0]!.content)).toBe('follow-up');

    capturedHandlers!.onDone('sess-1');
    await runPromise;
  });

  it('ends the turn as NeedMoreInfo with the question text when a top-level question arrives', async () => {
    const { runPromise } = await startRunAndOpenBridge();

    capturedHandlers!.onQuestionRequest!({
      id: 'question-1',
      questions: [
        {
          question: 'Which DB?',
          options: [{ label: 'Postgres', description: 'pg' }],
        },
      ],
    });
    expect(fakeTransport.interrupt).toHaveBeenCalled();
    capturedHandlers!.onAborted('sess-1');

    const output = await runPromise;
    expect(output.needsMoreInfo).toBe(true);
    const questionText = String(output.messages.at(-1)!.content);
    expect(questionText).toContain('Which DB?');
    expect(questionText).toContain('- Postgres: pg');

    const run = runEvents();
    expect(run).toHaveLength(1);
    expect(run[0]!.data.result?.needsMoreInfo).toBe(true);
    expect(run[0]!.data.error).toBeUndefined();
  });

  it('lets a user stop win over a pending question (no NeedMoreInfo after stop)', async () => {
    const { runPromise } = await startRunAndOpenBridge();

    capturedHandlers!.onQuestionRequest!({
      id: 'question-1',
      questions: [{ question: 'Which DB?' }],
    });
    await agent.stopThread(THREAD_ID, 'user stop');
    capturedHandlers!.onAborted('sess-1');

    const output = await runPromise;
    expect(output.needsMoreInfo).toBe(false);
    expect(runEvents()).toHaveLength(0);
  });

  it('forwards wired tool definitions in the start frame', async () => {
    agent.addTool({
      name: 'knowledge_search_docs',
      description: 'Search docs.',
      __ajvSchema: { type: 'object', properties: {} },
    } as never);

    const { runPromise } = await startRunAndOpenBridge();

    const frame = fakeTransport.send.mock.calls[0]![0] as {
      options: { tools?: unknown[] };
    };
    expect(frame.options.tools).toEqual([
      {
        name: 'knowledge_search_docs',
        description: 'Search docs.',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);

    capturedHandlers!.onDone('sess-1');
    await runPromise;
  });

  /**
   * Native gh/git auth wiring in run(): resolve the owner's GitHub App token,
   * inject it as GH_TOKEN into the session env, and configure git auth only
   * when a token resolved. The whole branch is dead unless a created_by id is
   * present, so these pin the production-reachable shape (graph-compiler /
   * graphs.service populate the owner) that the other tests leave undriven.
   */
  describe('native gh/git auth wiring', () => {
    const startEnv = () =>
      (startSpy.mock.calls[0]![0] as { env: Record<string, string> }).env;

    it('injects the resolved owner token as GH_TOKEN and configures git auth', async () => {
      gitTokenResolver.resolveDefaultToken.mockResolvedValue({
        token: 'ghs_x',
      });

      const { runPromise } = await startRunAndOpenBridge(undefined, {
        thread: 'user-thread',
      });
      capturedHandlers!.onDone('sess-1');
      await runPromise;

      expect(gitTokenResolver.resolveDefaultToken).toHaveBeenCalledWith(
        'user-thread',
      );
      expect(bootstrap.configureGitAuth).toHaveBeenCalledTimes(1);
      expect(startEnv().GH_TOKEN).toBe('ghs_x');
    });

    it('skips git-auth config and GH_TOKEN when the owner resolves no token', async () => {
      // resolveDefaultToken default → null.
      const { runPromise } = await startRunAndOpenBridge(undefined, {
        thread: 'user-thread',
      });
      capturedHandlers!.onDone('sess-1');
      await runPromise;

      expect(gitTokenResolver.resolveDefaultToken).toHaveBeenCalledWith(
        'user-thread',
      );
      expect(bootstrap.configureGitAuth).not.toHaveBeenCalled();
      expect(startEnv().GH_TOKEN).toBeUndefined();
    });

    it('never resolves a token when neither owner id is present', async () => {
      const { runPromise } = await startRunAndOpenBridge();
      capturedHandlers!.onDone('sess-1');
      await runPromise;

      expect(gitTokenResolver.resolveDefaultToken).not.toHaveBeenCalled();
      expect(bootstrap.configureGitAuth).not.toHaveBeenCalled();
      expect(startEnv().GH_TOKEN).toBeUndefined();
    });

    it('prefers the thread owner over the graph owner', async () => {
      gitTokenResolver.resolveDefaultToken.mockResolvedValue({
        token: 'ghs_thread',
      });

      const { runPromise } = await startRunAndOpenBridge(undefined, {
        thread: 'user-thread',
        graph: 'user-graph',
      });
      capturedHandlers!.onDone('sess-1');
      await runPromise;

      expect(gitTokenResolver.resolveDefaultToken).toHaveBeenCalledTimes(1);
      expect(gitTokenResolver.resolveDefaultToken).toHaveBeenCalledWith(
        'user-thread',
      );
      expect(startEnv().GH_TOKEN).toBe('ghs_thread');
    });
  });

  /**
   * BYO Anthropic auth mode (config.authMode === 'byo-anthropic'): the graph
   * author's own key is resolved host-side and injected directly as
   * ANTHROPIC_API_KEY with the direct-Anthropic base URL; NO LiteLLM virtual key
   * is issued or revoked. Every misconfiguration fails CLOSED — there is no
   * silent fallback to the system upstream. These pin the run()-level wiring the
   * way the gh/git block pins the github-token wiring.
   */
  describe('BYO Anthropic auth mode', () => {
    const BYO_CONFIG: ClaudeAgentSchemaType = {
      ...AGENT_CONFIG,
      authMode: ClaudeAuthMode.ByoAnthropic,
      apiKeySecretRef: 'my-anthropic-key',
    };
    const byoConfig = (
      over?: Partial<BaseAgentConfigurable>,
    ): RunnableConfig<BaseAgentConfigurable> => ({
      configurable: {
        thread_id: THREAD_ID,
        graph_id: 'g-1',
        node_id: 'claude-1',
        graph_project_id: 'proj-1',
        ...over,
      } as BaseAgentConfigurable,
    });
    const startEnv = () =>
      (startSpy.mock.calls[0]![0] as { env: Record<string, string> }).env;

    beforeEach(() => {
      agent.setConfig(BYO_CONFIG);
    });

    it('resolves the BYO key, injects it with the direct Anthropic base URL, and issues NO virtual key', async () => {
      const runPromise = agent.run(
        THREAD_ID,
        [new HumanMessage('hi')],
        undefined,
        byoConfig(),
      );
      await vi.waitFor(() => expect(startSpy).toHaveBeenCalled());
      releaseTransportStart();
      await vi.waitFor(() => expect(fakeTransport.send).toHaveBeenCalled());
      capturedHandlers!.onDone('sess-byo');
      await runPromise;

      expect(secretsService.resolveSecretValue).toHaveBeenCalledWith(
        'proj-1',
        'my-anthropic-key',
      );
      // No virtual key is issued in BYO, so none is revoked either.
      expect(virtualKeys.issueThreadKey).not.toHaveBeenCalled();
      expect(virtualKeys.revokeThreadKey).not.toHaveBeenCalled();
      expect(startEnv().ANTHROPIC_API_KEY).toBe('sk-ant-api03-testkey');
      expect(startEnv().ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    });

    it('fails closed when no project scope is resolved for the thread', async () => {
      await expect(
        agent.run(
          THREAD_ID,
          [new HumanMessage('hi')],
          undefined,
          byoConfig({ graph_project_id: undefined }),
        ),
      ).rejects.toMatchObject({ errorCode: 'CLAUDE_BYO_NO_PROJECT' });
      expect(secretsService.resolveSecretValue).not.toHaveBeenCalled();
      expect(startSpy).not.toHaveBeenCalled();
    });

    it('fails closed when no API-key secret is selected', async () => {
      agent.setConfig({ ...BYO_CONFIG, apiKeySecretRef: undefined });
      await expect(
        agent.run(THREAD_ID, [new HumanMessage('hi')], undefined, byoConfig()),
      ).rejects.toMatchObject({ errorCode: 'CLAUDE_BYO_NO_SECRET_REF' });
      expect(secretsService.resolveSecretValue).not.toHaveBeenCalled();
    });

    it('fails closed when the secrets store is unavailable', async () => {
      secretsStore.isAvailable.mockReturnValue(false);
      await expect(
        agent.run(THREAD_ID, [new HumanMessage('hi')], undefined, byoConfig()),
      ).rejects.toMatchObject({ errorCode: 'CLAUDE_BYO_STORE_UNAVAILABLE' });
      expect(secretsService.resolveSecretValue).not.toHaveBeenCalled();
    });

    it('fails closed when the resolved secret is not an sk-ant- key', async () => {
      secretsService.resolveSecretValue.mockResolvedValue('sk-proj-openai-ish');
      await expect(
        agent.run(THREAD_ID, [new HumanMessage('hi')], undefined, byoConfig()),
      ).rejects.toMatchObject({ errorCode: 'CLAUDE_BYO_INVALID_KEY' });
      expect(startSpy).not.toHaveBeenCalled();
    });

    it('fails closed on a subscription OAuth token (sk-ant-oat…), which shares the sk-ant- prefix', async () => {
      secretsService.resolveSecretValue.mockResolvedValue(
        'sk-ant-oat01-subscription-token',
      );
      await expect(
        agent.run(THREAD_ID, [new HumanMessage('hi')], undefined, byoConfig()),
      ).rejects.toMatchObject({ errorCode: 'CLAUDE_BYO_INVALID_KEY' });
      expect(startSpy).not.toHaveBeenCalled();
    });

    /**
     * Run a BYO turn that may take EITHER path and settle it deterministically:
     * the transport start resolves immediately (no blocked
     * releaseTransportStart), and once start fires the bridge is driven to a
     * clean `done` so a run that wrongly ACCEPTS the key finishes instead of
     * hanging on a pending stream (an opaque timeout). A run that correctly
     * REJECTS before start never reaches the bridge — the returned promise
     * rejects, which the caller asserts on. Returns the settled outcome.
     */
    const runByoTurnToSettle = async (): Promise<
      { rejected: true; error: unknown } | { rejected: false }
    > => {
      startSpy.mockImplementation(
        async (params: Parameters<typeof ClaudeBridgeTransport.start>[0]) => {
          capturedHandlers = params.handlers;
          return fakeTransport as unknown as ClaudeBridgeTransport;
        },
      );
      const runPromise = agent.run(
        THREAD_ID,
        [new HumanMessage('hi')],
        undefined,
        byoConfig(),
      );
      let settled = false;
      const tracked = runPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // If start fired, drive the bridge to done so the run finishes; otherwise
      // the run already rejected pre-start. Poll until the run promise settles.
      await vi.waitFor(() => {
        if (!settled && startSpy.mock.calls.length > 0 && capturedHandlers) {
          capturedHandlers.onDone('sess-byo');
        }
        expect(settled).toBe(true);
      });
      await tracked;
      try {
        await runPromise;
        return { rejected: false };
      } catch (error) {
        return { rejected: true, error };
      }
    };

    it('fails closed on a bare "sk-ant-" prefix with no key body (a degenerate/empty secret value)', async () => {
      // The resolved secret is exactly the prefix and nothing else — it passes
      // startsWith('sk-ant-') and is NOT an oat- token, so the current
      // predicate (!startsWith('sk-ant-') || startsWith('sk-ant-oat'))
      // ACCEPTS it and injects an empty-bodied key as ANTHROPIC_API_KEY. A
      // prefix-only value carries no credential; the validator must refuse it
      // up front rather than letting Anthropic 401 opaquely on first call.
      secretsService.resolveSecretValue.mockResolvedValue('sk-ant-');

      const outcome = await runByoTurnToSettle();

      // A prefix-only value must never start a billable session.
      expect(startSpy).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        rejected: true,
        error: { errorCode: 'CLAUDE_BYO_INVALID_KEY' },
      });
    });

    it('fails closed on a key whose only body is whitespace ("sk-ant- ")', async () => {
      // A secret that is the prefix followed by whitespace passes the prefix
      // check and is injected verbatim as ANTHROPIC_API_KEY. Whitespace is not
      // a valid credential body; the validator must reject it rather than hand
      // the sandbox a blank key that fails opaquely upstream.
      secretsService.resolveSecretValue.mockResolvedValue('sk-ant- ');

      const outcome = await runByoTurnToSettle();

      expect(startSpy).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        rejected: true,
        error: { errorCode: 'CLAUDE_BYO_INVALID_KEY' },
      });
    });

    it('does not inject a key carrying a trailing newline into the session env (header-unsafe)', async () => {
      // Secrets-store values very commonly carry a trailing newline (e.g. a
      // value piped in with `echo`). ANTHROPIC_API_KEY becomes an HTTP header
      // value; a trailing "\n" is header-unsafe and makes Anthropic reject the
      // request. The current predicate trims nothing, so the raw "sk-ant-...\n"
      // is injected verbatim. The session env must never carry a key with a
      // trailing newline — either reject the malformed secret up front, or
      // inject a trimmed value, but not the raw newline-bearing string.
      secretsService.resolveSecretValue.mockResolvedValue(
        'sk-ant-api03-realkey\n',
      );

      await runByoTurnToSettle();

      // If the run rejected (validator refused the malformed value) the session
      // never started — acceptable. If it started, the injected key must be
      // clean: a newline in an HTTP header value breaks the upstream request.
      if (startSpy.mock.calls.length > 0) {
        expect(startEnv().ANTHROPIC_API_KEY).not.toMatch(/\n/);
      }
    });

    it('fails closed (no fallback to the system key) when secret resolution throws', async () => {
      secretsService.resolveSecretValue.mockRejectedValue(
        new Error('SECRET_NOT_FOUND'),
      );
      await expect(
        agent.run(THREAD_ID, [new HumanMessage('hi')], undefined, byoConfig()),
      ).rejects.toThrow('SECRET_NOT_FOUND');
      // The error came FROM resolution (not a coincidental earlier throw) — the
      // no-system-fallback intent is only proven if resolution was reached.
      expect(secretsService.resolveSecretValue).toHaveBeenCalledWith(
        'proj-1',
        'my-anthropic-key',
      );
      expect(virtualKeys.issueThreadKey).not.toHaveBeenCalled();
    });

    it('fails closed when the node model is not an Anthropic model', async () => {
      agent.setConfig({ ...BYO_CONFIG, model: 'gpt-4o' });
      await expect(
        agent.run(THREAD_ID, [new HumanMessage('hi')], undefined, byoConfig()),
      ).rejects.toMatchObject({ errorCode: 'CLAUDE_BYO_INVALID_MODEL' });
      expect(secretsService.resolveSecretValue).not.toHaveBeenCalled();
    });

    it('fails closed when the pricing alias resolves to zero rates (would otherwise run unpriced)', async () => {
      liteLlmClient.getModelInfo.mockResolvedValue({
        model_info: { input_cost_per_token: 0, output_cost_per_token: 0 },
      });
      await expect(
        agent.run(THREAD_ID, [new HumanMessage('hi')], undefined, byoConfig()),
      ).rejects.toMatchObject({ errorCode: 'CLAUDE_BYO_UNPRICED_MODEL' });
      expect(startSpy).not.toHaveBeenCalled();
    });

    it('short-circuits on prior spend BEFORE resolving the BYO key (cost gate precedes BYO resolution)', async () => {
      messagesDao.aggregateUsageByNodeId.mockResolvedValue(
        new Map([['claude-1', usage(1.5)]]),
      );
      const output = await agent.run(
        THREAD_ID,
        [new HumanMessage('hi')],
        undefined,
        byoConfig({ effective_cost_limit_usd: 1 }),
      );
      expect(output.messages).toEqual([]);
      expect(secretsService.resolveSecretValue).not.toHaveBeenCalled();
      expect(startSpy).not.toHaveBeenCalled();
      expect(stopEvents()[0]!.data).toMatchObject({ stopReason: 'cost_limit' });
    });

    it('still enforces the host-side cost-limit in BYO (mid-stream interrupt, no virtual key to revoke)', async () => {
      messagesDao.aggregateUsageByNodeId.mockResolvedValue(
        new Map([['claude-1', usage(0.95)]]),
      );
      const runPromise = agent.run(
        THREAD_ID,
        [new HumanMessage('hi')],
        undefined,
        byoConfig({ effective_cost_limit_usd: 1 }),
      );
      await vi.waitFor(() => expect(startSpy).toHaveBeenCalled());
      releaseTransportStart();
      await vi.waitFor(() => expect(fakeTransport.send).toHaveBeenCalled());

      capturedHandlers!.onSdkMessage({
        type: 'assistant',
        session_id: 'sess-byo',
        parent_tool_use_id: null,
        message: {
          id: 'm-1',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'expensive thought' }],
          usage: { input_tokens: 100_000, output_tokens: 75_000 },
        },
      });
      await vi.waitFor(() =>
        expect(fakeTransport.interrupt).toHaveBeenCalled(),
      );
      capturedHandlers!.onAborted('sess-byo');
      await runPromise;

      expect(stopEvents()[0]!.data.stopReason).toBe('cost_limit');
      expect(virtualKeys.revokeThreadKey).not.toHaveBeenCalled();
    });
  });
});
