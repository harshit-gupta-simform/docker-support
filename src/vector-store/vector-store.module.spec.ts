import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from '../config/env.validation';
import { VectorStoreModule } from './vector-store.module';
import { VECTOR_STORE_PORT } from './vector-store.port';
import { FakeVectorStoreAdapter } from './providers/fake-vector-store.adapter';
import { QdrantVectorStoreAdapter } from './providers/qdrant-vector-store.adapter';

async function buildModule(env: Record<string, string>) {
  const original = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        LoggerModule.forRoot(),
        VectorStoreModule,
      ],
    }).compile();
  } finally {
    process.env = original;
  }
}

describe('VectorStoreModule', () => {
  it('binds FakeVectorStoreAdapter when VECTOR_STORE_PROVIDER=fake', async () => {
    const moduleRef = await buildModule({ VECTOR_STORE_PROVIDER: 'fake' });
    expect(moduleRef.get(VECTOR_STORE_PORT)).toBeInstanceOf(
      FakeVectorStoreAdapter,
    );
  });

  it('binds QdrantVectorStoreAdapter when VECTOR_STORE_PROVIDER=qdrant', async () => {
    const moduleRef = await buildModule({ VECTOR_STORE_PROVIDER: 'qdrant' });
    expect(moduleRef.get(VECTOR_STORE_PORT)).toBeInstanceOf(
      QdrantVectorStoreAdapter,
    );
  });
});
