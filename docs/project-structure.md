# Project Structure and Description

This document describes the Geniro API project structure and architectural patterns.

## Overview

This is a monorepo project containing a NestJS-based API application and shared packages.

## Monorepo Structure

```
geniro/
├── apps/
│   └── api/              # Main API application
├── packages/             # Shared libraries and utilities
│   ├── common/          # Common utilities and exceptions
│   ├── cypress/         # Cypress testing utilities
│   ├── http-server/     # HTTP server setup and middleware
│   ├── metrics/         # Metrics and monitoring
│   └── mikroorm/        # MikroORM utilities and configurations
├── scripts/             # Utility scripts
└── .docker/             # Docker configuration files
```

## Application Architecture

The API follows a layered architecture pattern:

### 1. Controllers
- Handle HTTP requests and responses
- Located in feature directories (e.g., `src/v1/users/users.controller.ts`)
- Use decorators for routing and validation
- Should be thin - delegate business logic to services

### 2. Services
- Contain business logic
- Located in feature directories (e.g., `src/v1/users/users.service.ts`)
- Orchestrate operations between DAOs
- Handle complex business rules and validations

### 3. DAOs (Data Access Objects)
- Handle database operations
- Located in feature directories (e.g., `src/v1/users/users.dao.ts`)
- Use MikroORM EntityManager
- Provide methods for CRUD operations and queries

### 4. DTOs (Data Transfer Objects)
- Define data structures for API requests/responses
- Located in feature directories (e.g., `src/v1/users/dto/`)
- Use Zod schemas for validation and type inference
- Create DTO classes with `nestjs-zod` (`createZodDto`)
- Keep module DTOs in a single file within the `dto/` folder

### 5. Entities
- Define database table structures
- Located in feature directories (e.g., `src/v1/users/entities/`)
- Use MikroORM decorators for ORM mapping
- Represent database tables

### 6. Modules
- Organize related features
- Located in feature directories (e.g., `src/v1/users/users.module.ts`)
- Use NestJS dependency injection
- Import and export necessary providers

## Feature Organization

Each feature follows this structure:
```
src/v1/feature-name/
├── dto/                     # Data Transfer Objects
│   ├── feature.dto.ts
├── entities/               # Database entities
│   └── feature.entity.ts
├── feature.controller.ts   # HTTP endpoints
├── feature.service.ts      # Business logic
├── feature.dao.ts          # Data access
└── feature.module.ts       # Module definition
```

## Prerequisites

- Node.js >= 24
- pnpm 10.27.0 or later
- Docker or Podman for running dependencies (PostgreSQL)

## Setting Up the Project

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Start the required services (PostgreSQL):
   ```bash
   pnpm deps:up
   ```

3. Start the development server:
   ```bash
   cd apps/api
   pnpm start:dev
   ```
   This will start the server in development mode with hot reloading.

## Building the Project

To build the project:
```bash
pnpm build
```

To build only the packages:
```bash
pnpm build:packages
```

## Database Management

### Migrations

The project uses MikroORM for database management. When schema changes are introduced you **must** generate migrations via the script – do not hand-write them or run raw `migration:create` commands.

- Generate a migration from schema changes (required workflow):
  ```bash
  cd apps/api
  pnpm run migration:generate
  ```

  > Never add migration files manually. The generated output should be committed as-is after review.

- Revert the last migration:
  ```bash
  cd apps/api
  pnpm migration:revert
  ```

### Seeding Data

- Create a new seed file:
  ```bash
  cd apps/api
  pnpm seed:create
  ```

- Run all seed files:
  ```bash
  cd apps/api
  pnpm seed:run-all
  ```

### API Definition Generation

- Generate Cypress API types from the Swagger schema:
  ```bash
  cd apps/api
  pnpm test:e2e:generate-api
  ```

  > Always use this script to refresh generated API typings for E2E tests. Never hand-craft or manually edit the files in `apps/api/cypress/api-definitions/`.

## Claude Agent (sandbox-bridged)

The **Claude Agent** is a graph-node agent type that runs Claude Code (the
Anthropic Agent SDK) inside the thread's sandbox runtime and streams its
activity into Geniro threads in the existing message format. Unlike the
LangGraph-based Simple Agent, it has no host-side state machine or checkpointer —
the SDK owns the agent loop inside the sandbox.

### Bridge architecture

- A small **bridge** script (`packages/claude-bridge`) is delivered into the
  runtime and run as `node bridge.mjs`. The `@anthropic-ai/claude-agent-sdk`
  dependency lives **only** in this package — it is never loaded in the API host.
- Host and bridge speak a **newline-delimited JSON protocol**
  (`packages/claude-bridge/src/protocol.types.ts`) over a runtime exec session:
  stdout carries bridge→host events (`ready` / `sdk_message` / `tool_call_request`
  / `question_request` / `heartbeat` / `done` / `aborted` / `fatal`), stdin carries
  host→bridge commands (`start` / `user_message` / `interrupt` / `shutdown` /
  `tool_call_response` / `question_response`).
- All bridge stdout is **untrusted** (any process in the sandbox can write to it);
  every frame is structurally guarded at the JSON-line, envelope, and content-block
  levels (`.claude/rules/sandbox-boundary.md`). A periodic `heartbeat` frame keeps
  long, output-quiet turns from idle-timing-out the exec channel.

### Runtime transports

The bridge runs on any runtime provider; each satisfies the same
`BaseRuntime.execStream` duplex contract:

| Provider | Transport |
|---|---|
| **Docker** | hijacked exec stream (demuxed). |
| **K8s** | SPDY exec — cleanly demuxed stdin/stdout/stderr, no echo filter. |
| **Daytona** | **session process API** (NOT a PTY — a PTY echoes stdin and injects ANSI/prompt noise that corrupts the JSON protocol). An exact-line echo filter + input-pipe retry mirror `DaytonaExecTransport`. |

A Claude Agent node **requires a node-based runtime image** so the CLI/bridge is
installable at session init; a per-graph image override must provide `node`.

### Costs & lifecycle

- LLM calls route through LiteLLM via `ANTHROPIC_BASE_URL` with a **per-thread
  virtual key** (the LiteLLM master key never enters a sandbox). Crash-orphaned
  keys self-expire via the LiteLLM key TTL (no cross-module sweep).
- Thread stop/abort and a revision deploy landing on a live session both
  `interrupt()` the SDK query, revoke the virtual key, and fail the thread
  visibly. A periodic reaper transitions threads stranded in `Running` (whose
  backing runtime is gone) out of `Running`.

### Config divergence vs Simple Agent

- No `newMessageMode` / `summarize*` options — the SDK manages its own context.
  The SDK's auto-compaction is surfaced to the UI as a `stateUpdate` event.
- Thread rendering and usage stats are agent-kind-agnostic and need no
  Claude-specific UI.

### Deployment

- `LITELLM_SANDBOX_URL` — LiteLLM URL reachable from inside in-cluster sandboxes
  (Docker / K8s).
- `LITELLM_PUBLIC_URL` — LiteLLM URL reachable from a **remote (Daytona) sandbox
  host**, which cannot reach the cluster-internal URL. Required when running
  Claude Agent sessions on a Daytona runtime; sessions fail with a clear error if
  it is unset.

### Known limitation

In-session "parent answers while the query continues" for a subagent's
AskUserQuestion is **not** wired: every question routes as escalate-and-resume
(interrupt → NeedMoreInfo → the user's answer resumes the session). The bridge's
`question_response` primitive is kept as a forward-compat hook; driving it needs a
synchronous inter-agent ask-back channel that does not exist yet.

## Monorepo Management

- The project uses Turbo for task orchestration
- Workspace packages are referenced with `workspace:*` in package.json
- Shared packages in `packages/` directory are used across applications

