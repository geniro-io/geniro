# WS Replay Harness

Storybook harness for replaying recorded WebSocket event sequences through the production `useChatsWebSocket` + `useChatsUsageStats` + `ThreadMessagesView` reducer path. Used to reproduce intermittent cost-display regressions in isolation.

## Fixtures

Fixtures live in `./fixtures/*.json`. The loader `./fixture-schema.ts` validates every fixture via Zod at import time — invalid JSON throws a filename + issue list with NO payload echo (per `.claude/rules/zod-schemas.md`).

### Current fixtures

- `three-subagent-batch.json` — 28-event 3-subagent batch on `openai/gpt-5.4-mini`. Models the `b86d6ee3` regression (interleaved `agent.message` additive cost + `agent.state.update` currentContext replace). Expected total cost: $0.102.

## Recording a new fixture

### 1. Capture the message stream from Postgres

Connect to the dev database and run:

```sql
SELECT
  id,
  message,
  node_id,
  request_token_usage,
  tool_token_usage,
  external_thread_id,
  created_at
FROM messages
WHERE thread_id = '<target-thread-uuid>'
ORDER BY created_at;
```

### 2. Capture the `agent.state.update` events

Server-side `agent.state.update` notifications are emitted by the `notifications` module at `apps/api/src/v1/notifications/`. To capture them, enable debug logging on that module during a replay run, then transform the logs into the fixture event shape. See the Zod schemas in `./fixture-schema.ts` for the exact per-type shape.

### 3. Assemble the fixture

Combine messages and state updates into a single ordered array:

```json
{
  "name": "<descriptive-name>",
  "description": "<what this fixture tests>",
  "threadId": "<synthetic or real thread id>",
  "graphId": "<synthetic or real graph id>",
  "events": [
    { "delayMs": <number>, "event": { "type": "...", ... } },
    ...
  ]
}
```

### 4. Register in `WSReplayHarnessSection.tsx`

Add an `import` and extend `FIXTURE_MAP`.

## Test matrix

Per `.claude/rules/cost-accounting.md` § "Test matrix requirements", each fixture should cover at least one of:

| Scenario                                                    | three-subagent-batch                        |
| ----------------------------------------------------------- | ------------------------------------------- |
| All priced running                                          | ✓                                           |
| All priced done                                             | ✓                                           |
| Checkpoint empty, messages populated                        | — (WS events don't include checkpoint seed) |
| Running→done transition                                     | ✓ (final `thread.update` with status=done)  |
| Mixed `agent.message` + `agent.state.update` during running | ✓ (oscillation points 1 & 2)                |

Document in each new fixture's `description` field which scenarios it exercises.

## Deferred coverage

- **Thread-switch during running state** — the `.claude/rules/cost-accounting.md` test matrix lists this scenario, but the current harness renders a single seeded thread. Covering it requires a 2-thread fixture + a thread-selector control in `WSReplayHarnessSection.tsx`. Not part of H4's initial scope; track as a follow-up if intermittent thread-switch cost leaks surface.
