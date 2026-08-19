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
    public readonly expected: EmbeddingConfigSummary,
    public readonly actual: EmbeddingConfigSummary,
  ) {
    super(
      `Retrieval is configured for provider=${actual.provider}/model=${actual.model}/dimensions=${actual.dimensions}, but the target collection was built with provider=${expected.provider}/model=${expected.model}/dimensions=${expected.dimensions}. Point RETRIEVAL_* at a matching collection, or re-index with the current embedding configuration.`,
    );
    this.name = 'RetrievalConfigMismatchError';
  }
}
