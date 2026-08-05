import type { Logger } from 'nestjs-pino';

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

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
