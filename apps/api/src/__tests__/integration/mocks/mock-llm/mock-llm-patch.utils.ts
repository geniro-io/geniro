import { BaseAgent } from '../../../../v1/agents/services/agents/base-agent';
import { MockChatOpenAI } from './mock-chat-openai';
import { getMockLlmService } from './mock-llm-singleton.utils';

// Symbol used as an idempotency sentinel on `BaseAgent.prototype`.
// Uses `Symbol.for` so the same symbol is shared across module re-evaluations.
const PATCH_SENTINEL = Symbol.for('geniro.mock-llm.base-agent-patch-installed');

// Symbol that holds the pre-patch `buildLLM` so `uninstallBaseAgentPatch`
// can restore the original. `Symbol.for` keeps the slot stable across HMR /
// repeated module loads.
const ORIGINAL_BUILD_LLM = Symbol.for(
  'geniro.mock-llm.base-agent-original-build-llm',
);

type BuildLLMFn = (model: unknown, params?: unknown) => unknown;

interface PatchableBaseAgentPrototype {
  buildLLM: BuildLLMFn;
  [PATCH_SENTINEL]?: true;
  [ORIGINAL_BUILD_LLM]?: BuildLLMFn;
}

/**
 * Replace `BaseAgent.prototype.buildLLM` with a mock implementation backed
 * by `MockChatOpenAI`. Safe to call multiple times — subsequent calls are
 * no-ops (idempotent via `PATCH_SENTINEL`).
 *
 * The getter reference `getMockLlmService` (not a call) is passed to
 * `MockChatOpenAI` so service resolution is deferred to call time, matching
 * how `MockChatOpenAI`'s constructor is designed.
 */
export function installBaseAgentPatch(): void {
  const proto = (
    BaseAgent as unknown as { prototype: PatchableBaseAgentPrototype }
  ).prototype;

  if (proto[PATCH_SENTINEL]) {
    return;
  }

  proto[ORIGINAL_BUILD_LLM] = proto.buildLLM;

  proto.buildLLM = function patchedBuildLLM(
    model: unknown,
    params?: unknown,
  ): MockChatOpenAI {
    return new MockChatOpenAI(getMockLlmService, {
      model: String(model),
      params,
    });
  };

  proto[PATCH_SENTINEL] = true;
}

/**
 * Restore the pre-patch `BaseAgent.prototype.buildLLM`. Use this in test
 * files that bring their own LLM mocking strategy (e.g. `vi.spyOn` against
 * `ChatOpenAI.prototype.bindTools`) and need real `ChatOpenAI` instances.
 * Safe to call when the patch isn't installed — subsequent calls are no-ops.
 *
 * Pair with `installBaseAgentPatch()` in `afterAll` to leave the global
 * fixture in the same state for subsequent test files.
 */
export function uninstallBaseAgentPatch(): void {
  const proto = (
    BaseAgent as unknown as { prototype: PatchableBaseAgentPrototype }
  ).prototype;

  if (!proto[PATCH_SENTINEL]) {
    return;
  }

  const original = proto[ORIGINAL_BUILD_LLM];
  if (original) {
    proto.buildLLM = original;
    delete proto[ORIGINAL_BUILD_LLM];
  }
  delete proto[PATCH_SENTINEL];
}
