import { deriveVectorPointId } from './vector-store-id.util';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deriveVectorPointId', () => {
  it('is deterministic for the same embeddingId', () => {
    const a = deriveVectorPointId('abc123');
    const b = deriveVectorPointId('abc123');
    expect(a).toBe(b);
  });

  it('produces different UUIDs for different embeddingIds', () => {
    expect(deriveVectorPointId('abc123')).not.toBe(
      deriveVectorPointId('def456'),
    );
  });

  it('produces a well-formed RFC 4122 v5 UUID (version and variant nibbles set)', () => {
    expect(deriveVectorPointId('abc123')).toMatch(UUID_RE);
  });
});
