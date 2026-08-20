import {
  LlmGenerationRequest,
  LlmGenerationResponse,
  LlmModelMetadata,
  LlmProviderPort,
} from '../llm-provider.port';

export class FakeLlmProvider implements LlmProviderPort {
  constructor(public readonly metadata: LlmModelMetadata) {}

  generate(request: LlmGenerationRequest): Promise<LlmGenerationResponse> {
    const firstSourceId = /\[S\d+]/.exec(request.userPrompt)?.[0] ?? null;
    const text = firstSourceId
      ? `Based on the documentation, here is the answer. ${firstSourceId}`
      : 'Based on the documentation, here is the answer.';
    return Promise.resolve({ text });
  }
}
