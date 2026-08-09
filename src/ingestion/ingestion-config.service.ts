import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';

@Injectable()
export class IngestionConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get outputDir(): string {
    return this.configService.get('INGESTION_OUTPUT_DIR', { infer: true });
  }

  get maxEntryCount(): number {
    return this.configService.get('INGESTION_MAX_ENTRY_COUNT', {
      infer: true,
    });
  }

  get maxUncompressedBytes(): number {
    return this.configService.get('INGESTION_MAX_UNCOMPRESSED_BYTES', {
      infer: true,
    });
  }

  get includeGlob(): string {
    return this.configService.get('INGESTION_INCLUDE_GLOB', { infer: true });
  }

  get defaultLanguage(): string {
    return this.configService.get('INGESTION_DEFAULT_LANGUAGE', {
      infer: true,
    });
  }
}
