import {
  CollectionInfo,
  VectorPoint,
  VectorSearchFilter,
  VectorSearchQuery,
  VectorSearchMatch,
} from './vector-store.types';

export const VECTOR_STORE_PORT = Symbol('VECTOR_STORE_PORT');

export interface VectorStorePort {
  ensureCollection(collection: string, dimensions: number): Promise<void>;
  collectionInfo(collection: string): Promise<CollectionInfo | null>;
  upsert(collection: string, points: VectorPoint[]): Promise<void>;
  search(query: VectorSearchQuery): Promise<VectorSearchMatch[]>;
  deleteByFilter(
    collection: string,
    filter: VectorSearchFilter,
  ): Promise<number>;
}
