import { SelectedContextChunk } from './context-policy.types';

export interface CitationSource {
  documentId: string;
  chunkId: string;
  title: string;
  headingPath: string;
  source: string;
  score: number;
}

function toCitationSource(chunk: SelectedContextChunk): CitationSource {
  const { result } = chunk;
  return {
    documentId: result.documentId,
    chunkId: result.chunkId,
    title: result.documentTitle || '(untitled)',
    headingPath: result.headingPath || '(none)',
    source: result.sourcePath || '(unknown source)',
    score: result.score,
  };
}

export function extractCitations(
  answerText: string,
  chunks: SelectedContextChunk[],
): CitationSource[] {
  const bySourceId = new Map(chunks.map((chunk) => [chunk.sourceId, chunk]));
  const cited = new Set<string>();
  const ordered: CitationSource[] = [];

  for (const match of answerText.matchAll(/\[S(\d+)]/g)) {
    const sourceId = `S${match[1]}`;
    const chunk = bySourceId.get(sourceId);
    if (chunk !== undefined && !cited.has(sourceId)) {
      cited.add(sourceId);
      ordered.push(toCitationSource(chunk));
    }
  }

  // No fallback to "every sent chunk" here: a model that correctly declines
  // to answer (insufficient grounding) also cites nothing, and attaching
  // every retrieved chunk as a "source" to a non-answer is more misleading
  // than an empty sources array — confirmed against a real Gemini call
  // during the M5 smoke test (2026-08-20).
  return ordered;
}
