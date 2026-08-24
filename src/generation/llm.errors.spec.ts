import { PromptTokenLimitExceededError } from './llm.errors';

describe('PromptTokenLimitExceededError', () => {
  it('carries the estimated token count and configured limit', () => {
    const err = new PromptTokenLimitExceededError(9500, 8000);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PromptTokenLimitExceededError');
    expect(err.estimatedTokens).toBe(9500);
    expect(err.limit).toBe(8000);
    expect(err.message).toBe(
      'Estimated prompt size (9500 tokens) exceeds the configured limit of 8000 tokens',
    );
  });
});
