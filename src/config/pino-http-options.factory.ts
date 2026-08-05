import type { Options } from 'pino-http';
import { AppConfigService } from './app-config.service';

// Extend this list whenever a new header carries credentials or secrets
// (e.g. a future API-key header for admin endpoints).
const REDACT_PATHS = ['req.headers.authorization', 'req.headers.cookie'];

export function buildPinoHttpOptions(appConfig: AppConfigService): Options {
  return {
    level: appConfig.logLevel,
    redact: REDACT_PATHS,
    autoLogging: true,
    ...(appConfig.isProduction
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: { singleLine: true },
          },
        }),
  };
}
