import { ChunkAssemblerService } from './chunk-assembler.service';
import { ChunkingConfigService } from './chunking-config.service';
import { ResolvedPiece, Section } from './chunking.types';

function buildLogger(): { setContext: jest.Mock } {
  return { setContext: jest.fn() };
}

function buildConfig(
  overrides: Partial<{
    includeParentChunks: boolean;
    overlapStrategy: 'none' | 'heading-context' | 'sentence-overlap';
    overlapSentences: number;
  }> = {},
): ChunkingConfigService {
  return {
    includeParentChunks: overrides.includeParentChunks ?? true,
    overlapStrategy: overrides.overlapStrategy ?? 'heading-context',
    overlapSentences: overrides.overlapSentences ?? 1,
  } as ChunkingConfigService;
}

function sectionOf(headingText: string, level = 1): Section {
  const anchor = headingText.toLowerCase().replace(/\s+/g, '-');
  return {
    headingText,
    headingLevel: level,
    anchor,
    headingPath: [{ level, text: headingText, anchor }],
    blocks: [],
    children: [],
  };
}

function pieceFor(
  section: Section,
  overrides: Partial<ResolvedPiece> = {},
): ResolvedPiece {
  return {
    section,
    headingPath: section.headingPath,
    localSequenceIndex: 0,
    text: `## ${section.headingText}\n\nBody.`,
    length: 10,
    wasSplit: false,
    wasMerged: false,
    mergedHeadings: [],
    exceedsMaxSize: false,
    contentTypes: ['paragraph'],
    ...overrides,
  };
}

describe('ChunkAssemblerService', () => {
  it('assembles one child chunk per resolved piece with correct metadata', () => {
    const service = new ChunkAssemblerService(
      buildConfig(),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA],
    };
    const pieces = [pieceFor(sectionA)];

    const chunks = service.assemble(pieces, root, 'doc1', 'a.md', 'A Doc');
    const childChunks = chunks.filter((c) => c.metadata.chunkType === 'child');

    expect(childChunks).toHaveLength(1);
    expect(childChunks[0]?.metadata.documentId).toBe('doc1');
    expect(childChunks[0]?.metadata.sourcePath).toBe('a.md');
    expect(childChunks[0]?.metadata.headingPath).toEqual(sectionA.headingPath);
    expect(childChunks[0]?.metadata.sequenceIndex).toBe(0);
    expect(childChunks[0]?.metadata.contentHash).toHaveLength(64);
  });

  it('links previousChunkId/nextChunkId across the whole document in reading order', () => {
    const service = new ChunkAssemblerService(
      buildConfig(),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const sectionB = sectionOf('B');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA, sectionB],
    };
    const pieces = [pieceFor(sectionA), pieceFor(sectionB)];

    const chunks = service.assemble(pieces, root, 'doc1', 'a.md', 'A Doc');
    const childChunks = chunks.filter((c) => c.metadata.chunkType === 'child');

    expect(childChunks[0]?.relationships.previousChunkId).toBeNull();
    expect(childChunks[0]?.relationships.nextChunkId).toBe(
      childChunks[1]?.chunkId,
    );
    expect(childChunks[1]?.relationships.previousChunkId).toBe(
      childChunks[0]?.chunkId,
    );
    expect(childChunks[1]?.relationships.nextChunkId).toBeNull();
  });

  it('emits one parent chunk per section when includeParentChunks is true, always with null parentChunkId', () => {
    const service = new ChunkAssemblerService(
      buildConfig({ includeParentChunks: true }),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA],
    };
    const pieces = [pieceFor(sectionA)];

    const chunks = service.assemble(pieces, root, 'doc1', 'a.md', 'A Doc');
    const parentChunks = chunks.filter(
      (c) => c.metadata.chunkType === 'parent',
    );

    expect(parentChunks).toHaveLength(1);
    expect(parentChunks[0]?.relationships.parentChunkId).toBeNull();
    expect(parentChunks[0]?.relationships.previousChunkId).toBeNull();
    expect(parentChunks[0]?.relationships.nextChunkId).toBeNull();
  });

  it('links a child chunk to its own section parent chunk, and the parent back to its children', () => {
    const service = new ChunkAssemblerService(
      buildConfig({ includeParentChunks: true }),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA],
    };
    const pieces = [pieceFor(sectionA)];

    const chunks = service.assemble(pieces, root, 'doc1', 'a.md', 'A Doc');
    const parentChunk = chunks.find((c) => c.metadata.chunkType === 'parent')!;
    const childChunk = chunks.find((c) => c.metadata.chunkType === 'child')!;

    expect(childChunk.relationships.parentChunkId).toBe(parentChunk.chunkId);
    expect(parentChunk.relationships.childChunkIds).toEqual([
      childChunk.chunkId,
    ]);
  });

  it('gives a section whose content was merged away an empty parent childChunkIds', () => {
    const service = new ChunkAssemblerService(
      buildConfig({ includeParentChunks: true }),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const sectionB = sectionOf('B');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA, sectionB],
    };
    // Simulate a merge: one piece whose `section` is sectionA (the "first"
    // section in the merged run) and mergedHeadings includes B's heading.
    const mergedPiece = pieceFor(sectionA, {
      wasMerged: true,
      mergedHeadings: ['B'],
    });

    const chunks = service.assemble(
      [mergedPiece],
      root,
      'doc1',
      'a.md',
      'A Doc',
    );
    const parentOfB = chunks.find(
      (c) =>
        c.metadata.chunkType === 'parent' &&
        c.metadata.headingPath[0]?.text === 'B',
    )!;

    expect(parentOfB.relationships.childChunkIds).toEqual([]);
  });

  it('produces no parent chunks when includeParentChunks is false', () => {
    const service = new ChunkAssemblerService(
      buildConfig({ includeParentChunks: false }),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA],
    };
    const pieces = [pieceFor(sectionA)];

    const chunks = service.assemble(pieces, root, 'doc1', 'a.md', 'A Doc');

    expect(chunks.every((c) => c.metadata.chunkType === 'child')).toBe(true);
    expect(chunks[0]?.relationships.parentChunkId).toBeNull();
  });

  it('prefixes a heading-context breadcrumb on split continuation pieces only', () => {
    const service = new ChunkAssemblerService(
      buildConfig({ overlapStrategy: 'heading-context' }),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA],
    };
    const firstPiece = pieceFor(sectionA, {
      wasSplit: true,
      localSequenceIndex: 0,
    });
    const secondPiece = pieceFor(sectionA, {
      wasSplit: true,
      localSequenceIndex: 1,
    });

    const chunks = service.assemble(
      [firstPiece, secondPiece],
      root,
      'doc1',
      'a.md',
      'A Doc',
    );
    const childChunks = chunks.filter((c) => c.metadata.chunkType === 'child');

    expect(childChunks[0]?.text).not.toContain('continued from');
    expect(childChunks[1]?.text).toContain('continued from');
  });

  it('applies no overlap text when overlapStrategy is none', () => {
    const service = new ChunkAssemblerService(
      buildConfig({ overlapStrategy: 'none' }),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA],
    };
    const secondPiece = pieceFor(sectionA, {
      wasSplit: true,
      localSequenceIndex: 1,
    });

    const chunks = service.assemble(
      [secondPiece],
      root,
      'doc1',
      'a.md',
      'A Doc',
    );

    expect(chunks[0]?.text).not.toContain('continued from');
  });
});
