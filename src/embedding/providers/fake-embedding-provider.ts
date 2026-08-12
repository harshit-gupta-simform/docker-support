import { createHash } from 'node:crypto';
import {
  EmbeddingProviderPort,
  EmbeddingProviderRequestItem,
  EmbeddingProviderResponseItem,
} from '../embedding-provider.port';
import { TransientEmbeddingProviderError } from '../embedding.errors';
import { EmbeddingModelMetadata } from '../embedding.types';

export interface FakeEmbeddingProviderOptions {
  failFirstNCalls?: number;
  failWith?: () => Error;
  delayMs?: number;
}

export class FakeEmbeddingProvider implements EmbeddingProviderPort {
  private callCount = 0;

  constructor(
    public readonly metadata: EmbeddingModelMetadata,
    private readonly options: FakeEmbeddingProviderOptions = {},
  ) {}

  async embed(
    items: EmbeddingProviderRequestItem[],
  ): Promise<EmbeddingProviderResponseItem[]> {
    this.callCount += 1;

    if (this.options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }

    if (
      this.options.failFirstNCalls &&
      this.callCount <= this.options.failFirstNCalls
    ) {
      throw this.options.failWith
        ? this.options.failWith()
        : new TransientEmbeddingProviderError('fake transient failure');
    }

    return items.map((item) => ({
      id: item.id,
      vector: this.deterministicVector(item.text),
    }));
  }

  private deterministicVector(text: string): number[] {
    const hash = createHash('sha256').update(text, 'utf-8').digest();
    const vector: number[] = [];
    for (let i = 0; i < this.metadata.dimensions; i += 1) {
      vector.push((hash[i % hash.length]! / 255) * 2 - 1);
    }
    return vector;
  }
}
