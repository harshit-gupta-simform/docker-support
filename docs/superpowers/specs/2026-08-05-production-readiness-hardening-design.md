# Production Readiness Hardening — Design

## Context

A senior-engineer review of the newly scaffolded NestJS foundation (commit `0d8679b`) produced 18 actionable findings across folder organization, NestJS best practices, dependency injection, configuration, logging, scalability, maintainability, and testability, plus a few informational notes requiring no action. The user asked to resolve all actionable findings so the foundation is genuinely production-grade before any domain code (ingestion, retrieval, generation) is built on top of it.

Four scoping decisions were made before this design was written:

1. **Stay flat** — do not restructure into the `apps/`/`libs/` pnpm-workspace monorepo from the architecture doc yet; defer that until real domain code exists.
2. **Skip CI** — no git remote exists yet, so a GitHub Actions workflow is deferred to when the repo is actually pushed somewhere.
3. **Node 22.x LTS** — the target pin for `engines`/`.nvmrc`, chosen over Node 24.x LTS for broader current ecosystem support.
4. **Fix everything actionable** — all 18 High/Medium/Low findings, not just the high-severity subset.

This spec covers the remaining 18 findings, organized into six independently reviewable sections. Each section maps back to the finding numbers from the review report for traceability.

## Section A: Runtime Correctness

**Findings addressed:** 2.1, 2.2/6.1, 2.3, 2.5

- **2.1 — `@Injectable()` on `GlobalExceptionFilter`.** The filter is registered via `APP_FILTER` with a constructor-injected `PinoLogger`, but the class itself was never decorated `@Injectable()`. It currently works only because `@Catch()` happens to trigger TypeScript's decorator-metadata emission — an incidental side effect, not a documented contract. Add the decorator. Add a new test (alongside the existing `global-exception.filter.spec.ts`, which constructs the filter directly and bypasses DI entirely) that boots a real Nest `TestingModule` with the filter registered via `APP_FILTER` and asserts the `PinoLogger` dependency resolves correctly — this is the regression test that would have caught 2.1 in the first place.

- **2.2/6.1 — Graceful shutdown with a deadline.** `app.enableShutdownHooks()` is already called in `main.ts`, but nothing gives it a deadline — a long-lived connection (the architecture doc commits to SSE-streamed query responses later) could hold `app.close()` open indefinitely. Add explicit `SIGTERM`/`SIGINT` handlers in `main.ts` that call `app.close()` and force `process.exit(1)` if it hasn't resolved within **10 seconds**. Ten seconds leaves comfortable margin under Kubernetes' typical 30-second `terminationGracePeriodSeconds` default.

- **2.3 — Process-level crash handlers.** No `unhandledRejection`/`uncaughtException` handlers exist. Add both in `main.ts`: log the error via the Pino logger, then `process.exit(1)`. This is Node's own recommended pattern — do not attempt to keep running after an uncaught exception, since process state is no longer trustworthy; let the orchestrator (k8s, systemd, pm2) restart the process instead.

- **2.5 — Split liveness and readiness.** The single `/health` endpoint conflates two different concerns. Split into `GET /health/live` (process-only: memory heap + RSS checks — "is this process alive and not thrashing") and `GET /health/ready` (identical checks today, but structured as the module future DB/Redis/vector-store readiness indicators attach to, once those dependencies exist). This closes the gap before it matters for k8s liveness/readiness probe configuration. The disk check does not move to either endpoint — see Section C.

## Section B: Configuration Hardening

**Findings addressed:** 3.2/4.2, 4.1, 4.3

- **3.2/4.2 — Typed `AppConfigService`.** `ConfigService<EnvConfig, true>` is currently repeated ad hoc in both `app.module.ts` and `main.ts`; any consumer that forgets the generic or the `{ infer: true }` option silently degrades to `string | undefined` with no compiler error. Add `src/config/app-config.service.ts`: an `@Injectable()` class wrapping `ConfigService<EnvConfig, true>` internally, exposing typed getters — `get port(): number`, `get nodeEnv(): EnvConfig['NODE_ENV']`, `get logLevel(): EnvConfig['LOG_LEVEL']`. `app.module.ts`'s `LoggerModule.forRootAsync` factory and `main.ts`'s bootstrap both inject `AppConfigService` instead of the raw `ConfigService`. Add a unit test for `AppConfigService` covering all three getters.

- **4.1 — `cache: true`.** Add `cache: true` to the existing `ConfigModule.forRoot()` call — a one-line change, per NestJS's own documented recommendation for `ConfigService#get` performance.

- **4.3 — `.env.example` / schema drift test.** Add a unit test (e.g. `src/config/env-example.spec.ts`) that parses `.env.example`'s keys and asserts they exactly match the zod schema's key set in both directions (no key in one but not the other) — so the two can't silently drift as env vars are added later.

## Section C: Health Check Redesign

**Findings addressed:** 2.4, 8.2 (builds on the 2.5 split from Section A)

- **2.4 — Remove the disk-usage indicator.** `DiskHealthIndicator.checkStorage('disk', { path: '/', thresholdPercent: 0.9 })` currently measures the container's ephemeral writable layer — not a real dependency — and risks false "unhealthy" readings from unrelated log/tmp growth. Remove it from `HealthController`. Re-introduce a disk check meaningfully later, once there's an actual disk dependency to monitor (e.g. the future git-clone directory used by the `MarkdownGitRepoLoaderAdapter`).

- **8.2 — Failure-path test.** The existing `test/health.e2e-spec.ts` only proves the endpoint reports healthy when everything is fine — it's never proven the endpoint can report _unhealthy_. Add a unit test for `HealthController` that mocks `MemoryHealthIndicator.checkHeap` to reject, and asserts the resulting response is a `503 Service Unavailable` (Terminus's documented behavior when any indicator in a `HealthCheckService.check()` call fails).

Concretely, after this section and Section A's 2.5 split, `HealthModule` exposes:

- `GET /health/live` → heap + RSS memory checks only
- `GET /health/ready` → heap + RSS memory checks only (today; the attachment point for future readiness-specific indicators)

## Section D: Tooling & Process

**Findings addressed:** 7.2, 7.3, 7.5, 1.1

- **7.2 — Node LTS pin.** Add `"engines": { "node": ">=22 <23" }` to `package.json` and a `.nvmrc` containing `22`. This is documentation/CI-guidance strength, **not** a local enforcement gate — `engine-strict` will **not** be set in `.npmrc`, since the current development machine runs Node 25.9.0 and a hard block would break `pnpm install` today. Switching the local Node version is a separate decision left to the user.

- **7.3 — `packageManager` pin.** Add `"packageManager": "pnpm@10.33.2"` to `package.json` (the confirmed installed version), for corepack-based reproducibility.

- **7.5 — Strictness sign-off.** No code change. This item is a recorded confirmation: the user has approved keeping the TypeScript strictness flags added beyond the architecture doc's explicit list (`noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`), including `noUncheckedIndexedAccess`'s ongoing null-check burden on future array/record indexing in domain code.

- **1.1 — Record the flat-structure decision.** Add a short note to `docs/architecture/rag-platform-architecture.md` (new subsection under Section 4, "Folder Structure") recording: the project stays flat for now; the `apps/`/`libs/` pnpm-workspace monorepo restructure is deferred until real domain code (ingestion/retrieval) exists. This turns an absorbed decision into a documented one.

## Section E: Testing & Coverage

**Findings addressed:** 8.1

Add a `coverageThreshold` block to the Jest config in `package.json`:

```json
"coverageThreshold": {
  "global": {
    "branches": 80,
    "functions": 80,
    "lines": 80,
    "statements": 80
  }
}
```

Enforced via the existing `pnpm run test:cov` script (`jest --coverage`), which will now fail the run if coverage drops below 80% on any of the four metrics, globally. This is a floor, not a per-layer breakdown — the architecture doc's "domain/application layers" framing doesn't yet apply distinctly since there's no separate domain code, so a single global threshold is the correct interim enforcement.

## Section F: Documentation

**Findings addressed:** 7.4, 5.1

- **7.4 — Rewrite `README.md`.** Replace Nest's default boilerplate (donation links, generic framework description) with: a one-paragraph project description, setup steps (`cp .env.example .env`, `pnpm install`, `pnpm run start:dev`), a table of available `package.json` scripts, an env var reference (mirroring `.env.example`), an explanation of the husky pre-commit/commit-msg hooks and the Conventional Commits requirement, documentation of the `/health/live` and `/health/ready` endpoints, and a link to `docs/architecture/rag-platform-architecture.md`.

- **5.1 — Redact-list maintenance comment.** Add a one-line comment directly above the `redact: ['req.headers.authorization', 'req.headers.cookie']` array in `app.module.ts` flagging it as a checklist item to extend whenever a new auth/secret-bearing header is introduced (e.g. a future API-key header for admin endpoints).

## Testing Approach

Every code-touching item above follows the same discipline the original foundation was built with: a test that fails before the fix and passes after (TDD), verified individually. After all sections are implemented, the full verification sequence — `pnpm run build`, `pnpm run lint`, `pnpm run test`, `pnpm run test:e2e` — must pass cleanly, matching how the original scaffolding pass was verified.

## Out of Scope

- Restructuring into the `apps/`/`libs/` pnpm-workspace monorepo (deferred per scoping decision 1).
- Adding a CI workflow file (deferred per scoping decision 2; no git remote exists yet).
- Any business/domain logic (ingestion, retrieval, generation, vector store, LLM integration) — this spec is exclusively about hardening the existing foundation.
- Switching the local development machine's Node version — the `engines`/`.nvmrc` pin is documentation-strength only in this pass.
