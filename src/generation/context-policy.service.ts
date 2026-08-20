import { Injectable } from '@nestjs/common';
import { RetrievalResult } from '../retrieval/retrieval.types';
import { ContextSelection, SelectedContextChunk } from './context-policy.types';
import { LlmConfigService } from './llm-config.service';

@Injectable()
export class ContextPolicyService {
  constructor(private readonly config: LlmConfigService) {}

  select(results: RetrievalResult[]): ContextSelection {
    if (results.length === 0) {
      return { ok: false, reason: 'no_results' };
    }

    const seen = new Set<string>();
    const deduped = results.filter((result) => {
      if (seen.has(result.chunkId)) {
        return false;
      }
      seen.add(result.chunkId);
      return true;
    });

    const aboveThreshold = deduped
      .filter((result) => result.score >= this.config.minRetrievalScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.maxContextChunks);

    if (aboveThreshold.length === 0) {
      return { ok: false, reason: 'below_threshold' };
    }

    const chunks: SelectedContextChunk[] = [];
    let remainingChars = this.config.maxContextChars;

    for (const [index, result] of aboveThreshold.entries()) {
      if (remainingChars <= 0) {
        break;
      }
      const text = this.selectText(result, remainingChars);
      remainingChars -= text.length;
      chunks.push({ sourceId: `S${index + 1}`, result, text });
    }

    return { ok: true, chunks };
  }

  private selectText(result: RetrievalResult, remainingChars: number): string {
    const fullText = result.parentText ?? result.text;
    return fullText.length > remainingChars
      ? fullText.slice(0, remainingChars)
      : fullText;
  }
}
