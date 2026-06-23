---
paths:
  - "apps/api/**/*.controller.ts"
  - "apps/api/**/*.service.ts"
---

# Endpoint Security

## Controller-Level Auth

Every controller must have:

```typescript
@Controller('feature')
@ApiTags('feature')
@ApiBearerAuth()
@OnlyForAuthorized()
export class FeatureController { ... }
```

- `@OnlyForAuthorized()` from `@packages/http-server` enforces JWT authentication.
- `@ApiBearerAuth()` documents the auth requirement in Swagger.

## Context Injection

Every endpoint that needs the current user must inject context:

```typescript
@Get()
async getAll(
  @CtxStorage() ctx: AppContextStorage,
): Promise<ItemDto[]> {
  return this.service.getAll(ctx);
}
```

## Service-Level Authorization

Services must validate ownership. Never trust client-provided user IDs:

```typescript
async findById(ctx: AppContextStorage, id: string): Promise<ItemDto> {
  const userId = ctx.checkSub();        // throws UnauthorizedException if missing
  const projectId = ctx.checkProjectId(); // throws UnauthorizedException if missing

  const item = await this.dao.getOne({ id, createdBy: userId, projectId });
  if (!item) throw new NotFoundException('ITEM_NOT_FOUND');

  return item;
}
```

## Rules

- Always filter by `createdBy` and/or `projectId` in DAO queries for user-owned resources.
- **Sanctioned `createdBy` deviation — deployment-wide shared identity.** When a feature intentionally serves a SINGLE deployment-wide shared identity rather than per-user resources, it MAY widen the `createdBy` filter to a fixed sentinel through ONE chokepoint helper (e.g. `resolveRepoScope` → `PAT_DEPLOYMENT_OWNER`), provided: (a) requests stay authenticated (`ctx.checkSub()` is still called); (b) the helper's docstring states the ACCEPTED CONSEQUENCE — that destructive ops (hard-delete, reindex) and `projectId` isolation no longer bind per-user; (c) the deviation was approved at plan/implement time. Never drop `createdBy` filtering ad-hoc at individual call sites. Exemplar: `resolveRepoScope` in `apps/api/src/v1/git-repositories/services/git-repositories.service.ts`.
- Use `ctx.checkSub()` (not `ctx.sub`) to ensure the value is present and throw if not.
- Use `ctx.checkProjectId()` (not `ctx.projectId`) to ensure the project header is present.
- Rate-limit expensive endpoints with `@Throttle({ default: { ttl: 60000, limit: 10 } })`.
- Use `EntityUUIDDto` from `utils/dto/misc.dto` for `:id` param validation.

## Redact credential-bearing query params from request-URL logging

Any log line that can include a request URL / query string MUST mask credential-bearing params — `cap`, `code`, `state`, `token`, `access_token`, `refresh_token` — to `[REDACTED]` before the log call. OAuth and capability-link flows carry live, single-use secrets on the query string (`GET /oauth/:provider/start?cap=…`, the `?code=&state=` callback), and a verbatim URL leaks a redeemable credential into Pino/Sentry, browser history, proxies, and the `Referer` header.

The shared sink is the global Fastify `preHandler` request logger (`packages/http-server/src/setup.ts`), which already masks via `originalUrl.replace(/([?&](?:cap|code|state|token|access_token|refresh_token)=)[^&]*/gi, '$1[REDACTED]')`. Any NEW URL-logging path (a controller, interceptor, or error handler that echoes `originalUrl`) MUST apply the same masking. Prefer carrying one-shot secrets in a header or POST body over the query string where the endpoint design allows it (avoids the history/Referer leak entirely).
