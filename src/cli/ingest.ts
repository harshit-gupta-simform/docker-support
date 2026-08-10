import { readFile } from 'node:fs/promises';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger, LoggerModule } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { validateEnv } from '../config/env.validation';
import { buildPinoHttpOptions } from '../config/pino-http-options.factory';
import { IngestionPipelineService } from '../ingestion/ingestion-pipeline.service';
import { IngestionModule } from '../ingestion/ingestion.module';

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
    IngestionModule,
  ],
  providers: [AppConfigService],
})
class IngestCliModule {}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const zipPath = args[0];

  if (!zipPath) {
    console.error('Usage: pnpm ingest <path-to-zip>');
    console.error('Example: pnpm ingest ./docs/docker-docs.zip');
    process.exitCode = 1;
    return;
  }

  let zipBuffer: Buffer;
  try {
    zipBuffer = await readFile(zipPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Could not read "${zipPath}": ${message}`);
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(IngestCliModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const pipeline = app.get(IngestionPipelineService);

  try {
    const result = await pipeline.run(zipBuffer);

    console.log('\n=== Ingestion Result ===');
    console.log(JSON.stringify(result, null, 2));
    console.log(
      `\nStructuredDocument JSON files written to: ${result.outputDir}`,
    );

    if (result.failed > 0) {
      console.error(
        `\n${result.failed} file(s) failed to ingest — see "failures" above.`,
      );
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nIngestion run failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
