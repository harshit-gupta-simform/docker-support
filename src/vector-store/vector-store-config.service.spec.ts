import { ConfigService } from '@nestjs/config';
import { EnvConfig, validateEnv } from '../config/env.validation';
import { VectorStoreConfigService } from './vector-store-config.service';

function buildService(
  overrides: Partial<Record<string, string>> = {},
): VectorStoreConfigService {
  const env = validateEnv({ ...overrides });
  const configService = new ConfigService<EnvConfig, true>(env);
  return new VectorStoreConfigService(configService);
}

describe('VectorStoreConfigService', () => {
  it('exposes defaults matching the schema', () => {
    const service = buildService();
    expect(service.provider).toBe('qdrant');
    expect(service.url).toBe('http://localhost:6333');
    expect(service.domain).toBe('docker');
    expect(service.batchSize).toBe(200);
    expect(service.maxConcurrentBatches).toBe(4);
    expect(service.failureThreshold).toBe(0.5);
    expect(service.skipExisting).toBe(true);
    expect(service.allowFakeProvider).toBe(false);
  });

  it('reflects overridden values', () => {
    const service = buildService({
      VECTOR_STORE_PROVIDER: 'fake',
      VECTOR_STORE_ALLOW_FAKE_PROVIDER: 'true',
    });
    expect(service.provider).toBe('fake');
    expect(service.allowFakeProvider).toBe(true);
  });
});
