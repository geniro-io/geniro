import { RunnableConfig } from '@langchain/core/runnables';
import { describe, expect, it } from 'vitest';

import { RequestTokenUsage } from '../../../litellm/litellm.types';
import { BaseAgentConfigurable, BaseAgentState } from '../../agents.types';
import { AgentOutput, BaseAgent } from './base-agent';

// Minimal concrete subclass to expose the protected method under test.
class TestAgent extends BaseAgent<unknown> {
  public extract(state: BaseAgentState): RequestTokenUsage | null {
    return this.extractUsageFromState(state);
  }

  public async run(
    _threadId: string,
    _messages: never[],
    _config?: unknown,
    _runnableConfig?: RunnableConfig<BaseAgentConfigurable>,
  ): Promise<AgentOutput> {
    return { messages: [], threadId: _threadId };
  }

  public async stop(): Promise<void> {}

  public setConfig(_config: unknown): void {}

  public getConfig(): unknown {
    return {};
  }
}

function makeState(overrides: Partial<BaseAgentState> = {}): BaseAgentState {
  return {
    messages: [],
    summary: '',
    toolsMetadata: {},
    toolUsageGuardActivated: false,
    toolUsageGuardActivatedCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    totalPrice: 0,
    currentContext: 0,
    ...overrides,
  };
}

describe('BaseAgent.extractUsageFromState', () => {
  const agent = new TestAgent();

  // Scenario: all counters zero → no tokens consumed → return null.
  // Expected: PASS (current code returns null when hasAny is false).
  it('returns null when all token counters are zero', () => {
    const state = makeState();
    const result = agent.extract(state);
    expect(result).toBeNull();
  });
});
