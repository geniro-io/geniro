// @vitest-environment jsdom
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const THREAD_ID = 'thread-1';
const NODE_ID = 'node-1';
const GRAPH_ID = 'graph-1';

type UsageMap = Record<string, Record<string, ThreadTokenUsageSnapshot>>;

// Thin wrapper that mounts the real hook with stateful threadTokenUsageByNode so
// the test can observe reducer evolution.
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

  return threadTokenUsageByNode;
};

const agentMessage = (
  totalPrice: number,
  extra: Record<string, unknown> = {},
) => ({
  type: 'agent.message',
  internalThreadId: THREAD_ID,
  threadId: THREAD_ID,
  graphId: GRAPH_ID,
  nodeId: NODE_ID,
  data: {
    id: `msg-${Math.random()}`,
    threadId: THREAD_ID,
    externalThreadId: THREAD_ID,
    createdAt: new Date().toISOString(),
    nodeId: NODE_ID,
    message: {
      role: 'ai',
      content: 'hello',
      ...(extra.kwargs ? { additionalKwargs: extra.kwargs } : {}),
    },
    requestTokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      totalPrice,
    },
  },
});

const agentStateUpdate = (totalPrice: number, totalTokens: number) => ({
  type: 'agent.state.update',
  internalThreadId: THREAD_ID,
  threadId: THREAD_ID,
  graphId: GRAPH_ID,
  nodeId: NODE_ID,
  data: {
    inputTokens: Math.floor(totalTokens * 0.7),
    outputTokens: Math.ceil(totalTokens * 0.3),
    totalTokens,
    totalPrice,
    currentContext: totalTokens,
  },
});

// Helper: build an agent.message notification with role: 'tool' (for toolTokenUsage tests).
// The production code detects subagent tool messages via additionalKwargs.__subagentCommunication
// or toolName === 'subagents_run_task' and skips toolUsage accumulation for those.
const toolMessage = (
  toolPrice: number,
  toolName: string,
  extraKwargs: Record<string, unknown> = {},
  threadId: string = THREAD_ID,
  nodeId: string = NODE_ID,
) => ({
  type: 'agent.message',
  internalThreadId: threadId,
  threadId: threadId,
  graphId: GRAPH_ID,
  nodeId,
  data: {
    id: `tool-msg-${Math.random()}`,
    threadId,
    externalThreadId: threadId,
    createdAt: new Date().toISOString(),
    nodeId,
    message: {
      role: 'tool',
      content: 'tool result',
      name: toolName,
      additionalKwargs:
        Object.keys(extraKwargs).length > 0 ? extraKwargs : undefined,
    },
    // No requestTokenUsage on a tool message — only toolTokenUsage
    toolTokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalPrice: toolPrice,
    },
  },
});

// Helper: build an agent.state.update notification scoped to a specific thread/node.
const stateUpdateForThread = (
  inFlightSubagentPrice: Record<string, number>,
  threadId: string = THREAD_ID,
  nodeId: string = NODE_ID,
) => ({
  type: 'agent.state.update',
  internalThreadId: threadId,
  threadId,
  graphId: GRAPH_ID,
  nodeId,
  data: {
    inFlightSubagentPrice,
  },
});

describe('useChatsWebSocket — additive vs state.update reducer interaction', () => {
  beforeEach(() => {
    wsHandlers.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const dispatch = (type: string, payload: unknown) => {
    const fn = wsHandlers.get(type);
    if (!fn) {
      throw new Error(`No handler captured for ${type}`);
    }
    fn(payload);
  };

  const flushAgentMessageBatch = async () => {
    // flushAgentMessages is scheduled via setTimeout(fn, 0)
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
  };

  const totalPriceFor = (usageMap: UsageMap) =>
    usageMap[THREAD_ID]?.[NODE_ID]?.totalPrice;

  it('thread total must not drop when agent.state.update arrives after additive agent.message events', async () => {
    const { result } = renderHook(() => useHarness());

    // Step 1 — Parent LLM call completes, agent.message adds $0.10 additively.
    act(() => {
      dispatch('agent.message', agentMessage(0.1));
    });
    await flushAgentMessageBatch();
    expect(totalPriceFor(result.current)).toBeCloseTo(0.1, 10);

    // Step 2 — Checkpoint state.update arrives with cumulative totalPrice=$0.10.
    // With the current reducer this REPLACES the additive total (still $0.10,
    // no visible drop). But the authoritative-policy view is that state.update
    // should not touch additive fields at all. Sanity-check step 2.
    act(() => {
      dispatch('agent.state.update', agentStateUpdate(0.1, 15));
    });
    expect(totalPriceFor(result.current)).toBeCloseTo(0.1, 10);

    // Step 3 — Subagent completes, emits a subagent-flagged agent.message that
    // ALWAYS bypasses the nodeHasStateUpdates gate (useChatsWebSocket.ts:812).
    // Additively adds $0.02 — aggregate becomes $0.12.
    act(() => {
      dispatch(
        'agent.message',
        agentMessage(0.02, {
          kwargs: { __subagentCommunication: true },
        }),
      );
    });
    await flushAgentMessageBatch();
    expect(totalPriceFor(result.current)).toBeCloseTo(0.12, 10);

    // Step 4 — A new checkpoint state.update arrives BEFORE the parent's
    // checkpoint has folded in the subagent cost. Cumulative total $0.11
    // (parent $0.10 + new parent tool-call $0.01). Because the reducer spreads
    // this over the existing slot, it REPLACES totalPrice from $0.12 → $0.11,
    // which is the visible downward jump the user reports.
    act(() => {
      dispatch('agent.state.update', agentStateUpdate(0.11, 20));
    });

    // The invariant we care about: the aggregate MUST NEVER DECREASE during a
    // running thread. state.update should be informational for currentContext
    // only and must not overwrite additive totals.
    expect(totalPriceFor(result.current)).toBeGreaterThanOrEqual(0.12 - 1e-9);
  });

  it('Change 1: does not double-count priced subagent tokens (toolUsage skipped for subagent tool messages)', async () => {
    const { result } = renderHook(() => useHarness());

    // Step 1: AI message for a subagent communication — reqUsage ALWAYS accumulates.
    // This represents the subagent's own LLM call cost flowing up to the parent.
    act(() => {
      dispatch(
        'agent.message',
        agentMessage(0.1, {
          kwargs: { __subagentCommunication: true },
        }),
      );
    });
    await flushAgentMessageBatch();
    expect(totalPriceFor(result.current)).toBeCloseTo(0.1, 10);

    // Step 2: Corresponding TOOL message for the same subagent tool call.
    // toolTokenUsage.totalPrice === 0.10 — this is an aggregate that already
    // covers the same cost as step 1's reqUsage. Must NOT be accumulated.
    act(() => {
      dispatch(
        'agent.message',
        toolMessage(0.1, 'subagents_run_task', {
          __subagentCommunication: true,
        }),
      );
    });
    await flushAgentMessageBatch();

    // Total must still be 0.10 — subagent toolUsage is deliberately skipped.
    expect(totalPriceFor(result.current)).toBeCloseTo(0.1, 10);

    // Control: a non-subagent tool (shell) — its toolUsage MUST accumulate normally.
    act(() => {
      dispatch('agent.message', toolMessage(0.03, 'shell'));
    });
    await flushAgentMessageBatch();

    // 0.10 (subagent AI req) + 0.03 (shell tool) = 0.13 — shell tool is counted.
    expect(totalPriceFor(result.current)).toBeCloseTo(0.13, 10);
  });

  it('Change 2: parallel subagents — inFlightSubagentPrice map merges with replace semantics and sentinel-0 clear', async () => {
    const { result } = renderHook(() => useHarness());

    // Step 1: two parallel subagents emit separate inFlightSubagentPrice updates.
    // Each update must be merged into the same per-node map (no key loss).
    act(() => {
      dispatch('agent.state.update', stateUpdateForThread({ 'tc-A': 0.05 }));
    });
    act(() => {
      dispatch('agent.state.update', stateUpdateForThread({ 'tc-B': 0.07 }));
    });

    // Both keys must be present after merge.
    const mapAfterBoth =
      result.current[THREAD_ID]?.[NODE_ID]?.inFlightSubagentPrice;
    expect(mapAfterBoth?.['tc-A']).toBeCloseTo(0.05, 10);
    expect(mapAfterBoth?.['tc-B']).toBeCloseTo(0.07, 10);
    expect(Object.keys(mapAfterBoth ?? {})).toHaveLength(2);

    // Step 2: sentinel-0 clear for tc-A — key must be removed, tc-B must survive.
    act(() => {
      dispatch('agent.state.update', stateUpdateForThread({ 'tc-A': 0 }));
    });

    const mapAfterClear =
      result.current[THREAD_ID]?.[NODE_ID]?.inFlightSubagentPrice;
    expect(mapAfterClear?.['tc-A']).toBeUndefined();
    expect(mapAfterClear?.['tc-B']).toBeCloseTo(0.07, 10);
    expect(Object.keys(mapAfterClear ?? {})).toHaveLength(1);
  });

  it('Change 2 isolation: thread-switch — inFlightSubagentPrice state is independent per thread', async () => {
    const THREAD_ID_B = 'thread-2';

    const { result } = renderHook(() => useHarness());

    // Step 1: dispatch inFlightSubagentPrice for threadA.
    act(() => {
      dispatch(
        'agent.state.update',
        stateUpdateForThread({ 'tc-A': 0.05 }, THREAD_ID),
      );
    });

    // Step 2: dispatch inFlightSubagentPrice for threadB (same toolCallId key).
    act(() => {
      dispatch(
        'agent.state.update',
        stateUpdateForThread({ 'tc-A': 0.05 }, THREAD_ID_B),
      );
    });

    // threadA's map must be untouched by threadB's event.
    const mapA = result.current[THREAD_ID]?.[NODE_ID]?.inFlightSubagentPrice;
    expect(mapA?.['tc-A']).toBeCloseTo(0.05, 10);

    // threadB has its own independent map.
    const mapB = result.current[THREAD_ID_B]?.[NODE_ID]?.inFlightSubagentPrice;
    expect(mapB?.['tc-A']).toBeCloseTo(0.05, 10);

    // Step 3: sentinel-0 clear only for threadB — must NOT affect threadA's map.
    act(() => {
      dispatch(
        'agent.state.update',
        stateUpdateForThread({ 'tc-A': 0 }, THREAD_ID_B),
      );
    });

    const mapAAfterClear =
      result.current[THREAD_ID]?.[NODE_ID]?.inFlightSubagentPrice;
    expect(mapAAfterClear?.['tc-A']).toBeCloseTo(0.05, 10);

    const mapBAfterClear =
      result.current[THREAD_ID_B]?.[NODE_ID]?.inFlightSubagentPrice;
    // tc-A sentinel-cleared on threadB — key must be gone.
    expect(mapBAfterClear?.['tc-A']).toBeUndefined();

    // The reducer must NOT auto-clear inFlightSubagentPrice on thread.update done.
    // Per-node map cleanup is intentionally delegated to the usage-stats selector
    // (which ignores inFlight when !isRunning), NOT the reducer. Verify by
    // dispatching a thread.update with status 'done' for threadA — map must remain.
    act(() => {
      dispatch('thread.update', {
        type: 'thread.update',
        internalThreadId: THREAD_ID,
        threadId: THREAD_ID,
        graphId: GRAPH_ID,
        data: {
          id: THREAD_ID,
          graphId: GRAPH_ID,
          status: 'done',
          name: 'thread-1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          externalThreadId: THREAD_ID,
        },
      });
    });

    const mapAAfterDone =
      result.current[THREAD_ID]?.[NODE_ID]?.inFlightSubagentPrice;
    // Per-node map must not be cleared by a thread.update reducer — still 0.05.
    expect(mapAAfterDone?.['tc-A']).toBeCloseTo(0.05, 10);
  });
});
