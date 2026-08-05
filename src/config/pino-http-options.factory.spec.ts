import { buildPinoHttpOptions } from './pino-http-options.factory';
import { AppConfigService } from './app-config.service';

function createAppConfig(overrides: {
  logLevel?: string;
  isProduction?: boolean;
}): AppConfigService {
  return {
    logLevel: 'info',
    isProduction: false,
    ...overrides,
  } as unknown as AppConfigService;
}

describe('buildPinoHttpOptions', () => {
  it('uses the configured log level', () => {
    const options = buildPinoHttpOptions(
      createAppConfig({ logLevel: 'debug' }),
    );

    expect(options.level).toBe('debug');
  });

  it('redacts authorization and cookie headers', () => {
    const options = buildPinoHttpOptions(createAppConfig({}));

    expect(options.redact).toEqual([
      'req.headers.authorization',
      'req.headers.cookie',
    ]);
  });

  it('includes a pino-pretty transport outside production', () => {
    const options = buildPinoHttpOptions(
      createAppConfig({ isProduction: false }),
    );

    expect(options.transport).toEqual({
      target: 'pino-pretty',
      options: { singleLine: true },
    });
  });

  it('omits the transport in production', () => {
    const options = buildPinoHttpOptions(
      createAppConfig({ isProduction: true }),
    );

    expect(options.transport).toBeUndefined();
  });
});
