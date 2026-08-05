import type { Logger } from 'nestjs-pino';

export function registerProcessCrashHandlers(logger: Logger): void {
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection', 'Bootstrap');
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    logger.error({ err: error }, 'Uncaught exception', 'Bootstrap');
    process.exit(1);
  });
}
