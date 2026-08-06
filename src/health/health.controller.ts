import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  MemoryHealthIndicator,
} from '@nestjs/terminus';

const HEAP_THRESHOLD_BYTES = 300 * 1024 * 1024;
const RSS_THRESHOLD_BYTES = 300 * 1024 * 1024;

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
  ) {}

  @Get('live')
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.runChecks();
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.runChecks();
  }

  private runChecks(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', HEAP_THRESHOLD_BYTES),
      () => this.memory.checkRSS('memory_rss', RSS_THRESHOLD_BYTES),
    ]);
  }
}
