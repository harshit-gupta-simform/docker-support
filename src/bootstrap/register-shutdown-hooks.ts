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
