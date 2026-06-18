import {
  AIMessage,
  BaseMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { RunnableConfig } from '@langchain/core/runnables';
import { Injectable, Scope } from '@nestjs/common';
import {
  GENIRO_MCP_SERVER_KEY,
  type SerializableMcpConfig,
} from '@packages/claude-bridge';
import { DefaultLogger, InternalException } from '@packages/common';
import { v4 } from 'uuid';

import type { BuiltAgentTool } from '../../../agent-tools/tools/base-tool';
import { GitTokenResolverService } from '../../../git-auth/services/git-token-resolver.service';
import { MessageRole } from '../../../graphs/graphs.types';
import { RequestTokenUsage } from '../../../litellm/litellm.types';
import { LiteLlmClient } from '../../../litellm/services/litellm.client';
import { LitellmVirtualKeyService } from '../../../litellm/services/litellm-virtual-key.service';
import type { BaseRuntime } from '../../../runtime/services/base-runtime';
import { DaytonaRuntime } from '../../../runtime/services/daytona-runtime';
import { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
import { SecretsService } from '../../../secrets/services/secrets.service';
import { SecretsStoreService } from '../../../secrets-store/services/secrets-store.service';
import { MessagesDao } from '../../../threads/dao/messages.dao';
import { ThreadsDao } from '../../../threads/dao/threads.dao';
import { BaseAgentConfigurable, RunnableAgent } from '../../agents.types';
import {
  extractTextFromResponseContent,
  markMessageHideForLlm,
  updateMessagesListWithMetadata,
} from '../../agents.utils';
import { ClaudeBootstrapService } from '../claude/claude-bootstrap.service';
import { ClaudeBridgeTransport } from '../claude/claude-bridge-transport';
import { ClaudeKeepaliveService } from '../claude/claude-keepalive.service';
import {
  ClaudeAuthMode,
  ClaudeModelOverrides,
  ClaudePluginSource,
  ClaudeQuestionRequest,
  ClaudeThreadMetadata,
  ConnectedMcpServer,
} from '../claude/claude-session.types';
import {
  buildBridgeToolDefinitions,
  buildClaudeSessionEnv,
  collectClaudeKeyModels,
  formatQuestionsAsText,
  sanitizeSandboxError,
} from '../claude/claude-session.utils';
import { ClaudeStreamMapper } from '../claude/claude-stream-mapper';
import { ClaudeToolDispatcher } from '../claude/claude-tool-dispatcher';
import { AgentEventType, AgentOutput, BaseAgent } from './base-agent';

export type ClaudeAgentSchemaType = {
  name: string;
  description: string;
  instructions: string;
  model: string;
  authMode?: ClaudeAuthMode;
  apiKeySecretRef?: string;
  maxTurns?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxContext?: boolean;
  sonnetModel?: string;
  opusModel?: string;
  haikuModel?: string;
  fableModel?: string;
  plugins?: ClaudePluginSource[];
};

type ClaudeActiveRun = {
  abortController: AbortController;
  threadId: string;
  runnableConfig: RunnableConfig<BaseAgentConfigurable>;
  stopped?: boolean;
  stopReason?: string;
  stopCostUsd?: number;
  /**
   * Top-level AskUserQuestion that ended the turn: the session is interrupted
   * and the run finishes with `needsMoreInfo` carrying the question text.
   */
  pendingQuestion?: ClaudeQuestionRequest;
  /** Live transport — mid-run appends inject `user_message` frames through it. */
  transport?: ClaudeBridgeTransport;
  /**
   * Per-thread virtual key, stored on the run so the stop/redeploy seam can
   * revoke it immediately (the run's own `finally` is the idempotent backstop).
   */
  virtualKey?: string;
  /**
   * Mid-run appends that arrived while the bridge was still booting (bootstrap
   * can take minutes); flushed as `user_message` frames right after `start`.
   */
  pendingInjections: string[];
};

type BridgeOutcome =
  | { kind: 'done'; sessionId?: string }
  | { kind: 'aborted'; sessionId?: string }
  | { kind: 'fatal'; error: string };

const REPLAY_PREFIX_MAX_CHARS = 8_000;
/**
 * LiteLLM rejects non-positive key budgets; when the remaining thread budget
 * rounds to ≤ 0 (run still allowed — the pre-turn check uses ≥, not >), issue
 * a 1-cent key so the session can start and trip the limit on its first call.
 */
const MIN_VIRTUAL_KEY_BUDGET_USD = 0.01;
/**
 * Heartbeat period for the keepalive toucher. Must stay well under the idle
 * reaper threshold (30 min); the toucher itself throttles DB writes.
 */
const KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * BYO mode points the session's ANTHROPIC_BASE_URL straight at Anthropic,
 * bypassing LiteLLM. Note the host-side cost-limit (message-scan based) is the
 * only in-platform budget guard for BYO runs — there is no LiteLLM virtual-key
 * `max_budget`, and an interrupted turn's in-flight spend is not captured in the
 * rollup (the shared interrupt carve-out, cost-accounting.md). A Console
 * spend-limit on the BYO key is the recommended backstop.
 */
const ANTHROPIC_DIRECT_BASE_URL = 'https://api.anthropic.com';

/**
 * Agent kind backed by Claude Code (Anthropic Agent SDK) running inside the
 * thread's sandbox runtime via a stdio bridge. Unlike SimpleAgent there is no
 * LangGraph state machine and no checkpointer — the SDK session inside the
 * sandbox owns the conversation loop; this class maps the bridge stream onto
 * the BaseAgent event contract (invoke strictly before message/stateUpdate).
 *
 * Cost policy (".claude/rules/cost-accounting.md" — checkpoint-less variant):
 * - per-message `__requestUsage.totalPrice` is computed from LiteLLM
 *   registered rates; the SDK's `total_cost_usd` from the turn-end `result` is
 *   the PRIMARY turn price (`ClaudeStreamMapper.reconcileTurnUsage` prefers it),
 *   with the LiteLLM-rate figure as the fallback and the basis for the
 *   mid-stream cost-limit check — so the message-scan rollup matches billing;
 * - pre-turn spend is seeded from the message-scan aggregate (there is no
 *   checkpoint to seed from);
 * - mid-turn the per-thread virtual key budget (`effectiveLimit − prior
 *   spend`, model-scoped) is the OPERATIVE bound: through the LiteLLM
 *   passthrough, per-assistant-message usage is all zeros, so the host-side
 *   in-stream check below typically only trips once the turn's `result`
 *   message settles the real totals. LiteLLM tracks key spend asynchronously
 *   (batched), so the worst case is one in-flight turn of overshoot;
 * - a cost-limit trip mid-stream interrupts the session AFTER the tripping
 *   messages were emitted/persisted (messages stream as they arrive, so the
 *   persist-before-stop rule holds by construction).
 */
@Injectable({ scope: Scope.TRANSIENT })
export class ClaudeAgent
  extends BaseAgent<ClaudeAgentSchemaType>
  implements RunnableAgent<ClaudeAgentSchemaType>
{
  private currentConfig?: ClaudeAgentSchemaType;
  private runtimeProvider?: RuntimeThreadProvider;
  private externalMcpNodes: ConnectedMcpServer[] = [];
  private activeRuns = new Map<string, ClaudeActiveRun>();

  constructor(
    private readonly logger: DefaultLogger,
    private readonly bootstrap: ClaudeBootstrapService,
    private readonly keepalive: ClaudeKeepaliveService,
    private readonly virtualKeys: LitellmVirtualKeyService,
    private readonly liteLlmClient: LiteLlmClient,
    private readonly threadsDao: ThreadsDao,
    private readonly messagesDao: MessagesDao,
    private readonly gitTokenResolver: GitTokenResolverService,
    private readonly secretsService: SecretsService,
    private readonly secretsStore: SecretsStoreService,
  ) {
    super();
  }

  public setConfig(config: ClaudeAgentSchemaType): void {
    this.currentConfig = config;
  }

  public getConfig(): ClaudeAgentSchemaType {
    if (!this.currentConfig) {
      throw new InternalException(
        'CLAUDE_AGENT_NOT_CONFIGURED',
        'Agent config not initialized',
      );
    }
    return this.currentConfig;
  }

  public setRuntimeProvider(provider: RuntimeThreadProvider): void {
    this.runtimeProvider = provider;
  }

  /**
   * Connected MCP blocks collected by the template's `configure()` walk. They
   * are resolved into SDK `mcpServers` entries at run() against this node's
   * runtime. Replaced wholesale on each (re)configure — idempotent on redeploy.
   */
  public setExternalMcpServers(servers: ConnectedMcpServer[]): void {
    this.externalMcpNodes = servers;
  }

  public async run(
    threadId: string,
    messages: BaseMessage[],
    _config?: ClaudeAgentSchemaType,
    runnableConfig?: RunnableConfig<BaseAgentConfigurable>,
  ): Promise<AgentOutput> {
    const config = _config || this.currentConfig;
    if (!config) {
      throw new InternalException(
        'CLAUDE_AGENT_NOT_CONFIGURED',
        'Claude Agent configuration is required for execution',
      );
    }
    const runtimeProvider = this.runtimeProvider;
    if (!runtimeProvider) {
      throw new InternalException(
        'CLAUDE_AGENT_NO_RUNTIME',
        'Claude Agent requires a connected Runtime node',
      );
    }
    if (this.activeRuns.has(threadId)) {
      throw new InternalException(
        'THREAD_ALREADY_RUNNING',
        'Thread is currently running',
      );
    }

    const runId = runnableConfig?.configurable?.run_id || v4();
    const mergedConfig: RunnableConfig<BaseAgentConfigurable> = {
      ...(runnableConfig ?? {}),
      configurable: {
        ...(runnableConfig?.configurable ?? {}),
        thread_id: threadId,
        caller_agent: this,
        run_id: runId,
      },
    };
    const configurable = mergedConfig.configurable!;
    const rootThreadId =
      (configurable.parent_thread_id as string | undefined) || threadId;

    const abortController = new AbortController();
    const runEntry: ClaudeActiveRun = {
      abortController,
      threadId,
      runnableConfig: mergedConfig,
      stopped: false,
      pendingInjections: [],
    };
    this.activeRuns.set(threadId, runEntry);

    // Invoke is emitted after activeRuns.set and strictly BEFORE any message
    // event — persistence silently drops rows for threads the invoke handler
    // has not created yet.
    const updateMessages = updateMessagesListWithMetadata(
      messages,
      mergedConfig,
    );
    this.emit({
      type: 'invoke',
      data: { threadId, messages: updateMessages, config: mergedConfig },
    });
    this.emit({
      type: 'message',
      data: { threadId, messages: updateMessages, config: mergedConfig },
    });

    let virtualKey: string | undefined;
    let transport: ClaudeBridgeTransport | undefined;
    let keepaliveTimer: NodeJS.Timeout | undefined;

    try {
      const effectiveLimit = configurable.effective_cost_limit_usd;
      const hasLimit = typeof effectiveLimit === 'number';

      const threadRow = await this.threadsDao.getOne({
        externalThreadId: rootThreadId,
      });
      const priorSpendUsd = threadRow
        ? await this.aggregatePriorSpendUsd(threadRow.id)
        : 0;

      if (hasLimit && priorSpendUsd >= effectiveLimit) {
        return this.finishCostLimited(
          runEntry,
          [],
          effectiveLimit,
          priorSpendUsd,
        );
      }

      const runtime = await runtimeProvider.provide(mergedConfig);
      const { bridgePath, pluginPaths } =
        await this.bootstrap.ensureSessionReady(runtime, {
          ...(config.plugins !== undefined && {
            plugins: config.plugins,
          }),
        });

      // Per-node alias remapping injected into the session env so the SDK only
      // emits model names the upstream knows (system mode) or real Anthropic
      // ids (BYO). Unset aliases fall through to the SDK's own resolution.
      const modelOverrides: ClaudeModelOverrides = {
        ...(config.sonnetModel && { sonnet: config.sonnetModel }),
        ...(config.opusModel && { opus: config.opusModel }),
        ...(config.haikuModel && { haiku: config.haikuModel }),
        ...(config.fableModel && { fable: config.fableModel }),
      };
      // 1M context is opt-in via the [1m] model suffix; the SDK strips it before
      // calling the upstream, so host-side key scope + pricing keep the base id.
      const sessionModel = config.maxContext
        ? `${config.model}[1m]`
        : config.model;

      const isByo = config.authMode === ClaudeAuthMode.ByoAnthropic;
      // The key that fills ANTHROPIC_API_KEY for the session. System mode issues
      // a scoped per-thread LiteLLM virtual key (model-scoped + budgeted, revoked
      // in `finally`); BYO mode resolves the graph author's own Anthropic key
      // host-side and issues NO virtual key (so the `finally` revoke is skipped
      // by its `if (virtualKey)` guard).
      let sessionApiKey: string;
      if (isByo) {
        // The SDK reaches api.anthropic.com directly in BYO, so the node's model
        // must be a real Anthropic id. The standard aliases (claude-*) coincide;
        // a non-claude alias cannot route to direct Anthropic — fail closed.
        if (!config.model.startsWith('claude-')) {
          throw new InternalException(
            'CLAUDE_BYO_INVALID_MODEL',
            `Claude Agent BYO mode requires an Anthropic model (claude-*), but the node is configured with "${config.model}"`,
          );
        }
        sessionApiKey = await this.resolveByoApiKey(
          configurable,
          config.apiKeySecretRef,
        );
      } else {
        const issued = await this.virtualKeys.issueThreadKey({
          threadId: rootThreadId,
          ...(hasLimit && {
            budgetUsd: Math.max(
              effectiveLimit - priorSpendUsd,
              MIN_VIRTUAL_KEY_BUDGET_USD,
            ),
          }),
          // Model-scope the key: it enters a sandbox running untrusted code, so
          // an exfiltrated key must not be able to bill arbitrary models. Covers
          // the main model, the haiku/background model, and any alias override.
          models: collectClaudeKeyModels(config.model, modelOverrides),
          metadata: {
            graphId: configurable.graph_id,
            nodeId: configurable.node_id,
          },
        });
        virtualKey = issued.key;
        runEntry.virtualKey = issued.key;
        sessionApiKey = issued.key;
      }
      // Resolve the GitHub App installation token that authenticates Claude's
      // native gh/git (same resolver the proxied gh_* tools use). Prefer the
      // thread owner, then fall back to the graph owner so triggered/ownerless
      // runs (e.g. the github-issues webhook, where thread_created_by is unset)
      // still get native auth — acceptable under the current trusted-runtime
      // model, where all runtimes run trusted code and the token is not exposed
      // to an adversary. The token is owner-scoped, not repo-scoped, and
      // resolves to ONE arbitrary active install: a multi-install owner gets
      // native gh/git scoped to a single org, with the rest still reachable via
      // the proxied gh_* tools. When neither owner resolves a token, native
      // GitHub access is left unauthenticated and gh_* remains the only path.
      const ownerUserId =
        configurable.thread_created_by ?? configurable.graph_created_by;
      const githubToken = ownerUserId
        ? (await this.gitTokenResolver.resolveDefaultToken(ownerUserId))?.token
        : undefined;
      // A Daytona runtime runs on a separate host that cannot reach the
      // cluster-internal LiteLLM URL — its session points ANTHROPIC_BASE_URL at
      // the public LiteLLM URL instead (fail-closed if unset).
      const env = buildClaudeSessionEnv(sessionApiKey, githubToken, {
        isRemoteRuntime: runtime instanceof DaytonaRuntime,
        modelOverrides,
        ...(config.effort && { effort: config.effort }),
        // BYO talks to Anthropic directly with the user's own key, so the
        // LiteLLM sandbox-URL derivation/fail-close is bypassed.
        ...(isByo && { anthropicBaseUrlOverride: ANTHROPIC_DIRECT_BASE_URL }),
      });
      // Native gh/git become usable from Claude's Bash only once the session
      // carries a GH_TOKEN; install the matching credential helper then. The
      // proxied gh_* tools stay forwarded as the authoritative path until this
      // is verified end-to-end (native-github-auth plan, staged Phase 3).
      if (githubToken) {
        await this.bootstrap.configureGitAuth(runtime);
      }

      // Resume-or-replay: resume when the container still has the session
      // transcript; otherwise replay prior history into a fresh session.
      // Sessions are keyed by node id — several Claude agents can share one
      // root thread, and each must continue ITS OWN conversation only.
      const agentNodeId = (configurable.node_id as string | undefined) ?? '';
      const persistedSessionId = agentNodeId
        ? (threadRow?.metadata as ClaudeThreadMetadata | undefined)
            ?.claudeSessions?.[agentNodeId]
        : undefined;
      let resume: string | undefined;
      let replayPrefix = '';
      if (persistedSessionId) {
        if (
          await this.bootstrap.isSessionResumable(runtime, persistedSessionId)
        ) {
          resume = persistedSessionId;
        } else if (threadRow) {
          replayPrefix = await this.buildReplayPrefix(
            threadRow.id,
            agentNodeId,
          );
        }
      }

      const toucher = this.keepalive.createToucher({
        runtimeNodeId: runtimeProvider.getParams().runtimeNodeId,
        threadId: rootThreadId,
      });
      // Heartbeat alongside the per-chunk onActivity hook: while Claude Code
      // executes a long silent sandbox command, no SDK messages flow, and an
      // activity-only toucher would let the idle reaper kill the live session.
      keepaliveTimer = setInterval(toucher, KEEPALIVE_INTERVAL_MS);
      // Pricing ALWAYS resolves from the registered LiteLLM alias (config.model),
      // decoupled from the model id the SDK session talks to: they coincide for
      // the standard aliases, but pinning pricing to the registered alias means
      // an exotic/unregistered SDK id can never silently zero the per-message
      // rate fallback the cost-limit reads. In BYO there is no LiteLLM
      // `max_budget` backstop, so refuse to run when those rates resolve to 0 —
      // a turn lacking SDK `total_cost_usd` would otherwise price at 0 and slip
      // past the host-side cost-limit (a fail-open).
      const { calculatePriceUsd, hasNonZeroRates } =
        await this.buildPriceCalculator(config.model);
      if (isByo && !hasNonZeroRates) {
        throw new InternalException(
          'CLAUDE_BYO_UNPRICED_MODEL',
          `Pricing rates for "${config.model}" resolve to 0 — register the model in LiteLLM so BYO turns are cost-tracked. Refusing to run a BYO turn unpriced`,
        );
      }

      const mapper = new ClaudeStreamMapper({
        threadId,
        config: mergedConfig,
        model: config.model,
        calculatePriceUsd,
        emit: (event: AgentEventType) => {
          this.emit(event);
          if (
            event.type === 'stateUpdate' &&
            hasLimit &&
            !runEntry.stopped &&
            priorSpendUsd + mapper.getTotalPriceUsd() >= effectiveLimit
          ) {
            runEntry.stopped = true;
            runEntry.stopReason = 'cost_limit';
            runEntry.stopCostUsd = priorSpendUsd + mapper.getTotalPriceUsd();
            transport?.interrupt();
          }
        },
      });

      const toolDefinitions = buildBridgeToolDefinitions(
        Array.from(this.tools.values()) as BuiltAgentTool[],
      );
      // Resolve connected MCP blocks against THIS node's runtime; the bridge
      // merges them into the SDK `mcpServers` map next to the `geniro` server.
      const externalMcpServers = await this.resolveExternalMcpServers(runtime);
      const dispatcher = new ClaudeToolDispatcher({
        tools: this.tools,
        config: mergedConfig,
        mapper,
        logger: this.logger,
        signal: abortController.signal,
        // The transport is assigned below before `start` is sent; a tool call
        // can only arrive after the session started, so the closure is safe.
        send: (command) => transport?.send(command),
        // Mirrors ToolExecutorNode's pre-invocation cost check: forged or
        // late frames must not drive host-side tool work past the budget or
        // after a stop.
        shouldRefuse: () => {
          if (runEntry.stopped) {
            return 'The run was stopped';
          }
          if (
            hasLimit &&
            priorSpendUsd + mapper.getTotalPriceUsd() >=
              (effectiveLimit as number)
          ) {
            return `Cost limit reached ($${(effectiveLimit as number).toFixed(2)})`;
          }
          return null;
        },
      });

      const outcome = await new Promise<BridgeOutcome>((resolve, reject) => {
        ClaudeBridgeTransport.start({
          runtime,
          bridgePath,
          env,
          logger: this.logger,
          handlers: {
            onSdkMessage: (message) => mapper.onSdkMessage(message),
            onDone: (sessionId) => resolve({ kind: 'done', sessionId }),
            onAborted: (sessionId) => resolve({ kind: 'aborted', sessionId }),
            onFatal: (error) => resolve({ kind: 'fatal', error }),
            onActivity: toucher,
            onToolCallRequest: (request) => dispatcher.dispatch(request),
            // Both top-level AND subagent/peer questions route through here:
            // the question ends the turn (NeedMoreInfo) and the user's answer
            // resumes the same SDK session on the next run. There is no
            // in-session "parent answers while the query continues" branch — M3
            // confirmed that path needs a synchronous inter-agent ask-back
            // channel that does not exist (a subagent's parent is blocked
            // awaiting its result; caller_agent is .emit()-only; callees must
            // finish synchronously), a separate subsystem beyond this milestone.
            // Escalate-and-resume is the design for both modes until then.
            // Interrupting leaves the bridge's pending question unresolved on
            // purpose — failAll settles it once the session aborts.
            // Known cost residue (shared with the user-stop abort): an aborted
            // query emits no `result` frame, so the interrupted turn's LLM spend
            // never reaches the message rollup — the virtual-key budget remains
            // the hard backstop. A graceful query.interrupt() that drains a
            // final `result` would close the gap (future work).
            onQuestionRequest: (request) => {
              runEntry.pendingQuestion = request;
              transport?.interrupt();
            },
          },
        })
          .then((started) => {
            transport = started;
            if (abortController.signal.aborted) {
              // The thread was stopped while the bridge was still booting
              // (bootstrap can take minutes on first run): never launch the
              // billable session — close (sends shutdown) and settle as
              // aborted instead of sending `start`. runEntry.transport stays
              // unset on purpose: later appends must not write into a closed
              // transport's void.
              started.close();
              resolve({ kind: 'aborted' });
              return;
            }
            runEntry.transport = started;
            abortController.signal.addEventListener('abort', () =>
              started.interrupt(),
            );
            started.send({
              type: 'start',
              options: {
                prompt: replayPrefix + this.extractPromptText(messages),
                systemPrompt: config.instructions,
                model: sessionModel,
                ...(config.maxTurns !== undefined && {
                  maxTurns: config.maxTurns,
                }),
                ...(resume !== undefined && { resume }),
                cwd: runtime.getWorkdir(),
                ...(pluginPaths.length > 0 && { pluginPaths }),
                settingSources: ['project'],
                ...(toolDefinitions.length > 0 && { tools: toolDefinitions }),
                ...(Object.keys(externalMcpServers).length > 0 && {
                  externalMcpServers,
                }),
              },
            });
            for (const text of runEntry.pendingInjections.splice(0)) {
              started.send({ type: 'user_message', text });
            }
          })
          .catch(reject);
      });

      transport?.close();
      // Emit any assistant batch still in the lag-1 buffer (e.g. on abort).
      mapper.flush();

      const sessionId = mapper.sessionId ?? this.outcomeSessionId(outcome);
      if (sessionId && agentNodeId) {
        await this.persistSessionId(
          rootThreadId,
          threadRow?.id,
          agentNodeId,
          sessionId,
        );
      }
      if (mapper.sdkTotalCostUsd !== undefined) {
        this.logger.debug(
          `Claude SDK reported total_cost_usd=${mapper.sdkTotalCostUsd}; LiteLLM-rate rollup=${mapper.getTotalPriceUsd()}`,
        );
      }

      const output: AgentOutput = {
        messages: mapper.getMessages(),
        threadId,
        needsMoreInfo: false,
        statistics: { usage: mapper.getTotalUsage() },
      };

      if (outcome.kind === 'fatal') {
        // A bridge/stream death must not leave a silently error-stopped thread:
        // surface the reason as a visible message before the throw error-marks
        // the thread via the catch's run-error event (which resolves to Stopped
        // status — ThreadStatus has no Failed — but carries the error + message
        // that distinguish it from a clean user stop). EXCEPTION: a run that was
        // already stopped/redeployed had its terminal event + failure message
        // emitted by stopThread / failActiveRunsForRedeploy, and the abort they
        // issue can itself sever the stream and surface as 'fatal'. Re-emitting
        // would duplicate the message (redeploy) or overwrite the user's clean
        // Stopped with an error-marked one (stop) — so skip the emit, but still
        // propagate.
        if (!runEntry.stopped) {
          this.emitSessionFailureMessage(runEntry, mergedConfig, outcome.error);
        }
        throw new InternalException(
          'CLAUDE_BRIDGE_FAILED',
          sanitizeSandboxError(outcome.error),
        );
      }

      if (runEntry.stopReason === 'cost_limit') {
        return this.finishCostLimited(
          runEntry,
          output.messages,
          effectiveLimit as number,
          runEntry.stopCostUsd ?? priorSpendUsd + mapper.getTotalPriceUsd(),
          output.statistics,
        );
      }

      if (runEntry.pendingQuestion && !runEntry.stopped) {
        return this.finishNeedsMoreInfo(
          runEntry,
          runEntry.pendingQuestion,
          output,
          mergedConfig,
        );
      }

      if (outcome.kind === 'aborted' || runEntry.stopped) {
        // User-initiated stop: stopThread already emitted the hidden system
        // message + 'stop' event; emitting 'run' here would overwrite the
        // thread's Stopped status. `runEntry.stopped` also covers the race
        // where the stop lands so close to the natural end that the bridge
        // still reports 'done'.
        return output;
      }

      if (mapper.isError) {
        // Surface the failure as a visible thread message so an error-subtype
        // session end explains itself instead of a bare error-Stopped status.
        const subtype = sanitizeSandboxError(
          mapper.resultSubtype ?? 'an unknown error',
        );
        const failureMsgs = this.emitSessionFailureMessage(
          runEntry,
          mergedConfig,
          subtype,
        );
        const erroredMessages = [...output.messages, ...failureMsgs];
        this.emit({
          type: 'run',
          data: {
            threadId,
            messages: erroredMessages,
            config: mergedConfig,
            error: new InternalException(
              'CLAUDE_SESSION_ERROR',
              `Claude session ended with ${subtype}`,
            ),
          },
        });
        return { ...output, messages: erroredMessages };
      }

      this.emit({
        type: 'run',
        data: {
          threadId,
          messages: output.messages,
          config: mergedConfig,
          result: output,
        },
      });
      return output;
    } catch (error) {
      transport?.close();
      // A stopped/redeployed run already emitted its terminal 'run' event (and
      // failure message) via stopThread / failActiveRunsForRedeploy; emitting
      // here would duplicate it — and for a user stop, replace the clean Stopped
      // with an error-marked one. Still propagate the error to the caller.
      if (!runEntry.stopped) {
        this.emit({
          type: 'run',
          data: { threadId, messages: [], config: mergedConfig, error },
        });
      }
      throw error;
    } finally {
      // Stops the dispatcher from draining queued tool frames after the
      // session settled (in-flight invokes see the same signal). Interrupt
      // listeners hit an already-closed transport — a silent no-op.
      abortController.abort();
      if (runEntry.pendingInjections.length > 0) {
        this.logger.warn(
          `${runEntry.pendingInjections.length} mid-run append(s) never reached the Claude session for thread ${threadId} — the messages are persisted on the thread but the model did not see them this turn`,
        );
      }
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
      }
      if (virtualKey) {
        await this.virtualKeys.revokeThreadKey(virtualKey);
      }
      this.activeRuns.delete(threadId);
    }
  }

  public async runOrAppend(
    threadId: string,
    messages: BaseMessage[],
    _config?: ClaudeAgentSchemaType,
    runnableConfig?: RunnableConfig<BaseAgentConfigurable>,
  ): Promise<AgentOutput> {
    const activeRun = this.activeRuns.get(threadId);
    if (!activeRun) {
      return await this.run(threadId, messages, _config, runnableConfig);
    }

    // Mid-run append: persist/stream the Human messages immediately (the
    // bridge never re-echoes injected text as a persistable frame), then
    // inject into the live session over the SDK streaming-input channel.
    // Appends racing the bootstrap are buffered and flushed after `start`.
    const stamped = updateMessagesListWithMetadata(
      messages,
      activeRun.runnableConfig,
    );
    if (stamped.length > 0) {
      this.emit({
        type: 'message',
        data: {
          threadId: activeRun.threadId,
          messages: stamped,
          config: activeRun.runnableConfig,
        },
      });
      const text = this.extractPromptText(messages);
      if (text) {
        if (activeRun.transport && !activeRun.transport.isFinished()) {
          activeRun.transport.send({ type: 'user_message', text });
        } else {
          // No live session (still booting, or already settled while the run
          // entry lingers in its finally) — buffer instead of writing into a
          // closed transport's void; run() flushes on start or warn-logs the
          // strand, so a dropped append is never silent.
          activeRun.pendingInjections.push(text);
        }
      }
    }

    // Empty messages on purpose: the append has no callee response yet, and
    // a relay reading the last message must not mistake the caller's own
    // text for the agent's answer (the live run's output is the response).
    return {
      messages: [],
      threadId: activeRun.threadId,
      needsMoreInfo: false,
    };
  }

  public async stopThread(threadId: string, reason?: string): Promise<boolean> {
    const activeRun = this.findActiveRun(threadId);
    if (!activeRun) {
      return false;
    }

    activeRun.stopped = true;
    activeRun.stopReason = reason ?? 'stopped';

    const cfg = activeRun.runnableConfig.configurable;
    if (cfg?.graph_id) {
      const stopMessage = markMessageHideForLlm(
        new SystemMessage(reason ?? 'Graph execution was stopped'),
      );
      const msgs = updateMessagesListWithMetadata(
        [stopMessage],
        activeRun.runnableConfig,
      );
      this.emit({
        type: 'message',
        data: {
          threadId: activeRun.threadId,
          messages: msgs,
          config: activeRun.runnableConfig,
        },
      });
      this.emit({
        type: 'stop',
        data: {
          config: activeRun.runnableConfig,
          threadId: activeRun.threadId,
          stopReason: null,
          stopCostUsd: null,
        },
      });
    }

    activeRun.abortController.abort();
    return true;
  }

  /**
   * Abort every live run because the graph node is being reconfigured or
   * destroyed under it (a revision deploy or teardown). A live SDK session
   * cannot keep streaming against a swapped-out instance, so each run is failed
   * VISIBLY: a user-facing message, a Failed run event, an interrupt of the
   * bridge, and an immediate virtual-key revoke (idempotent with the run's own
   * `finally`). No-op when there are no live runs — e.g. the initial
   * `configure()` right after `provide()`, where the loop body never executes.
   */
  public async failActiveRunsForRedeploy(reason: string): Promise<void> {
    for (const runEntry of Array.from(this.activeRuns.values())) {
      if (runEntry.stopped) {
        continue;
      }
      runEntry.stopped = true;
      runEntry.stopReason = 'redeploy';

      const config = runEntry.runnableConfig;
      const failureMsgs = this.emitSessionFailureMessage(
        runEntry,
        config,
        reason,
      );
      // An error-carrying run event (not a 'stop'): a revision deploy
      // interrupting a live run leaves the thread error-stopped (Stopped status
      // with an error event + failure message), distinct from a clean
      // user-Stopped. run()'s settle path stays silent for stopped runs, so this
      // is the only terminal event.
      this.emit({
        type: 'run',
        data: {
          threadId: runEntry.threadId,
          messages: failureMsgs,
          config,
          error: new InternalException(
            'CLAUDE_REDEPLOY_INTERRUPTED',
            `Claude Agent run interrupted — ${reason}`,
          ),
        },
      });

      runEntry.transport?.interrupt();
      if (runEntry.virtualKey) {
        // Revoke now rather than waiting for the run's finally to unwind via
        // the abort cascade — the key must stop billing the moment the live
        // session is abandoned. Idempotent, so the finally double-revoke is safe.
        await this.virtualKeys.revokeThreadKey(runEntry.virtualKey);
      }
      runEntry.abortController.abort();
    }
  }

  /**
   * Graph-destroy hook (template destroy handler). Fails every active run
   * visibly (revision recreate / node teardown), then drops the run registry.
   */
  public async stop(): Promise<void> {
    await this.failActiveRunsForRedeploy(
      'the graph node was redeployed or torn down',
    );
    this.activeRuns.clear();
    this.currentConfig = undefined;
  }

  public override getGraphNodeMetadata(): Record<string, unknown> | undefined {
    if (!this.currentConfig) {
      return undefined;
    }
    return { invokeModelName: this.currentConfig.model };
  }

  /**
   * Surface a bridge/stream failure as a user-visible (LLM-hidden) thread
   * message so a failed Claude session explains itself in the conversation
   * rather than a silently error-Stopped thread. Carries no token usage, so it
   * does not perturb the cost rollup. Returns the persisted messages so the
   * caller can fold them into its AgentOutput.
   *
   * `reason` is sandbox-derived (a `fatal` frame's error string), so it is
   * routed through `sanitizeSandboxError` before persistence — a clone/LLM
   * error can legitimately embed a PAT or the per-thread virtual key, which
   * must never land in the durable conversation (sandbox trust boundary).
   */
  private emitSessionFailureMessage(
    runEntry: ClaudeActiveRun,
    config: RunnableConfig<BaseAgentConfigurable>,
    reason: string,
  ): BaseMessage[] {
    const notice = markMessageHideForLlm(
      new SystemMessage(
        `Claude Agent session failed: ${sanitizeSandboxError(reason)}`,
      ),
    );
    const msgs = updateMessagesListWithMetadata([notice], config);
    this.emit({
      type: 'message',
      data: { threadId: runEntry.threadId, messages: msgs, config },
    });
    return msgs;
  }

  /**
   * Top-level AskUserQuestion turn-end: surface the question as a visible
   * thread message and finish with `needsMoreInfo`, which the agent-event
   * chain maps to ThreadStatus.NeedMoreInfo for root threads. The user's
   * answer resumes the SAME SDK session via the persisted session id (the
   * interrupted AskUserQuestion call is settled by Claude Code on resume).
   */
  private finishNeedsMoreInfo(
    runEntry: ClaudeActiveRun,
    question: ClaudeQuestionRequest,
    output: AgentOutput,
    config: RunnableConfig<BaseAgentConfigurable>,
  ): AgentOutput {
    const questionMessage = new AIMessage(
      formatQuestionsAsText(question.questions),
    );
    const msgs = updateMessagesListWithMetadata([questionMessage], config);
    this.emit({
      type: 'message',
      data: { threadId: runEntry.threadId, messages: msgs, config },
    });

    const result: AgentOutput = {
      messages: [...output.messages, ...msgs],
      threadId: runEntry.threadId,
      needsMoreInfo: true,
      ...(output.statistics && { statistics: output.statistics }),
    };
    this.emit({
      type: 'run',
      data: {
        threadId: runEntry.threadId,
        messages: result.messages,
        config,
        result,
      },
    });
    return result;
  }

  private finishCostLimited(
    runEntry: ClaudeActiveRun,
    messages: BaseMessage[],
    effectiveLimitUsd: number,
    totalSpendUsd: number,
    statistics?: AgentOutput['statistics'],
  ): AgentOutput {
    // Same user-facing copy as SimpleAgent's cost-limit stop — the wording
    // must not depend on which agent kind hit the limit.
    const notice = markMessageHideForLlm(
      new SystemMessage(
        `Cost limit reached ($${effectiveLimitUsd.toFixed(2)})`,
      ),
    );
    const msgs = updateMessagesListWithMetadata(
      [notice],
      runEntry.runnableConfig,
    );
    this.emit({
      type: 'message',
      data: {
        threadId: runEntry.threadId,
        messages: msgs,
        config: runEntry.runnableConfig,
      },
    });
    this.emit({
      type: 'stop',
      data: {
        config: runEntry.runnableConfig,
        threadId: runEntry.threadId,
        stopReason: 'cost_limit',
        stopCostUsd: totalSpendUsd,
      },
    });

    // A cost-limited callee SPENT real money this run — the relay's parent
    // fold must still see it, or the parent's pre-invocation gate weakens.
    return {
      messages,
      threadId: runEntry.threadId,
      needsMoreInfo: false,
      ...(statistics && { statistics }),
    };
  }

  /**
   * Cross-turn cost seed: the pre-invocation gate compares
   * `priorSpendUsd + this run's getTotalPriceUsd()` against the limit, so the
   * seed must carry every prior turn's spend on this thread — BOTH LLM
   * (`request_token_usage`) and forwarded-tool (`tool_token_usage`) spend.
   *
   * `communication_exec` is now forwardable (a Claude agent can call its peers),
   * and its peer spend is recorded as `tool_token_usage` on the caller's tool
   * result message. `aggregateUsageByNodeId` sums only `request_token_usage`, so
   * we add `aggregateToolUsageTotalPrice` to fold the prior-turn tool spend in.
   * This does NOT double-count the `${parent}::sub::${toolCallId}` subagent
   * surrogates cost-accounting.md describes: a Claude thread never carries the
   * LangGraph subagent-as-tool fold (the SDK's native subagents persist only as
   * surrogate `request_token_usage`, never as a parent `tool_token_usage`), so
   * the two columns are disjoint and summing both counts each cost exactly once.
   */
  private async aggregatePriorSpendUsd(
    internalThreadId: string,
  ): Promise<number> {
    // Both aggregates are Postgres numerics coerced via Number(...), whose typed
    // `number` return includes NaN. An unguarded `total += NaN` poisons the whole
    // seed (1.0 + NaN = NaN) and the gate's `NaN >= limit` is false — a fail-OPEN
    // that bills past an already-exhausted budget. Coerce every term through
    // toFinite so a non-finite aggregate contributes 0 and the gate still trips on
    // the known spend (cost-accounting.md "coerce unknown pricing to 0" + the
    // Number.isFinite numeric-aggregation guard).
    const toFinite = (n: number | null | undefined): number =>
      typeof n === 'number' && Number.isFinite(n) ? n : 0;
    const byNode =
      await this.messagesDao.aggregateUsageByNodeId(internalThreadId);
    let total = 0;
    for (const usage of byNode.values()) {
      total += toFinite(usage.totalPrice);
    }
    total += toFinite(
      await this.messagesDao.aggregateToolUsageTotalPrice(internalThreadId),
    );
    return total;
  }

  /**
   * Resolve the graph author's own Anthropic API key for a BYO-mode run. Fails
   * CLOSED on every gap — no project scope, no secret selected, secrets store
   * unavailable, secret missing, or a value that is not an `sk-ant-` API key
   * (which also rejects subscription/OAuth tokens). There is deliberately NO
   * fallback to the system upstream key: a misconfigured BYO node refuses to run
   * rather than silently billing the platform account. The resolved value is a
   * secret and is NEVER logged — only the secret NAME appears in errors
   * (sandbox-boundary.md); any sink that could echo it is already routed through
   * `sanitizeSandboxError` (which masks `sk-***`).
   */
  private async resolveByoApiKey(
    configurable: BaseAgentConfigurable,
    secretRef?: string,
  ): Promise<string> {
    const projectId = configurable.graph_project_id;
    if (!projectId) {
      throw new InternalException(
        'CLAUDE_BYO_NO_PROJECT',
        'Claude Agent BYO mode requires a project-scoped run, but no project id was resolved for this thread',
      );
    }
    if (!secretRef) {
      throw new InternalException(
        'CLAUDE_BYO_NO_SECRET_REF',
        'Claude Agent BYO mode is enabled but no API-key secret is selected (set apiKeySecretRef)',
      );
    }
    if (!this.secretsStore.isAvailable()) {
      throw new InternalException(
        'CLAUDE_BYO_STORE_UNAVAILABLE',
        'Claude Agent BYO mode needs the secrets store (OpenBao) configured to resolve the API key',
      );
    }
    // Trim first: secrets-store values commonly carry surrounding whitespace or
    // a trailing newline (copy-paste / echo-piped), and ANTHROPIC_API_KEY
    // becomes an HTTP header value where a stray newline is rejected by
    // Anthropic — inject the clean value, never the raw one.
    const key = (
      await this.secretsService.resolveSecretValue(projectId, secretRef)
    ).trim();
    // Console API keys are `sk-ant-api…`; Claude subscription OAuth tokens are
    // `sk-ant-oat…` — BOTH carry the `sk-ant-` prefix, so a bare prefix check
    // would NOT block OAuth tokens (the spec's explicit goal: they are
    // ToS-prohibited for third-party tools and are rejected as an x-api-key by
    // Anthropic anyway). Require the `sk-ant-` prefix, a NON-EMPTY body after it
    // (a degenerate prefix-only value carries no credential and would only 401
    // opaquely on first call), NO embedded whitespace (real keys have none; an
    // embedded space/newline is header-unsafe — `.trim()` above only strips the
    // ends), and reject the OAuth subprefix case-insensitively — all refused up
    // front, not at first call.
    if (
      !key.startsWith('sk-ant-') ||
      key.length <= 'sk-ant-'.length ||
      /\s/.test(key) ||
      key.toLowerCase().startsWith('sk-ant-oat')
    ) {
      throw new InternalException(
        'CLAUDE_BYO_INVALID_KEY',
        `Secret "${secretRef}" is not a valid Anthropic Console API key (expected a non-empty sk-ant-api… key); subscription/OAuth tokens are not supported`,
      );
    }
    return key;
  }

  /**
   * Resolve each connected MCP block into an SDK `mcpServers` entry, against
   * THIS node's runtime. The blocks' own `getMcpConfig` reads the runtime from
   * internal state (e.g. the filesystem block derives its workdir from it), so
   * `resolveServerConfigForRuntime` re-points each block at the Claude runtime
   * before producing the config. M1 reuses only stdio blocks (custom/filesystem
   * run `npx`; playwright/jira run `docker` and need the daemon, handled inside
   * `resolveServerConfigForRuntime`), so every entry is stamped `type: 'stdio'`.
   *
   * External MCP is additive: a single misconfigured block must NOT abort the
   * run, so a failed resolution is logged (sandbox-redacted) and skipped. Server
   * keys are de-duplicated — two `custom` blocks both name themselves
   * `custom-mcp`, and the SDK map keys become the `mcp__<key>__<tool>`
   * namespace, so a collision would otherwise drop one block's tools.
   */
  private async resolveExternalMcpServers(
    runtime: BaseRuntime,
  ): Promise<Record<string, SerializableMcpConfig>> {
    const provider = this.runtimeProvider;
    if (!provider || this.externalMcpNodes.length === 0) {
      return {};
    }

    const resolved: Record<string, SerializableMcpConfig> = {};
    for (const node of this.externalMcpNodes) {
      try {
        const raw = await node.instance.resolveServerConfigForRuntime(
          node.config,
          provider,
          runtime,
        );
        const command = raw.command.trim();
        if (!command) {
          throw new Error('resolved MCP command is empty');
        }
        const key = this.uniqueMcpServerKey(raw.name, resolved);
        resolved[key] = {
          type: 'stdio',
          command,
          args: raw.args,
          ...(raw.env && Object.keys(raw.env).length > 0 && { env: raw.env }),
        };
      } catch (error) {
        this.logger.warn(
          `Skipping MCP server for node ${node.nodeId}: ${sanitizeSandboxError(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
      }
    }
    return resolved;
  }

  private uniqueMcpServerKey(
    name: string,
    existing: Record<string, SerializableMcpConfig>,
  ): string {
    // `GENIRO_MCP_SERVER_KEY` is reserved: the bridge registers its in-process
    // Geniro tool server under it and spreads external servers AFTER, so an
    // external block resolving to that name must be suffixed rather than left
    // to clobber the Geniro tools.
    if (name !== GENIRO_MCP_SERVER_KEY && !(name in existing)) {
      return name;
    }
    let suffix = 2;
    while (`${name}-${suffix}` in existing) {
      suffix += 1;
    }
    return `${name}-${suffix}`;
  }

  /**
   * Loads LiteLLM rates for the node's PRIMARY model once and prices every
   * message with them, ignoring the per-message `model` argument: through the
   * passthrough, per-message usage is all zeros, so effectively only the
   * result residual is priced — at the primary model's rates. M2 may load
   * per-model rates if mixed-model turns need exact attribution.
   */
  private async buildPriceCalculator(model: string): Promise<{
    calculatePriceUsd: (usage: RequestTokenUsage, model: string) => number;
    /**
     * True when LiteLLM returned at least one non-zero rate for `model`. BYO
     * runs fail closed when this is false: the LiteLLM `max_budget` backstop is
     * absent there, so a turn lacking SDK `total_cost_usd` would price at 0 and
     * slip past the host-side cost-limit.
     */
    hasNonZeroRates: boolean;
  }> {
    let inputRate = 0;
    let outputRate = 0;
    let cacheReadRate = 0;
    try {
      const info = await this.liteLlmClient.getModelInfo(model);
      inputRate = info?.model_info?.input_cost_per_token ?? 0;
      outputRate = info?.model_info?.output_cost_per_token ?? 0;
      cacheReadRate =
        info?.model_info?.cache_read_input_token_cost ??
        info?.model_info?.input_cost_per_token_cache_hit ??
        inputRate;
    } catch (error) {
      this.logger.warn(
        `Failed to load LiteLLM rates for ${model} — per-message prices fall back to 0 (register the model in LiteLLM): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const calculatePriceUsd = (usage: RequestTokenUsage): number => {
      const cached = usage.cachedInputTokens ?? 0;
      const uncached = Math.max(usage.inputTokens - cached, 0);
      return (
        uncached * inputRate +
        cached * cacheReadRate +
        usage.outputTokens * outputRate
      );
    };
    return {
      calculatePriceUsd,
      hasNonZeroRates: inputRate > 0 || outputRate > 0,
    };
  }

  private async buildReplayPrefix(
    internalThreadId: string,
    agentNodeId: string,
  ): Promise<string> {
    // Exact node-id match: replay only THIS agent's exchange — other agents'
    // rows (and `::sub::` surrogates) on a shared root thread are not part of
    // this node's conversation.
    const rows = await this.messagesDao.getAll(
      {
        threadId: internalThreadId,
        nodeId: agentNodeId,
        role: { $in: [MessageRole.Human, MessageRole.AI] },
      },
      { orderBy: { createdAt: 'ASC' } },
    );

    const lines: string[] = [];
    for (const row of rows) {
      const content = (row.message as { content?: unknown }).content;
      if (typeof content !== 'string' || !content.trim()) {
        continue;
      }
      lines.push(
        `${row.role === MessageRole.Human ? 'User' : 'Assistant'}: ${content}`,
      );
    }
    if (lines.length === 0) {
      return '';
    }

    let transcript = lines.join('\n\n');
    if (transcript.length > REPLAY_PREFIX_MAX_CHARS) {
      transcript = transcript.slice(
        transcript.length - REPLAY_PREFIX_MAX_CHARS,
      );
    }
    return `<conversation-history>\nThe sandbox restarted; this is the prior conversation of this thread:\n\n${transcript}\n</conversation-history>\n\n`;
  }

  private extractPromptText(messages: BaseMessage[]): string {
    return messages
      .map((message) => extractTextFromResponseContent(message.content))
      .filter((text): text is string => Boolean(text))
      .join('\n\n');
  }

  private outcomeSessionId(outcome: BridgeOutcome): string | undefined {
    return outcome.kind === 'fatal' ? undefined : outcome.sessionId;
  }

  private async persistSessionId(
    rootThreadId: string,
    loadedThreadRowId: string | undefined,
    agentNodeId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      // Reuse the row id loaded at the top of run() when it was already present
      // (avoids a redundant query). On a fresh thread's first turn the invoke
      // handler creates the row asynchronously, so it can still be absent at run
      // start — re-query here (post-session), by which point the handler has
      // committed it. Binding persistence to the start-of-run snapshot would
      // drop the SDK session id and force a full-history replay on the next turn.
      const threadRowId =
        loadedThreadRowId ??
        (await this.threadsDao.getOne({ externalThreadId: rootThreadId }))?.id;
      if (!threadRowId) {
        this.logger.debug(
          `Thread row for ${rootThreadId} not found — skipping Claude session persistence`,
        );
        return;
      }
      await this.threadsDao.mergeMetadataKey(threadRowId, 'claudeSessions', {
        [agentNodeId]: sessionId,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to persist Claude session id for thread ${rootThreadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Stop requests arrive with the external thread id, while subagent/peer
   * invocations key runs by derived ids prefixed with the parent thread id —
   * match both, mirroring SimpleAgent's parent_thread_id stop semantics.
   */
  private findActiveRun(threadId: string): ClaudeActiveRun | undefined {
    const direct = this.activeRuns.get(threadId);
    if (direct) {
      return direct;
    }
    for (const run of this.activeRuns.values()) {
      const parentThreadId = run.runnableConfig.configurable
        ?.parent_thread_id as string | undefined;
      if (parentThreadId === threadId) {
        return run;
      }
    }
    return undefined;
  }
}
