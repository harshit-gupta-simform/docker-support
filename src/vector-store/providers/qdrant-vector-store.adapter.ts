import { VectorStorePort } from '../vector-store.port';
import {
  PermanentVectorStoreError,
  TransientVectorStoreError,
} from '../vector-store.errors';
import {
  CollectionInfo,
  VectorPayload,
  VectorPoint,
  VectorSearchFilter,
  VectorSearchMatch,
  VectorSearchQuery,
} from '../vector-store.types';

interface QdrantFilterCondition {
  key: string;
  match: { value: string };
}

function buildQdrantFilter(
  filter?: VectorSearchFilter,
): { must: QdrantFilterCondition[] } | undefined {
  if (!filter) return undefined;
  const must: QdrantFilterCondition[] = [];
  if (filter.domain !== undefined)
    must.push({ key: 'domain', match: { value: filter.domain } });
  if (filter.documentId !== undefined)
    must.push({ key: 'documentId', match: { value: filter.documentId } });
  if (filter.chunkType !== undefined)
    must.push({ key: 'chunkType', match: { value: filter.chunkType } });
  if (filter.sourcePath !== undefined)
    must.push({ key: 'sourcePath', match: { value: filter.sourcePath } });
  if (must.length === 0) return undefined;
  return { must };
}

export class QdrantVectorStoreAdapter implements VectorStorePort {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  async ensureCollection(
    collection: string,
    dimensions: number,
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.url}/collections/${collection}`, {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({
          vectors: { size: dimensions, distance: 'Cosine' },
        }),
      });
    } catch (err) {
      throw new TransientVectorStoreError(
        'Qdrant ensureCollection request failed',
        {
          cause: err,
        },
      );
    }
    if (!response.ok && response.status !== 409) {
      throw this.toError(response);
    }
  }

  async collectionInfo(collection: string): Promise<CollectionInfo | null> {
    let response: Response;
    try {
      response = await fetch(`${this.url}/collections/${collection}`, {
        method: 'GET',
        headers: this.headers(),
      });
    } catch (err) {
      throw new TransientVectorStoreError(
        'Qdrant collectionInfo request failed',
        {
          cause: err,
        },
      );
    }
    if (response.status === 404) return null;
    if (!response.ok) throw this.toError(response);

    const body = (await response.json()) as {
      result: {
        points_count: number;
        config: { params: { vectors: { size: number } } };
      };
    };
    return {
      dimensions: body.result.config.params.vectors.size,
      pointCount: body.result.points_count,
    };
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    let response: Response;
    try {
      response = await fetch(
        `${this.url}/collections/${collection}/points?wait=true`,
        {
          method: 'PUT',
          headers: this.headers(),
          body: JSON.stringify({
            points: points.map((p) => ({
              id: p.id,
              vector: p.vector,
              payload: p.payload,
            })),
          }),
        },
      );
    } catch (err) {
      throw new TransientVectorStoreError('Qdrant upsert request failed', {
        cause: err,
      });
    }
    if (!response.ok) throw this.toError(response);
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchMatch[]> {
    let response: Response;
    try {
      const body: Record<string, unknown> = {
        vector: query.vector,
        limit: query.topK,
        with_payload: true,
      };
      const filter = buildQdrantFilter(query.filter);
      if (filter) body.filter = filter;
      if (query.scoreThreshold !== undefined)
        body.score_threshold = query.scoreThreshold;

      response = await fetch(
        `${this.url}/collections/${query.collection}/points/search`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
        },
      );
    } catch (err) {
      throw new TransientVectorStoreError('Qdrant search request failed', {
        cause: err,
      });
    }
    if (!response.ok) throw this.toError(response);

    const parsed = (await response.json()) as {
      result: Array<{ id: string; score: number; payload: VectorPayload }>;
    };
    return parsed.result.map((r) => ({
      id: r.id,
      score: r.score,
      payload: r.payload,
    }));
  }

  async deleteByFilter(
    collection: string,
    filter: VectorSearchFilter,
  ): Promise<number> {
    const qdrantFilter = buildQdrantFilter(filter) ?? { must: [] };

    // Count matching points before deleting: Qdrant's delete endpoint does
    // not report how many points it removed, so we must count first.
    let countResponse: Response;
    try {
      countResponse = await fetch(
        `${this.url}/collections/${collection}/points/count`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ filter: qdrantFilter }),
        },
      );
    } catch (err) {
      throw new TransientVectorStoreError('Qdrant count request failed', {
        cause: err,
      });
    }
    if (!countResponse.ok) throw this.toError(countResponse);
    const counted = (await countResponse.json()) as {
      result: { count: number };
    };
    const matchCount = counted.result.count;
    if (matchCount === 0) return 0;

    let response: Response;
    try {
      response = await fetch(
        `${this.url}/collections/${collection}/points/delete?wait=true`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ filter: qdrantFilter }),
        },
      );
    } catch (err) {
      throw new TransientVectorStoreError('Qdrant delete request failed', {
        cause: err,
      });
    }
    if (!response.ok) throw this.toError(response);

    return matchCount;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) headers['api-key'] = this.apiKey;
    return headers;
  }

  private toError(response: Response): Error {
    if (response.status === 429) {
      return new TransientVectorStoreError(
        `Qdrant rate limit exceeded (status ${response.status})`,
      );
    }
    if (response.status >= 500) {
      return new TransientVectorStoreError(
        `Qdrant request failed with status ${response.status}`,
      );
    }
    return new PermanentVectorStoreError(
      `Qdrant request failed with status ${response.status}`,
    );
  }
}
