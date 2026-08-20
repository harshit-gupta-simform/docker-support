import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmbeddingConfigService } from '../embedding/embedding-config.service';
import { GenerationService } from '../generation/generation.service';
import { GenerationResult } from '../generation/generation.types';
import { GenerationProviderError } from '../generation/llm.errors';
import { deriveCollectionName } from '../vector-store/vector-store-collection-name.util';
import { VectorStoreConfigService } from '../vector-store/vector-store-config.service';
import { validateQueryText } from './query-request.validator';
import {
  RetrievalConfigMismatchError,
  RetrievalValidationError,
} from './retrieval.errors';
import { RetrievalService } from './retrieval.service';

interface QueryRequestBody {
  text?: unknown;
}

@Controller()
export class RetrievalController {
  constructor(
    private readonly retrieval: RetrievalService,
    private readonly generation: GenerationService,
    private readonly vectorStoreConfig: VectorStoreConfigService,
    private readonly embeddingConfig: EmbeddingConfigService,
  ) {}

  @Post('query')
  @HttpCode(HttpStatus.OK)
  async query(@Body() body: QueryRequestBody): Promise<GenerationResult> {
    let text: string;
    try {
      text = validateQueryText(body?.text);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Invalid request',
      );
    }

    const collection = deriveCollectionName({
      domain: this.vectorStoreConfig.domain,
      provider: this.embeddingConfig.provider,
      model: this.embeddingConfig.model,
      dimensions: this.embeddingConfig.dimensions,
      modelVersion: this.embeddingConfig.modelVersion,
    });

    try {
      const results = await this.retrieval.retrieve(
        { text, domain: this.vectorStoreConfig.domain },
        collection,
      );
      return await this.generation.generate(text, results);
    } catch (err) {
      if (err instanceof RetrievalValidationError) {
        throw new BadRequestException(err.message);
      }
      if (
        err instanceof RetrievalConfigMismatchError ||
        err instanceof GenerationProviderError
      ) {
        throw new ServiceUnavailableException(err.message);
      }
      throw err;
    }
  }
}
