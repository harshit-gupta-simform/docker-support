export interface RawFile {
  sourcePath: string;
  content: Buffer;
  uncompressedSize: number;
  compressedSize: number;
  lastModified: Date;
}

export interface ExtractionResult {
  files: RawFile[];
  totalEntries: number;
}

export interface CleanedFile {
  sourcePath: string;
  text: string;
  frontMatter: Record<string, unknown>;
}

export interface HeadingNode {
  level: number;
  text: string;
  anchor: string;
  children: HeadingNode[];
}

export interface CodeBlock {
  language: string | null;
  content: string;
  position: number;
}

export interface ParsedDocument {
  sourcePath: string;
  title: string;
  headings: HeadingNode[];
  bodyText: string;
  codeBlocks: CodeBlock[];
  links: string[];
}

export interface DocumentMetadata {
  title: string;
  sourcePath: string;
  contentHash: string;
  wordCount: number;
  language: string;
  headingOutline: HeadingNode[];
  frontMatter: Record<string, unknown>;
  extractedAt: string;
}

export interface StructuredDocument {
  documentId: string;
  metadata: DocumentMetadata;
  headings: HeadingNode[];
  bodyText: string;
  codeBlocks: CodeBlock[];
}

export interface IngestionFailure {
  sourcePath: string;
  message: string;
}

export interface IngestionResult {
  totalEntries: number;
  matchedEntries: number;
  succeeded: number;
  failed: number;
  failures: IngestionFailure[];
  outputDir: string;
  durationMs: number;
}
