export type ContentBlockType = 'paragraph' | 'code' | 'list' | 'table' | 'note';

export interface ContentBlock {
  type: ContentBlockType;
  text: string;
  language: string | null;
  length: number;
  // Populated only for 'list' blocks — one entry per top-level list item, in
  // document order, used by SectionSizeBounderService to split a list that
  // alone exceeds maxChunkSize without ever splitting mid-item.
  itemTexts?: string[];
  // Populated only for 'table' blocks — the header row + separator row,
  // verbatim, repeated at the top of every split piece after the first when
  // a table alone exceeds maxChunkSize.
  headerText?: string;
  // Populated only for 'table' blocks — one entry per data row (excludes the
  // header and separator rows).
  rowTexts?: string[];
}

export interface HeadingPathSegment {
  level: number;
  text: string;
  anchor: string;
}

export interface Section {
  headingText: string;
  headingLevel: number;
  anchor: string;
  headingPath: HeadingPathSegment[];
  blocks: ContentBlock[];
  children: Section[];
}

export type ChunkType = 'parent' | 'child';

export interface ChunkRelationships {
  parentChunkId: string | null;
  childChunkIds: string[];
  previousChunkId: string | null;
  nextChunkId: string | null;
}

export interface ChunkMetadata {
  documentId: string;
  sourcePath: string;
  documentTitle: string;
  headingPath: HeadingPathSegment[];
  chunkType: ChunkType;
  contentTypes: ContentBlockType[];
  length: number;
  sequenceIndex: number;
  wasSplit: boolean;
  wasMerged: boolean;
  mergedHeadings: string[];
  exceedsMaxSize: boolean;
  contentHash: string;
  chunkedAt: string;
}

export interface Chunk {
  chunkId: string;
  text: string;
  metadata: ChunkMetadata;
  relationships: ChunkRelationships;
}

export interface ChunkingResult {
  documentId: string;
  chunks: Chunk[];
  totalSections: number;
  splitSections: number;
  mergedSections: number;
  durationMs: number;
}

// Internal Phase-2 output / Phase-3 input — never exposed outside the module.
export interface ResolvedPiece {
  section: Section;
  headingPath: HeadingPathSegment[];
  localSequenceIndex: number;
  text: string;
  length: number;
  wasSplit: boolean;
  wasMerged: boolean;
  mergedHeadings: string[];
  exceedsMaxSize: boolean;
  contentTypes: ContentBlockType[];
}
