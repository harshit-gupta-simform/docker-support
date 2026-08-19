interface EmbeddingConfigSummary {
  provider: string;
  model: string;
  dimensions: number;
}

export class RetrievalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalValidationError';
  }
}

export class RetrievalConfigMismatchError extends Error {
  constructor(
    public readonly collectionDimensions: number,
    public readonly actual: EmbeddingConfigSummary,
  ) {
    super(
      `Retrieval is configured for provider=${actual.provider}/model=${actual.model}/dimensions=${actual.dimensions}, but the target collection has dimensions=${collectionDimensions} (the collection's own provider/model identity is not stored in vector-store metadata, only its vector dimensionality). Point RETRIEVAL_* at a matching collection, or re-index with the current embedding configuration.`,
    );
    this.name = 'RetrievalConfigMismatchError';
  }
}
