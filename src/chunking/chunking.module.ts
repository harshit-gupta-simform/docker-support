import { Module } from '@nestjs/common';
import { ChunkAssemblerService } from './chunk-assembler.service';
import { ChunkingConfigService } from './chunking-config.service';
import { ChunkingPipelineService } from './chunking-pipeline.service';
import { createLengthMeasurer, LENGTH_MEASURER_PORT } from './length-measurer';
import { MarkdownSectionParserService } from './markdown-section-parser.service';
import { SectionSizeBounderService } from './section-size-bounder.service';

@Module({
  providers: [
    ChunkingConfigService,
    {
      provide: LENGTH_MEASURER_PORT,
      useFactory: (config: ChunkingConfigService) =>
        createLengthMeasurer(config.lengthStrategy),
      inject: [ChunkingConfigService],
    },
    MarkdownSectionParserService,
    SectionSizeBounderService,
    ChunkAssemblerService,
    ChunkingPipelineService,
  ],
  exports: [ChunkingPipelineService],
})
export class ChunkingModule {}
