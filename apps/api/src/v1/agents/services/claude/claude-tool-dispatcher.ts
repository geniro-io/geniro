import type { RunnableConfig } from '@langchain/core/runnables';
import type {
  DynamicStructuredTool,
  ToolRunnableConfig,
} from '@langchain/core/tools';
import type { BridgeCommand } from '@packages/claude-bridge';
import { DefaultLogger } from '@packages/common';

import type { ToolInvokeResult } from '../../../agent-tools/tools/base-tool';
import type { BaseAgentConfigurable } from '../../agents.types';
import { formatToolOutputForLlm } from '../../agents.utils';
import type { ClaudeToolCallRequest } from './claude-session.types';
import { isToolForwardableToClaude } from './claude-session.utils';
import type { ClaudeStreamMapper } from './claude-stream-mapper';

export type ClaudeToolDispatcherParams = {
  /** Wired forwardable tools, keyed by (unprefixed) tool name. */
  tools: Map<string, DynamicStructuredTool>;
  /** The run's merged runnable config — source of the synthesized configurable. */
  config: RunnableConfig<BaseAgentConfigurable>;
  mapper: ClaudeStreamMapper;
  logger: DefaultLogger;
  /** Aborting the run aborts in-flight AND queued tool executions through this signal. */
  signal: AbortSignal;
  send: (command: BridgeCommand) => void;
  /**
   * Pre-execution policy gate (cost limit, stop state). Returns the refusal
   * message, or null to proceed. Checked per dispatch — mirrors
   * ToolExecutorNode's pre-invocation cost check.
   */
  shouldRefuse?: () => string | null;
};

/** Mirrors ToolExecutorNode's output cap — results ride a JSON line over the exec stream. */
const MAX_RESULT_CHARS = 500_000;
/**
 * Backpressure bound on queued dispatches. Frames arrive from an untrusted
 * sandbox; without a cap a hostile writer could queue unbounded host work.
 */
const MAX_PENDING_DISPATCHES = 32;

/**
 * Host-side executor for `tool_call_request` frames: looks up the forwarded
 * Geniro tool, invokes it with a configurable synthesized from the run's
 * config (ToolExecutorNode parity — `toolMetadata` slot, `__toolCallId`,
 * abort signal), and answers the bridge with a `tool_call_response`.
 *
 * - Dispatch is serialized per session (the spec's frame-race mitigation):
 *   tools mutating shared sandbox state must not interleave.
 * - Tool failures are returned as error responses, never thrown — the model
 *   sees the error text as an MCP error result and can react to it.
 * - Defense-in-depth at the trust boundary: the exclusion policy is
 *   re-checked here (the template walk is the primary filter), the run's
 *   abort signal stops queued work, and `shouldRefuse` gates each execution
 *   on host policy (cost limit) — a forged frame cannot bypass any of these.
 * - `toolsMetadata` (a tool's `stateChange` slot) lives in memory for the
 *   duration of one run: ClaudeAgent is checkpoint-less, so unlike
 *   ToolExecutorNode there is no agent state to persist it across turns.
 * - A tool's own LLM usage (`toolRequestUsage`) is reported to the stream
 *   mapper, which stamps it as `__toolTokenUsage` on the matching synthesized
 *   ToolMessage and folds it into the thread totals (writer+reader parity per
 *   the cost-accounting rules).
 */
export class ClaudeToolDispatcher {
  private queue: Promise<void> = Promise.resolve();
  private pendingCount = 0;
  private readonly toolsMetadata: Record<string, unknown> = {};

  constructor(private readonly params: ClaudeToolDispatcherParams) {}

  dispatch(request: ClaudeToolCallRequest): void {
    if (this.pendingCount >= MAX_PENDING_DISPATCHES) {
      this.respond({
        type: 'tool_call_response',
        id: request.id,
        error: 'Tool dispatch queue is full — slow down and retry',
      });
      return;
    }
    this.pendingCount += 1;
    this.queue = this.queue
      .then(() => this.execute(request))
      // Backstop: execute() answers its own failures, but one escaped
      // rejection must never wedge every later dispatch in the session.
      .catch((error) => {
        // slice: id/toolName are sandbox-controlled bytes (frame fields) —
        // never echo them unbounded into Pino/Sentry per sandbox-boundary.md.
        this.params.logger.error(
          error as Error,
          `Tool dispatch chain error for '${request.toolName.slice(0, 200)}'`,
          {
            toolName: request.toolName.slice(0, 200),
            requestId: request.id.slice(0, 200),
          },
        );
      })
      .finally(() => {
        this.pendingCount -= 1;
      });
  }

  private async execute(request: ClaudeToolCallRequest): Promise<void> {
    // Drain the name-FIFO join for THIS dispatch up front — on EVERY path,
    // before the early returns below. The mapper enqueues a forwarded tool's
    // SDK `tool_use_id` at parse time; consuming it here keeps the FIFO balanced
    // 1:1 with the enqueue. Draining only on the happy path would leave a
    // refused/aborted call's id at the head of the queue, so the next same-name
    // delegation would inherit a dead call's id — the exact Communication-block
    // mis-grouping this id stamp fixes. It is stamped as the delegated agent's
    // `__toolCallId` (the key the UI groups Communication blocks by) and falls
    // back to the bridge `request.id` when nothing is pending. `request.id`
    // stays the `tool_call_response` correlation id — that pairing is unchanged.
    const toolCallId =
      this.params.mapper.resolveToolUseId(request.toolName) ?? request.id;

    if (this.params.signal.aborted) {
      this.respond({
        type: 'tool_call_response',
        id: request.id,
        error: 'The run was stopped',
      });
      return;
    }

    const refusal = this.params.shouldRefuse?.() ?? null;
    if (refusal !== null) {
      this.respond({
        type: 'tool_call_response',
        id: request.id,
        error: refusal,
      });
      return;
    }

    if (!isToolForwardableToClaude(request.toolName)) {
      this.respond({
        type: 'tool_call_response',
        id: request.id,
        error: `Tool '${request.toolName}' cannot be invoked from a Claude session`,
      });
      return;
    }

    const tool = this.params.tools.get(request.toolName);
    if (!tool) {
      this.respond({
        type: 'tool_call_response',
        id: request.id,
        error: `Tool '${request.toolName}' is not available`,
      });
      return;
    }

    try {
      const toolMetadata = this.toolsMetadata[request.toolName];
      const runnableConfig: ToolRunnableConfig<BaseAgentConfigurable> = {
        configurable: {
          ...(this.params.config.configurable ?? {}),
          ...(toolMetadata !== undefined && { toolMetadata }),
          __toolCallId: toolCallId,
        },
        signal: this.params.signal,
      };

      const rawResult = (await tool.invoke<
        unknown,
        ToolRunnableConfig<BaseAgentConfigurable>
      >(request.args, runnableConfig)) as unknown;
      const result = rawResult as ToolInvokeResult<unknown>;

      if (result.toolRequestUsage) {
        this.params.mapper.recordToolUsage(
          request.toolName,
          result.toolRequestUsage,
        );
      }
      if (result.stateChange !== undefined) {
        this.toolsMetadata[result.stateChangeKey ?? request.toolName] =
          result.stateChange;
      }

      const content = formatToolOutputForLlm(result.output, MAX_RESULT_CHARS);
      const text =
        content.length > MAX_RESULT_CHARS
          ? `${content.slice(0, MAX_RESULT_CHARS)}\n\n[output trimmed to ${MAX_RESULT_CHARS} characters from ${content.length}]`
          : content;

      this.respond({
        type: 'tool_call_response',
        id: request.id,
        result: text,
      });
    } catch (error) {
      const err = error as Error;
      if (err.name !== 'AbortError') {
        this.params.logger.error(
          err,
          `Error executing proxied tool '${request.toolName.slice(0, 200)}'`,
          {
            toolName: request.toolName.slice(0, 200),
            requestId: request.id.slice(0, 200),
          },
        );
      }
      this.respond({
        type: 'tool_call_response',
        id: request.id,
        error: `Error executing tool '${request.toolName}': ${err.message || String(err)}`,
      });
    }
  }

  /** All responses route here — a throwing transport must not poison the queue. */
  private respond(command: BridgeCommand): void {
    try {
      this.params.send(command);
    } catch (error) {
      this.params.logger.error(
        error as Error,
        'Failed to deliver tool_call_response to the bridge',
      );
    }
  }
}
