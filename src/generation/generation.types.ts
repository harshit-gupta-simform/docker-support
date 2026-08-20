import { CitationSource } from './citation-extractor.util';

export interface GenerationMetadata {
  provider: string;
  framework: 'langchain';
  model: string;
  retrievedCount: number;
}

export interface GenerationResult {
  answer: string;
  sources: CitationSource[];
  metadata: GenerationMetadata;
}
