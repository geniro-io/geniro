import { describe, expect, it } from 'vitest';

import type { LoadedFixture } from './fixture-schema';
import { parseFixture } from './fixture-schema';
import threeSubagentBatchRaw from './fixtures/three-subagent-batch.json';
import threeToolCallSubagentsRaw from './fixtures/three-tool-call-subagents.json';

const validFixture = {
  name: 'minimal',
  description: 'smoke',
  threadId: 'thread-1',
  graphId: 'graph-1',
  events: [
    {
      delayMs: 0,
      event: {
        type: 'agent.message',
        internalThreadId: 'thread-1',
        threadId: 'thread-1',
        nodeId: 'supervisor',
        graphId: 'graph-1',
        data: {
          id: 'msg-1',
          threadId: 'thread-1',
          createdAt: '2026-04-24T00:00:00Z',
          nodeId: 'supervisor',
          message: { role: 'ai', content: 'hello' },
          requestTokenUsage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            totalPrice: 0.001,
          },
        },
      },
    },
  ],
};

describe('parseFixture', () => {
  it('happy path: parses a minimal valid fixture and returns the correct event type', () => {
    const result: LoadedFixture = parseFixture(validFixture, 'minimal.json');
    expect(result.events[0].event.type).toBe('agent.message');
  });

  it('three-subagent-batch.json: full fixture parses without errors', () => {
    const result: LoadedFixture = parseFixture(
      threeSubagentBatchRaw,
      'three-subagent-batch.json',
    );
    expect(result.events.length).toBeGreaterThan(0);
  });

  it('three-tool-call-subagents.json: full fixture parses without errors and contains inFlightSubagentPrice events', () => {
    const result: LoadedFixture = parseFixture(
      threeToolCallSubagentsRaw,
      'three-tool-call-subagents.json',
    );
    expect(result.events.length).toBeGreaterThan(0);
    // Verify at least one agent.state.update event carries inFlightSubagentPrice.
    const stateUpdatesWithInFlight = result.events.filter(
      (e) =>
        e.event.type === 'agent.state.update' &&
        (e.event as { data?: { inFlightSubagentPrice?: unknown } }).data
          ?.inFlightSubagentPrice !== undefined,
    );
    expect(stateUpdatesWithInFlight.length).toBeGreaterThan(0);
  });

  it('missing `events` field: throws with filename and path in message', () => {
    const input: Record<string, unknown> = {
      name: 'x',
      description: 'y',
      threadId: 't',
      graphId: 'g',
    };

    let thrown: unknown;
    try {
      parseFixture(input, 'missing-events.json');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('missing-events.json');
    expect(message).toContain('events');
  });

  it('unknown event type: throws when event type is not in the discriminated union', () => {
    const input = {
      ...validFixture,
      events: [
        {
          delayMs: 0,
          event: {
            ...validFixture.events[0].event,
            type: 'agent.bogus',
          },
        },
      ],
    };

    expect(() => parseFixture(input, 'bogus-event.json')).toThrow();
  });

  it('no payload echo: error message does not contain secret data from failing event', () => {
    // Build a fixture whose event contains a secret in `data.message.content`
    // but is invalid because `type` is missing entirely (will fail EventSchema).
    const secretContent = 'SECRET-TOKEN-12345';
    const input = {
      name: 'secret-test',
      description: 'no-echo',
      threadId: 'thread-1',
      graphId: 'graph-1',
      events: [
        {
          delayMs: 0,
          event: {
            // Intentionally omit `type` to trigger a schema failure.
            internalThreadId: 'thread-1',
            threadId: 'thread-1',
            nodeId: 'supervisor',
            graphId: 'graph-1',
            data: {
              id: 'msg-2',
              threadId: 'thread-1',
              createdAt: '2026-04-24T00:00:00Z',
              nodeId: 'supervisor',
              message: { role: 'ai', content: secretContent },
            },
          },
        },
      ],
    };

    let thrown: unknown;
    try {
      parseFixture(input, 'secret.json');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(secretContent);
  });
});
