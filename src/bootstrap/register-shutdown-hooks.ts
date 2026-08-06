import type { Logger } from 'nestjs-pino';

// Single source of truth for shutdown signals: consumed both by the watchdog
// below and by app.enableShutdownHooks() in main.ts. Deliberately narrower than
// Nest's full ShutdownSignal enum — SIGHUP/SIGQUIT/SIGUSR2 and the fault signals
// (SIGSEGV/SIGABRT/...) are left to Node's default disposition. Adding a signal
// here changes BOTH the force-exit watchdog and Nest's lifecycle-hook coverage.
export const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

export function registerGracefulShutdown(
  logger: Logger,
  timeoutMs: number,
): void {
  let shuttingDown = false;

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      logger.log(`Received ${signal}, shutting down gracefully`);

      const forceExitTimer = setTimeout(() => {
        logger.error(
          `Graceful shutdown timed out after ${timeoutMs}ms, forcing exit`,
        );
        process.exit(1);
      }, timeoutMs);
      forceExitTimer.unref();
    });
  }
}
