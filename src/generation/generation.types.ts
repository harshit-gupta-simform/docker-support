import { CitationSource } from './citation-extractor.util';
import { TokenUsage } from './token-usage.util';

export interface GenerationMetadata {
  provider: string;
  framework: 'langchain';
  model: string;
  retrievedCount: number;
  usage?: TokenUsage;
  costUsd?: number;
}

export interface GenerationResult {
  answer: string;
  sources: CitationSource[];
  metadata: GenerationMetadata;
}
