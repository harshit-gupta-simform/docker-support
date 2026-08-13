import { Module } from '@nestjs/common';
import { EmbeddingBatchProcessorService } from './embedding-batch-processor.service';
import { EmbeddingConfigService } from './embedding-config.service';
import { EmbeddingOutputStoreService } from './embedding-output-store.service';
import { EmbeddingPipelineService } from './embedding-pipeline.service';
import {
  EMBEDDING_PROVIDER_PORT,
  EmbeddingProviderPort,
} from './embedding-provider.port';
import { FakeEmbeddingProvider } from './providers/fake-embedding-provider';
import { OpenAiEmbeddingProviderAdapter } from './providers/openai-embedding-provider.adapter';
import { VoyageEmbeddingProviderAdapter } from './providers/voyage-embedding-provider.adapter';
import { GoogleEmbeddingProviderAdapter } from './providers/google-embedding-provider.adapter';

function createEmbeddingProvider(
  config: EmbeddingConfigService,
): EmbeddingProviderPort {
  const metadata = {
    provider: config.provider,
    model: config.model,
    modelVersion: config.modelVersion,
    dimensions: config.dimensions,
  };

  if (config.provider === 'fake') {
    return new FakeEmbeddingProvider(metadata);
  }

  if (!config.apiKey) {
    throw new Error(
      `EMBEDDING_API_KEY is required when EMBEDDING_PROVIDER=${config.provider}`,
    );
  }

  if (config.provider === 'voyage') {
    return config.baseUrl
      ? new VoyageEmbeddingProviderAdapter(
          config.apiKey,
          metadata,
          config.baseUrl,
        )
      : new VoyageEmbeddingProviderAdapter(config.apiKey, metadata);
  }

  if (config.provider === 'google') {
    return config.baseUrl
      ? new GoogleEmbeddingProviderAdapter(
          config.apiKey,
          metadata,
          config.baseUrl,
        )
      : new GoogleEmbeddingProviderAdapter(config.apiKey, metadata);
  }

  return config.baseUrl
    ? new OpenAiEmbeddingProviderAdapter(
        config.apiKey,
        metadata,
        config.baseUrl,
      )
    : new OpenAiEmbeddingProviderAdapter(config.apiKey, metadata);
}

@Module({
  providers: [
    EmbeddingConfigService,
    {
      provide: EMBEDDING_PROVIDER_PORT,
      useFactory: createEmbeddingProvider,
      inject: [EmbeddingConfigService],
    },
    EmbeddingOutputStoreService,
    EmbeddingBatchProcessorService,
    EmbeddingPipelineService,
  ],
  exports: [EmbeddingPipelineService],
})
export class EmbeddingModule {}
