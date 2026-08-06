import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from './env.validation';

// Must stay stateless: this class is registered twice in app.module.ts
// (once inside LoggerModule.forRootAsync's own providers, once in
// AppModule's top-level providers) — two independent instances exist,
// which is only safe because neither holds mutable state.
@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get port(): number {
    return this.configService.get('PORT', { infer: true });
  }

  get nodeEnv(): EnvConfig['NODE_ENV'] {
    return this.configService.get('NODE_ENV', { infer: true });
  }

  get logLevel(): EnvConfig['LOG_LEVEL'] {
    return this.configService.get('LOG_LEVEL', { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }
}
