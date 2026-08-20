import { Module } from '@nestjs/common';
import { EmbeddingConfigService } from '../embedding/embedding-config.service';
import { EmbeddingModule } from '../embedding/embedding.module';
import { GenerationModule } from '../generation/generation.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { RetrievalConfigService } from './retrieval-config.service';
import { RetrievalController } from './retrieval.controller';
import { RetrievalService } from './retrieval.service';

@Module({
  imports: [EmbeddingModule, VectorStoreModule, GenerationModule],
  controllers: [RetrievalController],
  providers: [RetrievalConfigService, RetrievalService, EmbeddingConfigService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
