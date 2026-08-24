import { TokenUsage } from './token-usage.util';

export const LLM_PROVIDER_PORT = Symbol('LLM_PROVIDER_PORT');

export interface LlmModelMetadata {
  provider: string;
  model: string;
}

export interface LlmGenerationRequest {
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  temperature: number;
  thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface LlmGenerationResponse {
  text: string;
  usage?: TokenUsage;
}

export interface LlmProviderPort {
  readonly metadata: LlmModelMetadata;
  generate(
    request: LlmGenerationRequest,
    signal?: AbortSignal,
  ): Promise<LlmGenerationResponse>;
}
