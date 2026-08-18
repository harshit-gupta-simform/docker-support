import { ChunkType } from '../chunking/chunking.types';

export interface VectorPayload {
  chunkId: string;
  documentId: string;
  parentChunkId: string | null;
  chunkType: ChunkType;
  contentHash: string;
  headingPath: string;
  documentTitle: string;
  sourcePath: string;
  domain: string;
  text: string;
  parentText: string | null;
  provider: string;
  model: string;
  modelVersion: string;
  dimensions: number;
  embeddingId: string;
  indexedAt: string;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: VectorPayload;
}

export interface VectorSearchFilter {
  domain?: string;
  documentId?: string;
  chunkType?: ChunkType;
  sourcePath?: string;
}

export interface VectorSearchQuery {
  collection: string;
  vector: number[];
  topK: number;
  scoreThreshold?: number;
  filter?: VectorSearchFilter;
}

export interface VectorSearchMatch {
  id: string;
  score: number;
  payload: VectorPayload;
}

export interface CollectionInfo {
  dimensions: number;
  pointCount: number;
}

export interface IndexFailure {
  chunkId: string;
  message: string;
}

export interface IndexRunResult {
  jobId: string;
  collection: string;
  totalRecordsScanned: number;
  skippedByProvenanceMismatch: number;
  skippedFakeProvider: number;
  attempted: number;
  succeeded: number;
  failed: number;
  failures: IndexFailure[];
  totalBatches: number;
  durationMs: number;
}

export type { ChunkType };
