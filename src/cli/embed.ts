import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger, LoggerModule } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { validateEnv } from '../config/env.validation';
import { buildPinoHttpOptions } from '../config/pino-http-options.factory';
import { EmbeddingModule } from '../embedding/embedding.module';
import { EmbeddingPipelineService } from '../embedding/embedding-pipeline.service';

const DEFAULT_CHUNKS_DIR = './data/chunks-output';

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
    EmbeddingModule,
  ],
  providers: [AppConfigService],
})
class EmbedCliModule {}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const chunksDir = args[0] ?? DEFAULT_CHUNKS_DIR;

  const app = await NestFactory.createApplicationContext(EmbedCliModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const pipeline = app.get(EmbeddingPipelineService);

  try {
    const result = await pipeline.run(chunksDir);

    console.log('\n=== Embedding Result ===');
    console.log(JSON.stringify(result, null, 2));
    console.log(`\nEmbeddings written to: ${result.outputPath}`);

    if (result.failed > 0) {
      console.error(
        `\n${result.failed} chunk(s) failed to embed — see "failures" above.`,
      );
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nEmbedding run failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
