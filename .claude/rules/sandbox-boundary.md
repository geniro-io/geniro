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

## Host-only secret markers (template schema)

A graph-template field can carry one of two secret-picker markers, and they sit on OPPOSITE sides of the trust boundary even though they render the same picker widget:

- `x-ui:secret-select` / `x-ui:secret-multi-select` — a SANDBOX secret. `graph-compiler.ts` `collectSecretNames` resolves it and injects the value into the connected runtime's generic `secretEnv` (`addEnvVariables`). It is meant to reach the sandbox.
- `x-ui:secret-select-host` — a HOST-ONLY credential (e.g. the Claude Agent BYO Anthropic key). It is resolved host-side into the node's own session and must NEVER reach `collectSecretNames` / the generic `secretEnv`. Reusing the sandbox marker for a host-only credential would inject it into the runtime env — a trust-boundary regression the BYO spec rates HIGH.

Two invariants, enforced on opposite layers:

1. **Backend exclusion.** `collectSecretNames` matches ONLY `x-ui:secret-select` / `-multi-select`; a host-only marker is silently skipped. Adding a new host-only marker, or broadening the collection predicate (e.g. to `x-ui:secret-select*`), must keep the host marker out. Pin it with a graph-compiler test in which the excluded key RESOLVES to a non-undefined value, so the env-injection assertion (not just the resolver-call args) goes red on a leak — an unresolved key is filtered at injection and the test passes vacuously (see the exclusion-test rule in `.claude/rules/api-testing.md`).
2. **Client-side inclusion.** `GraphValidationService.checkSecretReferences` runs the "secret not found" pre-flight on the host-only marker TOO, so a missing/renamed ref is caught in the editor instead of failing opaquely host-side at run time.

Exemplars: `collectSecretNames` in `apps/api/src/v1/graphs/services/graph-compiler.ts` (+ the "excludes the host-only secret marker" test in `graph-compiler.spec.ts`); `checkSecretReferences` in `apps/web/src/services/GraphValidationService.ts` (+ `GraphValidationService.spec.ts`).

## External MCP on the Claude Agent node (creds-into-runtime)

The Claude bridge runs co-located INSIDE the thread's runtime, so the SDK can launch the existing Geniro MCP blocks (`custom` / `filesystem` / `playwright` / `jira`) as MCP children of the bridge process — there is no separate host-side MCP transport on this path. A Claude node collects its connected MCP output nodes at compile time (`claude-agent.template.ts` `configure()`), and at run() `ClaudeAgent.resolveExternalMcpServers` turns each into an SDK `mcpServers` entry that the bridge merges next to the in-bridge `geniro` server (`bridge.ts`). Reuse is **stdio-only** in M1: every block's `getMcpConfig` yields a `{command,args,env}` the SDK spawns in-runtime (the `custom` URL mode wraps a remote endpoint via `npx mcp-remote`, also stdio); remote `http` servers + their bearer-header validation arrive with the OAuth/Linear milestone.

Trust-boundary rules specific to this reuse:

1. **MCP credentials flow into the runtime, by design — accepted under trusted-runtimes.** A block's secrets (the `custom` block's `env` / URL-mode `--header` values, the `jira` block's API token) are baked into the stdio `{args,env}` the SDK spawns *inside* the runtime. That is the documented creds-into-runtime posture (`project_runtimes_trusted`): the server runs where the creds are needed. These creds use each block's **own** `x-ui:secret-select` (sandbox) mechanism — they must NEVER be routed through `x-ui:secret-select-host` / `collectSecretNames` (see the Host-only secret markers section above); the host-only marker is for credentials that must stay host-side (the BYO Anthropic key), the opposite side of this boundary.
2. **Resolve each block against the CLAUDE node's runtime, not the block's own.** `getMcpConfig` reads the runtime from the block's internal `runtimeThreadProvider` state (e.g. the `filesystem` block derives its workdir from it), so `BaseMcp.resolveServerConfigForRuntime` re-points the block at the Claude runtime BEFORE the call and restores the prior binding immediately after (a block wired to BOTH a SimpleAgent and a Claude node is shared; the restore keeps the other consumer's binding intact). The MCP node still requires its own Runtime edge (option-a: the `:108` Runtime-required throw is unchanged); the run()-time re-point handles the cross-runtime case.
3. **Skip-bad-server, redact on the way out.** External MCP is additive — a single block that fails to resolve (missing command, daemon-not-ready) is logged through `sanitizeSandboxError` and skipped, never aborting the run. Any error text that could carry a sandbox-derived value is redacted before logging (the Logging rule above applies).

Exemplars: `resolveExternalMcpServers` / `resolveServerConfigForRuntime` (`claude-agent.ts`, `base-mcp.ts`); merge guard + reuse tests in `bridge.spec.ts` ("bridge mcpServers merge") and `claude-mcp.int.ts`.
