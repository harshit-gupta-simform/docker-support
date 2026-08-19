import {
  RetrievalConfigMismatchError,
  RetrievalValidationError,
} from './retrieval.errors';

describe('retrieval error taxonomy', () => {
  it('RetrievalValidationError names itself', () => {
    expect(new RetrievalValidationError('bad query').name).toBe(
      'RetrievalValidationError',
    );
  });

  it('RetrievalConfigMismatchError composes a message naming both configurations', () => {
    const err = new RetrievalConfigMismatchError(
      { provider: 'google', model: 'gemini-embedding-2', dimensions: 768 },
      { provider: 'google', model: 'gemini-embedding-2', dimensions: 3 },
    );
    expect(err.name).toBe('RetrievalConfigMismatchError');
    expect(err.message).toContain('768');
    expect(err.message).toContain('3');
  });
});
