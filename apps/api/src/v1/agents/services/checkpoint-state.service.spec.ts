import { Test, TestingModule } from '@nestjs/testing';
import { DefaultLogger } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessagesDao } from '../../threads/dao/messages.dao';
import { ThreadsDao } from '../../threads/dao/threads.dao';
import { CheckpointStateService } from './checkpoint-state.service';
import { PgCheckpointSaver } from './pg-checkpoint-saver';

const THREAD_ID = 'thread-test-001';
const INTERNAL_THREAD_UUID = '11111111-1111-1111-1111-111111111111';

/**
 * Builds a minimal checkpoint tuple shape that CheckpointStateService reads.
 * Only channel_values is exercised here; other CheckpointTuple fields are
 * set to safe no-op values.
 */
function makeTuple(
  nodeId: string,
  state: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    totalPrice?: number;
    currentContext?: number;
  },
) {
  return {
    nodeId,
    checkpoint: {
      id: 'cp-1',
      ts: '2024-01-01T00:00:00Z',
      channel_values: {
        messages: [],
        summary: '',
        toolsMetadata: {},
        toolUsageGuardActivated: false,
        toolUsageGuardActivatedCount: 0,
        inputTokens: state.inputTokens ?? 0,
        cachedInputTokens: state.cachedInputTokens ?? 0,
        outputTokens: state.outputTokens ?? 0,
        reasoningTokens: state.reasoningTokens ?? 0,
        totalTokens: state.totalTokens ?? 0,
        totalPrice: state.totalPrice ?? 0,
        currentContext: state.currentContext ?? 0,
      },
      channel_versions: {},
      versions_seen: {},
      v: 1,
    },
    metadata: { source: 'loop', step: 1, parents: {} },
    config: { configurable: { thread_id: THREAD_ID, checkpoint_ns: '' } },
    pendingWrites: null,
    parentConfig: null,
  };
}

describe('CheckpointStateService', () => {
  let service: CheckpointStateService;
  let mockCheckpointSaver: {
    getTuples: ReturnType<typeof vi.fn>;
  };
  let mockLogger: {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    trace: ReturnType<typeof vi.fn>;
  };
  let mockMessagesDao: {
    aggregateUsageBySubagentNodeId: ReturnType<typeof vi.fn>;
  };
  let mockThreadsDao: {
    getOne: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    mockCheckpointSaver = {
      getTuples: vi.fn(),
    };

    mockLogger = {
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    };

    mockMessagesDao = {
      aggregateUsageBySubagentNodeId: vi.fn(),
    };

    mockThreadsDao = {
      getOne: vi.fn().mockResolvedValue({ id: INTERNAL_THREAD_UUID }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckpointStateService,
        {
          provide: PgCheckpointSaver,
          useValue: mockCheckpointSaver,
        },
        {
          provide: DefaultLogger,
          useValue: mockLogger,
        },
        {
          provide: MessagesDao,
          useValue: mockMessagesDao,
        },
        {
          provide: ThreadsDao,
          useValue: mockThreadsDao,
        },
      ],
    }).compile();

    service = module.get(CheckpointStateService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('populates parent bucket, inserts surrogate buckets, and subtracts subagent totals from parent', async () => {
    const parentState = {
      inputTokens: 5000,
      cachedInputTokens: 500,
      outputTokens: 1000,
      reasoningTokens: 200,
      totalTokens: 6000,
      totalPrice: 0.5,
      currentContext: 4000,
    };

    mockCheckpointSaver.getTuples.mockResolvedValueOnce([
      makeTuple('parent', parentState),
    ]);

    mockMessagesDao.aggregateUsageBySubagentNodeId.mockResolvedValueOnce(
      new Map([
        [
          'parent::sub::call_a',
          {
            inputTokens: 1000,
            cachedInputTokens: 100,
            outputTokens: 200,
            reasoningTokens: 50,
            totalTokens: 1200,
            totalPrice: 0.1,
          },
        ],
        [
          'parent::sub::call_b',
          {
            inputTokens: 1500,
            cachedInputTokens: 150,
            outputTokens: 300,
            reasoningTokens: 75,
            totalTokens: 1800,
            totalPrice: 0.15,
          },
        ],
      ]),
    );

    const result = await service.getThreadTokenUsage(THREAD_ID);

    expect(result).not.toBeNull();
    expect(result!.byNode).toBeDefined();
    const byNode = result!.byNode!;

    // Three entries total
    expect(Object.keys(byNode)).toHaveLength(3);
    expect(byNode['parent']).toBeDefined();
    expect(byNode['parent::sub::call_a']).toBeDefined();
    expect(byNode['parent::sub::call_b']).toBeDefined();

    // Parent is subtracted: 0.50 - 0.10 - 0.15 = 0.25
    expect(byNode['parent']!.totalPrice).toBeCloseTo(0.25, 10);
    // Parent totalTokens: 6000 - 1200 - 1800 = 3000
    expect(byNode['parent']!.totalTokens).toBe(3000);

    // Surrogate buckets match input exactly
    expect(byNode['parent::sub::call_a']!.totalPrice).toBeCloseTo(0.1, 10);
    expect(byNode['parent::sub::call_a']!.totalTokens).toBe(1200);
    expect(byNode['parent::sub::call_b']!.totalPrice).toBeCloseTo(0.15, 10);
    expect(byNode['parent::sub::call_b']!.totalTokens).toBe(1800);
  });

  it('inserts surrogate bucket without synthesizing a parent entry when parent is absent in byNode', async () => {
    // "parent absent" branch: a surrogate exists in messages but its parent
    // has no checkpoint tuple. We pass a tuple with a DIFFERENT nodeId so the
    // empty-tuples short-circuit at line 70 does NOT fire and we reach the
    // merge loop at line 130. In this orphan-surrogate case the production
    // code inserts the surrogate into byNode but does NOT synthesize a parent
    // entry (the `if (parent)` branch at line 134 is skipped). Callers that sum
    // byNode.totalPrice should not expect it to equal the top-level totalPrice
    // here — the message-scan path in ThreadsService.getThreadUsageStatistics
    // is the authoritative source for thread totals.
    mockCheckpointSaver.getTuples.mockResolvedValueOnce([
      makeTuple('some-other-node', {
        inputTokens: 100,
        totalTokens: 100,
        totalPrice: 0.01,
      }),
    ]);

    mockMessagesDao.aggregateUsageBySubagentNodeId.mockResolvedValueOnce(
      new Map([
        [
          'orphan-parent::sub::call_x',
          {
            inputTokens: 500,
            cachedInputTokens: 0,
            outputTokens: 100,
            reasoningTokens: 0,
            totalTokens: 600,
            totalPrice: 0.06,
          },
        ],
      ]),
    );

    const result = await service.getThreadTokenUsage(THREAD_ID);

    expect(result).not.toBeNull();
    const byNode = result!.byNode!;

    // Surrogate bucket inserted
    expect(byNode['orphan-parent::sub::call_x']).toBeDefined();
    expect(byNode['orphan-parent::sub::call_x']!.totalPrice).toBeCloseTo(
      0.06,
      10,
    );

    // No synthesized parent entry
    expect(byNode['orphan-parent']).toBeUndefined();

    // No crash
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('clamps subtraction to zero on underflow and calls logger.warn', async () => {
    mockCheckpointSaver.getTuples.mockResolvedValueOnce([
      makeTuple('parent', {
        inputTokens: 500,
        totalTokens: 500,
        totalPrice: 0.05,
        currentContext: 1000,
      }),
    ]);

    mockMessagesDao.aggregateUsageBySubagentNodeId.mockResolvedValueOnce(
      new Map([
        [
          'parent::sub::call_z',
          {
            inputTokens: 1000,
            cachedInputTokens: 0,
            outputTokens: 200,
            reasoningTokens: 0,
            totalTokens: 1200,
            totalPrice: 0.1, // exceeds parent 0.05
          },
        ],
      ]),
    );

    const result = await service.getThreadTokenUsage(THREAD_ID);

    expect(result).not.toBeNull();
    const byNode = result!.byNode!;

    // Parent totalPrice clamped to 0
    expect(byNode['parent']!.totalPrice).toBe(0);

    // logger.warn called with message containing 'clamped' and context object
    expect(mockLogger.warn).toHaveBeenCalledOnce();
    const [warnMsg, warnCtx] = mockLogger.warn.mock.calls[0] as [
      string,
      unknown,
    ];
    expect(warnMsg).toContain('clamped');
    expect(warnCtx).toMatchObject({
      threadId: THREAD_ID,
      parentNodeId: 'parent',
      surrogate: 'parent::sub::call_z',
    });
  });

  it('leaves byNode unchanged from tuple-derived shape when DAO returns empty Map (legacy thread)', async () => {
    mockCheckpointSaver.getTuples.mockResolvedValueOnce([
      makeTuple('node-a', {
        inputTokens: 2000,
        totalTokens: 2000,
        totalPrice: 0.2,
      }),
      makeTuple('node-b', {
        inputTokens: 1000,
        totalTokens: 1000,
        totalPrice: 0.1,
      }),
    ]);

    mockMessagesDao.aggregateUsageBySubagentNodeId.mockResolvedValueOnce(
      new Map(),
    );

    const result = await service.getThreadTokenUsage(THREAD_ID);

    expect(result).not.toBeNull();
    const byNode = result!.byNode!;

    expect(Object.keys(byNode)).toHaveLength(2);
    expect(byNode['node-a']).toBeDefined();
    expect(byNode['node-b']).toBeDefined();

    // No surrogate keys
    const hasSurrogatKey = Object.keys(byNode).some((k) =>
      k.includes('::sub::'),
    );
    expect(hasSurrogatKey).toBe(false);
  });

  it('returns null and does NOT call messagesDao when tuples list is empty', async () => {
    mockCheckpointSaver.getTuples.mockResolvedValueOnce([]);

    const result = await service.getThreadTokenUsage(THREAD_ID);

    expect(result).toBeNull();
    expect(
      mockMessagesDao.aggregateUsageBySubagentNodeId,
    ).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // H1 (adversarial): clamp-logger boundary — strict > vs >=
  //
  // When usage.totalPrice === parent.totalPrice exactly, Math.max(0, parent - usage)
  // produces 0, but the warn condition `(usage.totalPrice) > (parent.totalPrice)`
  // is STRICT: equality does NOT trigger the warning. A fix would change > to >=.
  //
  // Expected current behavior (bug): warn is NOT called.
  // Expected fixed behavior: warn IS called.
  // This test asserts the fixed behavior, so it FAILS today.
  // ────────────────────────────────────────────────────────────────────────────
  it('[ADVERSARIAL-H1] fires logger.warn when subagent totalPrice equals parent totalPrice exactly (not just when it exceeds)', async () => {
    const exactPrice = 0.05;

    mockCheckpointSaver.getTuples.mockResolvedValueOnce([
      makeTuple('parent', {
        inputTokens: 500,
        totalTokens: 500,
        totalPrice: exactPrice,
        currentContext: 1000,
      }),
    ]);

    mockMessagesDao.aggregateUsageBySubagentNodeId.mockResolvedValueOnce(
      new Map([
        [
          'parent::sub::call_exact',
          {
            inputTokens: 500,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 500,
            totalPrice: exactPrice, // exactly equal — not greater
          },
        ],
      ]),
    );

    await service.getThreadTokenUsage(THREAD_ID);

    // The parent bucket is clamped to 0 (0.05 - 0.05 = 0), and usage.totalPrice
    // equals parent.totalPrice, so this IS a suspicious underflow case.
    // The warn guard uses strict > today, so it does NOT fire on equality — bug.
    // Fixed code would use >=: warn fires whenever the result is clamped to 0
    // and at least one of the totals is non-zero.
    expect(mockLogger.warn).toHaveBeenCalledOnce();
    const [warnMsg] = mockLogger.warn.mock.calls[0] as [string, unknown];
    expect(warnMsg).toContain('clamped');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // H2 (adversarial): per-field subtraction completeness
  //
  // The production code subtracts all 6 token fields from the parent bucket:
  // inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens,
  // totalPrice.  The existing spec only asserts totalPrice and totalTokens.
  // This test pins all 4 remaining integer fields so a regression where any
  // one field was accidentally omitted from the subtraction would be caught.
  // ────────────────────────────────────────────────────────────────────────────
  it('[ADVERSARIAL-H2] subtracts all 6 token fields (not just totalPrice and totalTokens) from parent bucket', async () => {
    const parentState = {
      inputTokens: 5000,
      cachedInputTokens: 400,
      outputTokens: 1000,
      reasoningTokens: 200,
      totalTokens: 6000,
      totalPrice: 0.5,
      currentContext: 4000,
    };

    const surrogateUsage = {
      inputTokens: 1000,
      cachedInputTokens: 100,
      outputTokens: 200,
      reasoningTokens: 50,
      totalTokens: 1200,
      totalPrice: 0.1,
    };

    mockCheckpointSaver.getTuples.mockResolvedValueOnce([
      makeTuple('parent', parentState),
    ]);

    mockMessagesDao.aggregateUsageBySubagentNodeId.mockResolvedValueOnce(
      new Map([['parent::sub::call_h2', surrogateUsage]]),
    );

    const result = await service.getThreadTokenUsage(THREAD_ID);

    expect(result).not.toBeNull();
    const parent = result!.byNode!['parent'];
    expect(parent).toBeDefined();

    // inputTokens: 5000 - 1000 = 4000
    expect(parent!.inputTokens).toBe(4000);
    // cachedInputTokens: 400 - 100 = 300
    expect(parent!.cachedInputTokens).toBe(300);
    // outputTokens: 1000 - 200 = 800
    expect(parent!.outputTokens).toBe(800);
    // reasoningTokens: 200 - 50 = 150
    expect(parent!.reasoningTokens).toBe(150);
    // totalTokens and totalPrice verified by existing spec; included here for completeness
    expect(parent!.totalTokens).toBe(4800);
    expect(parent!.totalPrice).toBeCloseTo(0.4, 10);
  });
});
