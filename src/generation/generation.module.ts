import { Module } from '@nestjs/common';
import { ContextPolicyService } from './context-policy.service';
import { GenerationService } from './generation.service';
import { LlmConfigService } from './llm-config.service';
import { LLM_PROVIDER_PORT, LlmProviderPort } from './llm-provider.port';
import { PromptBuilderService } from './prompt-builder.service';
import { FakeLlmProvider } from './providers/fake-llm-provider';
import { LangChainGoogleGenerativeAiProvider } from './providers/langchain-google-generative-ai.provider';

function createLlmProvider(config: LlmConfigService): LlmProviderPort {
  const metadata = { provider: config.provider, model: config.model };

  if (config.provider === 'fake') {
    return new FakeLlmProvider(metadata);
  }

  if (!config.apiKey) {
    throw new Error(
      `LLM_API_KEY is required when LLM_PROVIDER=${config.provider}`,
    );
  }

  return new LangChainGoogleGenerativeAiProvider(config.apiKey, metadata);
}

@Module({
  providers: [
    LlmConfigService,
    {
      provide: LLM_PROVIDER_PORT,
      useFactory: createLlmProvider,
      inject: [LlmConfigService],
    },
    ContextPolicyService,
    PromptBuilderService,
    GenerationService,
  ],
  exports: [GenerationService],
})
export class GenerationModule {}
