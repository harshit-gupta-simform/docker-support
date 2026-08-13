import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from '../config/env.validation';
import { EmbeddingModule } from './embedding.module';
import { EmbeddingPipelineService } from './embedding-pipeline.service';
import { EMBEDDING_PROVIDER_PORT } from './embedding-provider.port';
import { FakeEmbeddingProvider } from './providers/fake-embedding-provider';
import { VoyageEmbeddingProviderAdapter } from './providers/voyage-embedding-provider.adapter';
import { OpenAiEmbeddingProviderAdapter } from './providers/openai-embedding-provider.adapter';
import { GoogleEmbeddingProviderAdapter } from './providers/google-embedding-provider.adapter';

async function buildModule(env: Record<string, string>) {
  process.env = { ...process.env, ...env };
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        validate: validateEnv,
        cache: false,
      }),
      LoggerModule.forRoot(),
      EmbeddingModule,
    ],
  }).compile();
}

describe('EmbeddingModule', () => {
  it('exports a working EmbeddingPipelineService', async () => {
    const moduleRef = await buildModule({ EMBEDDING_PROVIDER: 'fake' });

    expect(moduleRef.get(EmbeddingPipelineService)).toBeInstanceOf(
      EmbeddingPipelineService,
    );
  });

  it('binds EMBEDDING_PROVIDER_PORT to FakeEmbeddingProvider when EMBEDDING_PROVIDER=fake', async () => {
    const moduleRef = await buildModule({ EMBEDDING_PROVIDER: 'fake' });

    expect(moduleRef.get(EMBEDDING_PROVIDER_PORT)).toBeInstanceOf(
      FakeEmbeddingProvider,
    );
  });

  it('binds EMBEDDING_PROVIDER_PORT to VoyageEmbeddingProviderAdapter when EMBEDDING_PROVIDER=voyage', async () => {
    const moduleRef = await buildModule({
      EMBEDDING_PROVIDER: 'voyage',
      EMBEDDING_API_KEY: 'key',
    });

    expect(moduleRef.get(EMBEDDING_PROVIDER_PORT)).toBeInstanceOf(
      VoyageEmbeddingProviderAdapter,
    );
  });

  it('binds EMBEDDING_PROVIDER_PORT to OpenAiEmbeddingProviderAdapter when EMBEDDING_PROVIDER=openai', async () => {
    const moduleRef = await buildModule({
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_API_KEY: 'key',
    });

    expect(moduleRef.get(EMBEDDING_PROVIDER_PORT)).toBeInstanceOf(
      OpenAiEmbeddingProviderAdapter,
    );
  });

  it('binds EMBEDDING_PROVIDER_PORT to GoogleEmbeddingProviderAdapter when EMBEDDING_PROVIDER=google', async () => {
    const moduleRef = await buildModule({
      EMBEDDING_PROVIDER: 'google',
      EMBEDDING_API_KEY: 'key',
    });

    expect(moduleRef.get(EMBEDDING_PROVIDER_PORT)).toBeInstanceOf(
      GoogleEmbeddingProviderAdapter,
    );
  });

  it('throws a clear config error when a real provider is selected without an API key', async () => {
    await expect(
      buildModule({ EMBEDDING_PROVIDER: 'voyage', EMBEDDING_API_KEY: '' }),
    ).rejects.toThrow(/EMBEDDING_API_KEY/);
  });
});
