# Sandbox Trust Boundary

Rules for code that consumes data produced inside sandbox runtimes (bridge stdout frames, exec output) — `apps/api/src/v1/agents/services/claude/**`, `packages/claude-bridge/**`, and any future sandbox-bridged agent.

## Every nesting level is untrusted

All data arriving from a sandbox is untrusted bytes: any process in the container (running user-supplied code as root) can write to the bridge's stdout fd. A thrown property access inside a stream `'data'` handler is uncaught in the API process — guard structurally at EVERY level before touching properties:

1. **JSON line level** — `JSON.parse` returning `null` or a scalar is *valid JSON* and passes an invalid-line callback; check object-ness before reading `.type`. Exemplar: `claude-bridge-transport.ts` `handleEvent` non-object guard.
2. **Message envelope level** — `typeof message.message === 'object' && message.message !== null` before dereferencing nested payloads. Exemplar: `claude-stream-mapper.ts` `onSdkMessage` assistant/user guard.
3. **Content block level** — `Array.isArray(content)` plus per-element object checks; skip garbage elements, keep valid ones. Exemplar: `claude-stream-mapper.ts` `onAssistant` block filter.

The wire types in `packages/claude-bridge/src/protocol.types.ts` are compile-time only — they provide **zero runtime safety**. A new frame kind or block type added to the protocol MUST come with guards at all three levels and a crafted-frame test (see `claude-bridge-transport.spec.ts` "trust boundary" tests, `claude-stream-mapper.spec.ts` crafted-content tests).

## Logging

Never log raw frames or sandbox-derived URLs/strings verbatim — they can carry user message content or embedded credentials. Redact before logging (exemplar: `redactGitUrl` in `claude-session.utils.ts`); truncate frame echoes (`slice(0, 200)`).
