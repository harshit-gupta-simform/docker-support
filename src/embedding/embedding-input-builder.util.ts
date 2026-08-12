import { createHash } from 'node:crypto';
import { Chunk } from '../chunking/chunking.types';
import { EmbeddingInput } from './embedding.types';

const CHARS_PER_APPROX_TOKEN = 4;

// Deliberately duplicates chunking's approx-token heuristic rather than
// importing LengthMeasurerPort from src/chunking/ — this module must stay
// completely independent of chunking's runtime code (design §6). The
// duplication is 3 lines and the two heuristics are free to diverge later.
export function estimateTokenCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_APPROX_TOKEN);
}

function normalize(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateToTokenLimit(
  text: string,
  maxInputTokens: number,
): { text: string; truncated: boolean } {
  const maxChars = maxInputTokens * CHARS_PER_APPROX_TOKEN;
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const slice = text.slice(0, maxChars);
  const lastWhitespace = slice.search(/\s\S*$/);
  const safeSlice = lastWhitespace > 0 ? slice.slice(0, lastWhitespace) : slice;
  return { text: safeSlice.trimEnd(), truncated: true };
}

export function buildEmbeddingInput(
  chunk: Chunk,
  options: { includeHeadingContext: boolean; maxInputTokens: number },
): EmbeddingInput | null {
  const breadcrumb = chunk.metadata.headingPath
    .map((segment) => segment.text)
    .join(' › ');

  const withContext =
    options.includeHeadingContext && breadcrumb.length > 0
      ? `${breadcrumb}\n\n${chunk.text}`
      : chunk.text;

  const normalized = normalize(withContext);
  if (normalized.length === 0) {
    return null;
  }

  const { text: finalText, truncated } = truncateToTokenLimit(
    normalized,
    options.maxInputTokens,
  );

  return {
    chunkId: chunk.chunkId,
    documentId: chunk.metadata.documentId,
    sourcePath: chunk.metadata.sourcePath,
    contentHash: chunk.metadata.contentHash,
    text: finalText,
    inputHash: createHash('sha256').update(finalText, 'utf-8').digest('hex'),
    tokenCount: estimateTokenCount(finalText),
    truncated,
  };
}
