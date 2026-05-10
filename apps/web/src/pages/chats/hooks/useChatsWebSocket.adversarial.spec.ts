// @vitest-environment jsdom
/**
 * Adversarial edge-case tests for useChatsWebSocket and related helpers.
 *
 * These tests are authored to FAIL on current code and prove concrete bugs.
 * Run: cd apps/web && pnpm test:unit src/pages/chats/hooks/useChatsWebSocket.adversarial.spec.ts
 */
import { act, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Capture useWebSocketEvent handlers so the test can drive them directly ────

type Handler = (payload: unknown) => void;
const wsHandlers = new Map<string, Handler>();

vi.mock('../../../hooks/useWebSocket', () => ({
  useWebSocketEvent: (eventType: string, handler: Handler) => {
    wsHandlers.set(eventType, handler);
  },
}));

vi.mock('../../../api', () => ({
  threadsApi: {
    getThreadByExternalId: vi.fn(),
    getThreadById: vi.fn(),
  },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import type { ThreadTokenUsageSnapshot } from '../types';
import { useChatsWebSocket } from './useChatsWebSocket';

// ── Constants ─────────────────────────────────────────────────────────────────

const THREAD_ID = 'thread-1';
const NODE_ID = 'node-1';
const GRAPH_ID = 'graph-1';

type UsageMap = Record<string, Record<string, ThreadTokenUsageSnapshot>>;

// ── Shared harness ────────────────────────────────────────────────────────────

const useHarness = () => {
  const [threadTokenUsageByNode, setThreadTokenUsageByNode] =
    useState<UsageMap>({});
  const threadsRef = useRef<never[]>([]);
  const pendingThreadSelectionRef = useRef<string | null>(null);

  useChatsWebSocket({
    graphFilterId: undefined,
    selectedThreadId: THREAD_ID,
    draftThread: null,
    threadsRef: threadsRef as never,
    pendingThreadSelectionRef,
    setThreads: vi.fn(),
    setSelectedThreadId: vi.fn(),
    setSelectedThreadShadow: vi.fn(),
    setDraftThread: vi.fn(),
    setExternalThreadIds: vi.fn(),
    setMessageMeta: vi.fn(),
    setThreadTokenUsageByNode,
    messages: {},
    pendingMessages: {},
    updateMessages: vi.fn(),
    updatePendingMessages: vi.fn(),
    externalThreadIds: {},
    sortThreadsByTimestampDesc: (list) => list,
    getThreadTimestamp: () => 0,
    ensureGraphsLoaded: async () => {},
    graphCache: {},
    setGraphCache: vi.fn(),
    invalidateThreadUsageStats: vi.fn(),
  });

  return { threadTokenUsageByNode, setThreadTokenUsageByNode };
};

// ── Shared helpers ────────────────────────────────────────────────────────────

const dispatch = (type: string, payload: unknown) => {
  const fn = wsHandlers.get(type);
  if (!fn) {
    throw new Error(`No handler captured for ${type}`);
  }
  fn(payload);
};

const flushAgentMessageBatch = async () => {
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
};

// Build a tool message notification with role:'tool'
const toolMessage = (
  toolPrice: number,
  toolName: string,
  extraKwargs: Record<string, unknown> = {},
  msgId = `tool-msg-${Math.random()}`,
) => ({
  type: 'agent.message',
  internalThreadId: THREAD_ID,
  threadId: THREAD_ID,
  graphId: GRAPH_ID,
  nodeId: NODE_ID,
  data: {
    id: msgId,
    threadId: THREAD_ID,
    externalThreadId: THREAD_ID,
    createdAt: new Date().toISOString(),
    nodeId: NODE_ID,
    message: {
      role: 'tool',
      content: 'tool result',
      name: toolName,
      additionalKwargs:
        Object.keys(extraKwargs).length > 0 ? extraKwargs : undefined,
    },
    toolTokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalPrice: toolPrice,
    },
  },
});

// Build an AI message notification
const aiMessage = (totalPrice: number, msgId = `msg-${Math.random()}`) => ({
  type: 'agent.message',
  internalThreadId: THREAD_ID,
  threadId: THREAD_ID,
  graphId: GRAPH_ID,
  nodeId: NODE_ID,
  data: {
    id: msgId,
    threadId: THREAD_ID,
    externalThreadId: THREAD_ID,
    createdAt: new Date().toISOString(),
    nodeId: NODE_ID,
    message: { role: 'ai', content: 'hello' },
    requestTokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      totalPrice,
    },
  },
});

const stateUpdateWith = (inFlightSubagentPrice: Record<string, number>) => ({
  type: 'agent.state.update',
  internalThreadId: THREAD_ID,
  threadId: THREAD_ID,
  graphId: GRAPH_ID,
  nodeId: NODE_ID,
  data: { inFlightSubagentPrice },
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useChatsWebSocket — adversarial edge cases', () => {
  beforeEach(() => {
    wsHandlers.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // H5: NON-SUBAGENT TOOL MESSAGE WITH __subagentCommunication kwarg
  //
  // Hypothesis: A non-subagent tool that carries additionalKwargs.
  // __subagentCommunication === true will have its toolTokenUsage silently
  // dropped (isSubagentToolMessage becomes true). This causes LOST COST — a
  // tool that is NOT a subagent pays zero in the frontend aggregate even
  // though its toolTokenUsage carried real spend.
  //
  // The existing "Change 1" test only asserts that subagent tool messages
  // correctly skip toolUsage. It does NOT assert that a legitimate
  // non-subagent tool is NOT excluded by the same guard when the kwarg is
  // present through whatever injection path.
  //
  // Scenario: the subagent's streaming path tags ALL messages with
  // __subagentCommunication in emitClonedMessages (sub-agent.ts:710), which
  // means even ToolMessages emitted by the subagent's tool executor carry the
  // flag. If one of those nested tool messages has toolTokenUsage (e.g.
  // a sub-shell call inside the subagent), it would be silently dropped by
  // the Change 1 guard.
  // ═══════════════════════════════════════════════════════════════════════
  it('H5: non-subagent tool message with __subagentCommunication kwarg has toolUsage silently dropped (lost cost bug)', async () => {
    const { result } = renderHook(() => useHarness());

    // Step 1: Establish baseline with a priced AI message.
    act(() => {
      dispatch('agent.message', aiMessage(0.1));
    });
    await flushAgentMessageBatch();
    expect(
      result.current.threadTokenUsageByNode[THREAD_ID]?.[NODE_ID]?.totalPrice,
    ).toBeCloseTo(0.1, 10);

    // Step 2: A tool message from a NON-subagent tool (e.g., 'shell') that
    // ALSO carries __subagentCommunication: true in its additionalKwargs.
    // This can happen when the subagent's streaming path (emitClonedMessages)
    // tags its own tool results before they bubble up to the parent.
    //
    // Per the current implementation, this message has:
    //   toolName === 'shell'            → not 'subagents_run_task'
    //   __subagentCommunication: true   → causes isSubagentToolMessage = true
    //
    // The guard: additionalKwargs?.__subagentCommunication === true || toolName === 'subagents_run_task'
    // The first condition is TRUE even though this is 'shell'. Cost is lost.
    act(() => {
      dispatch(
        'agent.message',
        toolMessage(0.05, 'shell', { __subagentCommunication: true }),
      );
    });
    await flushAgentMessageBatch();

    // Expected behavior: a non-subagent tool's toolUsage MUST be accumulated.
    // A shell tool that happens to carry the subagentCommunication flag because
    // it was emitted from within a subagent still incurs real cost that must be
    // counted. The double-count prevention should ONLY apply to
    // 'subagents_run_task' aggregates, not to all tools with that kwarg.
    //
    // Actual behavior (bug): 0.05 is LOST — total stays at 0.10 because
    // isSubagentToolMessage fires on the kwarg alone.
    const totalPrice =
      result.current.threadTokenUsageByNode[THREAD_ID]?.[NODE_ID]?.totalPrice;
    // This SHOULD be 0.15 (0.10 AI + 0.05 shell) but is 0.10 due to the bug.
    expect(totalPrice).toBeCloseTo(0.15, 10);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // H8: selectedThreadInFlightSum > 0 but base.totalPrice === undefined
  //     (thread has in-flight cost before any priced AI message arrived)
  //
  // Hypothesis: When the first agent.state.update arrives with
  // inFlightSubagentPrice before any agent.message with requestTokenUsage,
  // base.totalPrice is undefined. The selectedThreadAggregateUsage memos
  // produce { totalPrice: inFlightSum } (basePrice coerces to 0).
  // BUT: the node's totalTokens is also undefined at this point, so
  // ThreadTokenUsageLine renders null (typeof totalTokens !== 'number').
  // The in-flight cost is therefore invisible in the UI until the first
  // AI message arrives. This is user-visible: the header shows nothing
  // while a subagent is accumulating cost.
  //
  // We prove this by verifying that selectedThreadAggregateUsage.totalPrice
  // returns a non-undefined value even when node.totalTokens is undefined.
  // ═══════════════════════════════════════════════════════════════════════
  it('H8: inFlight cost visible before first AI message — aggregate.totalPrice set even when totalTokens undefined', async () => {
    const { result } = renderHook(() => useHarness());

    // Step 1: Only an inFlightSubagentPrice update arrives — no AI messages yet.
    // Node snapshot after this: { inFlightSubagentPrice: { 'tc-A': 0.12 } }
    // totalTokens, totalPrice are all undefined.
    act(() => {
      dispatch('agent.state.update', stateUpdateWith({ 'tc-A': 0.12 }));
    });

    // The node should have inFlightSubagentPrice set.
    const nodeSnap =
      result.current.threadTokenUsageByNode[THREAD_ID]?.[NODE_ID];
    expect(nodeSnap?.inFlightSubagentPrice?.['tc-A']).toBeCloseTo(0.12, 10);

    // The aggregate computation:
    //   sumUsage([nodeSnap]) → totalPrice: undefined (no priced additive fields)
    //   selectedThreadInFlightSum = 0.12 (from node.inFlightSubagentPrice)
    // When isRunning=true:
    //   basePrice = typeof undefined === 'number' ? ... : 0   → 0
    //   return { ...base, totalPrice: 0 + 0.12 }             → totalPrice: 0.12
    //
    // The component guard: if (typeof totalTokens !== 'number') return null;
    //   totalTokens === undefined → component returns null → cost INVISIBLE.
    //
    // Invariant to assert: when inFlight > 0 and totalPrice was undefined,
    // the aggregate MUST expose a non-undefined totalPrice so the UI can show cost.
    // The aggregate currently DOES set totalPrice to 0.12 via the basePrice=0 path.
    //
    // The REAL bug: totalTokens is still undefined at this point, causing
    // ThreadTokenUsageLine to return null. We assert here that the aggregate
    // object has both totalPrice AND totalTokens defined (or at least that
    // totalTokens is 0 not undefined) so the display condition is met.
    //
    // To prove the bug we need to simulate what useChatsUsageStats does.
    // We directly verify the node snapshot: sumUsage([nodeSnap]) would produce
    // totalTokens: undefined when the only thing in the snapshot is inFlightSubagentPrice.
    // selectedThreadAggregateUsage then sets totalPrice=0.12 but leaves totalTokens=undefined.
    // If totalTokens===undefined the ThreadTokenUsageLine component renders null.
    //
    // Assert: when inFlightSubagentPrice is the ONLY data in the node, totalTokens
    // MUST be 0 (not undefined) so the cost line renders.
    // Current behavior: totalTokens is undefined → display broken.
    expect(nodeSnap?.totalTokens ?? 'not-set').not.toBe('not-set'); // totalTokens must be defined
    // More precise: it must be a number (even 0) so the component guard passes.
    expect(typeof nodeSnap?.totalTokens).toBe('number');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // H11: mergeInFlightMap with NaN value — key persists in map indefinitely
  //
  // Hypothesis: If backend emits inFlightSubagentPrice: { 'tc-A': NaN },
  // the value passes the `value === 0` check (NaN !== 0) so the key is
  // retained in the map. The key then can NEVER be cleared: sentinel-0
  // clears via `value === 0`, but there is no sentinel-NaN path.
  // The permanent key does NOT inflate selectedThreadInFlightSum (the
  // Number.isFinite guard excludes NaN) but the key occupies memory
  // indefinitely and skews Object.keys(map).length checks.
  //
  // Since the Zod validator on the fixture schema allows z.number() (which
  // includes NaN in JS), and backend schema z.record(z.string(), z.number())
  // also allows NaN (Zod's z.number() permits NaN unless .finite() is added),
  // this is a real input path.
  // ═══════════════════════════════════════════════════════════════════════
  it('H11: NaN inFlightSubagentPrice value stays in map indefinitely — sentinel-0 cannot clear it', async () => {
    const { result } = renderHook(() => useHarness());

    // Step 1: inFlightSubagentPrice arrives with NaN value for 'tc-A'.
    // Because NaN !== 0, mergeInFlightMap stores it.
    act(() => {
      dispatch('agent.state.update', stateUpdateWith({ 'tc-A': NaN }));
    });

    const mapAfterNaN =
      result.current.threadTokenUsageByNode[THREAD_ID]?.[NODE_ID]
        ?.inFlightSubagentPrice;
    // With the fix: NaN is treated as sentinel-clear at ingestion — the key is
    // REJECTED and never stored. This prevents permanent phantom leaks for keys
    // that will never receive a corresponding sentinel-0 clear.
    expect(Object.keys(mapAfterNaN ?? {})).not.toContain('tc-A');
    expect(mapAfterNaN?.['tc-A']).toBeUndefined();

    // Step 2: Sentinel-0 clear is emitted for 'tc-A'.
    // Since tc-A was rejected at ingestion (never stored), the sentinel-0 is a
    // no-op — the map stays empty. Confirm the key remains absent.
    act(() => {
      dispatch('agent.state.update', stateUpdateWith({ 'tc-A': 0 }));
    });

    const mapAfterClear =
      result.current.threadTokenUsageByNode[THREAD_ID]?.[NODE_ID]
        ?.inFlightSubagentPrice;
    // Key must still be absent (was never stored to begin with).
    expect(mapAfterClear?.['tc-A']).toBeUndefined();

    // Step 3: Now assert that when the cleared map is empty (undefined),
    // a subsequent NaN event re-inserts the key.
    act(() => {
      dispatch('agent.state.update', stateUpdateWith({ 'tc-B': NaN }));
    });
    const mapAfterNaN2 =
      result.current.threadTokenUsageByNode[THREAD_ID]?.[NODE_ID]
        ?.inFlightSubagentPrice;

    // A NaN-valued entry MUST NOT persist once the subagent is done.
    // The REAL issue: the entry cannot be cleared by a later sentinel-0
    // IF the TOOLCALLID for the NaN entry differs from the sentinel.
    // Here tc-B has NaN and there is no sentinel for tc-B.
    // Assert: tc-B must NOT be in the map (ideally it is rejected at ingestion).
    // Current behavior: tc-B IS in the map with NaN value — permanent leak.
    expect(Object.keys(mapAfterNaN2 ?? {})).not.toContain('tc-B');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // H12: Duplicate agent.message events in the SAME flush batch
  //      double-count token usage
  //
  // Hypothesis: If two WS 'agent.message' events arrive before the
  // microtask flush (both buffered in the same batch for the same threadId),
  // and both carry the SAME requestTokenUsage price but DIFFERENT message IDs,
  // both accumulate into tokenUsageUpdates. This is expected (they are
  // different messages). But if they carry the SAME message ID (e.g., a WS
  // reconnect replays the event), the message deduplication in
  // mergeMessagesReplacingStreaming prevents duplicates in the messages list,
  // but the token accumulation is NOT guarded by message ID — it pushes to
  // tokenUsageUpdates for EVERY entry in the `messages` buffer array,
  // including the duplicate.
  // ═══════════════════════════════════════════════════════════════════════
  it('H12: duplicate agent.message with same ID in one flush batch double-counts token usage', async () => {
    const { result } = renderHook(() => useHarness());

    const DUPLICATE_MSG_ID = 'dedup-msg-001';

    // Step 1: Send two events with IDENTICAL message ID in the same microtask
    // (before the setTimeout flush fires). Both land in the same buffer entry.
    act(() => {
      dispatch('agent.message', aiMessage(0.1, DUPLICATE_MSG_ID));
      // Dispatch second event with SAME id immediately — no flush between them.
      dispatch('agent.message', aiMessage(0.1, DUPLICATE_MSG_ID));
    });
    await flushAgentMessageBatch();

    const totalPrice =
      result.current.threadTokenUsageByNode[THREAD_ID]?.[NODE_ID]?.totalPrice;

    // Expected: 0.10 — duplicate message id should be deduplicated, so only
    // one instance of the token usage is counted.
    // Actual (if bug present): 0.20 — both events' reqUsage accumulated separately.
    expect(totalPrice).toBeCloseTo(0.1, 10);
  });
});
