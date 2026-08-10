import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';
import { LengthStrategy } from './length-measurer';

@Injectable()
export class ChunkingConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get maxChunkSize(): number {
    return this.configService.get('CHUNKING_MAX_CHUNK_SIZE', { infer: true });
  }

  get minChunkSize(): number {
    return this.configService.get('CHUNKING_MIN_CHUNK_SIZE', { infer: true });
  }

  get lengthStrategy(): LengthStrategy {
    return this.configService.get('CHUNKING_LENGTH_STRATEGY', {
      infer: true,
    });
  }

  get overlapStrategy(): 'none' | 'heading-context' | 'sentence-overlap' {
    return this.configService.get('CHUNKING_OVERLAP_STRATEGY', {
      infer: true,
    });
  }

  get overlapSentences(): number {
    return this.configService.get('CHUNKING_OVERLAP_SENTENCES', {
      infer: true,
    });
  }

  get includeParentChunks(): boolean {
    return this.configService.get('CHUNKING_INCLUDE_PARENT_CHUNKS', {
      infer: true,
    });
  }

  get outputDir(): string {
    return this.configService.get('CHUNKING_OUTPUT_DIR', { infer: true });
  }
}
