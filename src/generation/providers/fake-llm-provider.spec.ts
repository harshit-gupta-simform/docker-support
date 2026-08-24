import { FakeLlmProvider } from './fake-llm-provider';

describe('FakeLlmProvider', () => {
  const metadata = { provider: 'fake', model: 'fake-llm' };

  it('echoes the first source marker found in the user prompt', async () => {
    const provider = new FakeLlmProvider(metadata);

    const response = await provider.generate({
      systemPrompt: 'system',
      userPrompt: 'question\n<context>\n[S1] first\n\n[S2] second\n</context>',
      maxOutputTokens: 100,
      temperature: 0,
    });

    expect(response.text).toContain('[S1]');
    expect(response.text).not.toContain('[S2]');
  });

  it('returns plain text with no marker when the prompt has no sources', async () => {
    const provider = new FakeLlmProvider(metadata);

    const response = await provider.generate({
      systemPrompt: 'system',
      userPrompt: 'question with no context',
      maxOutputTokens: 100,
      temperature: 0,
    });

    expect(response.text.length).toBeGreaterThan(0);
    expect(response.text).not.toMatch(/\[S\d+]/);
  });

  it('reports deterministic usage derived from prompt and response length', async () => {
    const provider = new FakeLlmProvider(metadata);
    const systemPrompt = 'system';
    const userPrompt = 'question with no context';

    const response = await provider.generate({
      systemPrompt,
      userPrompt,
      maxOutputTokens: 100,
      temperature: 0,
    });

    const expectedInputTokens = Math.ceil(
      (systemPrompt.length + userPrompt.length) / 4,
    );
    const expectedOutputTokens = Math.ceil(response.text.length / 4);

    expect(response.usage).toEqual({
      inputTokens: expectedInputTokens,
      outputTokens: expectedOutputTokens,
      totalTokens: expectedInputTokens + expectedOutputTokens,
    });
  });

  it('exposes its metadata', () => {
    const provider = new FakeLlmProvider(metadata);
    expect(provider.metadata).toEqual(metadata);
  });
});
