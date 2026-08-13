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

interface GoogleEmbedContentResponseItem {
  values: number[];
}

interface GoogleBatchEmbedContentsResponseBody {
  embeddings: GoogleEmbedContentResponseItem[];
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Google's Gemini API authenticates via the `x-goog-api-key` header — not
// the `Authorization: Bearer` scheme Voyage/OpenAI use — and its
// batchEmbedContents response is a bare, positionally-ordered array with no
// per-item index/id field the way Voyage/OpenAI's `data[].index` provides.
// Unlike those two adapters, this one cannot defensively re-sort a reordered
// response: it trusts Google's own documented "response order matches
// request order" contract. The shared `validateProviderResponse` still
// catches a missing/extra item (a count mismatch); only a same-count
// silent reorder — which Google's docs give no indication the API ever
// does — would slip through undetected. This is a known, accepted, and
// documented limitation of this adapter specifically, not of the shared
// port design.
export class GoogleEmbeddingProviderAdapter implements EmbeddingProviderPort {
  constructor(
    private readonly apiKey: string,
    public readonly metadata: EmbeddingModelMetadata,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  async embed(
    items: EmbeddingProviderRequestItem[],
    signal?: AbortSignal,
  ): Promise<EmbeddingProviderResponseItem[]> {
    const url = `${this.baseUrl}/models/${this.metadata.model}:batchEmbedContents`;
    let response: Response;
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          requests: items.map((item) => ({
            content: { parts: [{ text: item.text }] },
            embedContentConfig: {
              taskType: 'RETRIEVAL_DOCUMENT',
              outputDimensionality: this.metadata.dimensions,
            },
          })),
        }),
      };
      if (signal !== undefined) {
        init.signal = signal;
      }
      response = await fetch(url, init);
    } catch (err) {
      throw new TransientEmbeddingProviderError(
        'Google embeddings request failed',
        { cause: err },
      );
    }

    if (!response.ok) {
      throw this.toError(response);
    }

    const body =
      (await response.json()) as GoogleBatchEmbedContentsResponseBody;
    return items.map((item, index) => ({
      id: item.id,
      vector: body.embeddings[index]?.values ?? [],
    }));
  }

  private toError(response: Response): Error {
    if (response.status === 429) {
      return new RateLimitEmbeddingProviderError(
        'Google rate limit exceeded',
        parseRetryAfterMs(response.headers.get('retry-after')),
      );
    }
    if (response.status >= 500) {
      return new TransientEmbeddingProviderError(
        `Google embeddings request failed with status ${response.status}`,
      );
    }
    return new PermanentEmbeddingProviderError(
      `Google embeddings request failed with status ${response.status}`,
    );
  }
}
