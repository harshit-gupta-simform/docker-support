import { ChunkType } from '../chunking/chunking.types';

export interface EmbeddingModelMetadata {
  provider: string;
  model: string;
  modelVersion: string;
  dimensions: number;
}

export interface EmbeddingInput {
  chunkId: string;
  documentId: string;
  sourcePath: string;
  contentHash: string;
  text: string;
  inputHash: string;
  tokenCount: number;
  truncated: boolean;
}

export interface EmbeddingRecord {
  embeddingId: string;
  chunkId: string;
  documentId: string;
  sourcePath: string;
  vector: number[];
  dimensions: number;
  provider: string;
  model: string;
  modelVersion: string;
  contentHash: string;
  inputHash: string;
  inputTokenCount: number;
  truncated: boolean;
  createdAt: string;
}

export interface EmbeddingFailure {
  chunkId: string;
  sourcePath: string;
  message: string;
}

export interface EmbeddingRunResult {
  jobId: string;
  totalChunksScanned: number;
  skippedByType: number;
  skippedEmpty: number;
  alreadyEmbedded: number;
  skippedByMaxChunksCap: number;
  attempted: number;
  succeeded: number;
  failed: number;
  failures: EmbeddingFailure[];
  totalBatches: number;
  provider: string;
  model: string;
  outputPath: string;
  durationMs: number;
}

// Re-exported so consumers of this module never need their own import of
// chunking.types for this one type (design §1: type-only cross-module
// dependency, kept to a single named re-export point).
export type { ChunkType };
