import { ChunkAssemblerService } from './chunk-assembler.service';
import { ChunkingConfigService } from './chunking-config.service';
import { ResolvedPiece, Section } from './chunking.types';

function buildLogger(): { setContext: jest.Mock } {
  return { setContext: jest.fn() };
}

function buildMeasurer(): { measure: (text: string) => number } {
  return { measure: (text: string) => text.length };
}

function buildConfig(
  overrides: Partial<{
    includeParentChunks: boolean;
    overlapStrategy: 'none' | 'heading-context' | 'sentence-overlap';
    overlapSentences: number;
    maxChunkSize: number;
  }> = {},
): ChunkingConfigService {
  return {
    includeParentChunks: overrides.includeParentChunks ?? true,
    overlapStrategy: overrides.overlapStrategy ?? 'heading-context',
    overlapSentences: overrides.overlapSentences ?? 1,
    maxChunkSize: overrides.maxChunkSize ?? 500,
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
      buildMeasurer(),
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
      buildMeasurer(),
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
      buildMeasurer(),
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

  it('computes parent-chunk length via the injected LengthMeasurerPort, not raw character count', () => {
    // Regression test for a bug found via real-data validation: parent
    // chunks were using fullText.length (character count) directly instead
    // of the configured length strategy, making parent/child lengths
    // inconsistent units and masking truly oversized parent chunks.
    const stubMeasurer = { measure: (text: string) => text.length / 4 };
    const service = new ChunkAssemblerService(
      stubMeasurer,
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

    expect(parentChunk.metadata.length).toBe(parentChunk.text.length / 4);
    expect(parentChunk.metadata.length).not.toBe(parentChunk.text.length);
  });

  it('flags a parent chunk as exceedsMaxSize when its length is over maxChunkSize', () => {
    // sectionA's fullText is just its heading line "## A" (4 characters) —
    // it has no own blocks and no children — so maxChunkSize must be below
    // 4 to actually trigger the oversized flag.
    const stubMeasurer = { measure: (text: string) => text.length };
    const service = new ChunkAssemblerService(
      stubMeasurer,
      buildConfig({ includeParentChunks: true, maxChunkSize: 2 }),
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

    expect(parentChunk.metadata.exceedsMaxSize).toBe(true);
  });

  it('gives a parent chunk and its own leaf section child chunk different chunkIds', () => {
    // Regression test for the chunkId collision bug found via real-data
    // validation: parent and child chunks for the same unsplit, unmerged
    // section previously shared an identical chunkId.
    const service = new ChunkAssemblerService(
      buildMeasurer(),
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

    expect(parentChunk.chunkId).not.toBe(childChunk.chunkId);
  });

  it('gives two sections with identical heading text at the same nesting depth different chunkIds', () => {
    // Regression test for a real bug found via a full run against Docker's
    // actual documentation corpus (github.com/docker/docs): pages like
    // uninstall.md have two separate, un-nested "## From the GUI"
    // subsections (one per platform tab) sharing the exact same heading
    // text and depth — headingPath alone can't distinguish them, so both
    // previously produced colliding chunkIds.
    const service = new ChunkAssemblerService(
      buildMeasurer(),
      buildConfig({ includeParentChunks: true }),
      buildLogger() as never,
    );
    const sectionA1 = sectionOf('From the GUI');
    const sectionA2 = sectionOf('From the GUI');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA1, sectionA2],
    };
    const pieces = [pieceFor(sectionA1), pieceFor(sectionA2)];

    const chunks = service.assemble(pieces, root, 'doc1', 'a.md', 'A Doc');
    const childChunks = chunks.filter((c) => c.metadata.chunkType === 'child');
    const parentChunks = chunks.filter(
      (c) => c.metadata.chunkType === 'parent',
    );

    expect(childChunks).toHaveLength(2);
    expect(childChunks[0]?.chunkId).not.toBe(childChunks[1]?.chunkId);
    expect(parentChunks).toHaveLength(2);
    expect(parentChunks[0]?.chunkId).not.toBe(parentChunks[1]?.chunkId);

    // Each child must still link to its own correct parent, not the other's.
    expect(childChunks[0]?.relationships.parentChunkId).toBe(
      parentChunks[0]?.chunkId,
    );
    expect(childChunks[1]?.relationships.parentChunkId).toBe(
      parentChunks[1]?.chunkId,
    );
  });

  it('keeps split pieces of one section under the same occurrence while a later, distinct section with the same heading text gets a new occurrence', () => {
    const service = new ChunkAssemblerService(
      buildMeasurer(),
      buildConfig({ includeParentChunks: false }),
      buildLogger() as never,
    );
    const sectionA = sectionOf('Examples');
    const sectionB = sectionOf('Examples');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA, sectionB],
    };
    const splitPiece0 = pieceFor(sectionA, {
      wasSplit: true,
      localSequenceIndex: 0,
    });
    const splitPiece1 = pieceFor(sectionA, {
      wasSplit: true,
      localSequenceIndex: 1,
    });
    const laterPiece = pieceFor(sectionB, { localSequenceIndex: 0 });

    const chunks = service.assemble(
      [splitPiece0, splitPiece1, laterPiece],
      root,
      'doc1',
      'a.md',
      'A Doc',
    );

    const ids = chunks.map((c) => c.chunkId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('links a child chunk to its own section parent chunk, and the parent back to its children', () => {
    const service = new ChunkAssemblerService(
      buildMeasurer(),
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
      buildMeasurer(),
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
      buildMeasurer(),
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
      buildMeasurer(),
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
      buildMeasurer(),
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
