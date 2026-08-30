import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger, LoggerModule } from 'nestjs-pino';
import { ChunkingModule } from '../chunking/chunking.module';
import { ChunkingPipelineService } from '../chunking/chunking-pipeline.service';
import { AppConfigService } from '../config/app-config.service';
import { validateEnv } from '../config/env.validation';
import { buildPinoHttpOptions } from '../config/pino-http-options.factory';

const DEFAULT_INGESTION_DIR = './data/ingestion-output';

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
    ChunkingModule,
  ],
  providers: [AppConfigService],
})
class ChunkCliModule {}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const inputDir = args[0] ?? DEFAULT_INGESTION_DIR;

  const app = await NestFactory.createApplicationContext(ChunkCliModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const pipeline = app.get(ChunkingPipelineService);

  try {
    const result = await pipeline.run(inputDir);

    console.log('\n=== Chunking Result ===');
    console.log(JSON.stringify(result, null, 2));
    console.log(`\nChunk JSON files written to: ${result.outputDir}`);

    if (result.failed > 0) {
      console.error(
        `\n${result.failed} document(s) failed to chunk — see "failures" above.`,
      );
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nChunking run failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
