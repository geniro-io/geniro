# Cost Accounting & Numeric Aggregation

Rules for any code that tracks, aggregates, or displays LLM usage costs, token counts, durations, or other measurements.

## Isolated-leaf agent model

- Every agent computes ONLY its own cost. An agent's own cost INCLUDES calls it makes to subagents and communication tools — from the parent's point of view, a subagent is just another tool.
- Subagent accumulators start at `0` on every invocation. Do NOT seed a subagent's `totalPrice` from the parent's state. Do NOT subtract a parent seed from the subagent's reported own-spend.
- The parent's `ToolExecutorNode` spreads the returned `statistics.usage` (including `totalPrice`) into parent state via the standard reducer. That's how the parent's `totalPrice` naturally accumulates subagent costs.
- Cost-limit enforcement is the parent's responsibility. The parent's tool-executor checks `(state.totalPrice + threadUsage.totalPrice >= effectiveLimit)` before invoking the next tool. Subagents run unbounded once invoked; the worst-case overshoot is one subagent's total cost.
- Cost-limit checks that fire AFTER an LLM call has completed (LiteLLM has billed) MUST persist the in-flight AIMessage before throwing. The cost is already incurred — discarding the message only hides it from the per-thread rollup. Pattern: build `out`/`reasoningMessages` first, then check the limit; if the limit trips, attach the messages to `CostLimitExceededError.inFlightMessages` so the parent catch handler can emit them before the system stop message.
- The same principle generalizes beyond the cost-limit throw to ANY billed LLM call followed by a fallible side-effect — a vector upsert, a cache write, a second network call, or a best-effort block whose `catch` swallows the error. Capture the returned `usage`/`totalPrice` into a local the instant the LLM call resolves (BEFORE the side-effect can throw or short-circuit), and attribute it on EVERY exit path, including the swallowed-failure path. A `catch` that returns without the captured usage hides incurred spend exactly as a discarding throw does — the bill already happened. Exemplar: `AgentMemoryVectorService.embedEntry` captures `billedUsage` before the Qdrant upsert and returns it even when the upsert throws (`apps/api/src/v1/agent-memory/services/agent-memory-vector.service.ts`); test asserts the price survives an upsert failure (`agent-memory-vector.service.spec.ts`).

## Type shape

- `totalPrice` is `number | undefined` everywhere — DTO, WebSocket event, state, accumulator. Never `number | null`.
- At ingestion (`LitellmService.extractTokenUsageFromResponse`), coerce unknown pricing to `0`: `providerCost ?? calculatedPrice ?? 0`. Unpriced-model handling is operational (register the model via `litellm.yaml` alias + restart LiteLLM) — not a type-system problem.
- Do NOT introduce `hasPricedCall` / `hasUnpricedCalls` / `hasUnknownContributors` companion flags. They clutter the pipeline without adding signal; if a cost reads `$0.000`, that is either genuine `$0` spend (unlikely for a real call) OR an unregistered model — both are fixable at the LiteLLM YAML layer.
- A numeric aggregate that feeds a cost-gate or budget comparison (a `Σ` of DB-numeric / `Number(...)`-coerced prices — e.g. `ClaudeAgent.aggregatePriorSpendUsd`, key-budget math) MUST coerce every term through a `Number.isFinite` guard (`typeof n === 'number' && Number.isFinite(n) ? n : 0`) BEFORE summing. A single non-finite term poisons the whole accumulator (`1.0 + NaN = NaN`), and `NaN >= limit` is `false` — a silent fail-OPEN that bills past an exhausted budget. The ingestion-time "coerce unknown pricing to `0`" rule above does NOT cover this: a gate that re-aggregates persisted numerics can still produce `NaN` from a downstream `Number()` cast. Reuse the `toFinite` helper shape (`ThreadsService.getThreadUsageStatistics`). Tests MUST cover the non-finite-term case explicitly — a fixture with only finite values passes whether or not the guard is present.

## Dual-source aggregation — document the policy

- When two pipelines compute the same aggregate (checkpoint snapshot vs message-scan, WS aggregate vs REST snapshot, cache vs source-of-truth), the service MUST have a docstring-level policy specifying which source is authoritative FOR WHICH FIELDS IN WHICH STATE.
- The current policy in `ThreadsService.getThreadUsageStatistics`: message-scan is authoritative for all additive fields; checkpoint is authoritative only for `currentContext` (point-in-time, can't be reconstructed from messages).
- Removing a `Math.max` / `Math.min` / `value ?? fallback` reconciliation requires a replacement policy. The reconciliation may have been silently fixing the "authoritative source empty, secondary populated" case — removing it without a `primary ?? secondary` fallback regresses that cohort.
- Tests MUST cover the "authoritative source empty" case explicitly. Fixtures that only populate both sources pass regardless of the fallback being present.

## Cost-by-node invariant (writer + reader must move together)

- Per-node cost breakdown reaches consumers via two source paths:
  1. **Messages path**: `Σ messages.requestTokenUsage WHERE node_id = K` — owned by `AgentMessageNotificationHandler` on write.
  2. **Checkpoint path**: `checkpoint-state.service.getThreadTokenUsage().byNode[K]` — owned by `tool-executor-node`'s state-fold on read.
- These two paths MUST reconcile for every `K`: if a query returns different per-node numbers from messages vs checkpoint, that is a bug.
- Any change to how messages are attributed to a `node_id` (e.g. introducing per-subagent surrogate keys like `${parent}::sub::${toolCallId}`) MUST be accompanied by:
  1. A matching change to `getThreadTokenUsage.byNode` so the same surrogate keys appear there.
  2. An integration test asserting `Σ messages.requestTokenUsage WHERE node_id = K == byNode[K]` for every `K` in a representative thread (parent + ≥2 subagents that each issue ≥1 LLM call).
  3. A documented before/after breakpoint for legacy rows if no backfill is performed — analytics consumers need to know.
- Single-side changes are forbidden. They look right at the call site and create silent drift across cost surfaces.
- Per-LLM-call attribution lives in `additionalKwargs.__toolCallId` + `__subagentCommunication`. Any new aggregator that ignores those flags and groups solely by `node_id` will misattribute subagent calls to the parent until Bug 4 ships and the surrogate scheme above is introduced.

## Test matrix requirements

Every change to cost-aggregation or display flow MUST cover at minimum:

| Scenario | Backend test | Frontend test |
|---|---|---|
| All calls priced, running | ✓ | ✓ |
| All calls priced, done | ✓ | ✓ |
| Checkpoint empty, messages populated | ✓ | — (consequence visible) |
| Running→done transition with fresh REST fetch | — | ✓ |
| Thread-switch during running state | — | ✓ |

## Live subagent streaming (Change 2, 2026-04-24)

Parent threads receive `inFlightSubagentPrice: Record<toolCallId, USD>` via `agent.state.update` events during subagent streaming. Frontend folds the sum into `totalPrice` ONLY when `isRunning`; `!isRunning` → ignore (REST is authoritative). WS accumulates `requestTokenUsage` unconditionally on AI messages but MUST NOT accumulate `toolTokenUsage` when the parent tool is a subagent invocation (mirrors REST single-source policy at `apps/api/src/v1/threads/services/threads.service.ts` line ~744). Clear via sentinel-0 per-toolCallId emitted by `ToolExecutorNode` on the subagent `ToolMessage` arrival.

## Bridge-agent (non-LangGraph) cost pipeline — Claude Agent

- Through the LiteLLM Anthropic passthrough, per-assistant-message `usage` is ALL ZEROS — the real turn totals and `total_cost_usd` arrive only with the SDK `result` message. `ClaudeStreamMapper` holds a lag-1 message buffer and stamps the residual turn usage/price onto the last buffered PARENT assistant message BEFORE persistence (insert-only — post-hoc updates are impossible).
- Invariant: `Σ messages.requestTokenUsage == billed turn totals` for EVERY turn-end shape — success, error_max_turns, abort, bridge death, result-without-usage. Any new turn-end path or frame kind MUST flow through `reconcileTurnUsage` (or emit a synthetic usage-bearing assistant message, as the no-stampable-target path does); usage that lives only in stream state is silently lost from the per-thread rollup.
- INTERRUPT CARVE-OUT (AskUserQuestion + user-stop turn ends) — the ONE documented exception to the invariant above. An interrupt aborts the SDK query before any `result` frame is produced (`claude-agent.ts` `onQuestionRequest`; `bridge.ts` `interrupt` → `abortController.abort()`), so there is NO billed total to reconcile or synthesize host-side: per-message passthrough usage is all zeros and the only authoritative turn total lives in the never-emitted `result`. The in-flight LLM spend of an interrupted turn is therefore NOT captured in the message rollup, and `reconcileTurnUsage` is correctly never reached on this path. Do NOT "fix" this by emitting a synthetic usage-bearing message — there is no usage value to put in it. The per-thread virtual-key budget is the backstop (it caps total spend independently of message-level attribution); a graceful `query.interrupt()` that drains a final `result` before aborting is the M3 revisit that would close the gap.
- Never stamp a whole-turn residual onto a buffered SDK-subagent (`__subagentCommunication`) message — it would inflate the `::sub::` surrogate bucket and zero the parent. Synthesize a parent-node message instead.
- Checkpoint-less threads (no LangGraph state machine) read totals via the message-scan fallback in `checkpoint-state.service.getUsageFromMessages`; `null` means "no usage data anywhere", never "0 spend".
- Exemplar test: `apps/api/src/__tests__/integration/agents/claude-cost-invariant.int.ts` (writer→reader parity through the real persistence handler, parent + 2 subagents with distinct token counts).

## Storybook harness

Cost-display components SHOULD have a storybook fixture that replays a recorded sequence of thread messages with configurable delays, running through the same `ThreadMessagesView` + `useChatsUsageStats` path used in production. This is how intermittent "numbers jumping" bugs become visible in isolation.