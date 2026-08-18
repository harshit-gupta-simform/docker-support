import { createHash } from 'node:crypto';

// Fixed, arbitrary namespace — never changes. embeddingId itself remains
// the single source of truth (design §8); this is a pure format
// conversion to satisfy Qdrant's uint64-or-UUID point ID constraint, not a
// second identity scheme.
const NAMESPACE = 'f47ee6f2-30c1-4b1e-9e17-embedding-id-v5';

export function deriveVectorPointId(embeddingId: string): string {
  const hash = createHash('sha1')
    .update(NAMESPACE + embeddingId, 'utf-8')
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // variant 10
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
