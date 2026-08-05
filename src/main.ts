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
  app.enableShutdownHooks([], { useProcessExit: true });

  registerProcessCrashHandlers(logger);
  registerGracefulShutdown(logger, SHUTDOWN_TIMEOUT_MS);

  const appConfig = app.get(AppConfigService);

  await app.listen(appConfig.port);
}

void bootstrap();
