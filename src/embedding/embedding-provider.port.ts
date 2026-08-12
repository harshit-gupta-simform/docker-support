import { EmbeddingModelMetadata } from './embedding.types';

export const EMBEDDING_PROVIDER_PORT = Symbol('EMBEDDING_PROVIDER_PORT');

export interface EmbeddingProviderRequestItem {
  id: string;
  text: string;
}

export interface EmbeddingProviderResponseItem {
  id: string;
  vector: number[];
}

export interface EmbeddingProviderPort {
  readonly metadata: EmbeddingModelMetadata;
  embed(
    items: EmbeddingProviderRequestItem[],
    signal?: AbortSignal,
  ): Promise<EmbeddingProviderResponseItem[]>;
}
