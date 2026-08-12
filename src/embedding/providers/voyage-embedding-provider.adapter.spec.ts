import {
  PermanentEmbeddingProviderError,
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from '../embedding.errors';
import { VoyageEmbeddingProviderAdapter } from './voyage-embedding-provider.adapter';

const metadata = {
  provider: 'voyage',
  model: 'voyage-code-3',
  modelVersion: '1',
  dimensions: 4,
};

function mockFetchOnce(response: {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}) {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: { get: (name: string) => response.headers?.[name] ?? null },
    json: () => Promise.resolve(response.body),
  } as unknown as Response);
}

describe('VoyageEmbeddingProviderAdapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the expected request shape and reconstructs id-tagged output from the positional response', async () => {
    const fetchSpy = mockFetchOnce({
      status: 200,
      body: {
        data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }],
        model: 'voyage-code-3',
      },
    });
    const adapter = new VoyageEmbeddingProviderAdapter('secret-key', metadata);

    const result = await adapter.embed([{ id: 'chunk1', text: 'hello' }]);

    expect(result).toEqual([{ id: 'chunk1', vector: [0.1, 0.2, 0.3, 0.4] }]);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.voyageai.com/v1/embeddings');
    expect((init!.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer secret-key',
    );
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      input: ['hello'],
      model: 'voyage-code-3',
      output_dimension: 4,
    });
  });

  it("reorders a provider response that does not preserve request order, using each item's own index", async () => {
    mockFetchOnce({
      status: 200,
      body: {
        data: [
          { embedding: [9, 9, 9, 9], index: 1 },
          { embedding: [1, 1, 1, 1], index: 0 },
        ],
      },
    });
    const adapter = new VoyageEmbeddingProviderAdapter('secret-key', metadata);

    const result = await adapter.embed([
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
    ]);

    expect(result).toEqual([
      { id: 'a', vector: [1, 1, 1, 1] },
      { id: 'b', vector: [9, 9, 9, 9] },
    ]);
  });

  it('maps a 401 response to PermanentEmbeddingProviderError', async () => {
    mockFetchOnce({ status: 401, body: { error: 'invalid api key' } });
    const adapter = new VoyageEmbeddingProviderAdapter('bad-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      PermanentEmbeddingProviderError,
    );
  });

  it('maps a 400 response to PermanentEmbeddingProviderError', async () => {
    mockFetchOnce({ status: 400, body: { error: 'invalid input' } });
    const adapter = new VoyageEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      PermanentEmbeddingProviderError,
    );
  });

  it('maps a 429 response to RateLimitEmbeddingProviderError, parsing Retry-After when present', async () => {
    mockFetchOnce({
      status: 429,
      body: { error: 'rate limited' },
      headers: { 'retry-after': '3' },
    });
    const adapter = new VoyageEmbeddingProviderAdapter('secret-key', metadata);

    try {
      await adapter.embed([{ id: 'a', text: 'x' }]);
      fail('expected embed() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitEmbeddingProviderError);
      expect((err as RateLimitEmbeddingProviderError).retryAfterMs).toBe(3000);
    }
  });

  it('falls back to a null retryAfterMs (instead of NaN) when Retry-After is an HTTP-date rather than delay-seconds', async () => {
    mockFetchOnce({
      status: 429,
      body: { error: 'rate limited' },
      headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    });
    const adapter = new VoyageEmbeddingProviderAdapter('secret-key', metadata);

    try {
      await adapter.embed([{ id: 'a', text: 'x' }]);
      fail('expected embed() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitEmbeddingProviderError);
      expect((err as RateLimitEmbeddingProviderError).retryAfterMs).toBeNull();
    }
  });

  it('maps a 500 response to TransientEmbeddingProviderError', async () => {
    mockFetchOnce({ status: 500, body: { error: 'internal error' } });
    const adapter = new VoyageEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      TransientEmbeddingProviderError,
    );
  });

  it('maps a network-level fetch rejection to TransientEmbeddingProviderError', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNRESET'));
    const adapter = new VoyageEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      TransientEmbeddingProviderError,
    );
  });

  it('never includes the API key in any thrown error message', async () => {
    mockFetchOnce({ status: 401, body: { error: 'invalid api key' } });
    const adapter = new VoyageEmbeddingProviderAdapter(
      'super-secret-key-value',
      metadata,
    );

    try {
      await adapter.embed([{ id: 'a', text: 'x' }]);
      fail('expected embed() to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret-key-value');
    }
  });
});
