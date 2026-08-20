import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from '../config/env.validation';
import { EmbeddingModule } from '../embedding/embedding.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { RetrievalController } from './retrieval.controller';
import { RetrievalModule } from './retrieval.module';
import { RetrievalService } from './retrieval.service';

describe('RetrievalModule', () => {
  it('resolves RetrievalService and RetrievalController with their EmbeddingModule and VectorStoreModule dependencies', async () => {
    const original = { ...process.env };
    Object.assign(process.env, {
      EMBEDDING_PROVIDER: 'fake',
      VECTOR_STORE_PROVIDER: 'fake',
    });
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
          LoggerModule.forRoot(),
          EmbeddingModule,
          VectorStoreModule,
          RetrievalModule,
        ],
      }).compile();

      expect(moduleRef.get(RetrievalService)).toBeInstanceOf(RetrievalService);
      expect(moduleRef.get(RetrievalController)).toBeInstanceOf(
        RetrievalController,
      );
    } finally {
      process.env = original;
    }
  });
});
