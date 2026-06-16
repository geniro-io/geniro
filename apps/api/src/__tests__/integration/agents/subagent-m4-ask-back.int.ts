import { randomUUID } from 'node:crypto';

import { HumanMessage } from '@langchain/core/messages';
import { INestApplication } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AskCallerTool } from '../../../v1/agent-tools/tools/common/subagents/ask-caller.tool';
import { BaseAgentConfigurable } from '../../../v1/agents/agents.types';
import { SubAgent } from '../../../v1/agents/services/agents/sub-agent';
import { LiteLlmClient } from '../../../v1/litellm/services/litellm.client';
import { ThreadNameGeneratorService } from '../../../v1/threads/services/thread-name-generator.service';
import {
  mockLiteLlmClient,
  mockThreadNameGenerator,
} from '../helpers/test-stubs';
import { getMockLlm } from '../mocks/mock-llm';
import { createTestModule } from '../setup';

/**
 * M4 subagent ask-back — durable suspend/resume.
 *
 * Exercises the load-bearing mechanic at the SubAgent level: a subagent that
 * calls `ask_caller` durably SUSPENDS at the question (its conversation is
 * persisted to the pg-checkpoint keyed by the durable thread id), and a SEPARATE
 * SubAgent instance resumes that exact checkpoint with the caller's answer and
 * completes — proving the durable round-trip survives the transient subagent
 * being rebuilt (as it is when `answer_callee` reconstructs it on a later turn).
 */
const INVOKE_MODEL = 'gpt-5-mini';

const SUBAGENT_INSTRUCTIONS =
  'You are a subagent. If a required detail is missing, ask your caller via the ' +
  'ask_caller tool; otherwise complete the task and reply with a short text result.';

describe('Subagent M4 ask-back (durable suspend/resume)', () => {
  let app: INestApplication;
  let moduleRef: ModuleRef;

  beforeAll(async () => {
    app = await createTestModule(async (m) =>
      m
        .overrideProvider(LiteLlmClient)
        .useValue(mockLiteLlmClient)
        .overrideProvider(ThreadNameGeneratorService)
        .useValue(mockThreadNameGenerator)
        .compile(),
    );
    moduleRef = app.get(ModuleRef);
  }, 300_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    getMockLlm(app).reset();
  });

  const buildSubagent = async (): Promise<SubAgent> => {
    const subAgent = await moduleRef.resolve(SubAgent, undefined, {
      strict: false,
    });
    subAgent.setConfig({
      instructions: SUBAGENT_INSTRUCTIONS,
      invokeModelName: INVOKE_MODEL,
      maxIterations: 10,
    });
    const askCaller = app.get(AskCallerTool);
    subAgent.addTool(askCaller.build({}));
    return subAgent;
  };

  const runnableConfig = (): {
    configurable: BaseAgentConfigurable;
  } => ({
    // Minimal config — the subagent generates its own (durable) thread id; no
    // parent inter-agent flags are needed for a direct SubAgent run.
    configurable: {} as BaseAgentConfigurable,
  });

  it(
    'suspends at an ask_caller question and resumes from the durable checkpoint with the answer',
    { timeout: 120_000 },
    async () => {
      const mockLlm = getMockLlm(app);

      // Turn 1 (initial run): the subagent asks its caller a question.
      mockLlm.queueChat({
        kind: 'toolCall',
        toolName: 'ask_caller',
        args: {
          purpose: 'need a missing detail',
          question: 'Which config file should I modify, A or B?',
        },
        usage: {
          inputTokens: 50,
          outputTokens: 10,
          totalTokens: 60,
          cachedInputTokens: 0,
          totalPrice: 0.0005,
        },
      });
      // Turn 2 (after resume): the subagent completes with a text result that
      // references the answer, proving the resumed run saw it.
      mockLlm.queueChat({
        kind: 'text',
        content: 'Done — modified config file A as you instructed.',
        usage: {
          inputTokens: 70,
          outputTokens: 12,
          totalTokens: 82,
          cachedInputTokens: 0,
          totalPrice: 0.0007,
        },
      });

      const durableThreadId = `subagent-askback-${randomUUID()}`;

      // Initial run — must suspend with a question, NOT complete.
      const subAgent1 = await buildSubagent();
      const suspended = await subAgent1.runSubagent(
        [
          new HumanMessage(
            'Update the auth config. If unsure which file, ask me.',
          ),
        ],
        runnableConfig(),
        { durableThreadId },
      );

      expect(suspended.needsAnswer).toBeDefined();
      expect(suspended.needsAnswer?.question).toContain('config file');
      // The suspend handle is the durable thread id we supplied.
      expect(suspended.needsAnswer?.suspendId).toBe(durableThreadId);
      // The subagent's pre-pause spend is reported so the caller can fold it.
      expect(suspended.statistics.usage?.totalPrice).toBeCloseTo(0.0005, 6);

      // Resume on a FRESH SubAgent instance (as answer_callee does) from the
      // same durable checkpoint, delivering the caller's answer.
      const subAgent2 = await buildSubagent();
      const completed = await subAgent2.resumeSubagent(
        durableThreadId,
        'Modify config file A — B is deprecated.',
        runnableConfig(),
      );

      // Now it completes — no further question — with the post-answer result.
      expect(completed.needsAnswer).toBeUndefined();
      expect(completed.error).toBeUndefined();
      expect(completed.result).toContain('config file A');
      // The resume turn's own spend is reported (folds at answer_callee time).
      expect(completed.statistics.usage?.totalPrice).toBeCloseTo(0.0007, 6);

      // Prove the durable pg-checkpoint actually LOADED on resume: the resumed
      // LLM request must carry the ORIGINAL conversation (the turn-1 task + the
      // ask_caller turn), not just the freshly-appended answer. The FIFO mock
      // would still serve the canned reply on an EMPTY resumed conversation, so
      // the result assertion alone cannot catch a checkpoint that failed to
      // load — this pins the round-trip.
      const requests = mockLlm.getRequests();
      expect(requests.length).toBeGreaterThanOrEqual(2);
      const resumeContent = JSON.stringify(requests.at(-1)?.messages ?? []);
      // From the turn-1 task (only present if the checkpoint history loaded):
      expect(resumeContent).toContain('auth config');
      // The injected caller answer that resumed the run:
      expect(resumeContent).toContain('answered your question');
    },
  );

  it(
    'completes normally (no needsAnswer) when the subagent never calls ask_caller',
    { timeout: 120_000 },
    async () => {
      const mockLlm = getMockLlm(app);
      mockLlm.queueChat({
        kind: 'text',
        content: 'Task complete — no questions needed.',
      });

      const subAgent = await buildSubagent();
      const result = await subAgent.runSubagent(
        [new HumanMessage('Say the task is complete.')],
        runnableConfig(),
        { durableThreadId: `subagent-noask-${randomUUID()}` },
      );

      expect(result.needsAnswer).toBeUndefined();
      expect(result.result).toContain('complete');
    },
  );
});
