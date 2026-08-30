import { RetrievalResult } from '../retrieval/retrieval.types';

export interface SelectedContextChunk {
  sourceId: string;
  result: RetrievalResult;
  text: string;
}

export type ContextSelection =
  | { ok: true; chunks: SelectedContextChunk[] }
  | { ok: false; reason: 'no_results' | 'below_threshold' };
