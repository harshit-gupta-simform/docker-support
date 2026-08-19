import { ChunkType } from '../chunking/chunking.types';

export interface RetrievalFilter {
  domain?: string;
  documentId?: string;
  sourcePath?: string;
}

export interface RetrievalQuery {
  text: string;
  domain: string;
  topK?: number;
  scoreThreshold?: number;
  filter?: RetrievalFilter;
  expandToParent?: boolean;
}

export interface RetrievalResult {
  chunkId: string;
  documentId: string;
  parentChunkId: string | null;
  chunkType: ChunkType;
  score: number;
  text: string;
  parentText: string | null;
  headingPath: string;
  documentTitle: string;
  sourcePath: string;
  domain: string;
}

export type { ChunkType };
