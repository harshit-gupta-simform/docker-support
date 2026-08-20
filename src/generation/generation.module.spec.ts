import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from '../config/env.validation';
import { GenerationModule } from './generation.module';
import { GenerationService } from './generation.service';

describe('GenerationModule', () => {
  it('resolves GenerationService with a fake LLM provider', async () => {
    const original = { ...process.env };
    Object.assign(process.env, { LLM_PROVIDER: 'fake' });
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
          LoggerModule.forRoot(),
          GenerationModule,
        ],
      }).compile();

      expect(moduleRef.get(GenerationService)).toBeInstanceOf(
        GenerationService,
      );
    } finally {
      process.env = original;
    }
  });
});
