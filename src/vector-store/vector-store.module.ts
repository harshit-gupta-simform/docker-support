import { Module } from '@nestjs/common';
import { IndexingBatchProcessorService } from './indexing-batch-processor.service';
import { IndexingPipelineService } from './indexing-pipeline.service';
import { VectorStoreConfigService } from './vector-store-config.service';
import { VECTOR_STORE_PORT, VectorStorePort } from './vector-store.port';
import { FakeVectorStoreAdapter } from './providers/fake-vector-store.adapter';
import { QdrantVectorStoreAdapter } from './providers/qdrant-vector-store.adapter';

function createVectorStore(config: VectorStoreConfigService): VectorStorePort {
  if (config.provider === 'fake') {
    return new FakeVectorStoreAdapter();
  }
  return new QdrantVectorStoreAdapter(config.url, config.apiKey);
}

@Module({
  providers: [
    VectorStoreConfigService,
    {
      provide: VECTOR_STORE_PORT,
      useFactory: createVectorStore,
      inject: [VectorStoreConfigService],
    },
    IndexingBatchProcessorService,
    IndexingPipelineService,
  ],
  exports: [
    IndexingPipelineService,
    VECTOR_STORE_PORT,
    VectorStoreConfigService,
  ],
})
export class VectorStoreModule {}
