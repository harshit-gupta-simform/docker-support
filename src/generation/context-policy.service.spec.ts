import { ContextPolicyService } from './context-policy.service';
import { LlmConfigService } from './llm-config.service';
import { RetrievalResult } from '../retrieval/retrieval.types';

function buildConfig(
  overrides: Partial<LlmConfigService> = {},
): LlmConfigService {
  return {
    minRetrievalScore: 0,
    maxContextChunks: 5,
    maxContextChars: 12000,
    ...overrides,
  } as LlmConfigService;
}

function buildResult(
  overrides: Partial<RetrievalResult> = {},
): RetrievalResult {
  return {
    chunkId: 'c1',
    documentId: 'd1',
    parentChunkId: null,
    chunkType: 'child',
    score: 0.9,
    text: 'child text',
    parentText: null,
    headingPath: 'Install',
    documentTitle: 'Install Docker',
    sourcePath: 'install.md',
    domain: 'docker',
    ...overrides,
  };
}

describe('ContextPolicyService', () => {
  it('rejects with no_results when given an empty array', () => {
    const service = new ContextPolicyService(buildConfig());
    expect(service.select([])).toEqual({ ok: false, reason: 'no_results' });
  });

  it('rejects with below_threshold when every result scores under minRetrievalScore', () => {
    const service = new ContextPolicyService(
      buildConfig({ minRetrievalScore: 0.5 }),
    );
    const result = service.select([buildResult({ score: 0.2 })]);
    expect(result).toEqual({ ok: false, reason: 'below_threshold' });
  });

  it('selects results at or above minRetrievalScore, sorted by score descending', () => {
    const service = new ContextPolicyService(
      buildConfig({ minRetrievalScore: 0.5 }),
    );
    const low = buildResult({ chunkId: 'low', score: 0.6 });
    const high = buildResult({ chunkId: 'high', score: 0.9 });
    const result = service.select([low, high]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chunks.map((c) => c.result.chunkId)).toEqual([
        'high',
        'low',
      ]);
      expect(result.chunks[0]!.sourceId).toBe('S1');
      expect(result.chunks[1]!.sourceId).toBe('S2');
    }
  });

  it('deduplicates by chunkId', () => {
    const service = new ContextPolicyService(buildConfig());
    const dup = buildResult({ chunkId: 'dup', score: 0.9 });
    const result = service.select([dup, { ...dup }]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chunks).toHaveLength(1);
    }
  });

  it('caps the number of selected chunks at maxContextChunks', () => {
    const service = new ContextPolicyService(
      buildConfig({ maxContextChunks: 1 }),
    );
    const a = buildResult({ chunkId: 'a', score: 0.9 });
    const b = buildResult({ chunkId: 'b', score: 0.8 });
    const result = service.select([a, b]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]!.result.chunkId).toBe('a');
    }
  });

  it('prefers parentText over text when present', () => {
    const service = new ContextPolicyService(buildConfig());
    const result = service.select([
      buildResult({ text: 'child only', parentText: 'full parent context' }),
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chunks[0]!.text).toBe('full parent context');
    }
  });

  it('truncates an oversized chunk to the remaining character budget', () => {
    const service = new ContextPolicyService(
      buildConfig({ maxContextChars: 10 }),
    );
    const result = service.select([
      buildResult({ text: 'x'.repeat(50), parentText: null }),
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chunks[0]!.text).toHaveLength(10);
    }
  });

  it('drops later chunks once the character budget is exhausted', () => {
    const service = new ContextPolicyService(
      buildConfig({ maxContextChars: 5 }),
    );
    const a = buildResult({
      chunkId: 'a',
      score: 0.9,
      text: 'x'.repeat(5),
      parentText: null,
    });
    const b = buildResult({
      chunkId: 'b',
      score: 0.8,
      text: 'y'.repeat(5),
      parentText: null,
    });
    const result = service.select([a, b]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]!.result.chunkId).toBe('a');
    }
  });
});
