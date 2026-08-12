import {
  PermanentEmbeddingProviderError,
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from '../embedding.errors';
import { OpenAiEmbeddingProviderAdapter } from './openai-embedding-provider.adapter';

const metadata = {
  provider: 'openai',
  model: 'text-embedding-3-large',
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

describe('OpenAiEmbeddingProviderAdapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the expected request shape and reconstructs id-tagged output', async () => {
    const fetchSpy = mockFetchOnce({
      status: 200,
      body: { data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }] },
    });
    const adapter = new OpenAiEmbeddingProviderAdapter('secret-key', metadata);

    const result = await adapter.embed([{ id: 'chunk1', text: 'hello' }]);

    expect(result).toEqual([{ id: 'chunk1', vector: [0.1, 0.2, 0.3, 0.4] }]);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect((init!.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer secret-key',
    );
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      input: ['hello'],
      model: 'text-embedding-3-large',
      dimensions: 4,
    });
  });

  it('honors a custom baseUrl, enabling a self-hosted OpenAI-compatible endpoint', async () => {
    const fetchSpy = mockFetchOnce({
      status: 200,
      body: { data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }] },
    });
    const adapter = new OpenAiEmbeddingProviderAdapter(
      'secret-key',
      metadata,
      'http://localhost:8080/v1/embeddings',
    );

    await adapter.embed([{ id: 'chunk1', text: 'hello' }]);

    expect(fetchSpy.mock.calls[0]![0]).toBe(
      'http://localhost:8080/v1/embeddings',
    );
  });

  it('maps a 401 response to PermanentEmbeddingProviderError', async () => {
    mockFetchOnce({ status: 401, body: { error: 'invalid api key' } });
    const adapter = new OpenAiEmbeddingProviderAdapter('bad-key', metadata);

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
    const adapter = new OpenAiEmbeddingProviderAdapter('secret-key', metadata);

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
    const adapter = new OpenAiEmbeddingProviderAdapter('secret-key', metadata);

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
    const adapter = new OpenAiEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      TransientEmbeddingProviderError,
    );
  });

  it('never includes the API key in any thrown error message', async () => {
    mockFetchOnce({ status: 401, body: { error: 'invalid api key' } });
    const adapter = new OpenAiEmbeddingProviderAdapter(
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
