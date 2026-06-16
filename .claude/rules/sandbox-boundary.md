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

## Injecting credentials into a session

The host↔sandbox boundary has an INPUT side too. A credential resolved from the secrets store (or any external store) and injected into a session env var or HTTP-header surface (e.g. `ANTHROPIC_API_KEY`, `GH_TOKEN`) must be validated BEFORE injection, not left to fail opaquely at first use.

- **Trim first.** Store values commonly carry surrounding whitespace or a trailing newline (copy-paste / `echo`-piped). An env var consumed as an HTTP header value is corrupted by a stray newline — inject the trimmed value.
- **Require a non-empty body and reject embedded whitespace.** A degenerate prefix-only value carries no credential; a value with an internal space/newline is header-unsafe.
- **A shared prefix is not a sufficient discriminator.** When two credential classes share a prefix, exclude the disallowed class EXPLICITLY (and case-insensitively). Example: Anthropic Console API keys (`sk-ant-api…`) and subscription OAuth tokens (`sk-ant-oat…`) both start `sk-ant-`, so a bare `sk-ant-` check does not block the OAuth tokens it intends to.
- **Fail closed, naming only the secret.** On a validation failure throw a clear error that references the secret NAME, never its value (the output-side Logging rule above still applies to every sink the value could reach).

Exemplar: `resolveByoApiKey` in `apps/api/src/v1/agents/services/agents/claude-agent.ts`.
