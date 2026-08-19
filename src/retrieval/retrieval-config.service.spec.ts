import { ConfigService } from '@nestjs/config';
import { EnvConfig, validateEnv } from '../config/env.validation';
import { RetrievalConfigService } from './retrieval-config.service';

function buildService(
  overrides: Partial<Record<string, string>> = {},
): RetrievalConfigService {
  const env = validateEnv({ ...overrides });
  const configService = new ConfigService<EnvConfig, true>(env);
  return new RetrievalConfigService(configService);
}

describe('RetrievalConfigService', () => {
  it('exposes defaults matching the schema', () => {
    const service = buildService();
    expect(service.defaultTopK).toBe(10);
    expect(service.maxTopK).toBe(100);
    expect(service.scoreThreshold).toBe(0);
    expect(service.expandToParent).toBe(true);
    expect(service.requestTimeoutMs).toBe(10000);
    expect(service.maxRetries).toBe(2);
  });
});
