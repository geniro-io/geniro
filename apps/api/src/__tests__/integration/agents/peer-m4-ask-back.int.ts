import { INestApplication } from '@nestjs/common';
import { BaseException } from '@packages/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { ReasoningEffort } from '../../../v1/agents/agents.types';
import { SimpleAgentSchemaType } from '../../../v1/agents/services/agents/simple-agent';
import { CreateGraphDto } from '../../../v1/graphs/dto/graphs.dto';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { LiteLlmClient } from '../../../v1/litellm/services/litellm.client';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { ThreadMessageDto } from '../../../v1/threads/dto/threads.dto';
import { ThreadNameGeneratorService } from '../../../v1/threads/services/thread-name-generator.service';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { waitForCondition } from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import {
  mockLiteLlmClient,
  mockThreadNameGenerator,
} from '../helpers/test-stubs';
import { getMockLlm } from '../mocks/mock-llm';
import { createTestModule } from '../setup';

/**
 * M4 peer ask-back — caller answers a peer's mid-run question in-session.
 *
 * Two real SimpleAgent graph nodes wired through an agent-communication-tool:
 *   trigger -> CALLER -> communication-tool -> PEER
 *
 * The caller delegates a task to the peer; the peer pauses with a question
 * (`finish(needsMoreInfo=true)`), which surfaces to the caller as a
 * `communication_exec` result carrying `needsMoreInfo` + an answer-or-escalate
 * directive. The caller ANSWERS it itself by re-invoking the SAME peer by name
 * — the deterministic callee thread id makes that re-invocation resume the peer
 * from its persisted checkpoint with the answer appended, and the peer completes
 * with NO user round-trip (the thread finishes Done, not NeedMoreInfo).
 *
 * This is the spec Done Condition for the peer channel: an orchestrator answers
 * (not escalates) a question raised by a peer in-session; the peer resumes and
 * completes.
 */
const TRIGGER_NODE_ID = 'trigger-1';
const CALLER_NODE_ID = 'agent-caller';
const COMM_NODE_ID = 'comm-1';
const PEER_NODE_ID = 'agent-peer';

const PEER_AGENT_NAME = 'Config Specialist';
const MODEL = 'gpt-5-mini';

// A marker placed in the PEER's agent instructions (and therefore only in the
// PEER's system prompt — the caller never sees the peer's instructions, only its
// name/description via the communication-tool listing). Lets the test isolate
// the peer's own LLM requests to prove its resume turn loaded the checkpoint.
const PEER_SENTINEL = 'PEER_AGENT_SENTINEL_4F2A9C';

// Marker in the CYCLE caller's system prompt — lets the cycle test's matchers
// steer the caller (always re-invoke) apart from the peer (always re-ask).
const CYCLE_CALLER_SENTINEL = 'CYCLE_CALLER_SENTINEL_9B7E1D';

const CALLER_INSTRUCTIONS =
  'You are an orchestrator. Delegate the user request to the connected agent and coordinate the work. ' +
  'If that agent replies that it needs more information, answer its question yourself — from the user request and your own knowledge — by sending another message to the SAME agent. Do NOT ask the user. ' +
  'When the agent reports the task is complete, call finish.';

const PEER_INSTRUCTIONS =
  `${PEER_SENTINEL} You are the Config Specialist. When given a task, if a required ` +
  'detail is missing, ask the caller by calling finish with needsMoreInfo=true and your ' +
  'question. Otherwise complete the task and call finish with needsMoreInfo=false.';

const THREAD_COMPLETION_STATUSES: ThreadStatus[] = [
  ThreadStatus.Done,
  ThreadStatus.NeedMoreInfo,
  ThreadStatus.Stopped,
];

let contextDataStorage: AppContextStorage;

describe('Peer M4 ask-back (caller answers a peer in-session, peer resumes)', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  let graphId: string;
  let testProjectId: string;

  beforeAll(async () => {
    app = await createTestModule(async (m) =>
      m
        .overrideProvider(LiteLlmClient)
        .useValue(mockLiteLlmClient)
        .overrideProvider(ThreadNameGeneratorService)
        .useValue(mockThreadNameGenerator)
        .compile(),
    );
    graphsService = app.get<GraphsService>(GraphsService);
    threadsService = app.get<ThreadsService>(ThreadsService);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;

    const graph = await graphsService.create(
      contextDataStorage,
      createPeerGraphData(),
    );
    graphId = graph.id;
    await graphsService.run(contextDataStorage, graphId);
    await waitForGraphStatus(graphId, GraphStatus.Running);
  }, 300_000);

  afterAll(async () => {
    if (graphId) {
      await cleanupGraph(graphId);
    }
    if (testProjectId) {
      try {
        await app.get(ProjectsDao).deleteById(testProjectId);
      } catch {
        // best effort cleanup
      }
    }
    await app.close();
  }, 300_000);

  beforeEach(() => {
    getMockLlm(app).reset();
  });

  const cleanupGraph = async (id: string) => {
    try {
      await graphsService.destroy(contextDataStorage, id);
    } catch (error: unknown) {
      if (
        !(error instanceof BaseException) ||
        (error.errorCode !== 'GRAPH_NOT_FOUND' &&
          error.errorCode !== 'GRAPH_NOT_RUNNING')
      ) {
        throw error;
      }
    }
    try {
      await graphsService.delete(contextDataStorage, id);
    } catch (error: unknown) {
      if (
        !(error instanceof BaseException) ||
        error.errorCode !== 'GRAPH_NOT_FOUND'
      ) {
        throw error;
      }
    }
  };

  const waitForGraphStatus = async (
    id: string,
    status: GraphStatus,
    timeoutMs = 240_000,
  ) => {
    return waitForCondition(
      () => graphsService.findById(contextDataStorage, id),
      (graph) => graph.status === status,
      { timeout: timeoutMs, interval: 1_000 },
    );
  };

  const waitForThreadCompletion = async (
    externalThreadId: string,
    timeoutMs = 240_000,
  ) => {
    const thread = await threadsService.getThreadByExternalId(
      contextDataStorage,
      externalThreadId,
    );
    return waitForCondition(
      () => threadsService.getThreadById(contextDataStorage, thread.id),
      (currentThread) =>
        THREAD_COMPLETION_STATUSES.includes(currentThread.status),
      { timeout: timeoutMs, interval: 1_000 },
    );
  };

  const getThreadMessages = async (
    externalThreadId: string,
  ): Promise<ThreadMessageDto[]> => {
    const thread = await threadsService.getThreadByExternalId(
      contextDataStorage,
      externalThreadId,
    );
    return threadsService.getThreadMessages(contextDataStorage, thread.id);
  };

  const ensureGraphRunning = async (id: string) => {
    const graph = await graphsService.findById(contextDataStorage, id);
    if (graph.status === GraphStatus.Running) {
      return;
    }
    await graphsService.run(contextDataStorage, id);
    await waitForGraphStatus(id, GraphStatus.Running);
  };

  const uniqueThreadSubId = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  function createPeerGraphData(): CreateGraphDto {
    const callerConfig: SimpleAgentSchemaType = {
      instructions: CALLER_INSTRUCTIONS,
      name: 'Orchestrator',
      description: 'Coordinates work across agents',
      invokeModelName: MODEL,
      invokeModelReasoningEffort: ReasoningEffort.None,
      maxIterations: 20,
      summarizeMaxTokens: 272000,
      summarizeKeepTokens: 30000,
    };
    const peerConfig: SimpleAgentSchemaType = {
      instructions: PEER_INSTRUCTIONS,
      name: PEER_AGENT_NAME,
      description: 'Specialist that edits configuration files',
      invokeModelName: MODEL,
      invokeModelReasoningEffort: ReasoningEffort.None,
      maxIterations: 20,
      summarizeMaxTokens: 272000,
      summarizeKeepTokens: 30000,
    };

    return {
      name: `Peer Ask-Back Integration Test ${Date.now()}`,
      description: 'Two agents connected via communication tool (M4 ask-back)',
      temporary: true,
      schema: {
        nodes: [
          { id: TRIGGER_NODE_ID, template: 'manual-trigger', config: {} },
          {
            id: CALLER_NODE_ID,
            template: 'simple-agent',
            config: callerConfig,
          },
          {
            id: COMM_NODE_ID,
            template: 'agent-communication-tool',
            config: {},
          },
          { id: PEER_NODE_ID, template: 'simple-agent', config: peerConfig },
        ],
        edges: [
          { from: TRIGGER_NODE_ID, to: CALLER_NODE_ID },
          { from: CALLER_NODE_ID, to: COMM_NODE_ID },
          { from: COMM_NODE_ID, to: PEER_NODE_ID },
        ],
      },
    };
  }

  // A mutual ask-back cycle graph: the caller always answers by re-invoking the
  // peer, and the peer always asks again. The caller's small maxIterations (the
  // LangGraph recursionLimit) is the only thing that breaks the loop — the
  // documented cycle guard (no bespoke counter). The peer's bound is set high so
  // the CALLER's bound fires first, making the termination deterministic.
  function createCycleGraphData(): CreateGraphDto {
    const callerConfig: SimpleAgentSchemaType = {
      instructions:
        `${CYCLE_CALLER_SENTINEL} You are an orchestrator. Delegate to the connected agent and, ` +
        'whenever it reports it needs more information, answer it yourself by sending another ' +
        'message to the SAME agent. Keep the collaboration going — do not stop.',
      name: 'Cycle Orchestrator',
      description: 'Coordinates work across agents',
      invokeModelName: MODEL,
      invokeModelReasoningEffort: ReasoningEffort.None,
      maxIterations: 6,
      summarizeMaxTokens: 272000,
      summarizeKeepTokens: 30000,
    };
    const peerConfig: SimpleAgentSchemaType = {
      instructions:
        `${PEER_SENTINEL} You are the Config Specialist. Every time you are asked, respond by ` +
        'calling finish with needsMoreInfo=true and another clarifying question — never complete the task.',
      name: PEER_AGENT_NAME,
      description: 'Specialist that edits configuration files',
      invokeModelName: MODEL,
      invokeModelReasoningEffort: ReasoningEffort.None,
      maxIterations: 30,
      summarizeMaxTokens: 272000,
      summarizeKeepTokens: 30000,
    };

    return {
      name: `Peer Ask-Back Cycle Test ${Date.now()}`,
      description: 'Mutual ask-back cycle bounded by caller maxIterations (M4)',
      temporary: true,
      schema: {
        nodes: [
          { id: TRIGGER_NODE_ID, template: 'manual-trigger', config: {} },
          {
            id: CALLER_NODE_ID,
            template: 'simple-agent',
            config: callerConfig,
          },
          {
            id: COMM_NODE_ID,
            template: 'agent-communication-tool',
            config: {},
          },
          { id: PEER_NODE_ID, template: 'simple-agent', config: peerConfig },
        ],
        edges: [
          { from: TRIGGER_NODE_ID, to: CALLER_NODE_ID },
          { from: CALLER_NODE_ID, to: COMM_NODE_ID },
          { from: COMM_NODE_ID, to: PEER_NODE_ID },
        ],
      },
    };
  }

  it(
    'caller answers a peer needsMoreInfo question in-session; peer resumes from its checkpoint and completes with no user round-trip',
    { timeout: 300_000 },
    async () => {
      const mockLlm = getMockLlm(app);

      /**
       * FIFO sequence (single-threaded graph execution order):
       *  Q0 CALLER — tool_search (communication_exec is deferred; load it)
       *  Q1 CALLER — communication_exec(peer, task)
       *  Q2 PEER   — finish(needsMoreInfo=true, question)         [peer pauses]
       *  Q3 CALLER — communication_exec(peer, answer)             [caller answers]
       *  Q4 PEER   — finish(needsMoreInfo=false, completion)      [peer RESUMES]
       *  Q5 CALLER — finish(needsMoreInfo=false, summary)         [thread Done]
       */
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'tool_search',
        args: { query: 'communication' },
      });
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'communication_exec',
        args: {
          agent: PEER_AGENT_NAME,
          message:
            'Update the auth configuration file. If you are unsure which file to modify, ask me which one.',
          purpose: 'delegate config update',
        },
      });
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'finish',
        args: {
          needsMoreInfo: true,
          message:
            'Which config file should I modify — auth.config.ts or legacy.config.ts?',
          purpose: 'need a missing detail',
        },
        usage: {
          inputTokens: 60,
          outputTokens: 12,
          totalTokens: 72,
          cachedInputTokens: 0,
          totalPrice: 0.0006,
        },
      });
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'communication_exec',
        args: {
          agent: PEER_AGENT_NAME,
          message: 'Modify auth.config.ts — legacy.config.ts is deprecated.',
          purpose: 'answer the peer question',
        },
      });
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'finish',
        args: {
          needsMoreInfo: false,
          message: 'Done — modified auth.config.ts as instructed.',
          purpose: 'task complete',
        },
        usage: {
          inputTokens: 90,
          outputTokens: 14,
          totalTokens: 104,
          cachedInputTokens: 0,
          totalPrice: 0.0008,
        },
      });
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'finish',
        args: {
          needsMoreInfo: false,
          message: 'Config Specialist updated auth.config.ts.',
          purpose: 'done',
        },
      });

      await ensureGraphRunning(graphId);

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        graphId,
        TRIGGER_NODE_ID,
        {
          messages: [
            'Coordinate with the Config Specialist to update the auth configuration.',
          ],
          async: false,
          threadSubId: uniqueThreadSubId('peer-askback'),
        },
      );

      const thread = await waitForThreadCompletion(execution.externalThreadId);

      // (1) The caller ANSWERED the peer itself — the thread completes Done, NOT
      // NeedMoreInfo. A NeedMoreInfo terminal would mean the caller escalated to
      // the user; Done proves the question was resolved in-session.
      expect(thread.status).toBe(ThreadStatus.Done);

      const messages = await getThreadMessages(execution.externalThreadId);

      // (2) The peer asked the caller: there are two communication_exec round
      // trips (ask + answer). Match by content, not position — getThreadMessages
      // does not guarantee the two tool results are in call order.
      const commContents = messages
        .filter(
          (m) =>
            m.message.role === 'tool' &&
            m.message.name === 'communication_exec',
        )
        .map((m) => m.message.content as Record<string, unknown>);
      expect(commContents.length).toBeGreaterThanOrEqual(2);

      // The ASK result carries needsMoreInfo + the actionable answer-or-escalate
      // directive that steers the caller to answer in-session.
      const askResult = commContents.find((c) => c.needsMoreInfo === true);
      expect(askResult).toBeDefined();
      expect(typeof askResult!.actionRequired).toBe('string');
      expect(askResult!.actionRequired as string).toContain(
        'communication_exec again',
      );

      // The COMPLETION result (peer resumed and finished, no more questions).
      const doneResult = commContents.find((c) => c.needsMoreInfo === false);
      expect(doneResult).toBeDefined();

      // (3) The peer RESUMED from its durable checkpoint: its second (resume)
      // LLM request carries BOTH the original task (only present if the
      // checkpoint history loaded) AND the caller's injected answer — proving it
      // continued from where it paused rather than starting fresh.
      const peerRequests = mockLlm
        .getRequests()
        .filter((r) => (r.systemMessage ?? '').includes(PEER_SENTINEL));
      expect(peerRequests.length).toBeGreaterThanOrEqual(2);

      const resumeContent = JSON.stringify(peerRequests.at(-1)?.messages ?? []);
      // This proof relies on the two tokens appearing in DIFFERENT turns:
      //   'auth configuration' — ONLY in the turn-1 task (the delegate message),
      //   'deprecated'         — ONLY in the turn-2 answer (the re-invoke).
      // A fresh (non-resumed) peer run would see ONLY the answer, so the presence
      // of the turn-1 task token is what discriminates a checkpoint resume from a
      // fresh run. Keep both tokens distinct-per-turn if these strings change.
      expect(resumeContent).toContain('auth configuration');
      expect(resumeContent).toContain('deprecated');
    },
  );

  it(
    'escalates to the user (thread NeedMoreInfo) when the caller cannot answer the peer itself',
    { timeout: 300_000 },
    async () => {
      const mockLlm = getMockLlm(app);

      /**
       * The complement of the answer path: the peer asks, but the caller cannot
       * resolve it and ESCALATES — finishing with needsMoreInfo and relaying the
       * peer's question. The thread terminates NeedMoreInfo (a user round-trip is
       * required), proving the answer-or-escalate fork has a working escalate arm.
       *
       *  Q0 CALLER — tool_search (load communication_exec)
       *  Q1 CALLER — communication_exec(peer, task)
       *  Q2 PEER   — finish(needsMoreInfo=true, question)   [peer pauses]
       *  Q3 CALLER — finish(needsMoreInfo=true, relay)      [caller escalates]
       */
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'tool_search',
        args: { query: 'communication' },
      });
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'communication_exec',
        args: {
          agent: PEER_AGENT_NAME,
          message:
            'Update the billing configuration to the new provider chosen by the customer.',
          purpose: 'delegate billing update',
        },
      });
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'finish',
        args: {
          needsMoreInfo: true,
          message:
            'Which billing provider did the customer choose? I have no record of it.',
          purpose: 'need a detail only the user knows',
        },
      });
      // The caller genuinely cannot answer (the choice is the user's) — escalate.
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'finish',
        args: {
          needsMoreInfo: true,
          message:
            'The Config Specialist needs to know which billing provider you chose. Which provider should it use?',
          purpose: 'escalate the peer question to the user',
        },
      });

      await ensureGraphRunning(graphId);

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        graphId,
        TRIGGER_NODE_ID,
        {
          messages: [
            'Coordinate with the Config Specialist to update the billing configuration.',
          ],
          async: false,
          threadSubId: uniqueThreadSubId('peer-escalate'),
        },
      );

      const thread = await waitForThreadCompletion(execution.externalThreadId);

      // The caller escalated — the thread terminates NeedMoreInfo (user input
      // required), NOT Done. This is the legitimate "cannot answer" outcome.
      expect(thread.status).toBe(ThreadStatus.NeedMoreInfo);

      const messages = await getThreadMessages(execution.externalThreadId);

      // The peer's question still surfaced to the caller with the answer-or-
      // escalate directive (the caller chose escalate over answer).
      const askResult = messages
        .filter(
          (m) =>
            m.message.role === 'tool' &&
            m.message.name === 'communication_exec',
        )
        .map((m) => m.message.content as Record<string, unknown>)
        .find((c) => c.needsMoreInfo === true);
      expect(askResult).toBeDefined();
      expect(typeof askResult!.actionRequired).toBe('string');
    },
  );

  it(
    'a mutual peer ask-back cycle terminates via the caller iteration bound rather than looping forever',
    { timeout: 300_000 },
    async () => {
      // A<->B ask-back cycle with NO bespoke cycle counter: the caller keeps
      // answering by re-invoking the peer (matcher), and the peer keeps asking
      // (matcher) — an infinite logical loop. The only thing that breaks it is
      // the caller's maxIterations -> LangGraph recursionLimit (the documented
      // cycle guard; see spec.md "As-Shipped Divergence"). A small caller bound
      // (6) fires well before the peer's (30), so the run terminates
      // deterministically instead of hanging — reaching the assertion below
      // (rather than the it() timeout) is itself the bounded-cycle proof.
      const mockLlm = getMockLlm(app);

      // The caller's first turn loads the deferred communication_exec tool
      // (FIFO, consumed before matchers); every later caller turn re-invokes the
      // peer, and every peer turn asks again — driven by content-stable matchers
      // so the loop has no natural end.
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'tool_search',
        args: { query: 'communication' },
      });
      mockLlm.onChat(
        { systemMessage: CYCLE_CALLER_SENTINEL },
        {
          kind: 'toolCall',
          toolName: 'communication_exec',
          args: {
            agent: PEER_AGENT_NAME,
            message:
              'Here is the detail you asked for; continue and tell me if you need anything else.',
            purpose: 'answer the peer and keep going',
          },
        },
      );
      mockLlm.onChat(
        { systemMessage: PEER_SENTINEL },
        {
          kind: 'toolCall',
          toolName: 'finish',
          args: {
            needsMoreInfo: true,
            message:
              'I need one more detail before I can proceed — which value should I use?',
            purpose: 'keep asking the caller',
          },
        },
      );

      const cycleGraph = await graphsService.create(
        contextDataStorage,
        createCycleGraphData(),
      );

      try {
        await graphsService.run(contextDataStorage, cycleGraph.id);
        await waitForGraphStatus(cycleGraph.id, GraphStatus.Running);

        // async:false: the caller's recursion-limit error propagates out of
        // executeTrigger (simple-agent re-throws it; graphs.service rethrows
        // after rolling the thread row back). The cycle is bounded if EITHER the
        // call rejects with a recursion error OR (defensive) it resolves and the
        // thread settled to a terminal status — never left Running, which a
        // genuinely unbounded loop would do (and would have timed out first).
        let threw = false;
        let externalThreadId: string | undefined;
        try {
          const execution = await graphsService.executeTrigger(
            contextDataStorage,
            cycleGraph.id,
            TRIGGER_NODE_ID,
            {
              messages: [
                'Coordinate with the Config Specialist; keep answering its questions until the task is done.',
              ],
              async: false,
              threadSubId: uniqueThreadSubId('peer-cycle'),
            },
          );
          externalThreadId = execution.externalThreadId;
        } catch (error: unknown) {
          threw = true;
          // The bound fired — distinguish a real recursion-limit stop from a
          // mock-setup miss (a MockLlmNoMatchError would also reject here).
          expect((error as Error).message).toMatch(/recursion limit/i);
        }

        if (!threw) {
          const thread = await waitForThreadCompletion(externalThreadId!);
          expect(thread.status).not.toBe(ThreadStatus.Running);
        }
      } finally {
        await cleanupGraph(cycleGraph.id);
      }
    },
  );

  it(
    'runs the same peer as independent conversations when delegated under different session labels',
    { timeout: 300_000 },
    async () => {
      // Two communication_exec calls to the SAME peer node, each with a distinct
      // `session` label ("plan" then "implement"). Each label scopes an
      // independent callee conversation (distinct effective thread id →
      // distinct checkpoint), so the implement turn must NOT carry the plan
      // turn's history. Pre-session behavior (one rolling conversation per node)
      // would resume the plan checkpoint and leak TASK_ALPHA into the implement
      // turn — this proves the separation end-to-end through real persistence.
      const mockLlm = getMockLlm(app);

      /**
       * FIFO (single-threaded graph execution order):
       *  Q0 CALLER — tool_search (load deferred communication_exec)
       *  Q1 CALLER — communication_exec(peer, TASK_ALPHA, session:'plan')
       *  Q2 PEER[plan]      — finish(needsMoreInfo=false)
       *  Q3 CALLER — communication_exec(peer, TASK_BETA, session:'implement')
       *  Q4 PEER[implement] — finish(needsMoreInfo=false)
       *  Q5 CALLER — finish(done)
       */
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'tool_search',
        args: { query: 'communication' },
      });
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'communication_exec',
        args: {
          agent: PEER_AGENT_NAME,
          message: 'TASK_ALPHA_TOKEN: draft the plan for the auth refactor.',
          purpose: 'delegate planning',
          session: 'plan',
        },
      });
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'finish',
        args: {
          needsMoreInfo: false,
          message: 'Plan drafted.',
          purpose: 'planning complete',
        },
      });
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'communication_exec',
        args: {
          agent: PEER_AGENT_NAME,
          message: 'TASK_BETA_TOKEN: implement the approved plan.',
          purpose: 'delegate implementation',
          session: 'implement',
        },
      });
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'finish',
        args: {
          needsMoreInfo: false,
          message: 'Implemented.',
          purpose: 'implementation complete',
        },
      });
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'finish',
        args: {
          needsMoreInfo: false,
          message: 'Plan and implementation both complete.',
          purpose: 'done',
        },
      });

      await ensureGraphRunning(graphId);

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        graphId,
        TRIGGER_NODE_ID,
        {
          messages: [
            'Plan then implement via the Config Specialist, using a separate thread for each phase.',
          ],
          async: false,
          threadSubId: uniqueThreadSubId('peer-sessions'),
        },
      );

      const thread = await waitForThreadCompletion(execution.externalThreadId);
      expect(thread.status).toBe(ThreadStatus.Done);

      const peerRequests = mockLlm
        .getRequests()
        .filter((r) => (r.systemMessage ?? '').includes(PEER_SENTINEL));
      // One LLM request per peer turn (each turn is a single finish call): the
      // plan turn first, the implement turn last.
      expect(peerRequests.length).toBeGreaterThanOrEqual(2);

      const planTurn = JSON.stringify(peerRequests[0]?.messages ?? []);
      const implementTurn = JSON.stringify(peerRequests.at(-1)?.messages ?? []);
      expect(planTurn).toContain('TASK_ALPHA_TOKEN');
      expect(implementTurn).toContain('TASK_BETA_TOKEN');
      // The independence proof: the implement conversation never saw the plan
      // task. If the two labels shared one conversation, the implement turn would
      // resume the plan checkpoint and TASK_ALPHA would appear here.
      expect(implementTurn).not.toContain('TASK_ALPHA_TOKEN');
    },
  );
});
