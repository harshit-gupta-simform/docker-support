import { Module } from '@nestjs/common';
import { DocumentCleanerService } from './document-cleaner.service';
import { IngestionConfigService } from './ingestion-config.service';
import { IngestionPipelineService } from './ingestion-pipeline.service';
import { MarkdownParserService } from './markdown-parser.service';
import { MetadataGeneratorService } from './metadata-generator.service';
import { ZipExtractorService } from './zip-extractor.service';

@Module({
  providers: [
    IngestionConfigService,
    ZipExtractorService,
    DocumentCleanerService,
    MarkdownParserService,
    MetadataGeneratorService,
    IngestionPipelineService,
  ],
  exports: [IngestionPipelineService],
})
export class IngestionModule {}
