import { createHash } from 'node:crypto';
import { Chunk } from '../chunking/chunking.types';
import {
  buildEmbeddingInput,
  estimateTokenCount,
} from './embedding-input-builder.util';

function buildChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    chunkId: 'chunk1',
    text: '## Install Docker Engine\n\nRun `docker --version` to verify.',
    metadata: {
      documentId: 'doc1',
      sourcePath: 'install.md',
      documentTitle: 'Install',
      headingPath: [
        {
          level: 1,
          text: 'Install Docker Engine',
          anchor: 'install-docker-engine',
        },
        { level: 2, text: 'On Ubuntu', anchor: 'on-ubuntu' },
      ],
      chunkType: 'child',
      contentTypes: ['paragraph', 'code'],
      length: 40,
      sequenceIndex: 0,
      wasSplit: false,
      wasMerged: false,
      mergedHeadings: [],
      exceedsMaxSize: false,
      contentHash: 'contenthash1',
      chunkedAt: '2026-01-01T00:00:00.000Z',
    },
    relationships: {
      parentChunkId: null,
      childChunkIds: [],
      previousChunkId: null,
      nextChunkId: null,
    },
    ...overrides,
  };
}

describe('estimateTokenCount', () => {
  it('estimates roughly 4 characters per token', () => {
    expect(estimateTokenCount('a'.repeat(400))).toBe(100);
  });

  it('returns 0 for an empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });
});

describe('buildEmbeddingInput', () => {
  const config = { includeHeadingContext: true, maxInputTokens: 8000 };

  it('copies chunkId, documentId, sourcePath, and contentHash from the chunk', () => {
    const input = buildEmbeddingInput(buildChunk(), config);

    expect(input?.chunkId).toBe('chunk1');
    expect(input?.documentId).toBe('doc1');
    expect(input?.sourcePath).toBe('install.md');
    expect(input?.contentHash).toBe('contenthash1');
  });

  it('prefixes the heading-path breadcrumb when includeHeadingContext is true', () => {
    const input = buildEmbeddingInput(buildChunk(), config);

    expect(input?.text.startsWith('Install Docker Engine › On Ubuntu')).toBe(
      true,
    );
    expect(input?.text).toContain('Run `docker --version` to verify.');
  });

  it('omits the breadcrumb when includeHeadingContext is false', () => {
    const input = buildEmbeddingInput(buildChunk(), {
      ...config,
      includeHeadingContext: false,
    });

    expect(input?.text.startsWith('Install Docker Engine ›')).toBe(false);
    expect(input?.text).toContain('Run `docker --version` to verify.');
  });

  it('omits the breadcrumb for a root-section chunk with an empty headingPath', () => {
    const input = buildEmbeddingInput(
      buildChunk({
        metadata: { ...buildChunk().metadata, headingPath: [] },
      }),
      config,
    );

    expect(input?.text).toBe(buildChunk().text);
  });

  it('normalizes 3+ consecutive newlines down to 2 and trims the result', () => {
    const chunk = buildChunk({
      text: '  paragraph one\n\n\n\nparagraph two  \n\n',
    });
    const input = buildEmbeddingInput(chunk, {
      ...config,
      includeHeadingContext: false,
    });

    expect(input?.text).toBe('paragraph one\n\nparagraph two');
  });

  it('returns null for a chunk whose text is empty after normalization', () => {
    const chunk = buildChunk({ text: '   \n\n  ' });
    const input = buildEmbeddingInput(chunk, {
      ...config,
      includeHeadingContext: false,
    });

    expect(input).toBeNull();
  });

  it('computes inputHash as the SHA-256 of the final prepared text', () => {
    const input = buildEmbeddingInput(buildChunk(), {
      ...config,
      includeHeadingContext: false,
    });
    const expected = createHash('sha256')
      .update(input!.text, 'utf-8')
      .digest('hex');

    expect(input?.inputHash).toBe(expected);
  });

  it('sets tokenCount to estimateTokenCount(finalText)', () => {
    const input = buildEmbeddingInput(buildChunk(), {
      ...config,
      includeHeadingContext: false,
    });

    expect(input?.tokenCount).toBe(estimateTokenCount(input!.text));
  });

  it('does not truncate text within the token limit', () => {
    const input = buildEmbeddingInput(buildChunk(), config);

    expect(input?.truncated).toBe(false);
  });

  it('truncates text exceeding maxInputTokens at a whitespace boundary and sets truncated true', () => {
    const longText = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    const chunk = buildChunk({ text: longText });
    const input = buildEmbeddingInput(chunk, {
      includeHeadingContext: false,
      maxInputTokens: 10, // ~40 characters
    });

    expect(input?.truncated).toBe(true);
    expect(input!.text.length).toBeLessThanOrEqual(40);
    expect(input!.text.endsWith(' ')).toBe(false);
    expect(input!.text.includes('word0')).toBe(true);
  });

  it('never truncates mid-word', () => {
    const longText = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    const chunk = buildChunk({ text: longText });
    const input = buildEmbeddingInput(chunk, {
      includeHeadingContext: false,
      maxInputTokens: 10,
    });

    const lastChar = input!.text[input!.text.length - 1]!;
    expect(longText.includes(input!.text)).toBe(true);
    expect(/\S/.test(lastChar)).toBe(true);
  });

  it('handles degenerate case: long unbroken run (no whitespace within limit) by extending past the limit to the next boundary', () => {
    // Text with no whitespace in the first ~40 chars, but whitespace exists later.
    // Example: 'word0 ' (6 chars) + 100 'x' chars (106 total unbroken) + ' word1'
    const degenerateText = 'word0 ' + 'x'.repeat(100) + ' word1';
    const chunk = buildChunk({ text: degenerateText });
    const input = buildEmbeddingInput(chunk, {
      includeHeadingContext: false,
      maxInputTokens: 10, // ~40 characters, but 'x' run is 100 chars long
    });

    expect(input).not.toBeNull();
    expect(input!.truncated).toBe(true);
    // The result must end at a word boundary: either at the space after 'word0',
    // or at the space after the 'x' run, or the full text if no whitespace exists.
    const lastChar = input!.text[input!.text.length - 1]!;
    expect(/\S/.test(lastChar)).toBe(true); // Never ends with whitespace after trim
    // The returned text must exist as a substring in the original (never mid-word cut).
    expect(degenerateText.includes(input!.text)).toBe(true);
  });

  it('returns full text without truncation when no whitespace exists after maxChars (degenerate: single unbroken word)', () => {
    // A single very long unbroken word (no whitespace at all).
    const singleWord = 'x'.repeat(500);
    const chunk = buildChunk({ text: singleWord });
    const input = buildEmbeddingInput(chunk, {
      includeHeadingContext: false,
      maxInputTokens: 10, // ~40 characters, much less than 500
    });

    expect(input).not.toBeNull();
    expect(input!.truncated).toBe(true);
    // Since there's no whitespace to split on, we return the full text.
    expect(input!.text).toBe(singleWord);
  });
});
