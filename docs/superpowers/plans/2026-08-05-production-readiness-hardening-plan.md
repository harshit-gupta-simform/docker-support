# Production Readiness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all 18 actionable findings from the prior senior-engineer review of the NestJS foundation, without restructuring into a monorepo and without adding CI.

**Architecture:** Extract currently-inline logic (pino-http options, graceful shutdown, process crash handling, typed config access) into small, independently unit-tested modules under `src/config/` and a new `src/bootstrap/`, then wire them into the existing `app.module.ts` and `main.ts`. Health checks split into `/health/live` and `/health/ready`, dropping the disk indicator. Tooling/docs changes (Node pin, coverage threshold, README, architecture-doc note) round out the pass.

**Tech Stack:** NestJS 11, TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Jest/ts-jest, pnpm, zod, nestjs-pino, @nestjs/terminus.

## Global Constraints

- Stay flat — do NOT restructure into an `apps/`/`libs/` pnpm workspace in this pass (spec scoping decision 1).
- Do NOT add a CI workflow file in this pass (spec scoping decision 2; no git remote exists yet).
- Node engine pin target: `>=22 <23` (Node 22.x LTS). Do NOT set `engine-strict` in `.npmrc` — the local dev machine runs Node 25.9.0, so this is documentation/CI-guidance strength only, not a local enforcement gate.
- Graceful shutdown deadline: exactly **10 seconds** (10,000 ms).
- Coverage threshold: **80%** on branches, functions, lines, and statements, applied globally in the Jest config (not per-layer — no separate domain/application layers exist yet).
- Keep all TypeScript strictness flags already in `tsconfig.json` (`strict`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`) — confirmed by the user; no relaxation.
- Follow existing conventions: unit `.spec.ts` files co-located beside their source file; e2e specs live in `test/`; Jest config lives in the `jest` key of `package.json`; ESLint is the flat config at `eslint.config.mjs`; package manager is pnpm.
- No business/domain logic (ingestion, retrieval, generation, vector store, LLM) in this pass — foundation hardening only.
- Finding 7.5 (strictness sign-off) requires no code — it is a recorded decision already confirmed by the user before this plan was written. No task implements it.

---

### Task 1: Make `GlobalExceptionFilter` explicitly injectable

**Files:**

- Modify: `src/common/filters/global-exception.filter.ts`
- Modify: `src/common/filters/global-exception.filter.spec.ts`

**Interfaces:**

- Consumes: existing `GlobalExceptionFilter` class, `PinoLogger` from `nestjs-pino`, `APP_FILTER` token from `@nestjs/core`.
- Produces: nothing new consumed by later tasks.

**Context:** `GlobalExceptionFilter` is registered via `{ provide: APP_FILTER, useClass: GlobalExceptionFilter }` in `app.module.ts` and has a constructor-injected `PinoLogger`, but the class itself is not decorated `@Injectable()`. This currently works in the real running app only because `@Catch()` happens to trigger the same TypeScript decorator-metadata emission Nest's DI relies on — an incidental side effect, not a documented contract. Note honestly: because of this, the regression test below will **pass both before and after** this fix — there is no way to make it fail first, because the existing `@Catch()` decorator already causes the metadata Nest needs to be emitted. The value of this task is making the DI contract explicit in the source rather than leaving it as an untested, undocumented side effect.

- [ ] **Step 1: Write the DI-resolution test**

Add to the bottom of `src/common/filters/global-exception.filter.spec.ts` (after the existing `describe('GlobalExceptionFilter', ...)` block, as a new top-level `describe`):

```typescript
describe('GlobalExceptionFilter (DI resolution)', () => {
  it('is resolved by the Nest DI container when registered via APP_FILTER', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: PinoLogger,
          useValue: { setContext: jest.fn(), error: jest.fn() },
        },
        {
          provide: APP_FILTER,
          useClass: GlobalExceptionFilter,
        },
      ],
    }).compile();

    const filter = moduleRef.get(APP_FILTER);

    expect(filter).toBeInstanceOf(GlobalExceptionFilter);
  });
});
```

Add these two imports to the top of the file, alongside the existing imports:

```typescript
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
```

- [ ] **Step 2: Run the test to confirm it passes already**

Run: `pnpm run test -- global-exception.filter`
Expected: PASS (all tests, including the new one). This confirms the currently-fragile behavior works today — the point of Step 3 is to stop relying on that fragility.

- [ ] **Step 3: Add the `@Injectable()` decorator**

In `src/common/filters/global-exception.filter.ts`, add the import and decorator:

```typescript
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
```

```typescript
@Injectable()
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
```

- [ ] **Step 4: Run the test to confirm it still passes**

Run: `pnpm run test -- global-exception.filter`
Expected: PASS (unchanged — this step locks in the contract explicitly rather than changing behavior).

- [ ] **Step 5: Commit**

```bash
git add src/common/filters/global-exception.filter.ts src/common/filters/global-exception.filter.spec.ts
git commit -m "fix: mark GlobalExceptionFilter explicitly injectable"
```

---

### Task 2: Add `AppConfigService`

**Files:**

- Create: `src/config/app-config.service.ts`
- Create: `src/config/app-config.service.spec.ts`

**Interfaces:**

- Consumes: `ConfigService` from `@nestjs/config`, `EnvConfig` type from `src/config/env.validation.ts`.
- Produces: `AppConfigService` class with `port: number`, `nodeEnv: EnvConfig['NODE_ENV']`, `logLevel: EnvConfig['LOG_LEVEL']`, `isProduction: boolean` getters — consumed by Task 3 (`buildPinoHttpOptions`), Task 4/6 (`main.ts`), and `app.module.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/config/app-config.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { EnvConfig } from './env.validation';

describe('AppConfigService', () => {
  async function createService(config: EnvConfig): Promise<AppConfigService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppConfigService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: keyof EnvConfig) => config[key],
          },
        },
      ],
    }).compile();

    return moduleRef.get(AppConfigService);
  }

  it('exposes the configured port as a number', async () => {
    const service = await createService({
      NODE_ENV: 'development',
      PORT: 4000,
      LOG_LEVEL: 'info',
    });

    expect(service.port).toBe(4000);
  });

  it('exposes the configured node environment', async () => {
    const service = await createService({
      NODE_ENV: 'test',
      PORT: 3000,
      LOG_LEVEL: 'info',
    });

    expect(service.nodeEnv).toBe('test');
  });

  it('exposes the configured log level', async () => {
    const service = await createService({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'debug',
    });

    expect(service.logLevel).toBe('debug');
  });

  it('reports isProduction as true only when NODE_ENV is production', async () => {
    const prod = await createService({
      NODE_ENV: 'production',
      PORT: 3000,
      LOG_LEVEL: 'info',
    });
    const dev = await createService({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
    });

    expect(prod.isProduction).toBe(true);
    expect(dev.isProduction).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- app-config.service`
Expected: FAIL with "Cannot find module './app-config.service'"

- [ ] **Step 3: Write the implementation**

Create `src/config/app-config.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from './env.validation';

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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- app-config.service`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/config/app-config.service.ts src/config/app-config.service.spec.ts
git commit -m "feat: add typed AppConfigService"
```

---

### Task 3: Extract `buildPinoHttpOptions` and wire config hardening into `app.module.ts`

**Files:**

- Create: `src/config/pino-http-options.factory.ts`
- Create: `src/config/pino-http-options.factory.spec.ts`
- Modify: `src/app.module.ts`

**Interfaces:**

- Consumes: `AppConfigService` (Task 2) — its `logLevel` and `isProduction` getters.
- Produces: `buildPinoHttpOptions(appConfig: AppConfigService): Options` (from `pino-http`) — used only by `app.module.ts` in this plan.

**Context:** This closes findings 3.2/4.2 (typed config, no more repeated `ConfigService<EnvConfig, true>` generics), 4.1 (`cache: true` on `ConfigModule.forRoot`), and 5.1 (redact-list maintenance comment) in one wiring change.

**Note on the DI wiring in Step 5:** `AppConfigService` is registered twice — once in `LoggerModule.forRootAsync({ providers: [AppConfigService], inject: [AppConfigService], ... })`, and once in `AppModule`'s own top-level `providers` array. This is intentional, not a duplication bug: `LoggerModule.forRootAsync(...)` is Nest resolving `inject` tokens against providers declared in that same dynamic-module registration call, a standard pattern for `forRootAsync`-style modules (mirrors how `TypeOrmModule.forRootAsync` and similar modules work). `AppModule`'s own copy is the one `main.ts` retrieves via `app.get(AppConfigService)`. `AppConfigService` is a stateless wrapper around the (globally available, since `ConfigModule.forRoot({ isGlobal: true })`) `ConfigService`, so two separate instances behave identically — there is nothing to deduplicate.

- [ ] **Step 1: Write the failing test**

Create `src/config/pino-http-options.factory.spec.ts`:

```typescript
import { buildPinoHttpOptions } from './pino-http-options.factory';
import { AppConfigService } from './app-config.service';

function createAppConfig(overrides: {
  logLevel?: string;
  isProduction?: boolean;
}): AppConfigService {
  return {
    logLevel: 'info',
    isProduction: false,
    ...overrides,
  } as unknown as AppConfigService;
}

describe('buildPinoHttpOptions', () => {
  it('uses the configured log level', () => {
    const options = buildPinoHttpOptions(
      createAppConfig({ logLevel: 'debug' }),
    );

    expect(options.level).toBe('debug');
  });

  it('redacts authorization and cookie headers', () => {
    const options = buildPinoHttpOptions(createAppConfig({}));

    expect(options.redact).toEqual([
      'req.headers.authorization',
      'req.headers.cookie',
    ]);
  });

  it('includes a pino-pretty transport outside production', () => {
    const options = buildPinoHttpOptions(
      createAppConfig({ isProduction: false }),
    );

    expect(options.transport).toEqual({
      target: 'pino-pretty',
      options: { singleLine: true },
    });
  });

  it('omits the transport in production', () => {
    const options = buildPinoHttpOptions(
      createAppConfig({ isProduction: true }),
    );

    expect(options.transport).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- pino-http-options.factory`
Expected: FAIL with "Cannot find module './pino-http-options.factory'"

- [ ] **Step 3: Write the implementation**

Create `src/config/pino-http-options.factory.ts`:

```typescript
import type { Options } from 'pino-http';
import { AppConfigService } from './app-config.service';

// Extend this list whenever a new header carries credentials or secrets
// (e.g. a future API-key header for admin endpoints).
const REDACT_PATHS = ['req.headers.authorization', 'req.headers.cookie'];

export function buildPinoHttpOptions(appConfig: AppConfigService): Options {
  return {
    level: appConfig.logLevel,
    redact: REDACT_PATHS,
    autoLogging: true,
    ...(appConfig.isProduction
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: { singleLine: true },
          },
        }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- pino-http-options.factory`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire into `app.module.ts`**

Replace the full contents of `src/app.module.ts` with:

```typescript
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { HealthModule } from './health/health.module';
import { validateEnv } from './config/env.validation';
import { AppConfigService } from './config/app-config.service';
import { buildPinoHttpOptions } from './config/pino-http-options.factory';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      cache: true,
    }),
    LoggerModule.forRootAsync({
      providers: [AppConfigService],
      inject: [AppConfigService],
      useFactory: (appConfig: AppConfigService) => ({
        pinoHttp: buildPinoHttpOptions(appConfig),
      }),
    }),
    HealthModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    AppConfigService,
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
```

- [ ] **Step 6: Run the full unit and e2e suites to confirm nothing broke**

Run: `pnpm run build && pnpm run test && pnpm run test:e2e`
Expected: build succeeds; all existing unit and e2e tests still pass (this wiring change has no dedicated new test of its own — its correctness is covered by `AppConfigService`'s and `buildPinoHttpOptions`'s own unit tests plus the existing e2e suite continuing to exercise the composed `AppModule`).

- [ ] **Step 7: Commit**

```bash
git add src/config/pino-http-options.factory.ts src/config/pino-http-options.factory.spec.ts src/app.module.ts
git commit -m "refactor: extract pino-http options factory, enable config cache"
```

---

### Task 4: Add `registerGracefulShutdown`

**Files:**

- Create: `src/bootstrap/register-shutdown-hooks.ts`
- Create: `src/bootstrap/register-shutdown-hooks.spec.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `registerGracefulShutdown(app: INestApplication, logger: Logger, timeoutMs: number): void` — consumed by Task 6 (`main.ts`).

**Context:** Closes findings 2.2/6.1. `app.enableShutdownHooks()` (already present in `main.ts`) triggers Nest's lifecycle hooks on `SIGTERM`/`SIGINT` but gives them no deadline. This adds an explicit deadline: try `app.close()`, force-exit if it doesn't finish within `timeoutMs`.

- [ ] **Step 1: Write the failing test**

Create `src/bootstrap/register-shutdown-hooks.spec.ts`:

```typescript
import { registerGracefulShutdown } from './register-shutdown-hooks';

describe('registerGracefulShutdown', () => {
  let onSpy: jest.SpiedFunction<typeof process.on>;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let logger: { log: jest.Mock; error: jest.Mock };
  let app: { close: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    onSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    logger = { log: jest.fn(), error: jest.fn() };
    app = { close: jest.fn() };
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function getHandler(signal: string): () => void {
    const call = onSpy.mock.calls.find(([sig]) => sig === signal);
    if (!call) {
      throw new Error(`No handler registered for ${signal}`);
    }
    return call[1] as () => void;
  }

  it('registers handlers for SIGTERM and SIGINT', () => {
    registerGracefulShutdown(app as never, logger as never, 10000);

    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('exits 0 once app.close() resolves before the deadline', async () => {
    app.close.mockResolvedValue(undefined);
    registerGracefulShutdown(app as never, logger as never, 10000);

    getHandler('SIGTERM')();
    await Promise.resolve();
    await Promise.resolve();

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('force-exits 1 if app.close() has not resolved within the deadline', () => {
    app.close.mockReturnValue(new Promise(() => {}));
    registerGracefulShutdown(app as never, logger as never, 10000);

    getHandler('SIGTERM')();
    jest.advanceTimersByTime(10000);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- register-shutdown-hooks`
Expected: FAIL with "Cannot find module './register-shutdown-hooks'"

- [ ] **Step 3: Write the implementation**

Create `src/bootstrap/register-shutdown-hooks.ts`:

```typescript
import type { INestApplication } from '@nestjs/common';
import type { Logger } from 'nestjs-pino';

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

export function registerGracefulShutdown(
  app: INestApplication,
  logger: Logger,
  timeoutMs: number,
): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      logger.log(`Received ${signal}, shutting down gracefully`);

      const forceExitTimer = setTimeout(() => {
        logger.error(
          `Graceful shutdown timed out after ${timeoutMs}ms, forcing exit`,
        );
        process.exit(1);
      }, timeoutMs);
      forceExitTimer.unref();

      void app.close().then(() => {
        clearTimeout(forceExitTimer);
        process.exit(0);
      });
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- register-shutdown-hooks`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/register-shutdown-hooks.ts src/bootstrap/register-shutdown-hooks.spec.ts
git commit -m "feat: add graceful shutdown with a forced-exit deadline"
```

---

### Task 5: Add `registerProcessCrashHandlers`

**Files:**

- Create: `src/bootstrap/register-process-crash-handlers.ts`
- Create: `src/bootstrap/register-process-crash-handlers.spec.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `registerProcessCrashHandlers(logger: Logger): void` — consumed by Task 6 (`main.ts`).

**Context:** Closes finding 2.3. No process-level `unhandledRejection`/`uncaughtException` handlers currently exist.

- [ ] **Step 1: Write the failing test**

Create `src/bootstrap/register-process-crash-handlers.spec.ts`:

```typescript
import { registerProcessCrashHandlers } from './register-process-crash-handlers';

describe('registerProcessCrashHandlers', () => {
  let onSpy: jest.SpiedFunction<typeof process.on>;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let logger: { error: jest.Mock };

  beforeEach(() => {
    onSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    logger = { error: jest.fn() };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function getHandler(event: string): (...args: unknown[]) => void {
    const call = onSpy.mock.calls.find(([name]) => name === event);
    if (!call) {
      throw new Error(`No handler registered for ${event}`);
    }
    return call[1] as (...args: unknown[]) => void;
  }

  it('registers handlers for unhandledRejection and uncaughtException', () => {
    registerProcessCrashHandlers(logger as never);

    expect(onSpy).toHaveBeenCalledWith(
      'unhandledRejection',
      expect.any(Function),
    );
    expect(onSpy).toHaveBeenCalledWith(
      'uncaughtException',
      expect.any(Function),
    );
  });

  it('logs and exits 1 on an unhandled rejection', () => {
    registerProcessCrashHandlers(logger as never);

    getHandler('unhandledRejection')(new Error('boom'));

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Unhandled promise rejection',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('logs and exits 1 on an uncaught exception', () => {
    registerProcessCrashHandlers(logger as never);

    getHandler('uncaughtException')(new Error('boom'));

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Uncaught exception',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- register-process-crash-handlers`
Expected: FAIL with "Cannot find module './register-process-crash-handlers'"

- [ ] **Step 3: Write the implementation**

Create `src/bootstrap/register-process-crash-handlers.ts`:

```typescript
import type { Logger } from 'nestjs-pino';

export function registerProcessCrashHandlers(logger: Logger): void {
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    logger.error({ err: error }, 'Uncaught exception');
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- register-process-crash-handlers`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/register-process-crash-handlers.ts src/bootstrap/register-process-crash-handlers.spec.ts
git commit -m "feat: add process-level unhandledRejection/uncaughtException handlers"
```

---

### Task 6: Wire shutdown and crash handling into `main.ts`

**Files:**

- Modify: `src/main.ts`

**Interfaces:**

- Consumes: `AppConfigService` (Task 2), `registerGracefulShutdown` (Task 4), `registerProcessCrashHandlers` (Task 5).
- Produces: nothing new — this is the final wiring point.

**Context:** `main.ts` has no dedicated test today (consistent with standard Nest convention — bootstrap's `NestFactory.create`/`app.listen` side effects aren't unit-tested) and stays that way; its logic has already been moved into the tested units from Tasks 2, 4, and 5, so this step is verified by a manual boot smoke test, not a new automated test.

- [ ] **Step 1: Replace `src/main.ts` contents**

```typescript
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { registerGracefulShutdown } from './bootstrap/register-shutdown-hooks';
import { registerProcessCrashHandlers } from './bootstrap/register-process-crash-handlers';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);

  app.useLogger(logger);
  app.enableShutdownHooks();

  registerProcessCrashHandlers(logger);
  registerGracefulShutdown(app, logger, SHUTDOWN_TIMEOUT_MS);

  const appConfig = app.get(AppConfigService);

  await app.listen(appConfig.port);
}

void bootstrap();
```

- [ ] **Step 2: Build and run the full test suites**

Run: `pnpm run build && pnpm run test && pnpm run test:e2e`
Expected: build succeeds; all unit and e2e tests pass.

- [ ] **Step 3: Manual boot smoke test**

Run: `node dist/main.js &` (in a scratch terminal), then `curl -s http://localhost:3000/health/live` (this route only exists after Task 8 — if running this task in isolation before Task 8, curl `http://localhost:3000/health` instead). Confirm the process starts without error and the endpoint responds `200`. Send the process a `SIGTERM` (`kill -TERM <pid>`) and confirm it logs "Received SIGTERM, shutting down gracefully" and exits cleanly (`echo $?` shows `0` for the backgrounded shell, or check via `wait`).

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire graceful shutdown and crash handlers into bootstrap"
```

---

### Task 7: Add `.env.example` / schema drift test

**Files:**

- Create: `src/config/env-example.spec.ts`

**Interfaces:**

- Consumes: `envSchema` from `src/config/env.validation.ts`, the repo-root `.env.example` file.
- Produces: nothing consumed by later tasks.

**Context:** Closes finding 4.3 — nothing currently guarantees `.env.example` and the zod schema stay in sync as env vars are added later.

- [ ] **Step 1: Write the failing test**

Create `src/config/env-example.spec.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envSchema } from './env.validation';

function parseEnvExampleKeys(): string[] {
  const contents = readFileSync(
    join(__dirname, '..', '..', '.env.example'),
    'utf-8',
  );

  const keys: string[] = [];
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const [key] = line.split('=');
    if (key) {
      keys.push(key);
    }
  }

  return keys;
}

describe('.env.example', () => {
  it('declares exactly the same keys as the env schema', () => {
    const exampleKeys = parseEnvExampleKeys().sort();
    const schemaKeys = Object.keys(envSchema.shape).sort();

    expect(exampleKeys).toEqual(schemaKeys);
  });
});
```

This test should already pass, since `.env.example` and `env.validation.ts` are currently in sync — this task is about locking that in, not fixing a present drift.

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm run test -- env-example`
Expected: PASS. If it fails, `.env.example` and `env.validation.ts` have drifted — reconcile them (add the missing key to whichever file is missing it) before proceeding.

- [ ] **Step 3: Commit**

```bash
git add src/config/env-example.spec.ts
git commit -m "test: guard against .env.example / env schema drift"
```

---

### Task 8: Redesign health checks — remove disk indicator, split live/ready

**Files:**

- Modify: `src/health/health.controller.ts`
- Modify: `test/health.e2e-spec.ts`

**Interfaces:**

- Consumes: `HealthCheckService`, `MemoryHealthIndicator` from `@nestjs/terminus` (already used).
- Produces: `HealthController` with public methods `live()` and `ready()` (replacing the old `check()` method bound to bare `GET /health`) — consumed by Task 9's new unit test.

**Context:** Closes findings 2.4 (remove the disk indicator — it only measures the container's ephemeral writable layer today, not a real dependency) and 2.5 (split liveness from readiness). Endpoints become `GET /health/live` and `GET /health/ready`; bare `GET /health` no longer exists.

- [ ] **Step 1: Replace the e2e test with failing assertions against the new routes**

Replace the full contents of `test/health.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('HealthController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health/live (GET)', () => {
    return request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect((res) => {
        const body = res.body as { status: string };
        expect(body.status).toBe('ok');
      });
  });

  it('/health/ready (GET)', () => {
    return request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect((res) => {
        const body = res.body as { status: string };
        expect(body.status).toBe('ok');
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test:e2e -- health`
Expected: FAIL with 404 responses (the old controller only serves bare `GET /health`)

- [ ] **Step 3: Rewrite `HealthController`**

Replace the full contents of `src/health/health.controller.ts`:

```typescript
import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
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
  live() {
    return this.runChecks();
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.runChecks();
  }

  private runChecks() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', HEAP_THRESHOLD_BYTES),
      () => this.memory.checkRSS('memory_rss', RSS_THRESHOLD_BYTES),
    ]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test:e2e -- health`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/health/health.controller.ts test/health.e2e-spec.ts
git commit -m "refactor: split health check into live/ready endpoints, drop disk indicator"
```

---

### Task 9: Add health check failure-path unit test

**Files:**

- Create: `src/health/health.controller.spec.ts`

**Interfaces:**

- Consumes: `HealthController` (Task 8), `TerminusModule`, `MemoryHealthIndicator`, `HealthCheckError` from `@nestjs/terminus`.
- Produces: nothing consumed by later tasks.

**Context:** Closes finding 8.2 — the e2e suite (Task 8) only proves the endpoint reports healthy on the happy path. This proves it correctly reports `503` when a dependency actually fails.

- [ ] **Step 1: Write the failing test**

Create `src/health/health.controller.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  HealthCheckError,
  MemoryHealthIndicator,
  TerminusModule,
} from '@nestjs/terminus';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('rejects with ServiceUnavailableException when a health indicator reports down', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
    })
      .overrideProvider(MemoryHealthIndicator)
      .useValue({
        checkHeap: jest.fn().mockRejectedValue(
          new HealthCheckError('memory_heap check failed', {
            memory_heap: { status: 'down' },
          }),
        ),
        checkRSS: jest.fn().mockResolvedValue({ memory_rss: { status: 'up' } }),
      })
      .compile();

    const controller = moduleRef.get(HealthController);

    await expect(controller.live()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('resolves with an ok status when all indicators are up', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
    })
      .overrideProvider(MemoryHealthIndicator)
      .useValue({
        checkHeap: jest
          .fn()
          .mockResolvedValue({ memory_heap: { status: 'up' } }),
        checkRSS: jest.fn().mockResolvedValue({ memory_rss: { status: 'up' } }),
      })
      .compile();

    const controller = moduleRef.get(HealthController);

    const result = await controller.ready();

    expect(result.status).toBe('ok');
  });
});
```

- [ ] **Step 2: Run test to verify the first assertion fails without the mock's error path**

Run: `pnpm run test -- health.controller`
Expected: PASS for both — this file is new, so there's no "before" state to compare against; instead, temporarily change the first test's mock to `mockResolvedValue({ memory_heap: { status: 'up' } })` and confirm the assertion `rejects.toBeInstanceOf(...)` now correctly FAILS, proving the test can actually detect a regression. Then revert to the `mockRejectedValue` version shown above.

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm run test -- health.controller`
Expected: PASS (2 tests)

- [ ] **Step 4: Commit**

```bash
git add src/health/health.controller.spec.ts
git commit -m "test: cover health check failure path"
```

---

### Task 10: Pin Node LTS and package manager version

**Files:**

- Modify: `package.json`
- Create: `.nvmrc`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing consumed by later tasks (metadata only).

**Context:** Closes findings 7.2 and 7.3. The project was scaffolded on Node 25.9.0, a non-LTS release with a short support window. Per the Global Constraints, this pin is documentation/CI-guidance strength only — `engine-strict` is not being set, since the local dev machine runs Node 25.9.0 and a hard block would break `pnpm install` today.

- [ ] **Step 1: Add `engines` and `packageManager` to `package.json`**

In `package.json`, add these two top-level fields (alongside `"license": "UNLICENSED"`):

```json
"engines": {
  "node": ">=22 <23"
},
"packageManager": "pnpm@10.33.2",
```

- [ ] **Step 2: Create `.nvmrc`**

Create `.nvmrc` with exactly:

```
22
```

- [ ] **Step 3: Verify `pnpm install` still succeeds**

Run: `pnpm install`
Expected: succeeds (with, at most, a non-blocking engines warning given the local Node version — no hard failure, since `engine-strict` was not set).

- [ ] **Step 4: Commit**

```bash
git add package.json .nvmrc
git commit -m "chore: pin Node 22 LTS and pnpm version"
```

---

### Task 11: Add Jest coverage threshold

**Files:**

- Modify: `package.json`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing consumed by later tasks.

**Context:** Closes finding 8.1. Enforces the architecture doc's "80%+ coverage" standard via `pnpm run test:cov`.

- [ ] **Step 1: Add `coverageThreshold` to the `jest` config block in `package.json`**

Add this key inside the existing `"jest": { ... }` object (alongside `"coverageDirectory"` and `"testEnvironment"`):

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

- [ ] **Step 2: Run coverage and confirm the threshold is met**

Run: `pnpm run test:cov`
Expected: PASS, with all four metrics at or above 80%. If any metric falls below 80%, identify the uncovered file/lines from the coverage report and add unit tests for them before proceeding — do not lower the threshold to make it pass.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test: enforce 80% coverage threshold"
```

---

### Task 12: Record the flat-structure decision in the architecture doc

**Files:**

- Modify: `docs/architecture/rag-platform-architecture.md`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing consumed by later tasks.

**Context:** Closes finding 1.1. Turns the "stay flat for now" decision into a documented one rather than a silently absorbed gap against the approved architecture.

- [ ] **Step 1: Add a new subsection to Section 4**

In `docs/architecture/rag-platform-architecture.md`, find the end of the "## 4. Folder Structure (pnpm workspaces, no Nx)" section — the paragraph beginning "**App-to-context mapping**:" is the last content before the `---` separator that precedes "## 5. Required npm Packages". Insert this new subsection immediately after that paragraph, before the `---`:

```markdown
### Current status: flat structure (as of 2026-08-05)

This project currently lives as a single flat NestJS app at the repository root — the `apps/`/`libs/` pnpm-workspace split described above has not been implemented yet. This was a deliberate decision made during the initial production-readiness hardening pass following the first scaffolding pass: restructuring into the monorepo before any real domain code (ingestion, retrieval, generation) exists would mean moving files based on a structure with no content yet to validate it against. The restructure is deferred until ingestion/retrieval code is actually being built — at that point, this app becomes `apps/api` per the structure above.
```

- [ ] **Step 2: Verify the doc still renders sensibly**

Run: `pnpm exec prettier --check docs/architecture/rag-platform-architecture.md` (fix formatting if it reports issues — run `pnpm exec prettier --write docs/architecture/rag-platform-architecture.md` if so).

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/rag-platform-architecture.md
git commit -m "docs: record decision to stay flat pending real domain code"
```

---

### Task 13: Rewrite `README.md`

**Files:**

- Modify: `README.md`

**Interfaces:**

- Consumes: env var names from `.env.example`/`src/config/env.validation.ts`, script names from `package.json`, endpoint paths from Task 8 (`/health/live`, `/health/ready`).
- Produces: nothing consumed by later tasks.

**Context:** Closes finding 7.4. Replaces Nest's default boilerplate with actual project documentation.

- [ ] **Step 1: Replace the full contents of `README.md`**

```markdown
# Docker Support — RAG Platform API

Backend API foundation for a Retrieval-Augmented Generation platform, built with NestJS, TypeScript, and pnpm. The first knowledge domain is Docker Official Documentation; see [`docs/architecture/rag-platform-architecture.md`](./docs/architecture/rag-platform-architecture.md) for the full platform architecture.

This repository currently contains the production-grade application foundation only — configuration, logging, health checks, error handling, and tooling. No domain logic (ingestion, retrieval, generation) has been built yet.

## Setup

\`\`\`bash
cp .env.example .env
pnpm install
pnpm run start:dev
\`\`\`

The app starts on the port configured in `.env` (default `3000`).

## Environment variables

| Variable    | Default       | Description                                                                                                                           |
| ----------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`  | `development` | `development`, `production`, or `test`. Controls log formatting (pretty outside production) and other environment-dependent behavior. |
| `PORT`      | `3000`        | HTTP port the app listens on.                                                                                                         |
| `LOG_LEVEL` | `info`        | Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`.                                                      |

All environment variables are validated at boot via a zod schema (`src/config/env.validation.ts`) — the app fails fast with a descriptive error if configuration is missing or invalid, rather than failing later at first use.

## Scripts

| Script                | Purpose                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm run build`      | Compile TypeScript to `dist/`.                                                               |
| `pnpm run start`      | Run the compiled app once.                                                                   |
| `pnpm run start:dev`  | Run with file-watching and hot reload.                                                       |
| `pnpm run start:prod` | Run the compiled production build (`dist/main.js`).                                          |
| `pnpm run lint`       | Lint and auto-fix `src/`, `test/`, `apps/`, `libs/`.                                         |
| `pnpm run format`     | Format `src/` and `test/` with Prettier.                                                     |
| `pnpm run test`       | Run unit tests.                                                                              |
| `pnpm run test:e2e`   | Run end-to-end tests.                                                                        |
| `pnpm run test:cov`   | Run unit tests with coverage (enforces an 80% floor on branches/functions/lines/statements). |

## Health endpoints

- `GET /health/live` — process-level liveness (memory heap/RSS checks). Use for a Kubernetes liveness probe.
- `GET /health/ready` — readiness (same checks today; the attachment point for future database/cache/vector-store readiness indicators). Use for a Kubernetes readiness probe.

Both return `200` with `{"status": "ok", ...}` when healthy, or `503` when any underlying check fails.

## Git hooks

This repo uses [Husky](https://typicode.github.io/husky/) for git hooks, installed automatically via the `prepare` script on `pnpm install`:

- **pre-commit** — runs `lint-staged` (ESLint + Prettier) on staged files.
- **commit-msg** — runs [commitlint](https://commitlint.js.org/) against [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:`, etc.). Non-conforming commit messages are rejected.

## Requirements

- Node.js `>=22 <23` (see `.nvmrc`) — an LTS release line.
- pnpm (see `packageManager` in `package.json` for the exact pinned version).
```

- [ ] **Step 2: Verify formatting**

Run: `pnpm exec prettier --check README.md` (run `pnpm exec prettier --write README.md` if it reports issues).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: replace boilerplate README with project documentation"
```

---

### Task 14: Final full verification

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the complete verification sequence**

Run: `pnpm run build && pnpm run lint && pnpm run test && pnpm run test:e2e && pnpm run test:cov`
Expected: all five commands succeed — clean build, zero lint errors/warnings, all unit tests pass, all e2e tests pass, coverage at or above the 80% threshold on all four metrics.

- [ ] **Step 2: Manual boot smoke test of the final state**

Run: `node dist/main.js &`, then:

- `curl -s -i http://localhost:3000/health/live` → expect `200` and `{"status":"ok",...}`
- `curl -s -i http://localhost:3000/health/ready` → expect `200` and `{"status":"ok",...}`
- `curl -s -i http://localhost:3000/does-not-exist` → expect `404` with the `GlobalExceptionFilter`'s JSON shape (`statusCode`, `timestamp`, `path`, `message`)

Then send `SIGTERM` to the process and confirm it logs the graceful-shutdown message and exits within the 10-second deadline.

- [ ] **Step 3: Confirm no uncommitted changes remain**

Run: `git status --short`
Expected: clean working tree (everything from Tasks 1–13 was committed individually).

---

## Self-Review Notes

**Spec coverage check** — every finding from the design doc maps to a task:

| Finding(s)        | Task                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| 2.1               | Task 1                                                                                                         |
| 3.2/4.2, 4.1, 5.1 | Task 2, Task 3                                                                                                 |
| 2.2/6.1           | Task 4, Task 6                                                                                                 |
| 2.3               | Task 5, Task 6                                                                                                 |
| 4.3               | Task 7                                                                                                         |
| 2.4, 2.5          | Task 8                                                                                                         |
| 8.2               | Task 9                                                                                                         |
| 7.2, 7.3          | Task 10                                                                                                        |
| 8.1               | Task 11                                                                                                        |
| 1.1               | Task 12                                                                                                        |
| 7.4               | Task 13                                                                                                        |
| 7.5               | No task — recorded decision only, confirmed by the user before this plan was written (see Global Constraints). |

All 18 findings accounted for.
