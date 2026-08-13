import {
  PermanentEmbeddingProviderError,
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from '../embedding.errors';
import { GoogleEmbeddingProviderAdapter } from './google-embedding-provider.adapter';

const metadata = {
  provider: 'google',
  model: 'gemini-embedding-001',
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

describe('GoogleEmbeddingProviderAdapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the expected request shape to the batchEmbedContents endpoint, authenticated via x-goog-api-key', async () => {
    const fetchSpy = mockFetchOnce({
      status: 200,
      body: { embeddings: [{ values: [0.1, 0.2, 0.3, 0.4] }] },
    });
    const adapter = new GoogleEmbeddingProviderAdapter('secret-key', metadata);

    const result = await adapter.embed([{ id: 'chunk1', text: 'hello' }]);

    expect(result).toEqual([{ id: 'chunk1', vector: [0.1, 0.2, 0.3, 0.4] }]);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
    );
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe(
      'secret-key',
    );
    expect(
      (init!.headers as Record<string, string>)['Authorization'],
    ).toBeUndefined();
    const body = JSON.parse(init!.body as string) as {
      requests: {
        model: string;
        content: { parts: { text: string }[] };
        embedContentConfig: { taskType: string; outputDimensionality: number };
      }[];
    };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]!.model).toBe('models/gemini-embedding-001');
    expect(body.requests[0]!.content.parts[0]!.text).toBe('hello');
    expect(body.requests[0]!.embedContentConfig).toEqual({
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: 4,
    });
  });

  it('sends multiple items as multiple requests in one batchEmbedContents call, preserving order positionally', async () => {
    const fetchSpy = mockFetchOnce({
      status: 200,
      body: {
        embeddings: [{ values: [1, 1, 1, 1] }, { values: [2, 2, 2, 2] }],
      },
    });
    const adapter = new GoogleEmbeddingProviderAdapter('secret-key', metadata);

    const result = await adapter.embed([
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
    ]);

    expect(result).toEqual([
      { id: 'a', vector: [1, 1, 1, 1] },
      { id: 'b', vector: [2, 2, 2, 2] },
    ]);
    // Regression guard: Google's real API rejects batchEmbedContents with
    // "requests[N].model: model is not specified" if this field is missing
    // from EVERY item, even though the model is already in the URL path —
    // confirmed against the live API on 2026-08-13. Every item needs it,
    // not just the first.
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as {
      requests: { model: string }[];
    };
    expect(body.requests[0]!.model).toBe('models/gemini-embedding-001');
    expect(body.requests[1]!.model).toBe('models/gemini-embedding-001');
  });

  it('honors a custom baseUrl, constructing the model path against it', async () => {
    const fetchSpy = mockFetchOnce({
      status: 200,
      body: { embeddings: [{ values: [0.1, 0.2, 0.3, 0.4] }] },
    });
    const adapter = new GoogleEmbeddingProviderAdapter(
      'secret-key',
      metadata,
      'http://localhost:8080/v1beta',
    );

    await adapter.embed([{ id: 'chunk1', text: 'hello' }]);

    expect(fetchSpy.mock.calls[0]![0]).toBe(
      'http://localhost:8080/v1beta/models/gemini-embedding-001:batchEmbedContents',
    );
  });

  it('maps a 401 response to PermanentEmbeddingProviderError', async () => {
    mockFetchOnce({
      status: 401,
      body: { error: { message: 'invalid api key' } },
    });
    const adapter = new GoogleEmbeddingProviderAdapter('bad-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      PermanentEmbeddingProviderError,
    );
  });

  it('maps a 400 response to PermanentEmbeddingProviderError', async () => {
    mockFetchOnce({
      status: 400,
      body: { error: { message: 'invalid input' } },
    });
    const adapter = new GoogleEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      PermanentEmbeddingProviderError,
    );
  });

  it('maps a 429 response to RateLimitEmbeddingProviderError, parsing Retry-After when present', async () => {
    mockFetchOnce({
      status: 429,
      body: { error: { message: 'rate limited' } },
      headers: { 'retry-after': '3' },
    });
    const adapter = new GoogleEmbeddingProviderAdapter('secret-key', metadata);

    try {
      await adapter.embed([{ id: 'a', text: 'x' }]);
      fail('expected embed() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitEmbeddingProviderError);
      expect((err as RateLimitEmbeddingProviderError).retryAfterMs).toBe(3000);
    }
  });

  it('falls back to a null retryAfterMs when Retry-After is absent', async () => {
    mockFetchOnce({
      status: 429,
      body: { error: { message: 'rate limited' } },
    });
    const adapter = new GoogleEmbeddingProviderAdapter('secret-key', metadata);

    try {
      await adapter.embed([{ id: 'a', text: 'x' }]);
      fail('expected embed() to throw');
    } catch (err) {
      expect((err as RateLimitEmbeddingProviderError).retryAfterMs).toBeNull();
    }
  });

  it('maps a 500 response to TransientEmbeddingProviderError', async () => {
    mockFetchOnce({
      status: 500,
      body: { error: { message: 'internal error' } },
    });
    const adapter = new GoogleEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      TransientEmbeddingProviderError,
    );
  });

  it('maps a network-level fetch rejection to TransientEmbeddingProviderError', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNRESET'));
    const adapter = new GoogleEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      TransientEmbeddingProviderError,
    );
  });

  it('never includes the API key in any thrown error message', async () => {
    mockFetchOnce({
      status: 401,
      body: { error: { message: 'invalid api key' } },
    });
    const adapter = new GoogleEmbeddingProviderAdapter(
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
