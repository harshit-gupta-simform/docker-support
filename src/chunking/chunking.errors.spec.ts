import {
  EmptyDocumentError,
  UnbalancedHeadingStructureError,
} from './chunking.errors';

describe('chunking errors', () => {
  it('EmptyDocumentError carries the documentId in its message', () => {
    const err = new EmptyDocumentError('abc123');

    expect(err.name).toBe('EmptyDocumentError');
    expect(err.message).toContain('abc123');
    expect(err).toBeInstanceOf(Error);
  });

  it('UnbalancedHeadingStructureError carries name and message', () => {
    const err = new UnbalancedHeadingStructureError('bad token stream');

    expect(err.name).toBe('UnbalancedHeadingStructureError');
    expect(err.message).toBe('bad token stream');
  });
});
