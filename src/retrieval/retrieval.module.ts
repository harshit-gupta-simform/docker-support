import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding/embedding.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { RetrievalConfigService } from './retrieval-config.service';
import { RetrievalService } from './retrieval.service';

@Module({
  imports: [EmbeddingModule, VectorStoreModule],
  providers: [RetrievalConfigService, RetrievalService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
