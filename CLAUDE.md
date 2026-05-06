# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

Geniro is an open-source platform for building, running, and managing AI agent workflows. Users design agents as visual graphs, connect them to tools (web search, shell, file ops, GitHub, knowledge base, MCP), and execute them in sandboxed Docker environments — all through a REST API with real-time WebSocket updates.

**Tech stack**: TypeScript 6.x, Node.js 24+, NestJS 11 (Fastify), MikroORM (PostgreSQL), React 19 (Vite), pnpm + Turbo monorepo

**Key domain entities**: Graphs, Agents, Threads, Messages, Checkpoints, Graph Templates, Knowledge Bases, Git Repositories, Revisions, Runtimes, Triggers

**External dependencies**: PostgreSQL, Redis (BullMQ), Qdrant (vector search), Keycloak (auth), LiteLLM (LLM proxy), Docker/Podman (sandboxed execution), optional Daytona (remote runtimes)

---

## Authoritative docs

The `/docs` directory is the single source of truth for architecture, style, and process rules. Read the relevant files there before writing or changing code. This file is a condensed version for quick reference.

---

## Commands

All commands run from the **repo root** unless noted otherwise.

**⚠️ IMPORTANT**: Before running any commands, always run `pnpm install` first to ensure all dependencies are installed.

### Daily development
```bash
pnpm install                          # Install dependencies
pnpm deps:up                          # Start all services (Postgres, Redis, Qdrant, Keycloak, LiteLLM, Daytona)
pnpm deps:up:full                     # Start all services including Zitadel
pnpm deps:down                        # Stop all services (including Zitadel)
cd apps/api && pnpm start:dev         # Dev server with hot-reload (port 5000)
```

### LiteLLM model configuration (gotcha)

`litellm.yaml` changes do **not** reach the running LiteLLM proxy until the container is restarted **AND** the yaml-DB reconciliation is triggered. The proxy runs with `store_model_in_db: true`, so its authoritative model table lives in Postgres — yaml additions only merge into that table on specific startup paths. Symptoms of drift: a graph configured with a model like `openai/gpt-5.4-mini` returns `totalPrice: 0` on every call because LiteLLM's `/model/info` does not list it.

- Check registered models: `curl -s http://localhost:4000/model/info -H "Authorization: Bearer master" | jq '.data[] | {name: .model_name, in: .model_info.input_cost_per_token, out: .model_info.output_cost_per_token}'`
- Look for zero-pricing entries — any `in: 0, out: 0` silently produces $0.000 cost reports in the UI.
- To resync yaml → DB: `docker compose restart litellm` (or `podman-compose`). If the alias still doesn't appear, add it via LiteLLM's management API (`POST /model/new`) or clear the DB model table and restart.

### Build & lint
```bash
pnpm build                            # Full monorepo build (Turbo)
pnpm build:tests                      # Compile test files (run after build)
pnpm lint:fix                         # Auto-fix lint + formatting
pnpm lint                             # Lint without fixing (to see remaining issues)
```

### Testing

**⚠️ CRITICAL**: Always use the `pnpm run` / `pnpm` package.json scripts to run tests. Never call test runners directly (e.g. `vitest`, `npx vitest`).

```bash
# ✅ CORRECT — always use package.json scripts
pnpm test:unit                        # Vitest unit tests (*.spec.ts) — mandatory
pnpm test:integration {filename}      # Target one integration file (preferred for iteration)
pnpm test:integration                 # Run the full integration suite (allowed — LLM calls are mocked via MockLlmService)

# ❌ WRONG — never call test runners directly
# vitest run
# npx vitest
# pnpm vitest run

# Iteration tip: target a specific file with `pnpm test:integration <file>` to keep the loop tight.
# The bulk run is fine for verification (e.g. before pushing). Files run in parallel
# (5 workers, each with its own per-worker DB clone); within a file tests still run sequentially.
# The setup always boots ephemeral Postgres/Redis/Qdrant testcontainers and runs migrations
# against the base DB before cloning per-worker databases.

# E2E (Cypress) — requires server running + deps up:
cd apps/api
pnpm test:e2e:generate-api            # Regenerate API types from Swagger (do this before E2E runs)
pnpm test:e2e:local --spec "cypress/e2e/path/to/spec.cy.ts"   # Single spec (preferred for iteration)
pnpm test:e2e:local                   # Full E2E suite (only for final verification)
```

### Mandatory before finishing any work
```bash
pnpm run full-check                   # build + build:tests + lint:fix + unit tests — must pass
```

### Database
```bash
cd apps/api
pnpm run migration:generate           # Auto-generate migration from entity changes — NEVER hand-write migrations
pnpm migration:run                    # Run all pending migrations (run before start:dev after pulling new code)
pnpm migration:revert                 # Revert last migration
pnpm seed:create                      # Create a new seed file
pnpm seed:run-all                     # Run all seeds in timestamp order
```

### Commits
```bash
pnpm commit                           # Conventional commit via commitizen (type(scope): message)
```

### Script flag note
Never use `--` as a separator when running pnpm scripts. Pass flags directly:
```bash
# ✅  pnpm test:e2e:local --spec "path"
# ❌  pnpm test:e2e:local -- --spec "path"
```

---

### Web Frontend (apps/web/)

**Tech Stack:** React 19 + Vite, Tailwind CSS, Radix UI (shadcn/ui), TypeScript, Socket.io, @xyflow/react

```bash
pnpm --filter @geniro/web dev          # Dev server (port 5174)
pnpm --filter @geniro/web build        # Production build
pnpm --filter @geniro/web generate:api # Regenerate API client from Swagger
```

#### Directory structure

```
apps/web/src/
├── autogenerated/       # OpenAPI-generated REST client (DO NOT EDIT MANUALLY)
├── components/          # Shared layout components (Header, Sidebar)
│   └── ui/              # Shared component library (MANDATORY — see rules below)
├── config/              # Environment configs (development.ts, production.ts)
├── hooks/               # useWebSocket and other React hooks
├── pages/
│   ├── graphs/          # Graph list, canvas, node editor, template sidebar, revision UI
│   ├── chats/           # Thread directory and chat panel
│   ├── repositories/    # Git repository management
│   ├── knowledge/       # Knowledge base editor
│   └── main/            # Dashboard
├── services/            # WebSocketService, GraphStorageService, validation helpers
└── utils/               # Thread utilities, validation helpers
```

#### Key architecture

- **Auth**: Keycloak SSO via `@react-keycloak/web`. Tokens propagate to both Axios REST calls and WebSocket connections.
- **Data layer**: Auto-generated API clients from OpenAPI spec (`src/autogenerated/`). Always regenerate after backend changes.
- **State**: `GraphStorageService` provides local persistence for canvas viewport/layout. `WebSocketService` multiplexes graph subscriptions.
- **Real-time**: Socket.io streams for graph compilation/deployment status, node execution state, agent message tokens (including streaming), revision lifecycle events, thread mutations. Subscribe via hooks: `useWebSocket`, `useGraphWebSocket`, `useThreadWebSocket`.

#### Core file locations

| Feature | Key files |
|---|---|
| Graph canvas | `src/pages/graphs/components/GraphCanvas.tsx`, `TemplateSidebar.tsx` |
| Node config | `src/pages/graphs/components/NodeEditSidebar.tsx` (JSON-schema driven via `@rjsf/core`) |
| Conversation hub | `src/pages/chats/`, `src/pages/graphs/components/ThreadMessagesView.tsx` |
| Revision diffs | `src/pages/graphs/components/RevisionDiffModal.tsx` |
| Validation | `src/services/GraphValidationService.ts` (template compatibility, connection rules) |
| WebSocket | `src/services/websocketService.ts`, `src/hooks/useWebSocket.ts` |

#### Component library — MANDATORY rules

All UI must be built exclusively from the shared component library in `src/components/ui/`.

1. **Only use components from `src/components/ui/`** — never create custom inline components that replicate existing UI primitives.
2. **No custom styled divs/spans when a component exists** — if `Badge`, `Card`, `Button`, etc. cover the use case, use them.
3. **Storybook is the source of truth** — documented at `src/pages/storybook/page.tsx`. Every component has a corresponding storybook section.
4. **Update the component first, then use it** — if a variant is missing, update `src/components/ui/` first, then its storybook section, then use it.
5. **Never diverge from storybook visuals** — if a page looks different from storybook, the page is wrong.

#### Development conventions

- **Styling**: Tailwind CSS with Radix UI primitives (shadcn/ui pattern). Utility-first CSS with `class-variance-authority` and `tailwind-merge`.
- **Code organization**: Feature-based structure under `src/pages/`. Shared services in `src/services/`. Types from autogenerated client.
- **API integration**: Import from `src/autogenerated/api`. Always regenerate after backend schema changes.

#### Known patterns

- **Adding a new graph node type**: Backend defines template schema -> `pnpm generate:api` -> update `CustomNode.tsx` if special rendering needed -> add validation rules in `validationService.ts`.
- **Adding real-time event handling**: Define handler in `WebSocketService` -> create hook in `useWebSocket.ts` -> subscribe in component with `useEffect` -> clean up on unmount.
- **Modifying canvas behavior**: Edit `GraphCanvas.tsx` for layout/interaction -> update `GraphStorageService` for persistence -> ensure viewport syncs with backend.

#### Testing

Component tests use Vitest + Testing Library + jsdom. Two repo-specific gotchas every component test must follow:

1. **`// @vitest-environment jsdom` pragma on line 1** — Vitest 4 removed `environmentMatchGlobs`, so the per-file pragma is the only mechanism. The default project environment is `node` (fast for utility tests under `*.spec.ts`); component tests under `*.spec.tsx` must opt into jsdom explicitly. Exemplar: `apps/web/src/components/ui/thread-blocks.spec.tsx:1`.

2. **`vi.mock` + module-scope spies → wrap in `vi.hoisted()`** — `vi.mock(...)` factories hoist above all module-scope `const` declarations, so a factory that closes over a bare `const navigate = vi.fn()` throws `ReferenceError: Cannot access 'navigate' before initialization`. Wrap shared mock spies in `vi.hoisted(() => ({ navigate: vi.fn(), ... }))` and destructure. Exemplars: `apps/web/src/pages/projects/list.spec.tsx`, `apps/web/src/contexts/ProjectContext.spec.tsx`.

Test files are co-located as `*.spec.{ts,tsx}` next to the source. Run `pnpm --filter @geniro/web test:unit <relative-path>` to target a single file (or no path for the whole web suite). The web `test:unit` script is wired into `pnpm full-check` and CI (`.github/workflows/test-unit.yaml`) automatically.

#### Configuration

Edit `src/config/development.ts` or `src/config/production.ts`:

| Key | Purpose | Default (dev) |
|---|---|---|
| `API_URL` | REST + WebSocket base URL | `http://localhost:5000` |
| `KEYCLOAK_URL` | SSO endpoint | `http://localhost:8082` |
| `KEYCLOAK_REALM` | Keycloak realm name | `geniro` |
| `KEYCLOAK_CLIENT_ID` | OAuth client ID | `geniro` |
| `WEBSITE_URL` | Client base URL | `http://localhost:3004` |

---

## Architecture overview

This is a **pnpm + Turbo monorepo**. The single application lives in `apps/api` (NestJS on Fastify). Shared libraries live in `packages/`.

```
apps/api/src/
├── main.ts                   # Entry point
├── app.module.ts             # Root NestJS module
├── v1/                       # Feature modules (see below)
├── db/
│   ├── migrations/           # MikroORM migrations
│   ├── seeds/                # Seed files (timestamped, run in order)
│   └── mikro-orm.config.ts
├── environments/             # Env loading (dotenv)
├── utils/                    # Shared utilities
└── __tests__/integration/    # Integration tests (*.int.ts)

packages/
├── common/      # Logger (Pino+Sentry), custom exception classes, bootstrapper
├── http-server/ # Fastify setup, Swagger, auth (Keycloak), middleware, request tracing
├── metrics/     # Prometheus integration
├── mikroorm/    # MikroORM config wrapper, base entities, NestJS module integration
└── cypress/     # Cypress helpers + API type generator (cy-generate-api)
```

### Layered architecture (per feature)

Each feature in `src/v1/<feature-name>/` follows a strict layer structure:

```
Controller  →  Service  →  DAO  →  Entity  →  PostgreSQL
(HTTP/validation)  (business logic)  (queries)  (ORM mapping)
```

```
src/v1/feature-name/
├── dto/                    # Zod-backed DTOs (all in one file per module)
├── entities/               # MikroORM entities
├── feature.controller.ts
├── feature.service.ts
├── feature.dao.ts
└── feature.module.ts
```

- **Controllers** are thin: route + validate only.
- **Services** own business logic and orchestrate DAOs.
- **DAOs** inject `EntityManager` from `@mikro-orm/postgresql`. Use `FilterQuery<T>` for type-safe filtering — avoid proliferating `findByX` methods. Only add specific methods when they involve complex joins/raw SQL.
- **DTOs** use Zod schemas with `createZodDto()` from `nestjs-zod`. Keep all DTOs for a module in a single file.
- **Entities** are MikroORM-decorated classes. Schema changes must go through `migration:generate`.

### Key modules in `src/v1/`

| Module | Role |
|---|---|
| `graphs` | Core: graph CRUD, execution lifecycle, versioning, schema compilation |
| `agents` | LangGraph-based agent runtime |
| `agent-tools` | Tool implementations: web search, shell, file ops, GitHub, codebase search |
| `agent-triggers` | Trigger execution (e.g. manual) |
| `threads` | Thread/message/checkpoint persistence |
| `graph-templates` | Pluggable node template registry |
| `runtime` | Docker-based isolated execution (Dockerode) |
| `notifications` | Socket.IO WebSocket event broadcasting |
| `knowledge` | Vector embeddings + semantic search (Qdrant) |
| `litellm` | LLM proxy integration |
| `git-repositories` | GitHub repo management (Octokit) |
| `agent-mcp` | Model Context Protocol server integration |
| `cache` | Redis caching layer |
| `qdrant` | Qdrant client wrapper |

### GitHub App integration (optional)

The GitHub App feature (`github-app` module) is the authentication method for GitHub integration. It is **optional** — when not configured, GitHub operations that require authentication will fail.

To enable, set these environment variables:
- `GITHUB_APP_ID` — the numeric App ID
- `GITHUB_APP_PRIVATE_KEY` — the PEM private key (literal `\n` sequences are converted to newlines at runtime)
- `GITHUB_APP_CLIENT_ID` — the OAuth Client ID (used for the install/authorize redirect flow)
- `GITHUB_APP_CLIENT_SECRET` — the OAuth Client Secret (used to exchange authorization codes for tokens)

When all four are set, the `GET /api/system/settings` endpoint returns `githubAppEnabled: true`, and users can link GitHub App installations to their accounts via the OAuth flow. When not set, `githubAppEnabled` is `false` and GitHub operations that require authentication will not be available.

### Cross-cutting infrastructure

- **Auth**: Keycloak-backed. `AuthContextService` provides the current user. Dev-mode bypass available via `AUTH_DEV_MODE=true`.
- **Real-time**: Socket.IO for pushing graph/thread lifecycle events to clients.
- **Task queue**: BullMQ (Redis) for async work like revision processing and knowledge reindexing.
- **Observability**: Pino structured logging, Prometheus metrics at `/metrics`, optional Sentry.
- **Vector search**: Qdrant stores knowledge chunk embeddings; queries use `text-embedding-3-small` via LiteLLM.
- **LLM routing**: All model calls go through a local LiteLLM proxy (port 4000). Supports OpenAI, and Ollama for offline use.

---

## Coding conventions

- **No `any`** — use specific types, generics, or `unknown` + type guards.
- **No inline imports** — all imports at the top of the file.
- **Naming**: PascalCase for classes/interfaces/enums/types; camelCase for variables/functions; PascalCase for enum members.
- **Errors**: Throw custom exceptions from `@packages/common` (e.g. `NotFoundException`, `BadRequestException`). Never swallow errors silently.
- **Migrations**: Always `pnpm run migration:generate`. Never hand-write migration files. Run `pnpm migration:run` to apply pending migrations. **Known drift exception**: the generator consistently emits unrelated `runtime_instances` enum/CHECK-constraint changes alongside any intended migration (pre-existing mismatch between native-ENUM entity and CHECK-constraint dev schemas). When this happens, hand-edit the generated file to remove only the `runtime_instances` statements, keep the intended SQL, and add a header comment pointing at `.geniro/knowledge/gotchas/instruction-assembly-gotchas.jsonl` entry G4.
- **Generated files**: Never manually edit `cypress/api-definitions/` — regenerate with `pnpm test:e2e:generate-api`.
- **Imports**: Shared packages are aliased as `@packages/*` (e.g. `import { … } from '@packages/common'`).
- **Agent tool definitions**: All tools in `agent-tools/` must follow the best practices in `/docs/tool-definitions-best-practices.md` and the [official Anthropic tool use guide](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use#best-practices-for-tool-definitions). Descriptions must be detailed (3-4+ sentences), parameters must have clear `.describe()` strings, and `getDetailedInstructions()` must carry all heavy guidance. Read the docs file before creating or modifying any tool.
- **Tool and agent instructions must be generic**: Tool descriptions, `getDetailedInstructions()`, subagent system prompts (in `subagent-definitions.ts`), and agent templates must never contain repo-specific content. This includes: specific package manager commands (e.g. `pnpm run full-check`), specific tool names as if they are the only option (e.g. `turbo`, `vitest`), hardcoded instruction file names (e.g. `CLAUDE.md`), or project-specific directory paths (e.g. `apps/api/src/v1`). Repo-specific rules are injected dynamically at runtime via the `agentInstructions` field from `gh_clone`. Instructions should reference "the repository's instruction file" or "the `agentInstructions` field from `gh_clone`" — not specific filenames or commands. Examples in instructions should use generic placeholders (e.g. `npm install`, `npm test`, `<repo>/src/...`).

---

## Testing conventions

- **Always use package.json scripts**: Run tests via `pnpm test:unit`, `pnpm test:integration {filename}`, etc. **Never** invoke test runners directly (`vitest`, `npx vitest`, `pnpm vitest run`).
- **Iteration vs verification**: `pnpm test` (everything) is forbidden — too coarse. `pnpm test:integration` (whole integration suite) is **allowed** because LLM calls are mocked via `MockLlmService`. Prefer the targeted form `pnpm test:integration {filename}` while iterating; the bulk form is for pre-push verification.
- **Unit tests** (`*.spec.ts`): placed next to the source file. Run with `pnpm test:unit`. Prefer updating an existing spec file over creating a new one.
- **Integration tests** (`*.int.ts`): in `src/__tests__/integration/`. Call services directly (no HTTP). **Mandatory** when modifying code that already has integration tests — run with a specific filename while iterating, run `pnpm test:integration` to verify the suite.
- **E2E tests** (`*.cy.ts`): in `apps/api/cypress/e2e/`. Smoke-test endpoints over HTTP. Require a running server + deps.
- **E2E type safety**: When creating or modifying E2E tests, always regenerate API type definitions first (`cd apps/api && pnpm test:e2e:generate-api`). E2E helpers and tests **must** import request/response types from `../../api-definitions` (e.g. `import type { GraphDto, GetAllGraphsData } from '../../api-definitions'`) instead of defining inline types. Use the generated `*Data['query']` types for query parameters and the generated `*Dto` types for response bodies.
- **Must-fail policy**: Tests must never conditionally skip based on missing env vars or services. If a prerequisite is absent, the test must fail with a clear error — no `it.skip` or early returns.
- **Coverage thresholds** (when enabled): 90% lines/functions/statements, 80% branches.
- **E2E logging**: use `cy.task('log', message)` to print to terminal output.

### Mocking the LLM in integration tests

All integration tests **always** mock the LLM — there is no opt-out flag and no real-LLM mode. The mock is wired into `createTestModule()` automatically and covers two seams: `OpenaiService` (via NestJS DI override) and `BaseAgent.prototype.buildLLM` (via process-level patch).

**Import:** `import { getMockLlm, applyDefaults, MockLlmNoMatchError } from '../mocks/mock-llm';` (path relative to test location).

**API surface:**
```typescript
const mockLlm = getMockLlm(app);

// Register matcher-based fixtures (returns first match from filters):
mockLlm.onChat(matcher, reply);
mockLlm.onJsonRequest(matcher, reply);
mockLlm.onEmbeddings(matcher, reply);

// Queue FIFO replies (consumed before matchers, ignores matchers):
mockLlm.queueChat(reply);
mockLlm.queueCost(usd);  // sugar: text reply with totalPrice

// Inspect:
mockLlm.getRequests();    // ordered request log
mockLlm.getLastRequest();

// Test cleanup (call in beforeEach):
mockLlm.reset();
```

**Matcher fields:** `model` (string or RegExp), `lastUserMessage` (string-includes or RegExp), `systemMessage` (string-includes or RegExp), `hasTools` (string[] subset match), `hasToolResult` (string exact match), `callIndex` (number). No match throws `MockLlmNoMatchError` with context (model, call index, message, tool names, registered matchers).

**Specificity & multi-turn gotcha:** Fixtures are resolved by specificity (count of non-undefined matcher fields). Ties are broken by registration order. When agent loops `callTool → toolResult → followUp`, fixtures with `{ hasTools: ['T'] }` and `{ hasToolResult: 'T' }` both have specificity 1 and tie. To disambiguate, combine matchers: `{ hasToolResult: 'T', hasTools: ['finish'] }` (specificity 2).

**Tool-call fixture args MUST satisfy the real tool's Zod schema** — e.g., a `finish` tool fixture requires `{ purpose: string, message: string, needsMoreInfo?: boolean }` (not `{ result: 'done' }`). The mock will pass schema validation through to the real tool registry; mismatched args silently break tool dispatch.

**Apply defaults (optional):** `applyDefaults(mockLlm)` registers benign defaults: a finish-tool fallback, a catch-all text reply, and deterministic embeddings. Apply AFTER per-test fixtures or the catch-all swallows them.

**Limitations:** Code paths requiring real LLM behavior (e.g. `ReasoningAwareChatCompletions` normalization, token-stream timing, retry/backoff) must be covered by unit tests, not integration tests.

