import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { LangChainGoogleGenerativeAiProvider } from './langchain-google-generative-ai.provider';
import {
  LlmResponseValidationError,
  PermanentLlmProviderError,
  RateLimitLlmProviderError,
  TransientLlmProviderError,
} from '../llm.errors';

const mockInvoke = jest.fn();

jest.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    invoke: mockInvoke,
  })),
}));

const mockChatGoogleGenerativeAI =
  ChatGoogleGenerativeAI as unknown as jest.Mock<
    unknown,
    [Record<string, unknown>]
  >;

const request = {
  systemPrompt: 'system',
  userPrompt: 'question',
  maxOutputTokens: 100,
  temperature: 0.2,
};

describe('LangChainGoogleGenerativeAiProvider', () => {
  const metadata = { provider: 'google', model: 'gemini-2.5-flash' };

  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('returns the response text on success (string content)', async () => {
    mockInvoke.mockResolvedValue({
      content: 'the answer',
      response_metadata: {},
    });
    const provider = new LangChainGoogleGenerativeAiProvider('key', metadata);

    const response = await provider.generate(request);
    expect(response.text).toBe('the answer');
  });

  it('passes thinkingConfig through when the request specifies a thinkingLevel', async () => {
    mockInvoke.mockResolvedValue({
      content: 'the answer',
      response_metadata: {},
    });
    const provider = new LangChainGoogleGenerativeAiProvider('key', metadata);

    await provider.generate({ ...request, thinkingLevel: 'LOW' });

    expect(mockChatGoogleGenerativeAI).toHaveBeenCalledWith(
      expect.objectContaining({
        thinkingConfig: { thinkingLevel: 'LOW' },
      }),
    );
  });

  it('omits thinkingConfig entirely when the request has no thinkingLevel', async () => {
    mockInvoke.mockResolvedValue({
      content: 'the answer',
      response_metadata: {},
    });
    const provider = new LangChainGoogleGenerativeAiProvider('key', metadata);

    await provider.generate(request);

    const constructorArgs = mockChatGoogleGenerativeAI.mock.calls[0]![0];
    expect(constructorArgs).not.toHaveProperty('thinkingConfig');
  });

  it('maps usage_metadata into the response usage field', async () => {
    mockInvoke.mockResolvedValue({
      content: 'the answer',
      response_metadata: {},
      usage_metadata: {
        input_tokens: 10,
        output_tokens: 149,
        total_tokens: 159,
      },
    });
    const provider = new LangChainGoogleGenerativeAiProvider('key', metadata);

    const response = await provider.generate(request);

    expect(response.usage).toEqual({
      inputTokens: 10,
      outputTokens: 149,
      totalTokens: 159,
    });
  });

  it('omits usage when usage_metadata is absent from the response', async () => {
    mockInvoke.mockResolvedValue({
      content: 'the answer',
      response_metadata: {},
    });
    const provider = new LangChainGoogleGenerativeAiProvider('key', metadata);

    const response = await provider.generate(request);

    expect(response.usage).toBeUndefined();
  });

  it('joins array-of-parts content', async () => {
    mockInvoke.mockResolvedValue({
      content: [{ text: 'part one ' }, { text: 'part two' }],
      response_metadata: {},
    });
    const provider = new LangChainGoogleGenerativeAiProvider('key', metadata);

    const response = await provider.generate(request);
    expect(response.text).toBe('part one part two');
  });

  it('throws LlmResponseValidationError on a SAFETY finish reason', async () => {
    mockInvoke.mockResolvedValue({
      content: '',
      response_metadata: { finishReason: 'SAFETY' },
    });
    const provider = new LangChainGoogleGenerativeAiProvider('key', metadata);

    await expect(provider.generate(request)).rejects.toBeInstanceOf(
      LlmResponseValidationError,
    );
  });

  it('throws LlmResponseValidationError on an empty response', async () => {
    mockInvoke.mockResolvedValue({ content: '   ', response_metadata: {} });
    const provider = new LangChainGoogleGenerativeAiProvider('key', metadata);

    await expect(provider.generate(request)).rejects.toBeInstanceOf(
      LlmResponseValidationError,
    );
  });

  it('classifies a 429 status as RateLimitLlmProviderError', async () => {
    mockInvoke.mockRejectedValue(
      Object.assign(new Error('too many requests'), { status: 429 }),
    );
    const provider = new LangChainGoogleGenerativeAiProvider('key', metadata);

    await expect(provider.generate(request)).rejects.toBeInstanceOf(
      RateLimitLlmProviderError,
    );
  });

  it('classifies a 401 status as PermanentLlmProviderError', async () => {
    mockInvoke.mockRejectedValue(
      Object.assign(new Error('unauthenticated'), { status: 401 }),
    );
    const provider = new LangChainGoogleGenerativeAiProvider('key', metadata);

    await expect(provider.generate(request)).rejects.toBeInstanceOf(
      PermanentLlmProviderError,
    );
  });

  it('classifies a 500 status as TransientLlmProviderError', async () => {
    mockInvoke.mockRejectedValue(
      Object.assign(new Error('server error'), { status: 500 }),
    );
    const provider = new LangChainGoogleGenerativeAiProvider('key', metadata);

    await expect(provider.generate(request)).rejects.toBeInstanceOf(
      TransientLlmProviderError,
    );
  });

  it('classifies a network-shaped message as TransientLlmProviderError', async () => {
    mockInvoke.mockRejectedValue(new Error('ECONNRESET while calling Gemini'));
    const provider = new LangChainGoogleGenerativeAiProvider('key', metadata);

    await expect(provider.generate(request)).rejects.toBeInstanceOf(
      TransientLlmProviderError,
    );
  });

  it('defaults an unrecognized error to PermanentLlmProviderError (fail closed)', async () => {
    mockInvoke.mockRejectedValue(new Error('something truly unexpected'));
    const provider = new LangChainGoogleGenerativeAiProvider('key', metadata);

    await expect(provider.generate(request)).rejects.toBeInstanceOf(
      PermanentLlmProviderError,
    );
  });
});
