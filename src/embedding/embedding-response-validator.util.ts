import {
  EmbeddingProviderRequestItem,
  EmbeddingProviderResponseItem,
} from './embedding-provider.port';
import { EmbeddingResponseValidationError } from './embedding.errors';

export function validateProviderResponse(
  requestItems: EmbeddingProviderRequestItem[],
  responseItems: EmbeddingProviderResponseItem[],
  expectedDimensions: number,
): void {
  if (responseItems.length !== requestItems.length) {
    throw new EmbeddingResponseValidationError(
      `Provider returned ${responseItems.length} embeddings for ${requestItems.length} requested inputs`,
    );
  }

  requestItems.forEach((requestItem, index) => {
    const responseItem = responseItems[index]!;

    if (responseItem.id !== requestItem.id) {
      throw new EmbeddingResponseValidationError(
        `Provider response ordering mismatch at index ${index}: expected id "${requestItem.id}", got "${responseItem.id}"`,
      );
    }

    if (
      !Array.isArray(responseItem.vector) ||
      responseItem.vector.length === 0
    ) {
      throw new EmbeddingResponseValidationError(
        `Missing vector for chunk "${requestItem.id}"`,
      );
    }

    if (responseItem.vector.length !== expectedDimensions) {
      throw new EmbeddingResponseValidationError(
        `Vector for chunk "${requestItem.id}" has ${responseItem.vector.length} dimensions, expected ${expectedDimensions}`,
      );
    }

    if (
      responseItem.vector.some(
        (value) => typeof value !== 'number' || !Number.isFinite(value),
      )
    ) {
      throw new EmbeddingResponseValidationError(
        `Vector for chunk "${requestItem.id}" contains a non-numeric or non-finite value`,
      );
    }
  });
}
