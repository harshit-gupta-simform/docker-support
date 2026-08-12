import {
  EmbeddingProviderPort,
  EmbeddingProviderRequestItem,
  EmbeddingProviderResponseItem,
} from '../embedding-provider.port';
import {
  PermanentEmbeddingProviderError,
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from '../embedding.errors';
import { EmbeddingModelMetadata } from '../embedding.types';
import { parseRetryAfterMs } from './retry-after.util';

interface VoyageResponseBody {
  data: { embedding: number[]; index: number }[];
}

const DEFAULT_BASE_URL = 'https://api.voyageai.com/v1/embeddings';

export class VoyageEmbeddingProviderAdapter implements EmbeddingProviderPort {
  constructor(
    private readonly apiKey: string,
    public readonly metadata: EmbeddingModelMetadata,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  async embed(
    items: EmbeddingProviderRequestItem[],
    signal?: AbortSignal,
  ): Promise<EmbeddingProviderResponseItem[]> {
    let response: Response;
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: items.map((item) => item.text),
          model: this.metadata.model,
          input_type: 'document',
          output_dimension: this.metadata.dimensions,
        }),
      };
      if (signal !== undefined) {
        init.signal = signal;
      }
      response = await fetch(this.baseUrl, init);
    } catch (err) {
      throw new TransientEmbeddingProviderError(
        'Voyage embeddings request failed',
        {
          cause: err,
        },
      );
    }

    if (!response.ok) {
      throw this.toError(response);
    }

    const body = (await response.json()) as VoyageResponseBody;
    return items.map((item, index) => {
      const entry = body.data.find((candidate) => candidate.index === index);
      return { id: item.id, vector: entry?.embedding ?? [] };
    });
  }

  private toError(response: Response): Error {
    if (response.status === 429) {
      return new RateLimitEmbeddingProviderError(
        'Voyage rate limit exceeded',
        parseRetryAfterMs(response.headers.get('retry-after')),
      );
    }
    if (response.status >= 500) {
      return new TransientEmbeddingProviderError(
        `Voyage embeddings request failed with status ${response.status}`,
      );
    }
    return new PermanentEmbeddingProviderError(
      `Voyage embeddings request failed with status ${response.status}`,
    );
  }
}
