import { TransientEmbeddingProviderError } from '../embedding.errors';
import { FakeEmbeddingProvider } from './fake-embedding-provider';

const metadata = {
  provider: 'fake',
  model: 'fake-model',
  modelVersion: '1',
  dimensions: 8,
};

describe('FakeEmbeddingProvider', () => {
  it('exposes the metadata it was constructed with', () => {
    const provider = new FakeEmbeddingProvider(metadata);

    expect(provider.metadata).toBe(metadata);
  });

  it('returns one deterministic vector per input, matching the configured dimensions', async () => {
    const provider = new FakeEmbeddingProvider(metadata);

    const result = await provider.embed([
      { id: 'a', text: 'hello' },
      { id: 'b', text: 'world' },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('a');
    expect(result[0]!.vector).toHaveLength(8);
    expect(result[1]!.id).toBe('b');
  });

  it('is deterministic — the same text always produces the same vector', async () => {
    const provider = new FakeEmbeddingProvider(metadata);

    const first = await provider.embed([{ id: 'a', text: 'hello' }]);
    const second = await provider.embed([{ id: 'a', text: 'hello' }]);

    expect(first[0]!.vector).toEqual(second[0]!.vector);
  });

  it('produces different vectors for different text', async () => {
    const provider = new FakeEmbeddingProvider(metadata);

    const result = await provider.embed([
      { id: 'a', text: 'hello' },
      { id: 'b', text: 'goodbye' },
    ]);

    expect(result[0]!.vector).not.toEqual(result[1]!.vector);
  });

  it('can be configured to fail its first N calls with a given error, then succeed', async () => {
    const provider = new FakeEmbeddingProvider(metadata, {
      failFirstNCalls: 2,
      failWith: () =>
        new TransientEmbeddingProviderError('fake transient failure'),
    });

    await expect(provider.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      TransientEmbeddingProviderError,
    );
    await expect(provider.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      TransientEmbeddingProviderError,
    );
    await expect(
      provider.embed([{ id: 'a', text: 'x' }]),
    ).resolves.toHaveLength(1);
  });

  it('can be configured with an artificial delay, for testing timeout handling', async () => {
    const provider = new FakeEmbeddingProvider(metadata, { delayMs: 20 });
    const startedAt = Date.now();

    await provider.embed([{ id: 'a', text: 'x' }]);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });
});
