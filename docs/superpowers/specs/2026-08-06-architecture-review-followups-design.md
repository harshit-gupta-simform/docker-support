# Architecture Review Follow-ups — Design

## Context

Three senior-engineer review passes have now run against the NestJS foundation (the original 18-finding review, a final whole-branch review that caught 3 more issues, and two confirmation passes after fix waves). All Critical and Important findings are resolved. What remains is a short list of previously-identified Minor items — small, well-understood improvements that were deliberately parked rather than blocking anything. The user asked to implement "every approved improvement from the architecture review" with the constraints: preserve existing functionality, improve maintainability/scalability/readability, update tests, update documentation, and verify with `pnpm lint && pnpm test && pnpm build`.

Two previously-flagged items are explicitly excluded from this pass, per the user's own stated constraints:

- **Removing the hello-world scaffold** (`AppController`/`AppService`) — would remove the `GET /` route, directly contradicting "preserve existing functionality." Deferred until real domain code replaces it.
- **Adding CI** — still not applicable; no git remote is configured (the user explicitly declined setting one up when asked during the prior pass's finishing step).

This spec covers the 5 remaining items, all confirmed in conversation before writing this doc.

## Item 1: Signal-handling symmetry + single source of truth

**Problem:** `src/main.ts` calls `app.enableShutdownHooks([], { useProcessExit: true })`. Passing `[]` makes NestJS register its own internal listeners for **all** `ShutdownSignal` enum values (SIGTERM, SIGINT, SIGHUP, SIGUSR2, SIGBREAK, and more), while `registerGracefulShutdown`'s force-exit watchdog (`src/bootstrap/register-shutdown-hooks.ts`) only listens for `SIGTERM`/`SIGINT`. A shutdown triggered by any other signal in Nest's list gets full lifecycle-hook cleanup but no force-exit deadline and no log line.

**Resolution (per user's explicit choice):** narrow Nest's list to exactly match the watchdog's list, and make that list a single shared source of truth so the two can't silently drift apart again.

- Export the existing `SHUTDOWN_SIGNALS` constant from `src/bootstrap/register-shutdown-hooks.ts` (currently module-private).
- In `src/main.ts`, import it and call `app.enableShutdownHooks(SHUTDOWN_SIGNALS, { useProcessExit: true })` instead of passing `[]`.
- No new test is needed for `main.ts` itself (per the established, already-reviewed convention in this codebase that `main.ts`'s bootstrap wiring is verified via full-suite + manual smoke test, not a dedicated unit test — see the prior hardening plan's Task 6). Verification for this item is: the existing e2e suite still passes (proves the app still boots and shuts down), plus a manual `SIGTERM` smoke test proving graceful shutdown still fires exactly once (guarding against a regression of the double-invocation bug fixed in the prior pass).

## Item 2: Explicit return types on `HealthController`

**Problem:** `live()`, `ready()`, and the shared private `runChecks()` in `src/health/health.controller.ts` have no explicit return type, inconsistent with every other method in the codebase (`AppConfigService`'s getters, `AppService.getHello(): string`, `bootstrap(): Promise<void>`).

**Resolution:** add `: Promise<HealthCheckResult>` to all three methods, importing `HealthCheckResult` from `@nestjs/terminus`. No behavior change — this is a type-annotation-only edit. Existing tests (`health.controller.spec.ts`, `test/health.e2e-spec.ts`) continue to cover behavior; no test changes needed, but `pnpm build` must still pass under `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` to confirm the annotation is accurate.

## Item 3: Document `AppConfigService`'s stateless constraint

**Problem:** `AppConfigService` is deliberately registered twice — once in `LoggerModule.forRootAsync`'s own `providers` array, once in `AppModule`'s top-level `providers` — which is safe only because the class is stateless. That constraint currently lives only in planning documents, not in the code itself.

**Resolution:** add a short comment directly above the class in `src/config/app-config.service.ts` stating the constraint and pointing at why (dual registration in `app.module.ts`). No test needed — this is documentation only.

## Item 4: Strengthen the shutdown-watchdog test

**Problem:** `src/bootstrap/register-shutdown-hooks.spec.ts`'s "force-exits 1 if the process has not exited within the deadline" test only asserts `exitSpy` was called with `1` _after_ advancing timers by the full deadline. Nothing asserts it was **not** called immediately after the signal fires — a regression that reintroduced an eager `process.exit()` in the signal handler would pass this test unchanged.

**Resolution:** add an assertion immediately after `getHandler('SIGTERM')()` and before `jest.advanceTimersByTime(...)`, asserting `expect(exitSpy).not.toHaveBeenCalled()`. This is a one-line addition to an existing test, not a new test case.

## Item 5: Real-Logger integration test for crash handlers

**Problem:** `src/bootstrap/register-process-crash-handlers.spec.ts` asserts `logger.error` was called with the right arguments against a `jest.fn()` mock. It does not prove the _emitted log line_ actually has `msg`/`context` set correctly — that claim currently rests on two rounds of manual source-code reading (by the original implementer's fix and the final reviewer), not a test.

**Resolution:** add one new test that constructs a real `nestjs-pino` `PinoLogger` + `Logger` pair writing to an in-memory stream, triggers the `unhandledRejection` handler, and parses the actual emitted JSON line to assert `msg === 'Unhandled promise rejection'` and `context === 'Bootstrap'`.

**Known implementation risk, called out explicitly in the design discussion:** `nestjs-pino`'s `PinoLogger` holds its underlying `pino` instance in module-level singleton state (`outOfContext`), initialized once per process. Building a fresh one with a custom capture stream requires calling the library's own exported test-only reset hook, `__resetOutOfContextForTests()`. This is a legitimate, intentionally-exported hook (not a private/internal hack), but it does couple this test to library internals more than any other test in this codebase.

**Fallback if this proves too fragile in practice:** drop this item and leave `register-process-crash-handlers.spec.ts` as-is (its existing call-shape assertions from the prior fix wave remain valid and correct; only the "does the real emitted line look right" proof would remain a documented, accepted gap rather than a tested one). This fallback does not require going back to the user for approval — it is pre-authorized by this spec as the explicit exit condition for this one item, since the item's own risk was disclosed and accepted before implementation.

## Testing Approach

Items 1 and 3 need no new tests (behavior-preserving wiring change / comment-only). Item 2 is verified by `pnpm build` succeeding under strict TypeScript. Items 4 and 5 each add assertions to existing test files following this codebase's established TDD discipline: write the assertion, confirm it fails for the right reason against the current code (item 4: the test currently doesn't check this at all, so "failing" here means confirming the new assertion is meaningful, not that current behavior is broken — current behavior already satisfies it), then confirm it passes.

After all items: run `pnpm run build`, `pnpm run lint`, `pnpm run test`, `pnpm run test:e2e` and confirm all green, plus a manual `SIGTERM` smoke test on the compiled app to reconfirm single-invocation graceful shutdown (guarding Item 1 against reintroducing the previously-fixed double-shutdown bug).

## Documentation

No README or architecture-doc changes are needed — none of these 5 items change externally-observable behavior, environment variables, scripts, or endpoints. (Item 3's comment lives in code, not docs, since it's an implementation-detail constraint for future maintainers of that one class, not user-facing documentation.)

## Out of Scope

- Removing the hello-world scaffold (would remove functionality).
- Adding CI (no remote configured).
- Any other Minor item not in the 5 listed above.
- Any business/domain logic.
