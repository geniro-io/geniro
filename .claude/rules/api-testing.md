---
paths:
  - "apps/api/**/*.spec.ts"
  - "apps/api/**/*.int.ts"
  - "apps/api/src/__tests__/**/*.ts"
---

# API Testing

## Commands

```bash
pnpm test:unit                                    # all unit tests
pnpm test:integration src/__tests__/integration/path/to/file.int.ts  # specific integration test (preferred for iteration)
pnpm test:integration                             # full integration suite — hermetic (LLM mocked, runtimes mocked, services spawned via testcontainers when not already running locally)
pnpm run full-check                               # build + lint + unit + integration (mandatory before finishing)
```

Never call `vitest` directly. `pnpm test` (whole monorepo) is forbidden — too coarse. The bulk integration run is hermetic and required by `pnpm full-check`; targeted runs are preferred while iterating.

The integration setup always boots ephemeral Postgres/Redis/Qdrant testcontainers and runs migrations against the base DB before cloning per-worker databases. Files run in parallel (5 workers locally, 3 on CI — the 4-vCPU runner oversubscribes at 5; each worker has its own DB clone); within a file, tests still run sequentially.

## Unit Tests (*.spec.ts)

Place next to source file. Use NestJS `TestingModule` with mocked dependencies:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('MyService', () => {
  let service: MyService;
  let dao: MyDao;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MyService,
        {
          provide: MyDao,
          useValue: {
            getAll: vi.fn(),
            getOne: vi.fn(),
            create: vi.fn(),
            updateById: vi.fn(),
            deleteById: vi.fn(),
          },
        },
        // mock other deps the same way
      ],
    }).compile();

    service = module.get(MyService);
    dao = module.get(MyDao);
  });

  it('should throw NotFoundException when item not found', async () => {
    vi.mocked(dao.getOne).mockResolvedValue(null);
    await expect(service.findById(mockCtx, 'id')).rejects.toThrow(NotFoundException);
  });
});
```

### Mock Context

```typescript
const mockCtx = new AppContextStorage(
  { sub: 'user-123' },
  { headers: { 'x-project-id': '11111111-1111-1111-1111-111111111111' } } as unknown as FastifyRequest,
);
```

### Rules

- Test behavior and business logic, not that mocks were called.
- An exclusion / negative test (asserting a value is NOT in a downstream sink — an injected env, a resolved set, an output payload) must make the excluded value **resolvable upstream** so the sink assertion is independently load-bearing. If the upstream mock returns nothing for the excluded key, an `=== undefined` (or `value !== undefined`) filter at the sink drops it anyway, so the assertion passes vacuously even under the exact regression it guards against — only an incidental call-count/args assertion would catch the leak. Resolve the excluded key to a real value, then assert it is absent at the sink.
- Prefer updating existing spec files over creating new ones.
- Mock external dependencies; test real logic.
- Use `vi.fn()` and `vi.mocked()` from vitest for simple cases (mocking a few methods).
- Use `mockDeep<T>()` from `vitest-mock-extended` when mocking classes with many methods where manually stubbing each with `vi.fn()` is impractical (see below).

### Deep Mocks with `vitest-mock-extended`

Use `mockDeep<T>()` when a dependency has many methods and you only care about a few in each test. All methods are auto-stubbed and type-safe:

```typescript
import { mockDeep } from 'vitest-mock-extended';

const dao = mockDeep<ItemDao>();

// Only configure what the test needs — all other methods return undefined by default
dao.getOne.mockResolvedValue(mockItem);
dao.count.mockResolvedValue(5);
```

Use `mockDeep` when: the class has 5+ methods and manually listing `vi.fn()` for each is noisy. Prefer explicit `vi.fn()` mocks when the dependency is small (1-3 methods) — it makes test setup more readable and intentional.

## Integration Tests (*.int.ts)

Place in `src/__tests__/integration/<feature>/`. Use real DB, call services directly:

```typescript
import { createTestModule } from '../setup';

describe('Feature Integration', () => {
  let app: INestApplication;
  let service: MyService;

  beforeAll(async () => {
    app = await createTestModule();
    service = app.get(MyService);
  });

  afterAll(async () => { await app.close(); });

  // Always clean up created resources
  afterEach(async () => { /* delete test data */ });

  it('performs complex workflow', { timeout: 30000 }, async () => {
    // Call services directly, verify state transitions
  });
});
```

### Rules

- Mandatory when modifying code that already has integration tests.
- Prefer the targeted form `pnpm test:integration <file>` while iterating; run the bulk `pnpm test:integration` for pre-push verification.
- No `it.skip`, `describe.skip`, or conditional skipping. Missing prerequisites must cause test failure.
- Clean up all created resources in `afterEach`/`afterAll`.

## Opt-in real-network tests — the one sanctioned exception to no-conditional-skip

The no-conditional-skip / must-fail policy above (and in CLAUDE.md) exists so a missing prerequisite that *should* be present fails loudly instead of silently passing. There is exactly ONE sanctioned carve-out: a test that must reach a **rate-limited third party CI cannot guarantee** (e.g. a live MCP server's DCR `/register` endpoint, where there is no provisioned credential and a network round-trip per run).

Such a test MAY be `it.runIf(process.env.RUN_X === '1')`-gated and OFF by default, PROVIDED all three hold:

1. The same file carries an **always-on, no-network sanity test** (e.g. asserting the provider's static config), so the file is never a silent no-op.
2. When the gate is ON, the test **fails loudly** — no `try/catch` that swallows a network or assertion failure.
3. A docstring names the env var and explains *why* it is opt-in (third-party, rate-limited, human-consent leg, etc.).

This is NOT a license to gate ordinary missing-env/service cases — those still fail hard. The carve-out is only for a deliberate human opt-in to hit an external host. Exemplar: `apps/api/src/v1/oauth-credentials/providers/linear-oauth-provider.real-network.spec.ts` (`RUN_LINEAR_DCR_E2E=1`).
