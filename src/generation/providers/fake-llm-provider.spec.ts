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

  it('exposes its metadata', () => {
    const provider = new FakeLlmProvider(metadata);
    expect(provider.metadata).toEqual(metadata);
  });
});
