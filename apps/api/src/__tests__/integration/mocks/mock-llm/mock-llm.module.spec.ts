import { describe, expect, it } from 'vitest';

import { BaseAgent } from '../../../../v1/agents/services/agents/base-agent';
import { installBaseAgentPatch } from './mock-llm-patch.utils';

// Symbol used as the idempotency sentinel — must match the one in mock-llm-patch.utils.ts.
const PATCH_SENTINEL = Symbol.for('geniro.mock-llm.base-agent-patch-installed');

interface PatchedProto {
  buildLLM: (model: unknown, params?: unknown) => unknown;
  [key: symbol]: boolean | undefined;
}

describe('installBaseAgentPatch', () => {
  // Note on test isolation: `installBaseAgentPatch` patches BaseAgent.prototype
  // at the process level. Because Vitest shares a single module registry per
  // worker, the patch may already be installed before these tests run (e.g. if
  // another spec file or the integration test setup.ts imported and called it
  // first). Resetting the patch between tests is intentionally avoided — doing
  // so would leave other specs in an inconsistent state. Instead:
  //   - Test (a) verifies that after a call to installBaseAgentPatch() the
  //     prototype's buildLLM is the mock implementation (sentinel present).
  //   - Test (b) verifies idempotency: a second call leaves the reference unchanged.

  it('(a) after installBaseAgentPatch() BaseAgent.prototype.buildLLM is replaced and sentinel is set', () => {
    installBaseAgentPatch();

    const proto = (BaseAgent as unknown as { prototype: PatchedProto })
      .prototype;

    // The sentinel must be set — this proves the patch ran at least once.
    expect(proto[PATCH_SENTINEL]).toBe(true);

    // buildLLM must exist and be a function (the patched version).
    expect(typeof proto.buildLLM).toBe('function');
    expect(proto.buildLLM.name).toBe('patchedBuildLLM');
  });

  it('(b) calling installBaseAgentPatch() a second time is a no-op — buildLLM reference is unchanged', () => {
    // Ensure patch is installed
    installBaseAgentPatch();

    const proto = (BaseAgent as unknown as { prototype: PatchedProto })
      .prototype;
    const refBeforeSecondCall = proto.buildLLM;

    // Second call — must not replace the reference again
    installBaseAgentPatch();

    expect(proto.buildLLM).toBe(refBeforeSecondCall);
  });
});
