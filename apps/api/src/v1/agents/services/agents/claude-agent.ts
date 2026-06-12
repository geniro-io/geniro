import { BaseMessage, SystemMessage } from '@langchain/core/messages';
import { RunnableConfig } from '@langchain/core/runnables';
import { Injectable, Scope } from '@nestjs/common';
import { DefaultLogger, InternalException } from '@packages/common';
import { v4 } from 'uuid';

import { MessageRole } from '../../../graphs/graphs.types';
import { RequestTokenUsage } from '../../../litellm/litellm.types';
import { LiteLlmClient } from '../../../litellm/services/litellm.client';
import { LitellmVirtualKeyService } from '../../../litellm/services/litellm-virtual-key.service';
import { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
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
import { ClaudeThreadMetadata } from '../claude/claude-session.types';
import {
  buildClaudeSessionEnv,
  SMALL_FAST_MODEL_ALIAS,
} from '../claude/claude-session.utils';
import { ClaudeStreamMapper } from '../claude/claude-stream-mapper';
import { AgentEventType, AgentOutput, BaseAgent } from './base-agent';

export type ClaudeAgentSchemaType = {
  name: string;
  description: string;
  instructions: string;
  model: string;
  maxTurns?: number;
  pluginRepoUrl?: string;
  pluginRepoRef?: string;
};

type ClaudeActiveRun = {
  abortController: AbortController;
  threadId: string;
  runnableConfig: RunnableConfig<BaseAgentConfigurable>;
  stopped?: boolean;
  stopReason?: string;
  stopCostUsd?: number;
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
 * Agent kind backed by Claude Code (Anthropic Agent SDK) running inside the
 * thread's sandbox runtime via a stdio bridge. Unlike SimpleAgent there is no
 * LangGraph state machine and no checkpointer — the SDK session inside the
 * sandbox owns the conversation loop; this class maps the bridge stream onto
 * the BaseAgent event contract (invoke strictly before message/stateUpdate).
 *
 * Cost policy (".claude/rules/cost-accounting.md" — checkpoint-less variant):
 * - per-message `__requestUsage.totalPrice` is computed from LiteLLM
 *   registered rates (the same rates LiteLLM bills by), so the message-scan
 *   rollup matches billing; the SDK's own `total_cost_usd` is logged for
 *   drift diagnostics only;
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
  private activeRuns = new Map<string, ClaudeActiveRun>();

  constructor(
    private readonly logger: DefaultLogger,
    private readonly bootstrap: ClaudeBootstrapService,
    private readonly keepalive: ClaudeKeepaliveService,
    private readonly virtualKeys: LitellmVirtualKeyService,
    private readonly liteLlmClient: LiteLlmClient,
    private readonly threadsDao: ThreadsDao,
    private readonly messagesDao: MessagesDao,
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
          ...(config.pluginRepoUrl !== undefined && {
            pluginRepoUrl: config.pluginRepoUrl,
          }),
          ...(config.pluginRepoRef !== undefined && {
            pluginRepoRef: config.pluginRepoRef,
          }),
        });

      const issued = await this.virtualKeys.issueThreadKey({
        threadId: rootThreadId,
        ...(hasLimit && {
          budgetUsd: Math.max(
            effectiveLimit - priorSpendUsd,
            MIN_VIRTUAL_KEY_BUDGET_USD,
          ),
        }),
        // Model-scope the key: it enters a sandbox running untrusted code, so
        // an exfiltrated key must not be able to bill arbitrary models.
        models: Array.from(new Set([config.model, SMALL_FAST_MODEL_ALIAS])),
        metadata: {
          graphId: configurable.graph_id,
          nodeId: configurable.node_id,
        },
      });
      virtualKey = issued.key;
      const env = buildClaudeSessionEnv(virtualKey);

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
      const calculatePriceUsd = await this.buildPriceCalculator(config.model);

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
          },
        })
          .then((started) => {
            transport = started;
            if (abortController.signal.aborted) {
              // The thread was stopped while the bridge was still booting
              // (bootstrap can take minutes on first run): never launch the
              // billable session — close (sends shutdown) and settle as
              // aborted instead of sending `start`.
              started.close();
              resolve({ kind: 'aborted' });
              return;
            }
            abortController.signal.addEventListener('abort', () =>
              started.interrupt(),
            );
            started.send({
              type: 'start',
              options: {
                prompt: replayPrefix + this.extractPromptText(messages),
                systemPrompt: config.instructions,
                model: config.model,
                ...(config.maxTurns !== undefined && {
                  maxTurns: config.maxTurns,
                }),
                ...(resume !== undefined && { resume }),
                cwd: runtime.getWorkdir(),
                ...(pluginPaths.length > 0 && { pluginPaths }),
                settingSources: ['project'],
              },
            });
          })
          .catch(reject);
      });

      transport?.close();
      // Emit any assistant batch still in the lag-1 buffer (e.g. on abort).
      mapper.flush();

      const sessionId = mapper.sessionId ?? this.outcomeSessionId(outcome);
      if (sessionId && agentNodeId) {
        await this.persistSessionId(rootThreadId, agentNodeId, sessionId);
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
      };

      if (outcome.kind === 'fatal') {
        throw new InternalException('CLAUDE_BRIDGE_FAILED', outcome.error);
      }

      if (runEntry.stopReason === 'cost_limit') {
        return this.finishCostLimited(
          runEntry,
          output.messages,
          effectiveLimit as number,
          runEntry.stopCostUsd ?? priorSpendUsd + mapper.getTotalPriceUsd(),
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
        this.emit({
          type: 'run',
          data: {
            threadId,
            messages: output.messages,
            config: mergedConfig,
            error: new InternalException(
              'CLAUDE_SESSION_ERROR',
              `Claude session ended with ${mapper.resultSubtype ?? 'an unknown error'}`,
            ),
          },
        });
        return output;
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
      this.emit({
        type: 'run',
        data: { threadId, messages: [], config: mergedConfig, error },
      });
      throw error;
    } finally {
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

    // Mid-run message injection over the SDK streaming-input channel ships in
    // milestone 2; until then a Running Claude thread rejects new input.
    throw new InternalException(
      'THREAD_ALREADY_RUNNING',
      'Thread is currently running',
    );
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
   * Graph-destroy hook (template destroy handler). Aborts every active run.
   */
  public async stop(): Promise<void> {
    for (const run of this.activeRuns.values()) {
      run.stopped = true;
      run.abortController.abort();
    }
    this.activeRuns.clear();
    this.currentConfig = undefined;
  }

  public override getGraphNodeMetadata(): Record<string, unknown> | undefined {
    if (!this.currentConfig) {
      return undefined;
    }
    return { invokeModelName: this.currentConfig.model };
  }

  private finishCostLimited(
    runEntry: ClaudeActiveRun,
    messages: BaseMessage[],
    effectiveLimitUsd: number,
    totalSpendUsd: number,
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

    return {
      messages,
      threadId: runEntry.threadId,
      needsMoreInfo: false,
    };
  }

  private async aggregatePriorSpendUsd(
    internalThreadId: string,
  ): Promise<number> {
    const byNode =
      await this.messagesDao.aggregateUsageByNodeId(internalThreadId);
    let total = 0;
    for (const usage of byNode.values()) {
      total += usage.totalPrice ?? 0;
    }
    return total;
  }

  /**
   * Loads LiteLLM rates for the node's PRIMARY model once and prices every
   * message with them, ignoring the per-message `model` argument: through the
   * passthrough, per-message usage is all zeros, so effectively only the
   * result residual is priced — at the primary model's rates. M2 may load
   * per-model rates if mixed-model turns need exact attribution.
   */
  private async buildPriceCalculator(
    model: string,
  ): Promise<(usage: RequestTokenUsage, model: string) => number> {
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

    return (usage: RequestTokenUsage) => {
      const cached = usage.cachedInputTokens ?? 0;
      const uncached = Math.max(usage.inputTokens - cached, 0);
      return (
        uncached * inputRate +
        cached * cacheReadRate +
        usage.outputTokens * outputRate
      );
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
    agentNodeId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      const threadRow = await this.threadsDao.getOne({
        externalThreadId: rootThreadId,
      });
      if (!threadRow) {
        this.logger.debug(
          `Thread row for ${rootThreadId} not found — skipping Claude session persistence`,
        );
        return;
      }
      await this.threadsDao.mergeMetadataKey(threadRow.id, 'claudeSessions', {
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
