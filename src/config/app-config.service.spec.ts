import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { EnvConfig } from './env.validation';

describe('AppConfigService', () => {
  async function createService(config: EnvConfig): Promise<AppConfigService> {
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
