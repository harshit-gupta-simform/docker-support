import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { EnvConfig } from './env.validation';

const DEFAULT_ENV_CONFIG: EnvConfig = {
  NODE_ENV: 'development',
  PORT: 3000,
  LOG_LEVEL: 'info',
  INGESTION_OUTPUT_DIR: './data/ingestion-output',
  INGESTION_MAX_ENTRY_COUNT: 10000,
  INGESTION_MAX_UNCOMPRESSED_BYTES: 524288000,
  INGESTION_INCLUDE_GLOB: '**/*.md',
  INGESTION_DEFAULT_LANGUAGE: 'en',
};

describe('AppConfigService', () => {
  async function createService(
    overrides: Partial<EnvConfig>,
  ): Promise<AppConfigService> {
    const config: EnvConfig = { ...DEFAULT_ENV_CONFIG, ...overrides };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppConfigService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: keyof EnvConfig) => config[key],
          },
        },
      ],
    }).compile();

    return moduleRef.get(AppConfigService);
  }

  it('exposes the configured port as a number', async () => {
    const service = await createService({
      NODE_ENV: 'development',
      PORT: 4000,
      LOG_LEVEL: 'info',
    });

    expect(service.port).toBe(4000);
  });

  it('exposes the configured node environment', async () => {
    const service = await createService({
      NODE_ENV: 'test',
      PORT: 3000,
      LOG_LEVEL: 'info',
    });

    expect(service.nodeEnv).toBe('test');
  });

  it('exposes the configured log level', async () => {
    const service = await createService({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'debug',
    });

    expect(service.logLevel).toBe('debug');
  });

  it('reports isProduction as true only when NODE_ENV is production', async () => {
    const prod = await createService({
      NODE_ENV: 'production',
      PORT: 3000,
      LOG_LEVEL: 'info',
    });
    const dev = await createService({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
    });

    expect(prod.isProduction).toBe(true);
    expect(dev.isProduction).toBe(false);
  });
});
