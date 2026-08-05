import { Test } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  HealthCheckError,
  MemoryHealthIndicator,
  TerminusModule,
} from '@nestjs/terminus';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('rejects with ServiceUnavailableException when a health indicator reports down', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
    })
      .overrideProvider(MemoryHealthIndicator)
      .useValue({
        checkHeap: jest.fn().mockRejectedValue(
          new HealthCheckError('memory_heap check failed', {
            memory_heap: { status: 'down' },
          }),
        ),
        checkRSS: jest.fn().mockResolvedValue({ memory_rss: { status: 'up' } }),
      })
      .compile();

    const controller = moduleRef.get(HealthController);

    await expect(controller.live()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('resolves with an ok status when all indicators are up', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
    })
      .overrideProvider(MemoryHealthIndicator)
      .useValue({
        checkHeap: jest
          .fn()
          .mockResolvedValue({ memory_heap: { status: 'up' } }),
        checkRSS: jest.fn().mockResolvedValue({ memory_rss: { status: 'up' } }),
      })
      .compile();

    const controller = moduleRef.get(HealthController);

    const result = await controller.ready();

    expect(result.status).toBe('ok');
  });
});
