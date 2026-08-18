import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger, LoggerModule } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { validateEnv } from '../config/env.validation';
import { buildPinoHttpOptions } from '../config/pino-http-options.factory';
import { EmbeddingConfigService } from '../embedding/embedding-config.service';
import { EmbeddingModule } from '../embedding/embedding.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { IndexingPipelineService } from '../vector-store/indexing-pipeline.service';
import { VectorStoreConfigService } from '../vector-store/vector-store-config.service';
import { deriveCollectionName } from '../vector-store/vector-store-collection-name.util';

const DEFAULT_EMBEDDINGS_FILE = './data/embedding-output/embeddings.jsonl';
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
    VectorStoreModule,
  ],
  providers: [AppConfigService],
})
class IndexCliModule {}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const embeddingsFile = args[0] ?? DEFAULT_EMBEDDINGS_FILE;
  const chunksDir = args[1] ?? DEFAULT_CHUNKS_DIR;

  const app = await NestFactory.createApplicationContext(IndexCliModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const pipeline = app.get(IndexingPipelineService);
  const vectorStoreConfig = app.get(VectorStoreConfigService);
  const embeddingConfig = app.get(EmbeddingConfigService);

  const collection = deriveCollectionName({
    domain: vectorStoreConfig.domain,
    provider: embeddingConfig.provider,
    model: embeddingConfig.model,
    dimensions: embeddingConfig.dimensions,
    modelVersion: embeddingConfig.modelVersion,
  });

  try {
    const result = await pipeline.run(embeddingsFile, chunksDir, collection);

    console.log('\n=== Indexing Result ===');
    console.log(JSON.stringify(result, null, 2));
    console.log(`\nCollection: ${result.collection}`);

    if (result.failed > 0) {
      console.error(
        `\n${result.failed} point(s) failed to index — see "failures" above.`,
      );
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nIndexing run failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
