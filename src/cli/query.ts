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
import { VectorStoreConfigService } from '../vector-store/vector-store-config.service';
import { deriveCollectionName } from '../vector-store/vector-store-collection-name.util';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { RetrievalService } from '../retrieval/retrieval.service';

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
    RetrievalModule,
  ],
  providers: [AppConfigService],
})
class QueryCliModule {}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const text = args.join(' ').trim();

  if (!text) {
    console.error('Usage: pnpm query "<question>"');
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(QueryCliModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const retrieval = app.get(RetrievalService);
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
    const results = await retrieval.retrieve(
      { text, domain: vectorStoreConfig.domain },
      collection,
    );

    console.log(`\n=== Retrieval Results (collection: ${collection}) ===`);
    console.log(JSON.stringify(results, null, 2));
    console.log(`\n${results.length} result(s) returned.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nQuery failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
