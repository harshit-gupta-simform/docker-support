# Architecture Review Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 5 remaining Minor findings from the architecture review series (signal-handling symmetry, explicit return types, a documentation comment, and two test-strength improvements) without changing any externally-observable behavior.

**Architecture:** Each item is an isolated, small edit to an already-existing file — no new modules, no new abstractions. Two items add test assertions to existing spec files; one of those (the real-Logger integration test) uses a verified-working approach with a pre-authorized fallback.

**Tech Stack:** NestJS 11, TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Jest/ts-jest, pnpm, `nestjs-pino`, `@nestjs/terminus`.

## Global Constraints

- Preserve existing functionality — no behavior changes anywhere in this plan except the signal-list narrowing explicitly approved by the user (Task 1).
- No CI and no hello-world-scaffold removal in this pass — both explicitly out of scope per the design spec.
- Keep all TypeScript strictness flags in `tsconfig.json` unchanged.
- Follow existing conventions: unit `.spec.ts` files co-located beside their source; no dedicated test for `main.ts` (established convention — verified via full suite + manual smoke test instead).
- Task 5 has a pre-authorized fallback: if the real-Logger approach doesn't work as specified, drop the new test and leave `register-process-crash-handlers.spec.ts` unchanged, and say so in the report — this is not a blocker requiring escalation.

---

### Task 1: Signal-handling symmetry via a shared `SHUTDOWN_SIGNALS` constant

**Files:**

- Modify: `src/bootstrap/register-shutdown-hooks.ts`
- Modify: `src/main.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `SHUTDOWN_SIGNALS: NodeJS.Signals[]` now exported from `register-shutdown-hooks.ts` — consumed by `main.ts` in this same task.

**Context:** `main.ts` currently calls `app.enableShutdownHooks([], { useProcessExit: true })`. Passing `[]` makes NestJS internally register listeners for **all** `ShutdownSignal` enum values, while `registerGracefulShutdown`'s watchdog only covers `SIGTERM`/`SIGINT`. The user chose to narrow Nest's list to match the watchdog's list exactly, via one shared constant.

- [ ] **Step 1: Export the constant**

In `src/bootstrap/register-shutdown-hooks.ts`, change:

```typescript
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
```

to:

```typescript
export const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
```

(Only the `export` keyword is added — nothing else in this file changes.)

- [ ] **Step 2: Use it in `main.ts`**

Replace the full contents of `src/main.ts`:

```typescript
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import {
  registerGracefulShutdown,
  SHUTDOWN_SIGNALS,
} from './bootstrap/register-shutdown-hooks';
import { registerProcessCrashHandlers } from './bootstrap/register-process-crash-handlers';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);

  app.useLogger(logger);
  app.enableShutdownHooks(SHUTDOWN_SIGNALS, { useProcessExit: true });

  registerProcessCrashHandlers(logger);
  registerGracefulShutdown(logger, SHUTDOWN_TIMEOUT_MS);

  const appConfig = app.get(AppConfigService);

  await app.listen(appConfig.port);
}

void bootstrap();
```

(`enableShutdownHooks`'s signature is `enableShutdownHooks(signals?: ShutdownSignal[] | string[], options?: ShutdownHooksOptions): this` — a `NodeJS.Signals[]` array is assignable to `string[]`, so this compiles under strict mode with no cast needed.)

- [ ] **Step 3: Run the existing unit and e2e suites to confirm nothing broke**

Run: `pnpm run build && pnpm run test && pnpm run test:e2e`
Expected: build succeeds; all existing unit tests pass (no test currently asserts the literal array passed to `enableShutdownHooks`, so none should need updating); e2e suite passes (proves the app still boots and serves routes).

- [ ] **Step 4: Manual smoke test — confirm graceful shutdown still fires exactly once**

Run (check `ss -ltnp` first to avoid colliding with any other process already listening on the port you pick):

```bash
LOGFILE=$(mktemp)
PORT=4501 node dist/main.js > "$LOGFILE" 2>&1 &
PID=$!
sleep 1.5
kill -TERM $PID
wait $PID
echo "exit code: $?"
grep -c "shutting down gracefully" "$LOGFILE"
cat "$LOGFILE"
```

Expected: exit code `0`; the grep count is exactly `1` (not 0, not 2) — this is the regression guard for the double-shutdown bug fixed in the prior pass. If the count is anything other than 1, stop and report — do not proceed to commit.

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/register-shutdown-hooks.ts src/main.ts
git commit -m "refactor: share SHUTDOWN_SIGNALS between main.ts and the shutdown watchdog"
```

---

### Task 2: Explicit return types on `HealthController`

**Files:**

- Modify: `src/health/health.controller.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: nothing new consumed by other tasks — this is a leaf, type-annotation-only change.

**Context:** `live()`, `ready()`, and the shared private `runChecks()` currently have no explicit return type, inconsistent with every other method in this codebase.

- [ ] **Step 1: Add the import and return types**

Replace the full contents of `src/health/health.controller.ts`:

```typescript
import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  MemoryHealthIndicator,
} from '@nestjs/terminus';

const HEAP_THRESHOLD_BYTES = 300 * 1024 * 1024;
const RSS_THRESHOLD_BYTES = 300 * 1024 * 1024;

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
  ) {}

  @Get('live')
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.runChecks();
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.runChecks();
  }

  private runChecks(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', HEAP_THRESHOLD_BYTES),
      () => this.memory.checkRSS('memory_rss', RSS_THRESHOLD_BYTES),
    ]);
  }
}
```

- [ ] **Step 2: Verify the build and existing tests still pass**

Run: `pnpm run build && pnpm run test -- health.controller && pnpm run test:e2e -- health`
Expected: build succeeds (this is the real check — the annotation must match what `HealthCheckService.check()` actually returns, and TypeScript will reject the file if it doesn't); existing `health.controller.spec.ts` (2 tests) and `test/health.e2e-spec.ts` (2 tests) still pass unchanged, since no behavior changed.

- [ ] **Step 3: Commit**

```bash
git add src/health/health.controller.ts
git commit -m "refactor: add explicit return types to HealthController methods"
```

---

### Task 3: Document `AppConfigService`'s stateless constraint

**Files:**

- Modify: `src/config/app-config.service.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: nothing new — documentation only.

**Context:** `AppConfigService` is registered twice in `src/app.module.ts` (once inside `LoggerModule.forRootAsync`'s own `providers`, once in `AppModule`'s top-level `providers`), which is safe only because the class is stateless. This constraint currently exists only in planning documents.

- [ ] **Step 1: Add the comment**

In `src/config/app-config.service.ts`, add a comment directly above the class declaration:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from './env.validation';

// Must stay stateless: this class is registered twice in app.module.ts
// (once inside LoggerModule.forRootAsync's own providers, once in
// AppModule's top-level providers) — two independent instances exist,
// which is only safe because neither holds mutable state.
@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get port(): number {
    return this.configService.get('PORT', { infer: true });
  }

  get nodeEnv(): EnvConfig['NODE_ENV'] {
    return this.configService.get('NODE_ENV', { infer: true });
  }

  get logLevel(): EnvConfig['LOG_LEVEL'] {
    return this.configService.get('LOG_LEVEL', { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }
}
```

(Only the comment is new — every line of actual code is unchanged from the current file.)

- [ ] **Step 2: Verify nothing broke**

Run: `pnpm run build && pnpm run test -- app-config.service`
Expected: build succeeds; existing 4 tests in `app-config.service.spec.ts` still pass unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/config/app-config.service.ts
git commit -m "docs: document AppConfigService's stateless constraint"
```

---

### Task 4: Strengthen the shutdown-watchdog test

**Files:**

- Modify: `src/bootstrap/register-shutdown-hooks.spec.ts`

**Interfaces:**

- Consumes: `registerGracefulShutdown` (unchanged signature from Task 1).
- Produces: nothing new consumed elsewhere.

**Context:** The existing "force-exits 1 if the process has not exited within the deadline" test only asserts `exitSpy` was called with `1` _after_ advancing timers by the full deadline. Nothing currently asserts it was **not** called immediately after the signal fires — a regression reintroducing an eager `process.exit()` in the signal handler would pass this test unchanged.

- [ ] **Step 1: Add the missing assertion**

In `src/bootstrap/register-shutdown-hooks.spec.ts`, change the second test from:

```typescript
it('force-exits 1 if the process has not exited within the deadline', () => {
  registerGracefulShutdown(logger as never, 10000);

  getHandler('SIGTERM')();
  jest.advanceTimersByTime(10000);

  expect(exitSpy).toHaveBeenCalledWith(1);
});
```

to:

```typescript
it('force-exits 1 if the process has not exited within the deadline', () => {
  registerGracefulShutdown(logger as never, 10000);

  getHandler('SIGTERM')();

  expect(exitSpy).not.toHaveBeenCalled();

  jest.advanceTimersByTime(10000);

  expect(exitSpy).toHaveBeenCalledWith(1);
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm run test -- register-shutdown-hooks`
Expected: PASS (3 tests) — the new assertion should pass immediately, since the current implementation never calls `process.exit()` before the timer fires; this addition is a regression guard, not a bug fix.

- [ ] **Step 3: Commit**

```bash
git add src/bootstrap/register-shutdown-hooks.spec.ts
git commit -m "test: assert the shutdown watchdog stays silent before its deadline"
```

---

### Task 5: Real-Logger integration test for crash handlers

**Files:**

- Modify: `src/bootstrap/register-process-crash-handlers.spec.ts`

**Interfaces:**

- Consumes: `registerProcessCrashHandlers` (unchanged).
- Produces: nothing new consumed elsewhere.

**Context:** The existing tests assert `logger.error` was called with the right arguments against a `jest.fn()` mock, but never prove the actual _emitted log line_ has `msg`/`context` set correctly. The code below has already been verified working by the controller (built and ran successfully in this exact codebase before this plan was written) — this is not speculative.

**Important — `nestjs-pino`'s `PinoLogger` holds its underlying `pino` instance in module-level singleton state**, initialized once per process. `__resetOutOfContextForTests()` (exported only from the `nestjs-pino/PinoLogger` subpath, not the main `nestjs-pino` entry point) resets that singleton so a fresh instance with a custom stream can be built. This is a legitimate, intentionally-exported test hook, not a private hack — but it does couple this one test to library internals.

**Pre-authorized fallback:** if this exact code does not work when you run it (e.g. a version mismatch, a changed export path), do NOT try to work around it with a different approach. Stop, revert this one test addition, leave `register-process-crash-handlers.spec.ts` exactly as it is today (its existing assertions remain valid), and report `DONE_WITH_CONCERNS` noting you dropped this item per the pre-authorized fallback. This is not a blocker — proceed to Task 6 either way.

- [ ] **Step 1: Add the new test**

At the top of `src/bootstrap/register-process-crash-handlers.spec.ts`, add two imports alongside the existing one:

```typescript
import { Writable } from 'node:stream';
import { Logger, PinoLogger } from 'nestjs-pino';
import { __resetOutOfContextForTests } from 'nestjs-pino/PinoLogger';
import { registerProcessCrashHandlers } from './register-process-crash-handlers';
```

Add this new test inside the existing `describe('registerProcessCrashHandlers', ...)` block, after the last existing test (`'logs and exits 1 on an uncaught exception'`), before the closing `});` of the `describe` block:

```typescript
it('emits a real log line with the message and context in the correct fields', () => {
  __resetOutOfContextForTests();

  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk as Buffer));
      callback();
    },
  });

  const pinoLogger = new PinoLogger({ pinoHttp: stream });
  const realLogger = new Logger(pinoLogger, {});

  registerProcessCrashHandlers(realLogger);

  getHandler('unhandledRejection')(new Error('boom'));

  const output = Buffer.concat(chunks).toString('utf-8').trim();
  const parsed = JSON.parse(output) as { msg: string; context: string };

  expect(parsed.msg).toBe('Unhandled promise rejection');
  expect(parsed.context).toBe('Bootstrap');
});
```

Note: this test reuses the existing `getHandler` helper already defined earlier in the file — do not redefine it. `registerProcessCrashHandlers` is called a second time here, on a fresh `process.on` spy state from `beforeEach`, exactly like the other tests in this file.

- [ ] **Step 2: Run the test to verify it fails for the right reason if something's wrong, then passes**

Run: `pnpm run test -- register-process-crash-handlers`
Expected: PASS (4 tests total: the 3 existing tests plus this new one). If it fails, read the actual error before assuming anything — if the failure is about `__resetOutOfContextForTests` not being found or a type error on the import, that's the trigger for the pre-authorized fallback in this task's Context section. If it fails for a different reason (e.g. `parsed.msg` or `parsed.context` don't match), do not adjust the assertions to make it pass — that would hide a real regression; report exactly what you observed instead.

- [ ] **Step 3: Run the full unit suite once to confirm no cross-test interference**

Run: `pnpm run test`
Expected: all suites still pass (27 previously + 1 new = 28). `__resetOutOfContextForTests()` only affects `nestjs-pino`'s internal module-level singleton, not any other test file's mocks — but confirm this empirically rather than assuming it.

- [ ] **Step 4: Commit**

```bash
git add src/bootstrap/register-process-crash-handlers.spec.ts
git commit -m "test: verify crash-handler log output through a real nestjs-pino Logger"
```

(If the pre-authorized fallback was invoked instead, there is nothing to commit for this task — proceed directly to Task 6 and note the dropped item in your final report.)

---

### Task 6: Final verification

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the complete verification sequence**

Run: `pnpm run build && pnpm run lint && pnpm run test && pnpm run test:e2e`
Expected: all four commands succeed — clean build, zero lint errors/warnings, all unit tests pass (28 if Task 5 landed, 27 if it was dropped via the fallback), all e2e tests pass (4).

- [ ] **Step 2: Run coverage and confirm the 80% threshold still holds**

Run: `pnpm run test:cov`
Expected: PASS, all four metrics (branches/functions/lines/statements) still at or above 80%. The new/changed code in this plan (Tasks 1-5) is either already-tested logic with an added type annotation, or new test assertions — none of it should lower coverage; if anything, Task 5 (if it lands) adds coverage.

- [ ] **Step 3: Confirm no uncommitted changes remain**

Run: `git status --short`
Expected: clean working tree — everything from Tasks 1-5 was committed individually already.

---

## Self-Review Notes

**Spec coverage check** — every item from the design spec maps to a task:

| Spec item                                | Task   |
| ---------------------------------------- | ------ |
| Item 1 (signal symmetry)                 | Task 1 |
| Item 2 (return types)                    | Task 2 |
| Item 3 (stateless comment)               | Task 3 |
| Item 4 (watchdog test)                   | Task 4 |
| Item 5 (real-Logger test, with fallback) | Task 5 |
| Verification (lint/test/build/e2e)       | Task 6 |

All 5 items plus verification accounted for. The out-of-scope items (CI, hello-world removal) have no task, matching the spec's explicit exclusion.
