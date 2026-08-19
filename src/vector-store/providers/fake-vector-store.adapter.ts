import { VectorStorePort } from '../vector-store.port';
import { VectorStoreValidationError } from '../vector-store.errors';
import {
  CollectionInfo,
  VectorPoint,
  VectorSearchFilter,
  VectorSearchMatch,
  VectorSearchQuery,
} from '../vector-store.types';

interface FakeCollection {
  dimensions: number;
  points: Map<string, VectorPoint>;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function matchesFilter(
  payload: VectorPoint['payload'],
  filter?: VectorSearchFilter,
): boolean {
  if (!filter) return true;
  if (filter.domain !== undefined && payload.domain !== filter.domain)
    return false;
  if (
    filter.documentId !== undefined &&
    payload.documentId !== filter.documentId
  )
    return false;
  if (filter.chunkType !== undefined && payload.chunkType !== filter.chunkType)
    return false;
  if (
    filter.sourcePath !== undefined &&
    payload.sourcePath !== filter.sourcePath
  )
    return false;
  return true;
}

export class FakeVectorStoreAdapter implements VectorStorePort {
  private readonly collections = new Map<string, FakeCollection>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async ensureCollection(
    collection: string,
    dimensions: number,
  ): Promise<void> {
    if (!this.collections.has(collection)) {
      this.collections.set(collection, { dimensions, points: new Map() });
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async collectionInfo(collection: string): Promise<CollectionInfo | null> {
    const found = this.collections.get(collection);
    if (!found) return null;
    return { dimensions: found.dimensions, pointCount: found.points.size };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    const found = this.collections.get(collection);
    if (!found) {
      throw new Error(`Collection "${collection}" does not exist`);
    }
    for (const point of points) {
      found.points.set(point.id, point);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async search(query: VectorSearchQuery): Promise<VectorSearchMatch[]> {
    const found = this.collections.get(query.collection);
    if (!found) return [];

    const scored = Array.from(found.points.values())
      .filter((point) => matchesFilter(point.payload, query.filter))
      .map((point) => ({
        id: point.id,
        score: cosineSimilarity(query.vector, point.vector),
        payload: point.payload,
      }))
      .filter(
        (match) =>
          query.scoreThreshold === undefined ||
          match.score >= query.scoreThreshold,
      )
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, query.topK);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteByFilter(
    collection: string,
    filter: VectorSearchFilter,
  ): Promise<number> {
    if (
      filter.domain === undefined &&
      filter.documentId === undefined &&
      filter.chunkType === undefined &&
      filter.sourcePath === undefined
    ) {
      throw new VectorStoreValidationError(
        'deleteByFilter requires at least one filter condition — refusing to delete an entire collection implicitly',
      );
    }

    const found = this.collections.get(collection);
    if (!found) return 0;

    let deleted = 0;
    for (const [id, point] of found.points) {
      if (matchesFilter(point.payload, filter)) {
        found.points.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }
}
