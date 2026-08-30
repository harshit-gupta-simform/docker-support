import {
  LlmGenerationRequest,
  LlmGenerationResponse,
  LlmModelMetadata,
  LlmProviderPort,
} from '../llm-provider.port';
import { estimateTokenCount } from '../token-usage.util';

export class FakeLlmProvider implements LlmProviderPort {
  constructor(public readonly metadata: LlmModelMetadata) {}

  generate(request: LlmGenerationRequest): Promise<LlmGenerationResponse> {
    const firstSourceId = /\[S\d+]/.exec(request.userPrompt)?.[0] ?? null;
    const text = firstSourceId
      ? `Based on the documentation, here is the answer. ${firstSourceId}`
      : 'Based on the documentation, here is the answer.';

    const inputTokens = estimateTokenCount(
      request.systemPrompt + request.userPrompt,
    );
    const outputTokens = estimateTokenCount(text);

    return Promise.resolve({
      text,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    });
  }
}
